using System.Diagnostics;
using System.Net;
using System.Text.Encodings.Web;
using System.Text.Json;

namespace LexTrace.NativeHost;

internal sealed class RuntimeEngine
{
    private static readonly JsonSerializerOptions CanonicalContextJsonSerializerOptions = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping
    };

    private readonly NativeMessagingTransport _transport;
    private readonly HostStateStore _stateStore;
    private readonly OpenAiClient _openAiClient;
    private readonly SemaphoreSlim _stateLock = new(1, 1);
    private readonly Dictionary<string, CancellationTokenSource> _aiProcessingTokens = [];
    private readonly Dictionary<string, Task> _aiProcessingTasks = [];

    private HostJournal _journal = new();
    private CancellationTokenSource? _heartbeatLoopCts;
    private Task? _heartbeatLoopTask;

    private sealed record ManualCompactionResult(
        bool Triggered,
        string Mode,
        string? CompactionId,
        string? Reason,
        int? AffectedMessageCount,
        int? CompactedItemCount,
        int? PreservedTailCount
    );

    internal sealed record RetryDisposition(
        string Decision,
        string FailureClassification
    )
    {
        public const string DecisionAutoRetry = "auto-retry";
        public const string DecisionRestartFresh = "restart-fresh";
        public const string DecisionManualPause = "manual-pause";
    }

    internal sealed record RetryHandlingDecision(
        string Action,
        string FailureClassification,
        string RetryMode,
        int DelayMs,
        bool ClearResponseState
    )
    {
        public const string ActionAutoRetry = "auto-retry";
        public const string ActionManualPause = "manual-pause";
    }

    private sealed class OpenAiTerminalResponseException : InvalidOperationException
    {
        public OpenAiTerminalResponseException(string responseStatus)
            : base($"OpenAI background response ended with status {responseStatus}.")
        {
            ResponseStatus = responseStatus;
        }

        public string ResponseStatus { get; }
    }

    public RuntimeEngine(NativeMessagingTransport transport, HostStateStore stateStore)
    {
        _transport = transport;
        _stateStore = stateStore;
        _openAiClient = new OpenAiClient();
    }

    public async Task InitializeAsync(CancellationToken cancellationToken)
    {
        _journal = await _stateStore.LoadAsync(cancellationToken);
        NormalizeJournalState();
        _journal.NativeHostPid = Environment.ProcessId;
        await _stateStore.SaveAsync(_journal, cancellationToken);

        if (_journal.Running)
        {
            EnsureHeartbeatLoop();
            await EmitLogAsync(
                "info",
                "native-host.resume",
                "Recovered running host session from journal.",
                new
                {
                    _journal.SessionId,
                    _journal.TaskId,
                    _journal.TickCount,
                    snapshot = BuildStatus()
                },
                cancellationToken
            );
        }
        else
        {
            await EmitLogAsync(
                "info",
                "native-host.startup",
                "Native host is ready.",
                new
                {
                    pid = Environment.ProcessId,
                    apiKeyPresent = _openAiClient.HasApiKey,
                    snapshot = BuildStatus()
                },
                cancellationToken
            );
        }

        foreach (var session in _journal.AiSessions.Where(ShouldAutoResumeSession))
        {
            EnsureAiProcessing(session.PageKey);
        }

        await SendStatusAsync("Host initialized.", cancellationToken);
    }

    public async Task<object?> HandleCommandAsync(ProtocolEnvelope envelope, CancellationToken cancellationToken)
    {
        return envelope.Action switch
        {
            "config.sync" => await SyncConfigAsync(envelope, cancellationToken),
            "worker.start" => await StartWorkerAsync(envelope, cancellationToken),
            "worker.stop" => await StopWorkerAsync(envelope, cancellationToken),
            "worker.status" => BuildStatus(),
            "task.demo.start" => await StartDemoTaskAsync(envelope, cancellationToken),
            "task.demo.stop" => await StopDemoTaskAsync(envelope, cancellationToken),
            "ai.models.catalog" => await GetAiModelCatalogAsync(envelope, cancellationToken),
            "ai.chat.status" => await GetAiChatStatusAsync(envelope, cancellationToken),
            "ai.chat.send" => await SendAiChatAsync(envelope, cancellationToken),
            "ai.chat.compact" => await CompactAiChatAsync(envelope, cancellationToken),
            "ai.chat.resume" => await ResumeAiChatAsync(envelope, cancellationToken),
            "ai.chat.reset" => await ResetAiChatAsync(envelope, cancellationToken),
            "ai.chat.list" => await ListAiChatsAsync(cancellationToken),
            "test.host.crash" => await CrashAsync(envelope, cancellationToken),
            _ => throw new InvalidOperationException($"Unsupported native host action: {envelope.Action}")
        };
    }

    public async Task ShutdownAsync(CancellationToken cancellationToken)
    {
        if (_heartbeatLoopCts is not null)
        {
            await _heartbeatLoopCts.CancelAsync();
        }

        foreach (var cts in _aiProcessingTokens.Values)
        {
            await cts.CancelAsync();
        }

        if (_heartbeatLoopTask is not null)
        {
            try
            {
                await _heartbeatLoopTask.WaitAsync(cancellationToken);
            }
            catch (OperationCanceledException)
            {
                // Normal during shutdown.
            }
        }

        foreach (var task in _aiProcessingTasks.Values)
        {
            try
            {
                await task.WaitAsync(cancellationToken);
            }
            catch (OperationCanceledException)
            {
                // Normal during shutdown.
            }
        }
    }

    private void NormalizeJournalState()
    {
        _journal.AiConfig ??= AiRuntimeConfig.CreateDefault();
        _journal.AiConfig.Chat ??= new AiChatConfig();
        _journal.AiConfig.Chat.StructuredOutput ??= new AiStructuredOutputConfig();
        _journal.AiConfig.Compaction ??= new AiCompactionConfig();
        _journal.AiConfig.PromptCaching ??= new AiPromptCachingConfig();
        _journal.AiConfig.Retries ??= new AiRetryConfig();
        _journal.AiConfig.RateLimits ??= new AiRateLimitConfig();
        _journal.AiConfig.Compaction.Instructions = ResolveCompactionInstructions(_journal.AiConfig);
        _journal.AiConfig.PromptCaching.Routing = PromptCaching.NormalizeRouting(_journal.AiConfig.PromptCaching.Routing);
        _journal.AiConfig.PromptCaching.Retention = PromptCaching.NormalizeRetention(_journal.AiConfig.PromptCaching.Retention);
        _journal.ModelBudgets ??= [];
        _journal.AiSessions ??= [];
        _journal.AiSessions = _journal.AiSessions
            .Where(session => session is not null && !string.IsNullOrWhiteSpace(session.PageKey))
            .ToList();

        foreach (var session in _journal.AiSessions)
        {
            NormalizeSessionState(session);
        }
    }

    private static void NormalizeSessionState(AiPageSessionRecord session)
    {
        session.PageKey ??= string.Empty;
        session.RequestState ??= "idle";
        session.Messages ??= [];
        session.PendingQueue ??= [];
        session.CanonicalContextJsonItems = NormalizeCanonicalContextJsonItems(session.CanonicalContextJsonItems ?? []);
        session.PromptCaching ??= new AiPromptCachingState();
        session.PromptCaching.Session ??= new AiPromptCacheSessionState();
        if (session.PromptCaching.LastRequest is not null)
        {
            session.PromptCaching.LastRequest.Source ??= PromptCaching.SourceChat;
            session.PromptCaching.LastRequest.Status ??= PromptCaching.StatusUnknown;
            session.PromptCaching.LastRequest.RetentionApplied = PromptCaching.NormalizeRetention(session.PromptCaching.LastRequest.RetentionApplied);
            session.PromptCaching.LastRequest.RoutingApplied = PromptCaching.NormalizeRouting(session.PromptCaching.LastRequest.RoutingApplied);
        }

        foreach (var message in session.Messages)
        {
            NormalizeMessageState(message);
        }

        foreach (var item in session.PendingQueue)
        {
            NormalizeQueueItemState(item);
        }

        NormalizeQueueItemState(session.ActiveItem);
        NormalizeQueueItemState(session.RetryableItem);
    }

    private static void NormalizeMessageState(AiChatMessageRecord message)
    {
        message.PageKey ??= string.Empty;
        message.RequestId ??= string.Empty;
        message.Origin ??= "system";
        message.Role ??= "system";
        message.Kind ??= "system";
        message.Text ??= string.Empty;
        message.State ??= "completed";
        message.Ts ??= DateTimeOffset.UtcNow.ToString("O");
    }

    private static void NormalizeQueueItemState(AiQueueItemRecord? item)
    {
        if (item is null)
        {
            return;
        }

        item.RequestId ??= Guid.NewGuid().ToString("D");
        item.PageKey ??= string.Empty;
        item.Origin ??= "user";
        item.Text ??= string.Empty;
        item.CreatedAt ??= DateTimeOffset.UtcNow.ToString("O");
        item.State ??= "queued";
        item.UserMessageId ??= string.Empty;
        item.AttemptCount = Math.Max(0, item.AttemptCount);
        item.AutoRetryCount = Math.Max(0, item.AutoRetryCount);
        item.NotBeforeAt = NormalizeOptionalIsoTimestamp(item.NotBeforeAt);
        item.PromptCacheRoutingApplied = PromptCaching.NormalizeRouting(item.PromptCacheRoutingApplied);
        item.PromptCacheRetentionApplied = PromptCaching.NormalizeRetention(item.PromptCacheRetentionApplied);
    }

    private async Task<object> SyncConfigAsync(ProtocolEnvelope envelope, CancellationToken cancellationToken)
    {
        await _stateLock.WaitAsync(cancellationToken);
        try
        {
            ApplyAiConfig(_journal, _openAiClient, envelope.Payload);
            await _stateStore.SaveAsync(_journal, cancellationToken);
        }
        finally
        {
            _stateLock.Release();
        }

        await EmitLogAsync(
            "info",
            "config.sync",
            "Native host config synced.",
            new
            {
                model = BuildAiModelSelectionPayload(_journal.AiConfig.Chat.Model),
                modelOverride = BuildAiModelSelectionPayload(_journal.AiConfig.Compaction.ModelOverride),
                chatStreamingEnabled = _journal.AiConfig.Chat.StreamingEnabled,
                structuredOutputEnabled = !string.IsNullOrWhiteSpace(_journal.AiConfig.Chat.StructuredOutput.Schema),
                structuredOutputName = string.IsNullOrWhiteSpace(_journal.AiConfig.Chat.StructuredOutput.Name)
                    ? "chat_response"
                    : _journal.AiConfig.Chat.StructuredOutput.Name,
                compactionEnabled = _journal.AiConfig.Compaction.Enabled,
                compactionStreamingEnabled = _journal.AiConfig.Compaction.StreamingEnabled,
                maxRetries = _journal.AiConfig.Retries.MaxRetries,
                retryBaseDelayMs = _journal.AiConfig.Retries.BaseDelayMs,
                retryMaxDelayMs = _journal.AiConfig.Retries.MaxDelayMs,
                reserveOutputTokens = _journal.AiConfig.RateLimits.ReserveOutputTokens,
                maxQueuedPerPage = _journal.AiConfig.RateLimits.MaxQueuedPerPage,
                maxQueuedGlobal = _journal.AiConfig.RateLimits.MaxQueuedGlobal,
                apiKeyPresent = _openAiClient.HasApiKey
            },
            cancellationToken,
            envelope.CorrelationId
        );

        foreach (var session in _journal.AiSessions.Where(ShouldAutoResumeSession))
        {
            EnsureAiProcessing(session.PageKey);
        }

        return new
        {
            synced = true,
            apiKeyPresent = _openAiClient.HasApiKey
        };
    }

    private async Task<HostStatus> StartWorkerAsync(ProtocolEnvelope envelope, CancellationToken cancellationToken)
    {
        await _stateLock.WaitAsync(cancellationToken);
        try
        {
            var configuredHeartbeatMs = GetOptionalInt(envelope.Payload, "heartbeatMs");
            if (!_journal.Running)
            {
                _journal.Running = true;
                _journal.SessionId = _journal.SessionId ?? Guid.NewGuid().ToString("D");
                _journal.StartedAt = NowIso();
                _journal.LastHeartbeatAt = NowIso();
                _journal.NativeHostPid = Environment.ProcessId;
            }

            if (configuredHeartbeatMs is > 0)
            {
                _journal.HeartbeatMs = configuredHeartbeatMs.Value;
            }

            await _stateStore.SaveAsync(_journal, cancellationToken);
        }
        finally
        {
            _stateLock.Release();
        }

        EnsureHeartbeatLoop();
        await EmitLogAsync(
            "info",
            "worker.start",
            "Worker start command accepted.",
            new
            {
                reason = GetOptionalString(envelope.Payload, "reason"),
                _journal.SessionId,
                snapshot = BuildStatus()
            },
            cancellationToken,
            envelope.CorrelationId
        );
        await SendStatusAsync("Worker started.", cancellationToken);
        return BuildStatus();
    }

    private async Task<HostStatus> StopWorkerAsync(ProtocolEnvelope envelope, CancellationToken cancellationToken)
    {
        if (_heartbeatLoopCts is not null)
        {
            await _heartbeatLoopCts.CancelAsync();
        }

        if (_heartbeatLoopTask is not null)
        {
            try
            {
                await _heartbeatLoopTask.WaitAsync(cancellationToken);
            }
            catch (OperationCanceledException)
            {
                // Ignore.
            }
        }

        await _stateLock.WaitAsync(cancellationToken);
        try
        {
            _journal.Running = false;
            _journal.TaskId = null;
            _journal.SessionId = null;
            _journal.StartedAt = null;
            _journal.LastHeartbeatAt = null;
            _journal.TickCount = 0;
            _journal.NativeHostPid = Environment.ProcessId;
            await _stateStore.SaveAsync(_journal, cancellationToken);
        }
        finally
        {
            _stateLock.Release();
        }

        await EmitLogAsync(
            "info",
            "worker.stop",
            "Worker stop command accepted.",
            new
            {
                reason = GetOptionalString(envelope.Payload, "reason"),
                snapshot = BuildStatus()
            },
            cancellationToken,
            envelope.CorrelationId
        );
        await SendStatusAsync("Worker stopped.", cancellationToken);
        return BuildStatus();
    }

    private async Task<HostStatus> StartDemoTaskAsync(ProtocolEnvelope envelope, CancellationToken cancellationToken)
    {
        await StartWorkerAsync(envelope, cancellationToken);

        await _stateLock.WaitAsync(cancellationToken);
        try
        {
            _journal.TaskId = GetOptionalString(envelope.Payload, "taskId") ?? "demo-task";
            _journal.LastHeartbeatAt = NowIso();
            var configuredHeartbeatMs = GetOptionalInt(envelope.Payload, "heartbeatMs");
            if (configuredHeartbeatMs is > 0)
            {
                _journal.HeartbeatMs = configuredHeartbeatMs.Value;
            }
            await _stateStore.SaveAsync(_journal, cancellationToken);
        }
        finally
        {
            _stateLock.Release();
        }

        await EmitLogAsync(
            "info",
            "task.demo.start",
            "Demo task started.",
            new
            {
                _journal.TaskId,
                _journal.SessionId,
                snapshot = BuildStatus()
            },
            cancellationToken,
            envelope.CorrelationId
        );
        await SendStatusAsync("Demo task started.", cancellationToken);
        return BuildStatus();
    }

    private async Task<HostStatus> StopDemoTaskAsync(ProtocolEnvelope envelope, CancellationToken cancellationToken)
    {
        await _stateLock.WaitAsync(cancellationToken);
        try
        {
            _journal.TaskId = null;
            var configuredHeartbeatMs = GetOptionalInt(envelope.Payload, "heartbeatMs");
            if (configuredHeartbeatMs is > 0)
            {
                _journal.HeartbeatMs = configuredHeartbeatMs.Value;
            }
            await _stateStore.SaveAsync(_journal, cancellationToken);
        }
        finally
        {
            _stateLock.Release();
        }

        await EmitLogAsync(
            "info",
            "task.demo.stop",
            "Demo task stopped.",
            new
            {
                _journal.SessionId,
                snapshot = BuildStatus()
            },
            cancellationToken,
            envelope.CorrelationId
        );
        await SendStatusAsync("Demo task stopped.", cancellationToken);
        return BuildStatus();
    }

    private async Task<object> GetAiModelCatalogAsync(ProtocolEnvelope envelope, CancellationToken cancellationToken)
    {
        var catalog = await _openAiClient.ListChatModelsAsync(cancellationToken);

        await EmitLogAsync(
            "info",
            "ai.models.catalog",
            "Fetched OpenAI chat model catalog.",
            new
            {
                modelCount = catalog.Models.Count,
                apiKeyPresent = _openAiClient.HasApiKey
            },
            cancellationToken,
            envelope.CorrelationId
        );

        return new
        {
            fetchedAt = catalog.FetchedAt,
            models = catalog.Models,
            warning = catalog.Warning
        };
    }

    private async Task<object> GetAiChatStatusAsync(ProtocolEnvelope envelope, CancellationToken cancellationToken)
    {
        var pageKey = GetRequiredString(envelope.Payload, "pageKey");
        var pageUrl = GetOptionalString(envelope.Payload, "pageUrl");
        AiPageSessionRecord session;

        await _stateLock.WaitAsync(cancellationToken);
        try
        {
            session = GetOrCreatePageSessionLocked(pageKey, pageUrl);
            await _stateStore.SaveAsync(_journal, cancellationToken);
        }
        finally
        {
            _stateLock.Release();
        }

        await EnsureCurrentModelBudgetTelemetryAsync(cancellationToken);

        await _stateLock.WaitAsync(cancellationToken);
        try
        {
            session = GetOrCreatePageSessionLocked(pageKey, pageUrl);
        }
        finally
        {
            _stateLock.Release();
        }

        return new
        {
            session = await CaptureAiSessionPayloadAsync(pageKey, pageUrl, cancellationToken)
        };
    }

    private async Task<object> SendAiChatAsync(ProtocolEnvelope envelope, CancellationToken cancellationToken)
    {
        var pageKey = GetRequiredString(envelope.Payload, "pageKey");
        var pageUrl = GetRequiredString(envelope.Payload, "pageUrl");
        var origin = GetRequiredString(envelope.Payload, "origin");
        var text = GetRequiredString(envelope.Payload, "text");
        var requestId = GetOptionalString(envelope.Payload, "requestId") ?? Guid.NewGuid().ToString("D");

        AiPageSessionRecord session;

        await _stateLock.WaitAsync(cancellationToken);
        try
        {
            if (string.IsNullOrWhiteSpace(GetConfiguredModelId(_journal.AiConfig.Chat.Model)))
            {
                throw new InvalidOperationException("AI model is unset in config.");
            }

            if (!_openAiClient.HasApiKey)
            {
                throw new InvalidOperationException($"{OpenAiClient.ApiKeyEnvironmentVariableName} environment variable is missing.");
            }

            if (GetGlobalQueuedWorkCountLocked() >= _journal.AiConfig.RateLimits.MaxQueuedGlobal)
            {
                throw new InvalidOperationException("Global AI queue limit has been reached.");
            }

            session = GetOrCreatePageSessionLocked(pageKey, pageUrl);
            if (GetSessionQueuedWorkCountLocked(session) >= _journal.AiConfig.RateLimits.MaxQueuedPerPage)
            {
                throw new InvalidOperationException("Page AI queue limit has been reached.");
            }

            var userMessage = new AiChatMessageRecord
            {
                PageKey = pageKey,
                RequestId = requestId,
                Origin = origin,
                Role = "user",
                Kind = origin == "code" ? "code" : "user",
                Text = text,
                State = "pending"
            };
            session.Messages.Add(userMessage);

            session.PendingQueue.Add(new AiQueueItemRecord
            {
                RequestId = requestId,
                PageKey = pageKey,
                Origin = origin,
                Text = text,
                UserMessageId = userMessage.Id,
                State = "queued"
            });
            session.RequestState = session.ActiveItem is null ? "queued" : session.RequestState;
            session.LastError = null;
            session.LastCheckpointAt = NowIso();

            await _stateStore.SaveAsync(_journal, cancellationToken);
        }
        finally
        {
            _stateLock.Release();
        }

        EnsureAiProcessing(pageKey);

        await EmitAiEventAsync(
            "ai.chat.status",
            "AI request queued.",
            session,
            cancellationToken,
            details: new
            {
                requestId,
                queueCount = GetVisibleQueueCountLocked(session)
            },
            messageRecord: session.Messages.LastOrDefault(message => message.RequestId == requestId && message.Role == "user"),
            correlationId: envelope.CorrelationId
        );

        await EmitLogAsync(
            "info",
            "ai.chat.send",
            "AI request queued.",
            new
            {
                pageKey,
                requestId,
                origin,
                queueCount = GetVisibleQueueCountLocked(session),
                queuedWorkCount = GetSessionQueuedWorkCountLocked(session),
                inputLength = text.Length
            },
            cancellationToken,
            envelope.CorrelationId
        );

        return new
        {
            session = await CaptureAiSessionPayloadAsync(pageKey, pageUrl, cancellationToken)
        };
    }

    private async Task<object> ResumeAiChatAsync(ProtocolEnvelope envelope, CancellationToken cancellationToken)
    {
        var pageKey = GetRequiredString(envelope.Payload, "pageKey");
        AiPageSessionRecord session;

        await _stateLock.WaitAsync(cancellationToken);
        try
        {
            session = GetOrCreatePageSessionLocked(pageKey, pageUrl: null);
            if (session.RetryableItem is not null)
            {
                ResetRetryCycleForManualResume(session.RetryableItem);
                session.PendingQueue.Insert(0, session.RetryableItem);
                session.RetryableItem = null;
                session.RequestState = "queued";
            }

            await _stateStore.SaveAsync(_journal, cancellationToken);
        }
        finally
        {
            _stateLock.Release();
        }

        EnsureAiProcessing(pageKey);
        await EmitAiEventAsync(
            "ai.chat.status",
            "AI page session resumed.",
            session,
            cancellationToken
        );

        await EmitLogAsync(
            "info",
            "ai.chat.resume",
            "AI page session resumed.",
            new
            {
                pageKey,
                queueCount = GetVisibleQueueCountLocked(session),
                queuedWorkCount = GetSessionQueuedWorkCountLocked(session),
                recoverable = session.Recoverable
            },
            cancellationToken,
            envelope.CorrelationId
        );

        return new
        {
            session = await CaptureAiSessionPayloadAsync(pageKey, pageUrl: null, cancellationToken)
        };
    }

    private async Task<object> ResetAiChatAsync(ProtocolEnvelope envelope, CancellationToken cancellationToken)
    {
        var pageKey = GetRequiredString(envelope.Payload, "pageKey");
        string? responseId = null;
        string? pageUrl = null;

        await _stateLock.WaitAsync(cancellationToken);
        try
        {
            var currentSession = GetOrCreatePageSessionLocked(pageKey, pageUrl: null);
            responseId = currentSession.OpenAiResponseId ?? currentSession.ActiveItem?.OpenAiResponseId;
            pageUrl = currentSession.PageUrlSample;
        }
        finally
        {
            _stateLock.Release();
        }

        CancelPageProcessing(pageKey);

        if (!string.IsNullOrWhiteSpace(responseId))
        {
            try
            {
                await _openAiClient.CancelResponseAsync(responseId, cancellationToken);
            }
            catch
            {
                // Best effort.
            }
        }

        AiPageSessionRecord session;
        await _stateLock.WaitAsync(cancellationToken);
        try
        {
            session = GetOrCreatePageSessionLocked(pageKey, pageUrl);
            session.Messages.Clear();
            session.PendingQueue.Clear();
            session.ActiveItem = null;
            session.RetryableItem = null;
            session.CanonicalContextJsonItems.Clear();
            session.CompactionPassCount = 0;
            PromptCaching.ResetSessionState(session);
            session.OpenAiResponseId = null;
            session.LastSequenceNumber = null;
            session.LastResolvedServiceTier = null;
            session.RequestState = "idle";
            session.LastError = null;
            session.Recoverable = false;
            session.LastCheckpointAt = NowIso();
            await _stateStore.SaveAsync(_journal, cancellationToken);
        }
        finally
        {
            _stateLock.Release();
        }

        await EmitAiEventAsync(
            "ai.chat.status",
            "AI page session reset.",
            session,
            cancellationToken
        );

        await EmitLogAsync(
            "info",
            "ai.chat.reset",
            "AI page session reset.",
            new
            {
                pageKey,
                cancelledResponseId = responseId
            },
            cancellationToken,
            envelope.CorrelationId
        );

        return new
        {
            session = await CaptureAiSessionPayloadAsync(pageKey, pageUrl, cancellationToken)
        };
    }

    private async Task<object> CompactAiChatAsync(ProtocolEnvelope envelope, CancellationToken cancellationToken)
    {
        var pageKey = GetRequiredString(envelope.Payload, "pageKey");
        var pageUrl = GetOptionalString(envelope.Payload, "pageUrl");
        var requestedMode = GetOptionalString(envelope.Payload, "mode");
        var mode = string.Equals(requestedMode, "force", StringComparison.OrdinalIgnoreCase) ? "force" : "safe";
        var restartProcessing = false;

        await _stateLock.WaitAsync(cancellationToken);
        try
        {
            var session = GetOrCreatePageSessionLocked(pageKey, pageUrl);
            pageUrl = session.PageUrlSample ?? pageUrl;
            if (session.ActiveItem is not null || !string.IsNullOrWhiteSpace(session.OpenAiResponseId))
            {
                throw new InvalidOperationException("Cannot compact context while an AI request is active.");
            }

            restartProcessing = session.PendingQueue.Count > 0 || session.RetryableItem is not null;
            CancelPageProcessing(pageKey);
        }
        finally
        {
            _stateLock.Release();
        }

        try
        {
            var result = await ExecuteManualCompactionAsync(
                pageKey,
                pageUrl,
                mode,
                cancellationToken,
                envelope.CorrelationId
            );

            return new
            {
                session = await CaptureAiSessionPayloadAsync(pageKey, pageUrl, cancellationToken),
                triggered = result.Triggered,
                mode = result.Mode,
                compactionId = result.CompactionId,
                reason = result.Reason,
                affectedMessageCount = result.AffectedMessageCount,
                compactedItemCount = result.CompactedItemCount,
                preservedTailCount = result.PreservedTailCount
            };
        }
        finally
        {
            if (restartProcessing)
            {
                EnsureAiProcessing(pageKey);
            }
        }
    }

    private async Task<ManualCompactionResult> ExecuteManualCompactionAsync(
        string pageKey,
        string? pageUrl,
        string mode,
        CancellationToken cancellationToken,
        string? correlationId
    )
    {
        var force = string.Equals(mode, "force", StringComparison.OrdinalIgnoreCase);
        var config = _journal.AiConfig;
        AiPageSessionRecord session;

        await _stateLock.WaitAsync(cancellationToken);
        try
        {
            session = GetOrCreatePageSessionLocked(pageKey, pageUrl);
        }
        finally
        {
            _stateLock.Release();
        }

        if (!force && !config.Compaction.Enabled)
        {
            await EmitLogAsync(
                "info",
                "ai.chat.compaction.requested",
                "Manual AI context compaction skipped.",
                new
                {
                    pageKey,
                    mode,
                    reason = "compaction_disabled"
                },
                cancellationToken,
                correlationId
            );
            return new ManualCompactionResult(false, mode, null, "compaction_disabled", null, null, null);
        }

        if (session.CanonicalContextJsonItems.Count == 0)
        {
            await EmitLogAsync(
                "info",
                "ai.chat.compaction.requested",
                "Manual AI context compaction skipped.",
                new
                {
                    pageKey,
                    mode,
                    reason = "empty_context"
                },
                cancellationToken,
                correlationId
            );
            return new ManualCompactionResult(false, mode, null, "empty_context", null, null, null);
        }

        if (!force && session.CompactionPassCount >= config.Compaction.MaxPassesPerPage)
        {
            await EmitLogAsync(
                "info",
                "ai.chat.compaction.requested",
                "Manual AI context compaction skipped.",
                new
                {
                    pageKey,
                    mode,
                    reason = "max_passes_reached",
                    session.CompactionPassCount,
                    config.Compaction.MaxPassesPerPage
                },
                cancellationToken,
                correlationId
            );
            return new ManualCompactionResult(false, mode, null, "max_passes_reached", null, null, null);
        }

        var compactionSelection = config.Compaction.ModelOverride ?? config.Chat.Model;
        var compactionModel = GetConfiguredModelId(compactionSelection);
        if (string.IsNullOrWhiteSpace(compactionModel) || compactionSelection is null)
        {
            await EmitLogAsync(
                "warn",
                "ai.chat.compaction.requested",
                "Manual AI context compaction rejected: compaction model is not configured.",
                new
                {
                    pageKey,
                    mode,
                    reason = "model_not_configured"
                },
                cancellationToken,
                correlationId
            );
            return new ManualCompactionResult(false, mode, null, "model_not_configured", null, null, null);
        }

        var affectedMessages = GetCompactionAffectedMessages(session, config.Compaction.PreserveRecentTurns);
        if (affectedMessages.Count == 0)
        {
            await EmitLogAsync(
                "info",
                "ai.chat.compaction.requested",
                "Manual AI context compaction skipped.",
                new
                {
                    pageKey,
                    mode,
                    reason = "no_eligible_messages"
                },
                cancellationToken,
                correlationId
            );
            return new ManualCompactionResult(false, mode, null, "no_eligible_messages", 0, null, null);
        }

        var requestId = Guid.NewGuid().ToString("D");
        var compactionId = Guid.NewGuid().ToString("D");
        var affectedMessageIds = affectedMessages.Select(message => message.Id).ToList();
        var rangeStartMessageId = affectedMessageIds[0];
        var rangeEndMessageId = affectedMessageIds[^1];
        var resolvedInstructions = ResolveCompactionInstructions(config);
        var preservedTailItems = GetPreservedTailContextJson(session, config.Compaction.PreserveRecentTurns);
        var compactionInputItems = GetCompactionInputItems(session, preservedTailItems);
        if (compactionInputItems.Count == 0)
        {
            await EmitLogAsync(
                "info",
                "ai.chat.compaction.requested",
                "Manual AI context compaction skipped.",
                new
                {
                    pageKey,
                    mode,
                    reason = "no_compaction_input"
                },
                cancellationToken,
                correlationId
            );
            return new ManualCompactionResult(false, mode, null, "no_compaction_input", 0, null, null);
        }

        var promptCacheRequest = PromptCaching.ResolveCompactionRequest(config, session, compactionSelection);
        AiChatMessageRecord? compactionRequestMessage = null;

        await EmitLogAsync(
            "info",
            "ai.chat.compaction.requested",
            "Manual AI context compaction requested.",
            new
            {
                pageKey,
                requestId,
                mode,
                compactionId,
                affectedMessageCount = affectedMessageIds.Count,
                rangeStartMessageId,
                rangeEndMessageId
            },
            cancellationToken,
            correlationId
        );

        await _stateLock.WaitAsync(cancellationToken);
        try
        {
            session = GetOrCreatePageSessionLocked(pageKey, pageUrl);
            compactionRequestMessage = new AiChatMessageRecord
            {
                PageKey = session.PageKey,
                RequestId = requestId,
                Origin = "system",
                Role = "system",
                Kind = "compaction-request",
                Text = "Compacting context by explicit request.",
                Summary = $"Compacting {affectedMessageIds.Count} messages.",
                State = "pending",
                Meta = new AiCompactionRequestMeta
                {
                    CompactionId = compactionId,
                    AffectedMessageIds = [.. affectedMessageIds],
                    RangeStartMessageId = rangeStartMessageId,
                    RangeEndMessageId = rangeEndMessageId,
                    InstructionsText = resolvedInstructions
                }
            };
            session.Messages.Add(compactionRequestMessage);
            await _stateStore.SaveAsync(_journal, cancellationToken);
        }
        finally
        {
            _stateLock.Release();
        }

        await EmitAiEventAsync(
            "ai.chat.compaction.started",
            "AI context compaction started.",
            session,
            cancellationToken,
            details: new
            {
                compactionId,
                mode,
                requestId,
                affectedMessageCount = affectedMessageIds.Count,
                rangeStartMessageId,
                rangeEndMessageId
            },
            messageRecord: compactionRequestMessage,
            correlationId: correlationId
        );

        await EmitLogAsync(
            "info",
            "ai.chat.compaction.started",
            "AI context compaction started.",
            new
            {
                pageKey,
                requestId,
                mode,
                compactionId,
                affectedMessageCount = affectedMessageIds.Count,
                rangeStartMessageId,
                rangeEndMessageId
            },
            cancellationToken,
            correlationId
        );

        try
        {
            var response = await _openAiClient.CompactAsync(
                compactionSelection,
                compactionInputItems,
                resolvedInstructions,
                promptCacheRequest,
                cancellationToken
            );
            await ApplyRateLimitsAsync(compactionModel, resolvedServiceTier: null, response.RateLimits, cancellationToken);

            await _stateLock.WaitAsync(cancellationToken);
            try
            {
                session = GetOrCreatePageSessionLocked(pageKey, pageUrl);
                var promptCacheUsage = PromptCaching.ReadUsage(response.Document.RootElement);
                var compactedItems = GetOutputItemsAsJsonStrings(response.Document.RootElement);
                var resultPreviewText = BuildCompactionResultPreview(compactedItems);
                session.CanonicalContextJsonItems = MergeCanonicalContext(compactedItems, preservedTailItems);
                session.CompactionPassCount += 1;
                PromptCaching.RecordUsage(session, promptCacheRequest, promptCacheUsage, NowIso());
                session.LastCheckpointAt = NowIso();

                var persistedRequestMessage = session.Messages.FirstOrDefault(message => message.Id == compactionRequestMessage!.Id);
                if (persistedRequestMessage is not null)
                {
                    persistedRequestMessage.State = "completed";
                    persistedRequestMessage.Summary = $"Compacting {affectedMessageIds.Count} messages.";
                    persistedRequestMessage.Meta = new AiCompactionRequestMeta
                    {
                        CompactionId = compactionId,
                        AffectedMessageIds = [.. affectedMessageIds],
                        RangeStartMessageId = rangeStartMessageId,
                        RangeEndMessageId = rangeEndMessageId,
                        InstructionsText = resolvedInstructions
                    };
                }

                MarkMessagesCompacted(session, affectedMessageIds, compactionId);

                var compactionResultMessage = new AiChatMessageRecord
                {
                    PageKey = session.PageKey,
                    RequestId = requestId,
                    Origin = "system",
                    Role = "system",
                    Kind = "compaction-result",
                    Text = "Context compaction completed.",
                    Summary = $"Compacted into {compactedItems.Count} items, preserved tail {preservedTailItems.Count}.",
                    State = "completed",
                    Meta = new AiCompactionResultMeta
                    {
                        CompactionId = compactionId,
                        AffectedMessageIds = [.. affectedMessageIds],
                        RangeStartMessageId = rangeStartMessageId,
                        RangeEndMessageId = rangeEndMessageId,
                        ResultPreviewText = resultPreviewText,
                        CompactedItemCount = compactedItems.Count,
                        PreservedTailCount = preservedTailItems.Count
                    }
                };
                session.Messages.Add(compactionResultMessage);

                await _stateStore.SaveAsync(_journal, cancellationToken);

                await EmitAiEventAsync(
                    "ai.chat.compaction.completed",
                    "AI context compaction completed.",
                    session,
                    cancellationToken,
                    details: new
                    {
                        compactionId,
                        mode,
                        requestId,
                        affectedMessageCount = affectedMessageIds.Count,
                        rangeStartMessageId,
                        rangeEndMessageId,
                        compactedItemCount = compactedItems.Count,
                        preservedTailCount = preservedTailItems.Count,
                        promptCaching = BuildPromptCacheTelemetryDetails(session, promptCacheRequest.FallbackReason)
                    },
                    messageRecord: compactionResultMessage,
                    correlationId: correlationId
                );

                await EmitLogAsync(
                    "info",
                    "ai.chat.compaction.completed",
                    "AI context compaction completed.",
                    new
                    {
                        pageKey,
                        requestId,
                        mode,
                        compactionId,
                        affectedMessageCount = affectedMessageIds.Count,
                        rangeStartMessageId,
                        rangeEndMessageId,
                        compactedItemCount = compactedItems.Count,
                        preservedTailCount = preservedTailItems.Count,
                        resultPreviewText,
                        promptCaching = BuildPromptCacheTelemetryDetails(session, promptCacheRequest.FallbackReason)
                    },
                    cancellationToken,
                    correlationId
                );

                return new ManualCompactionResult(
                    true,
                    mode,
                    compactionId,
                    null,
                    affectedMessageIds.Count,
                    compactedItems.Count,
                    preservedTailItems.Count
                );
            }
            finally
            {
                _stateLock.Release();
            }
        }
        catch
        {
            await _stateLock.WaitAsync(cancellationToken);
            try
            {
                session = GetOrCreatePageSessionLocked(pageKey, pageUrl);
                var pendingCompactionMessage = session.Messages.LastOrDefault(
                    message => message.Kind == "compaction-request" &&
                               message.RequestId == requestId &&
                               message.State == "pending");
                if (pendingCompactionMessage is not null)
                {
                    pendingCompactionMessage.State = "error";
                    pendingCompactionMessage.Text = "Context compaction request failed.";
                    await _stateStore.SaveAsync(_journal, cancellationToken);
                }
            }
            finally
            {
                _stateLock.Release();
            }

            throw;
        }
    }

    private async Task<object> ListAiChatsAsync(CancellationToken cancellationToken)
    {
        await _stateLock.WaitAsync(cancellationToken);
        try
        {
            return new
            {
                sessions = _journal.AiSessions
                    .OrderBy(session => session.PageKey, StringComparer.Ordinal)
                    .Select(BuildAiSessionPayload)
                    .ToArray()
            };
        }
        finally
        {
            _stateLock.Release();
        }
    }

    private async Task<object> CrashAsync(ProtocolEnvelope envelope, CancellationToken cancellationToken)
    {
        await EmitLogAsync(
            "warn",
            "test.host.crash",
            "Native host crash has been scheduled.",
            new
            {
                _journal.SessionId,
                _journal.TaskId,
                aiSessions = _journal.AiSessions.Count,
                snapshot = BuildStatus()
            },
            cancellationToken,
            envelope.CorrelationId
        );

        _ = Task.Run(async () =>
        {
            await Task.Delay(300);
            Process.GetCurrentProcess().Kill(entireProcessTree: true);
        });

        return new
        {
            scheduled = true
        };
    }

    private void EnsureHeartbeatLoop()
    {
        if (_heartbeatLoopTask is { IsCompleted: false })
        {
            return;
        }

        _heartbeatLoopCts = new CancellationTokenSource();
        _heartbeatLoopTask = Task.Run(() => HeartbeatLoopAsync(_heartbeatLoopCts.Token));
    }

    private async Task HeartbeatLoopAsync(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            int heartbeatMs;
            await _stateLock.WaitAsync(cancellationToken);
            try
            {
                if (!_journal.Running)
                {
                    return;
                }

                heartbeatMs = _journal.HeartbeatMs;
            }
            finally
            {
                _stateLock.Release();
            }

            try
            {
                await Task.Delay(heartbeatMs, cancellationToken);
            }
            catch (OperationCanceledException)
            {
                return;
            }

            await _stateLock.WaitAsync(cancellationToken);
            try
            {
                if (!_journal.Running)
                {
                    return;
                }

                _journal.TickCount += 1;
                _journal.LastHeartbeatAt = NowIso();
                _journal.NativeHostPid = Environment.ProcessId;
                await _stateStore.SaveAsync(_journal, cancellationToken);
            }
            finally
            {
                _stateLock.Release();
            }

            await EmitLogAsync(
                "info",
                "heartbeat.tick",
                "Heartbeat emitted.",
                new
                {
                    tick = _journal.TickCount,
                    _journal.SessionId,
                    _journal.TaskId,
                    heartbeatMs,
                    pid = Environment.ProcessId,
                    snapshot = BuildStatus()
                },
                cancellationToken
            );
            await SendStatusAsync("Heartbeat emitted.", cancellationToken);
        }
    }

    private void EnsureAiProcessing(string pageKey)
    {
        if (_aiProcessingTasks.TryGetValue(pageKey, out var existingTask) && !existingTask.IsCompleted)
        {
            return;
        }

        var processingCts = new CancellationTokenSource();
        _aiProcessingTokens[pageKey] = processingCts;
        _aiProcessingTasks[pageKey] = Task.Run(() => ProcessPageQueueAsync(pageKey, processingCts.Token));
    }

    private void CancelPageProcessing(string pageKey)
    {
        if (_aiProcessingTokens.Remove(pageKey, out var cts))
        {
            cts.Cancel();
            cts.Dispose();
        }
    }

    private async Task ProcessPageQueueAsync(string pageKey, CancellationToken cancellationToken)
    {
        try
        {
            while (!cancellationToken.IsCancellationRequested)
            {
                AiQueueItemRecord? activeItem;
                AiPageSessionRecord? session;
                TimeSpan? waitDelay = null;

                await _stateLock.WaitAsync(cancellationToken);
                try
                {
                    session = FindPageSessionLocked(pageKey);
                    if (session is null)
                    {
                        return;
                    }

                    if (session.ActiveItem is not null)
                    {
                        activeItem = session.ActiveItem;
                    }
                    else if (session.RetryableItem is { State: "blocked" } blockedItem)
                    {
                        var estimatedTokenCost = EstimateBudgetTokenCost(session, blockedItem.Text);
                        if (TryGetRateLimitBlockInfoLocked(GetConfiguredModelId(_journal.AiConfig.Chat.Model), estimatedTokenCost, out _))
                        {
                            session.RequestState = "blocked";
                            session.LastCheckpointAt = NowIso();
                            await _stateStore.SaveAsync(_journal, cancellationToken);
                            return;
                        }

                        session.PendingQueue.Insert(0, blockedItem);
                        session.RetryableItem = null;
                        if (TryTakeNextPendingQueueItemForExecution(session, DateTimeOffset.UtcNow, out activeItem, out var nextRetryAt))
                        {
                            ActivateQueuedItem(session, activeItem!);
                            session.RequestState = "running";
                            session.LastError = null;
                            session.LastCheckpointAt = NowIso();
                            await _stateStore.SaveAsync(_journal, cancellationToken);
                        }
                        else
                        {
                            session.RequestState = "queued";
                            session.LastCheckpointAt = NowIso();
                            await _stateStore.SaveAsync(_journal, cancellationToken);
                            waitDelay = GetWaitDelay(nextRetryAt);
                            activeItem = null;
                        }
                    }
                    else if (session.PendingQueue.Count > 0)
                    {
                        if (TryTakeNextPendingQueueItemForExecution(session, DateTimeOffset.UtcNow, out activeItem, out var nextRetryAt))
                        {
                            ActivateQueuedItem(session, activeItem!);
                            session.RequestState = "running";
                            session.LastCheckpointAt = NowIso();
                            await _stateStore.SaveAsync(_journal, cancellationToken);
                        }
                        else
                        {
                            session.RequestState = "queued";
                            session.LastCheckpointAt = NowIso();
                            await _stateStore.SaveAsync(_journal, cancellationToken);
                            waitDelay = GetWaitDelay(nextRetryAt);
                            activeItem = null;
                        }
                    }
                    else
                    {
                        session.RequestState = session.RetryableItem?.State == "blocked"
                            ? "blocked"
                            : session.RetryableItem is not null
                                ? "paused"
                                : "idle";
                        await _stateStore.SaveAsync(_journal, cancellationToken);
                        return;
                    }
                }
                finally
                {
                    _stateLock.Release();
                }

                if (activeItem is null)
                {
                    if (waitDelay is null)
                    {
                        return;
                    }

                    await Task.Delay(waitDelay.Value, cancellationToken);
                    continue;
                }

                await ProcessActiveQueueItemAsync(pageKey, activeItem!, cancellationToken);
            }
        }
        catch (OperationCanceledException)
        {
            // Normal reset/shutdown path.
        }
        finally
        {
            if (_aiProcessingTokens.Remove(pageKey, out var processingCts))
            {
                processingCts.Dispose();
            }
            _aiProcessingTasks.Remove(pageKey);
        }
    }

    private async Task ProcessActiveQueueItemAsync(
        string pageKey,
        AiQueueItemRecord activeItem,
        CancellationToken cancellationToken
    )
    {
        if (!string.IsNullOrWhiteSpace(activeItem.OpenAiResponseId))
        {
            await ResumeOrPollResponseAsync(pageKey, activeItem, cancellationToken);
            return;
        }

        AiPageSessionRecord? session;
        await _stateLock.WaitAsync(cancellationToken);
        try
        {
            session = FindPageSessionLocked(pageKey);
        }
        finally
        {
            _stateLock.Release();
        }

        if (session is null)
        {
            return;
        }

        try
        {
            await MaybeCompactContextAsync(session, activeItem, cancellationToken);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception error)
        {
            await HandleActiveItemFailureAsync(pageKey, activeItem, error, cancellationToken);
            return;
        }
        var executionModel = string.IsNullOrWhiteSpace(activeItem.ModelId)
            ? GetConfiguredModelId(_journal.AiConfig.Chat.Model)
            : activeItem.ModelId;
        var estimatedTokenCost = EstimateBudgetTokenCost(session, activeItem.Text);
        if (await TryBlockActiveItemByRateLimitAsync(pageKey, activeItem, executionModel, estimatedTokenCost, cancellationToken))
        {
            return;
        }

        var assistantMessage = EnsureAssistantDraftMessage(session, activeItem);
        await PersistSessionAsync(cancellationToken);

        var inputItems = BuildInputItemsForRequest(session, activeItem);
        var promptCacheRequest = PromptCaching.ResolveChatRequest(_journal.AiConfig, session, _journal.AiConfig.Chat.Model);

        try
        {
            activeItem.ModelId = executionModel;
            activeItem.PromptCacheRoutingApplied = promptCacheRequest.RoutingApplied;
            activeItem.PromptCacheRetentionApplied = promptCacheRequest.RetentionApplied;
            activeItem.PromptCacheKey = promptCacheRequest.CacheKey;
            await PersistJournalAsync(cancellationToken);

            if (!string.IsNullOrWhiteSpace(promptCacheRequest.FallbackReason))
            {
                await EmitLogAsync(
                    "info",
                    "ai.prompt_cache.fallback",
                    "Prompt cache request used a fallback policy.",
                    new
                    {
                        pageKey = session.PageKey,
                        source = promptCacheRequest.Source,
                        requestedRetention = PromptCaching.NormalizeRetention(_journal.AiConfig.PromptCaching.Retention),
                        appliedRetention = promptCacheRequest.RetentionApplied,
                        routingApplied = promptCacheRequest.RoutingApplied,
                        reason = promptCacheRequest.FallbackReason,
                        model = executionModel
                    },
                    cancellationToken
                );
            }

            if (_journal.AiConfig.Chat.StreamingEnabled)
            {
                await using var streamResponse = await _openAiClient.CreateResponseStreamAsync(
                    _journal.AiConfig,
                    inputItems,
                    background: true,
                    promptCacheRequest,
                    cancellationToken
                );
                await ApplyRateLimitsAsync(executionModel, resolvedServiceTier: null, streamResponse.RateLimits, cancellationToken);
                await ConsumeStreamingResponseAsync(session, activeItem, assistantMessage, streamResponse, cancellationToken);
                return;
            }

            var response = await _openAiClient.CreateResponseAsync(
                _journal.AiConfig,
                inputItems,
                background: true,
                stream: false,
                promptCacheRequest,
                cancellationToken
            );
            await ApplyRateLimitsAsync(executionModel, resolvedServiceTier: null, response.RateLimits, cancellationToken);

            var responseId = GetResponseId(response.Document.RootElement);
            var responseStatus = GetResponseStatus(response.Document.RootElement);
            var responseServiceTier = GetResponseServiceTier(response.Document.RootElement);
            if (!string.IsNullOrWhiteSpace(responseId))
            {
                await UpdateActiveResponseAsync(
                    session.PageKey,
                    responseId!,
                    responseStatus,
                    sequenceNumber: null,
                    responseServiceTier,
                    cancellationToken
                );
            }

            if (responseStatus == "completed")
            {
                await FinalizeCompletedResponseAsync(session.PageKey, activeItem, response.Document.RootElement, cancellationToken);
            }
            else
            {
                await PollResponseUntilTerminalAsync(session.PageKey, activeItem, cancellationToken);
            }
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception error)
        {
            await HandleActiveItemFailureAsync(pageKey, activeItem, error, cancellationToken);
        }
    }

    private async Task ResumeOrPollResponseAsync(
        string pageKey,
        AiQueueItemRecord activeItem,
        CancellationToken cancellationToken
    )
    {
        try
        {
            if (_journal.AiConfig.Chat.StreamingEnabled)
            {
                await using var streamResponse = await _openAiClient.ResumeResponseStreamAsync(
                    activeItem.OpenAiResponseId!,
                    activeItem.LastSequenceNumber,
                    cancellationToken
                );
                await ApplyRateLimitsAsync(GetExecutionModel(activeItem), resolvedServiceTier: null, streamResponse.RateLimits, cancellationToken);

                var session = FindPageSession(pageKey);
                var assistantMessage = EnsureAssistantDraftMessage(session, activeItem);
                await ConsumeStreamingResponseAsync(session, activeItem, assistantMessage, streamResponse, cancellationToken);
                return;
            }

            await PollResponseUntilTerminalAsync(pageKey, activeItem, cancellationToken);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception error)
        {
            await HandleActiveItemFailureAsync(pageKey, activeItem, error, cancellationToken);
        }
    }

    private async Task ConsumeStreamingResponseAsync(
        AiPageSessionRecord session,
        AiQueueItemRecord activeItem,
        AiChatMessageRecord assistantMessage,
        OpenAiStreamResponse streamResponse,
        CancellationToken cancellationToken
    )
    {
        await foreach (var streamEvent in streamResponse.ReadEventsAsync(cancellationToken))
        {
            var sequenceNumber = GetOptionalInt(streamEvent.Data, "sequence_number");
            var responseElement = GetOptionalElement(streamEvent.Data, "response");
            var responseId = responseElement is { ValueKind: JsonValueKind.Object }
                ? GetOptionalString(responseElement.Value, "id")
                : GetOptionalString(streamEvent.Data, "response_id");
            var responseServiceTier = responseElement is { ValueKind: JsonValueKind.Object }
                ? GetResponseServiceTier(responseElement.Value)
                : null;

            if (!string.IsNullOrWhiteSpace(responseId))
            {
                var responseStatus = responseElement is { ValueKind: JsonValueKind.Object }
                    ? GetResponseStatus(responseElement.Value)
                    : session.RequestState;
                await UpdateActiveResponseAsync(
                    session.PageKey,
                    responseId!,
                    responseStatus,
                    sequenceNumber,
                    responseServiceTier,
                    cancellationToken
                );
            }

            switch (streamEvent.EventName)
            {
                case "response.output_text.delta":
                    var delta = GetOptionalString(streamEvent.Data, "delta") ?? string.Empty;
                    if (delta.Length > 0)
                    {
                        await AppendAssistantDeltaAsync(session.PageKey, activeItem, assistantMessage, delta, responseId, sequenceNumber, cancellationToken);
                    }
                    break;

                case "response.completed":
                    if (responseElement is { ValueKind: JsonValueKind.Object })
                    {
                        await FinalizeCompletedResponseAsync(session.PageKey, activeItem, responseElement.Value, cancellationToken);
                        return;
                    }
                    break;

                case "response.failed":
                    throw new OpenAiTerminalResponseException("failed");
            }
        }

        if (!string.IsNullOrWhiteSpace(activeItem.OpenAiResponseId))
        {
            await PollResponseUntilTerminalAsync(session.PageKey, activeItem, cancellationToken);
        }
    }

    private async Task PollResponseUntilTerminalAsync(
        string pageKey,
        AiQueueItemRecord activeItem,
        CancellationToken cancellationToken
    )
    {
        while (!cancellationToken.IsCancellationRequested && !string.IsNullOrWhiteSpace(activeItem.OpenAiResponseId))
        {
            var response = await _openAiClient.RetrieveResponseAsync(activeItem.OpenAiResponseId!, cancellationToken);
            await ApplyRateLimitsAsync(GetExecutionModel(activeItem), resolvedServiceTier: null, response.RateLimits, cancellationToken);
            var responseStatus = GetResponseStatus(response.Document.RootElement);
            var responseServiceTier = GetResponseServiceTier(response.Document.RootElement);
            await UpdateActiveResponseAsync(
                pageKey,
                activeItem.OpenAiResponseId!,
                responseStatus,
                activeItem.LastSequenceNumber,
                responseServiceTier,
                cancellationToken
            );

            if (responseStatus == "completed")
            {
                await FinalizeCompletedResponseAsync(pageKey, activeItem, response.Document.RootElement, cancellationToken);
                return;
            }

            if (responseStatus is "failed" or "cancelled" or "incomplete")
            {
                throw new OpenAiTerminalResponseException(responseStatus);
            }

            await Task.Delay(1500, cancellationToken);
        }
    }

    private async Task AppendAssistantDeltaAsync(
        string pageKey,
        AiQueueItemRecord activeItem,
        AiChatMessageRecord assistantMessage,
        string delta,
        string? responseId,
        int? sequenceNumber,
        CancellationToken cancellationToken
    )
    {
        await _stateLock.WaitAsync(cancellationToken);
        try
        {
            var session = GetOrCreatePageSessionLocked(pageKey, pageUrl: null);
            assistantMessage = session.Messages.FirstOrDefault(message => message.Id == assistantMessage.Id) ?? assistantMessage;
            assistantMessage.Text += delta;
            assistantMessage.State = "streaming";
            assistantMessage.OpenAiResponseId = responseId;
            activeItem = session.ActiveItem ?? activeItem;
            activeItem.OpenAiResponseId = responseId ?? activeItem.OpenAiResponseId;
            activeItem.LastSequenceNumber = sequenceNumber ?? activeItem.LastSequenceNumber;
            session.OpenAiResponseId = responseId ?? session.OpenAiResponseId;
            session.LastSequenceNumber = sequenceNumber ?? session.LastSequenceNumber;
            session.RequestState = "streaming";
            session.Recoverable = true;
            session.LastCheckpointAt = NowIso();
            await _stateStore.SaveAsync(_journal, cancellationToken);

            await EmitAiEventAsync(
                "ai.chat.delta",
                "AI assistant delta received.",
                session,
                cancellationToken,
                messageRecord: assistantMessage,
                delta: delta
            );
        }
        finally
        {
            _stateLock.Release();
        }
    }

    private async Task UpdateActiveResponseAsync(
        string pageKey,
        string responseId,
        string responseStatus,
        int? sequenceNumber,
        string? resolvedServiceTier,
        CancellationToken cancellationToken
    )
    {
        await _stateLock.WaitAsync(cancellationToken);
        try
        {
            var session = GetOrCreatePageSessionLocked(pageKey, pageUrl: null);
            if (session.ActiveItem is not null)
            {
                session.ActiveItem.OpenAiResponseId = responseId;
                session.ActiveItem.LastSequenceNumber = sequenceNumber ?? session.ActiveItem.LastSequenceNumber;
            }
            session.OpenAiResponseId = responseId;
            session.LastSequenceNumber = sequenceNumber ?? session.LastSequenceNumber;
            session.LastResolvedServiceTier = resolvedServiceTier ?? session.LastResolvedServiceTier;
            if (resolvedServiceTier is not null)
            {
                UpdateModelBudgetResolvedTierLocked(session.ActiveItem?.ModelId, resolvedServiceTier);
            }
            session.RequestState = responseStatus switch
            {
                "queued" => "queued",
                "in_progress" => "running",
                "completed" => "running",
                _ => session.RequestState
            };
            session.Recoverable = true;
            session.LastCheckpointAt = NowIso();
            await _stateStore.SaveAsync(_journal, cancellationToken);

            await EmitAiEventAsync(
                "ai.chat.status",
                "AI background response updated.",
                session,
                cancellationToken,
                details: new
                {
                    responseId,
                    responseStatus,
                    sequenceNumber,
                    resolvedServiceTier = session.LastResolvedServiceTier
                }
            );
        }
        finally
        {
            _stateLock.Release();
        }
    }

    private async Task FinalizeCompletedResponseAsync(
        string pageKey,
        AiQueueItemRecord activeItem,
        JsonElement responseElement,
        CancellationToken cancellationToken
    )
    {
        var assistantText = ExtractAssistantText(responseElement);
        var responseId = GetResponseId(responseElement);
        var responseServiceTier = GetResponseServiceTier(responseElement);
        var promptCacheUsage = PromptCaching.ReadUsage(responseElement);
        var promptCacheRequest = new PromptCaching.PromptCacheRequestSettings(
            PromptCaching.SourceChat,
            PromptCaching.NormalizeRouting(activeItem.PromptCacheRoutingApplied),
            PromptCaching.NormalizeRetention(activeItem.PromptCacheRetentionApplied),
            activeItem.PromptCacheKey,
            null
        );

        await _stateLock.WaitAsync(cancellationToken);
        try
        {
            var session = GetOrCreatePageSessionLocked(pageKey, pageUrl: null);
            var assistantMessage = EnsureAssistantDraftMessage(session, activeItem);
            assistantMessage.Text = assistantText;
            assistantMessage.State = "completed";
            assistantMessage.OpenAiResponseId = responseId;

            MarkMessageState(session, activeItem.UserMessageId, "completed");

            session.CanonicalContextJsonItems.Add(SerializeUserMessageInputJson(activeItem.Origin, activeItem.Text));
            session.CanonicalContextJsonItems.Add(SerializeAssistantMessageOutputJson(assistantText));
            session.ActiveItem = null;
            session.OpenAiResponseId = null;
            session.LastSequenceNumber = null;
            session.LastResolvedServiceTier = responseServiceTier ?? session.LastResolvedServiceTier;
            if (responseServiceTier is not null)
            {
                UpdateModelBudgetResolvedTierLocked(activeItem.ModelId, responseServiceTier);
            }
            PromptCaching.RecordUsage(session, promptCacheRequest, promptCacheUsage, NowIso());
            session.RequestState = session.PendingQueue.Count > 0 ? "queued" : "idle";
            session.LastError = null;
            session.Recoverable = session.PendingQueue.Count > 0 || session.RetryableItem is not null;
            session.LastCheckpointAt = NowIso();

            await _stateStore.SaveAsync(_journal, cancellationToken);

            await EmitAiEventAsync(
                "ai.chat.completed",
                "AI response completed.",
                session,
                cancellationToken,
                details: new
                {
                    responseId,
                    resolvedServiceTier = session.LastResolvedServiceTier,
                    promptCaching = BuildPromptCacheTelemetryDetails(session)
                },
                messageRecord: assistantMessage
            );

            await EmitLogAsync(
                "info",
                "ai.chat.completed",
                "AI response completed.",
                new
                {
                    pageKey,
                    requestId = activeItem.RequestId,
                    responseId,
                    resolvedServiceTier = session.LastResolvedServiceTier,
                    queueRemaining = session.PendingQueue.Count,
                    assistantLength = assistantText.Length,
                    recoverable = session.Recoverable,
                    promptCaching = BuildPromptCacheTelemetryDetails(session)
                },
                cancellationToken
            );
        }
        finally
        {
            _stateLock.Release();
        }
    }

    private async Task HandleActiveItemFailureAsync(
        string pageKey,
        AiQueueItemRecord activeItem,
        Exception error,
        CancellationToken cancellationToken
    )
    {
        var errorMessage = error.Message;
        var retryHandling = DetermineRetryHandling(error, activeItem, _journal.AiConfig.Retries);
        if (retryHandling.Action == RetryHandlingDecision.ActionAutoRetry)
        {
            await ScheduleAutomaticRetryAsync(pageKey, activeItem, errorMessage, retryHandling, cancellationToken);
            return;
        }

        await MarkRetryableAsync(pageKey, activeItem, errorMessage, retryHandling, cancellationToken);
    }

    private async Task ScheduleAutomaticRetryAsync(
        string pageKey,
        AiQueueItemRecord activeItem,
        string errorMessage,
        RetryHandlingDecision retryHandling,
        CancellationToken cancellationToken
    )
    {
        AiPageSessionRecord? session = null;
        AiChatMessageRecord? assistantMessage = null;
        var nextRetryAt = DateTimeOffset.UtcNow.AddMilliseconds(retryHandling.DelayMs).ToString("O");

        await _stateLock.WaitAsync(cancellationToken);
        try
        {
            session = GetOrCreatePageSessionLocked(pageKey, pageUrl: null);
            session.ActiveItem = null;
            activeItem.State = "queued";
            activeItem.AutoRetryCount += 1;
            activeItem.NotBeforeAt = nextRetryAt;
            PrepareQueueItemForRetry(session, activeItem, retryHandling.RetryMode, messageState: "pending");
            session.PendingQueue.Insert(0, activeItem);
            session.RequestState = "queued";
            session.LastError = errorMessage;
            session.Recoverable = true;
            session.LastCheckpointAt = NowIso();
            assistantMessage = FindAssistantMessage(session, activeItem);
            MarkPendingCompactionRequestFailed(session);

            await _stateStore.SaveAsync(_journal, cancellationToken);
        }
        finally
        {
            _stateLock.Release();
        }

        await EmitAiEventAsync(
            "ai.chat.status",
            "AI request scheduled for automatic retry.",
            session!,
            cancellationToken,
            details: new
            {
                activeItem.RequestId,
                errorMessage,
                attemptCount = activeItem.AttemptCount,
                maxRetries = _journal.AiConfig.Retries.MaxRetries,
                delayMs = retryHandling.DelayMs,
                retryMode = retryHandling.RetryMode,
                failureClassification = retryHandling.FailureClassification,
                nextRetryAt
            },
            messageRecord: assistantMessage
        );

        await EmitLogAsync(
            "warn",
            "ai.chat.retry_scheduled",
            "AI request scheduled for automatic retry.",
            new
            {
                pageKey,
                requestId = activeItem.RequestId,
                errorMessage,
                attemptCount = activeItem.AttemptCount,
                maxRetries = _journal.AiConfig.Retries.MaxRetries,
                delayMs = retryHandling.DelayMs,
                retryMode = retryHandling.RetryMode,
                failureClassification = retryHandling.FailureClassification,
                nextRetryAt,
                recoverable = session!.Recoverable,
                requestState = session.RequestState
            },
            cancellationToken
        );
    }

    private async Task MarkRetryableAsync(
        string pageKey,
        AiQueueItemRecord activeItem,
        string errorMessage,
        RetryHandlingDecision retryHandling,
        CancellationToken cancellationToken
    )
    {
        AiPageSessionRecord? session = null;
        AiChatMessageRecord? assistantMessage = null;

        await _stateLock.WaitAsync(cancellationToken);
        try
        {
            session = GetOrCreatePageSessionLocked(pageKey, pageUrl: null);
            session.ActiveItem = null;
            activeItem.State = "retryable";
            activeItem.NotBeforeAt = null;
            PrepareQueueItemForRetry(session, activeItem, retryHandling.RetryMode, messageState: "error");
            session.RetryableItem = activeItem;
            session.RequestState = "paused";
            session.LastError = errorMessage;
            session.Recoverable = true;
            session.LastCheckpointAt = NowIso();
            assistantMessage = FindAssistantMessage(session, activeItem);
            MarkPendingCompactionRequestFailed(session);

            await _stateStore.SaveAsync(_journal, cancellationToken);
        }
        finally
        {
            _stateLock.Release();
        }

        await EmitAiEventAsync(
            "ai.chat.error",
            "AI request moved to retryable state.",
            session!,
            cancellationToken,
            details: new
            {
                activeItem.RequestId,
                errorMessage,
                attemptCount = activeItem.AttemptCount,
                maxRetries = _journal.AiConfig.Retries.MaxRetries,
                retryMode = retryHandling.RetryMode,
                failureClassification = retryHandling.FailureClassification
            },
            messageRecord: assistantMessage
        );

        await EmitLogAsync(
            "error",
            "ai.chat.error",
            "AI request moved to retryable state.",
            new
            {
                pageKey,
                requestId = activeItem.RequestId,
                errorMessage,
                attemptCount = activeItem.AttemptCount,
                maxRetries = _journal.AiConfig.Retries.MaxRetries,
                retryMode = retryHandling.RetryMode,
                failureClassification = retryHandling.FailureClassification,
                recoverable = session!.Recoverable,
                requestState = session.RequestState
            },
            cancellationToken
        );
    }

    internal static RetryDisposition ClassifyRetry(Exception error)
    {
        if (error is OpenAiTerminalResponseException terminal)
        {
            return new RetryDisposition(
                RetryDisposition.DecisionManualPause,
                $"openai_response_{terminal.ResponseStatus}"
            );
        }

        if (error is OpenAiClient.OpenAiHttpException openAiError)
        {
            if (openAiError.StatusCode == HttpStatusCode.BadRequest && IsExpiredResumeError(openAiError))
            {
                return new RetryDisposition(
                    RetryDisposition.DecisionRestartFresh,
                    "expired_response_id"
                );
            }

            if (openAiError.StatusCode == HttpStatusCode.RequestTimeout)
            {
                return new RetryDisposition(
                    RetryDisposition.DecisionAutoRetry,
                    "openai_http_408"
                );
            }

            if ((int)openAiError.StatusCode == 409)
            {
                return new RetryDisposition(
                    RetryDisposition.DecisionAutoRetry,
                    "openai_http_409"
                );
            }

            if (openAiError.StatusCode == HttpStatusCode.TooManyRequests)
            {
                return new RetryDisposition(
                    string.Equals(openAiError.ErrorCode, "insufficient_quota", StringComparison.OrdinalIgnoreCase)
                        ? RetryDisposition.DecisionManualPause
                        : RetryDisposition.DecisionAutoRetry,
                    string.Equals(openAiError.ErrorCode, "insufficient_quota", StringComparison.OrdinalIgnoreCase)
                        ? "insufficient_quota"
                        : "openai_http_429"
                );
            }

            if ((int)openAiError.StatusCode >= 500)
            {
                return new RetryDisposition(
                    RetryDisposition.DecisionAutoRetry,
                    $"openai_http_{(int)openAiError.StatusCode}"
                );
            }

            return new RetryDisposition(
                RetryDisposition.DecisionManualPause,
                $"openai_http_{(int)openAiError.StatusCode}"
            );
        }

        if (error is HttpRequestException)
        {
            return new RetryDisposition(
                RetryDisposition.DecisionAutoRetry,
                "transport_http"
            );
        }

        if (error is IOException or EndOfStreamException)
        {
            return new RetryDisposition(
                RetryDisposition.DecisionAutoRetry,
                "stream_disconnect"
            );
        }

        return new RetryDisposition(
            RetryDisposition.DecisionManualPause,
            "non_retryable_error"
        );
    }

    internal static RetryHandlingDecision DetermineRetryHandling(
        Exception error,
        AiQueueItemRecord activeItem,
        AiRetryConfig config
    )
    {
        var disposition = ClassifyRetry(error);
        var retryMode = ResolveRetryMode(activeItem, disposition);
        var clearResponseState = string.Equals(retryMode, "restart", StringComparison.Ordinal);

        if ((disposition.Decision == RetryDisposition.DecisionAutoRetry ||
             disposition.Decision == RetryDisposition.DecisionRestartFresh) &&
            activeItem.AutoRetryCount < config.MaxRetries)
        {
            var retryIndex = activeItem.AutoRetryCount + 1;
            return new RetryHandlingDecision(
                RetryHandlingDecision.ActionAutoRetry,
                disposition.FailureClassification,
                retryMode,
                ComputeRetryDelayMs(config, retryIndex),
                clearResponseState
            );
        }

        return new RetryHandlingDecision(
            RetryHandlingDecision.ActionManualPause,
            disposition.FailureClassification,
            retryMode,
            0,
            clearResponseState
        );
    }

    internal static int ComputeRetryDelayMs(AiRetryConfig config, int retryIndex)
    {
        if (retryIndex <= 0)
        {
            return 0;
        }

        var multiplier = 1L << Math.Min(retryIndex - 1, 30);
        var delayMs = config.BaseDelayMs * multiplier;
        return (int)Math.Min(delayMs, config.MaxDelayMs);
    }

    internal static void ResetRetryCycleForManualResume(AiQueueItemRecord? item)
    {
        if (item is null)
        {
            return;
        }

        item.AutoRetryCount = 0;
        item.NotBeforeAt = null;
        if (item.State != "blocked")
        {
            item.State = "queued";
        }
    }

    private static string ResolveRetryMode(
        AiQueueItemRecord activeItem,
        RetryDisposition disposition
    ) =>
        disposition.Decision == RetryDisposition.DecisionRestartFresh ||
        string.IsNullOrWhiteSpace(activeItem.OpenAiResponseId)
            ? "restart"
            : "resume";

    private static bool IsExpiredResumeError(OpenAiClient.OpenAiHttpException error)
    {
        var message = error.ErrorMessage ?? error.ResponseBody;
        return message.Contains("no longer be streamed", StringComparison.OrdinalIgnoreCase) &&
               message.Contains("more than 5 minutes old", StringComparison.OrdinalIgnoreCase);
    }

    private static AiChatMessageRecord? FindAssistantMessage(
        AiPageSessionRecord session,
        AiQueueItemRecord activeItem
    ) =>
        session.Messages.FirstOrDefault(message => message.Id == activeItem.AssistantMessageId);

    internal static void PrepareQueueItemForRetry(
        AiPageSessionRecord session,
        AiQueueItemRecord activeItem,
        string retryMode,
        string messageState
    )
    {
        var assistantMessage = FindAssistantMessage(session, activeItem);
        if (string.Equals(retryMode, "restart", StringComparison.Ordinal))
        {
            activeItem.OpenAiResponseId = null;
            activeItem.LastSequenceNumber = null;
            activeItem.ModelId = null;
            session.OpenAiResponseId = null;
            session.LastSequenceNumber = null;

            if (assistantMessage is not null)
            {
                assistantMessage.Text = string.Empty;
                assistantMessage.OpenAiResponseId = null;
            }
        }

        if (assistantMessage is not null)
        {
            assistantMessage.State = messageState;
        }
    }

    private static void MarkPendingCompactionRequestFailed(AiPageSessionRecord session)
    {
        var pendingCompactionMessage = session.Messages.LastOrDefault(message => message.Kind == "compaction-request" && message.State == "pending");
        if (pendingCompactionMessage is not null)
        {
            pendingCompactionMessage.State = "error";
            pendingCompactionMessage.Text = "Context compaction request failed.";
        }
    }

    private async Task MaybeCompactContextAsync(
        AiPageSessionRecord session,
        AiQueueItemRecord activeItem,
        CancellationToken cancellationToken
    )
    {
        var config = _journal.AiConfig;
        if (!config.Compaction.Enabled ||
            session.CanonicalContextJsonItems.Count == 0 ||
            session.CompactionPassCount >= config.Compaction.MaxPassesPerPage)
        {
            return;
        }

        var estimatedPromptTokens = EstimateCompactionPromptTokenCost(session, activeItem.Text);
        var estimatedBudgetTokens = EstimateBudgetTokenCost(session, activeItem.Text);
        var shouldCompact = estimatedPromptTokens >= config.Compaction.TriggerPromptTokens ||
                            NeedsTpmHeadroom(estimatedBudgetTokens);
        if (!shouldCompact)
        {
            return;
        }

        var compactionSelection = config.Compaction.ModelOverride ?? config.Chat.Model;
        var compactionModel = GetConfiguredModelId(compactionSelection);
        if (string.IsNullOrWhiteSpace(compactionModel) || compactionSelection is null)
        {
            return;
        }

        var compactionId = Guid.NewGuid().ToString("D");
        var affectedMessages = GetCompactionAffectedMessages(session, config.Compaction.PreserveRecentTurns);
        if (affectedMessages.Count == 0)
        {
            return;
        }

        var affectedMessageIds = affectedMessages.Select(message => message.Id).ToList();
        var rangeStartMessageId = affectedMessageIds[0];
        var rangeEndMessageId = affectedMessageIds[^1];
        var resolvedInstructions = ResolveCompactionInstructions(config);
        var preservedTailItems = GetPreservedTailContextJson(session, config.Compaction.PreserveRecentTurns);
        var compactionInputItems = GetCompactionInputItems(session, preservedTailItems);
        if (compactionInputItems.Count == 0)
        {
            return;
        }

        var promptCacheRequest = PromptCaching.ResolveCompactionRequest(config, session, compactionSelection);

        AiChatMessageRecord? compactionRequestMessage = null;
        await _stateLock.WaitAsync(cancellationToken);
        try
        {
            session = GetOrCreatePageSessionLocked(session.PageKey, session.PageUrlSample);
            compactionRequestMessage = new AiChatMessageRecord
            {
                PageKey = session.PageKey,
                RequestId = activeItem.RequestId,
                Origin = "system",
                Role = "system",
                Kind = "compaction-request",
                Text = "Compacting context before the next AI request.",
                Summary = $"Compacting {affectedMessageIds.Count} messages.",
                State = "pending",
                Meta = new AiCompactionRequestMeta
                {
                    CompactionId = compactionId,
                    AffectedMessageIds = [.. affectedMessageIds],
                    RangeStartMessageId = rangeStartMessageId,
                    RangeEndMessageId = rangeEndMessageId,
                    InstructionsText = resolvedInstructions
                }
            };
            session.Messages.Add(compactionRequestMessage);
            await _stateStore.SaveAsync(_journal, cancellationToken);
        }
        finally
        {
            _stateLock.Release();
        }

        await EmitAiEventAsync(
            "ai.chat.compaction.started",
            "AI context compaction started.",
            session,
            cancellationToken,
            details: new
            {
                compactionId,
                contextPromptTokens = estimatedPromptTokens,
                triggerPromptTokens = config.Compaction.TriggerPromptTokens,
                affectedMessageCount = affectedMessageIds.Count,
                rangeStartMessageId,
                rangeEndMessageId
            },
            messageRecord: compactionRequestMessage
        );

        await EmitLogAsync(
            "info",
            "ai.chat.compaction.started",
            "AI context compaction started.",
            new
            {
                pageKey = session.PageKey,
                requestId = activeItem.RequestId,
                compactionId,
                contextPromptTokens = estimatedPromptTokens,
                triggerPromptTokens = config.Compaction.TriggerPromptTokens,
                affectedMessageCount = affectedMessageIds.Count,
                rangeStartMessageId,
                rangeEndMessageId
            },
            cancellationToken
        );

        var response = await _openAiClient.CompactAsync(
            compactionSelection,
            compactionInputItems,
            resolvedInstructions,
            promptCacheRequest,
            cancellationToken
        );
        await ApplyRateLimitsAsync(compactionModel, resolvedServiceTier: null, response.RateLimits, cancellationToken);

        await _stateLock.WaitAsync(cancellationToken);
        try
        {
            session = GetOrCreatePageSessionLocked(session.PageKey, session.PageUrlSample);
            var promptCacheUsage = PromptCaching.ReadUsage(response.Document.RootElement);
            var compactedItems = GetOutputItemsAsJsonStrings(response.Document.RootElement);
            var resultPreviewText = BuildCompactionResultPreview(compactedItems);
            session.CanonicalContextJsonItems = MergeCanonicalContext(compactedItems, preservedTailItems);
            session.CompactionPassCount += 1;
            PromptCaching.RecordUsage(session, promptCacheRequest, promptCacheUsage, NowIso());
            session.LastCheckpointAt = NowIso();

            var persistedRequestMessage = session.Messages.FirstOrDefault(message => message.Id == compactionRequestMessage!.Id);
            if (persistedRequestMessage is not null)
            {
                persistedRequestMessage.State = "completed";
                persistedRequestMessage.Summary = $"Compacting {affectedMessageIds.Count} messages.";
                persistedRequestMessage.Meta = new AiCompactionRequestMeta
                {
                    CompactionId = compactionId,
                    AffectedMessageIds = [.. affectedMessageIds],
                    RangeStartMessageId = rangeStartMessageId,
                    RangeEndMessageId = rangeEndMessageId,
                    InstructionsText = resolvedInstructions
                };
            }

            MarkMessagesCompacted(session, affectedMessageIds, compactionId);

            var compactionResultMessage = new AiChatMessageRecord
            {
                PageKey = session.PageKey,
                RequestId = activeItem.RequestId,
                Origin = "system",
                Role = "system",
                Kind = "compaction-result",
                Text = "Context compaction completed.",
                Summary = $"Compacted into {compactedItems.Count} items, preserved tail {preservedTailItems.Count}.",
                State = "completed",
                Meta = new AiCompactionResultMeta
                {
                    CompactionId = compactionId,
                    AffectedMessageIds = [.. affectedMessageIds],
                    RangeStartMessageId = rangeStartMessageId,
                    RangeEndMessageId = rangeEndMessageId,
                    ResultPreviewText = resultPreviewText,
                    CompactedItemCount = compactedItems.Count,
                    PreservedTailCount = preservedTailItems.Count
                }
            };
            session.Messages.Add(compactionResultMessage);

            await _stateStore.SaveAsync(_journal, cancellationToken);

            await EmitAiEventAsync(
                "ai.chat.compaction.completed",
                "AI context compaction completed.",
                session,
                cancellationToken,
                details: new
                {
                    compactionId,
                    affectedMessageCount = affectedMessageIds.Count,
                    rangeStartMessageId,
                    rangeEndMessageId,
                    compactedItemCount = compactedItems.Count,
                    preservedTailCount = preservedTailItems.Count,
                    promptCaching = BuildPromptCacheTelemetryDetails(session, promptCacheRequest.FallbackReason)
                },
                messageRecord: compactionResultMessage
            );

            await EmitLogAsync(
                "info",
                "ai.chat.compaction.completed",
                "AI context compaction completed.",
                new
                {
                    pageKey = session.PageKey,
                    requestId = activeItem.RequestId,
                    compactionId,
                    affectedMessageCount = affectedMessageIds.Count,
                    rangeStartMessageId,
                    rangeEndMessageId,
                    compactedItemCount = compactedItems.Count,
                    preservedTailCount = preservedTailItems.Count,
                    resultPreviewText,
                    promptCaching = BuildPromptCacheTelemetryDetails(session, promptCacheRequest.FallbackReason)
                },
                cancellationToken
            );
        }
        finally
        {
            _stateLock.Release();
        }
    }

    private async Task<bool> TryBlockActiveItemByRateLimitAsync(
        string pageKey,
        AiQueueItemRecord activeItem,
        string? modelId,
        int estimatedTokenCost,
        CancellationToken cancellationToken
    )
    {
        await _stateLock.WaitAsync(cancellationToken);
        try
        {
            if (!TryGetRateLimitBlockInfoLocked(modelId, estimatedTokenCost, out var blockInfo) || blockInfo is null)
            {
                return false;
            }

            var session = GetOrCreatePageSessionLocked(pageKey, pageUrl: null);
            session.ActiveItem = null;
            activeItem.State = "blocked";
            activeItem.ModelId = null;
            session.RetryableItem = activeItem;
            session.RequestState = "blocked";
            session.LastError = "rate_limit_blocked";
            session.Recoverable = true;
            session.LastCheckpointAt = NowIso();

            await _stateStore.SaveAsync(_journal, cancellationToken);
            await EmitAiEventAsync(
                "ai.chat.status",
                "AI request blocked by current model rate limits.",
                session,
                cancellationToken,
                details: new
                {
                    code = "rate_limit_blocked",
                    model = blockInfo.Model,
                    remainingRequests = blockInfo.Budget.ServerRemainingRequests,
                    remainingTokens = blockInfo.Budget.ServerRemainingTokens,
                    resetRequests = blockInfo.Budget.ServerResetRequests,
                    resetTokens = blockInfo.Budget.ServerResetTokens
                },
                level: "warn"
            );

            await EmitLogAsync(
                "warn",
                "ai.chat.rate_limit_blocked",
                "AI request blocked by current model rate limits.",
                new
                {
                    pageKey,
                    requestId = activeItem.RequestId,
                    code = "rate_limit_blocked",
                    model = blockInfo.Model,
                    remainingRequests = blockInfo.Budget.ServerRemainingRequests,
                    remainingTokens = blockInfo.Budget.ServerRemainingTokens,
                    resetRequests = blockInfo.Budget.ServerResetRequests,
                    resetTokens = blockInfo.Budget.ServerResetTokens
                },
                cancellationToken
            );

            return true;
        }
        finally
        {
            _stateLock.Release();
        }
    }

    private bool TryGetRateLimitBlockInfoLocked(
        string? modelId,
        int estimatedTokenCost,
        out RateLimitBlockInfo? blockInfo
    )
    {
        blockInfo = null;
        var budget = GetModelBudgetLocked(modelId);
        if (budget is null)
        {
            return false;
        }

        var requestBlocked = budget.ServerRemainingRequests is <= 0;
        var tokenBlocked = budget.ServerRemainingTokens is int remainingTokens && remainingTokens < estimatedTokenCost;
        if (!requestBlocked && !tokenBlocked)
        {
            return false;
        }

        blockInfo = new RateLimitBlockInfo(budget.Model, budget);
        return true;
    }

    private bool NeedsTpmHeadroom(int estimatedTokenCost)
    {
        var budget = GetModelBudgetLocked(GetConfiguredModelId(_journal.AiConfig.Chat.Model));
        return budget?.ServerRemainingTokens is int remainingTokens &&
               remainingTokens >= 0 &&
               estimatedTokenCost > remainingTokens;
    }

    private async Task ApplyRateLimitsAsync(
        string? modelId,
        string? resolvedServiceTier,
        AiRateLimitSnapshot snapshot,
        CancellationToken cancellationToken
    )
    {
        if (string.IsNullOrWhiteSpace(modelId))
        {
            return;
        }

        await _stateLock.WaitAsync(cancellationToken);
        try
        {
            var hasSnapshotData = HasRateLimitData(snapshot);
            var normalizedModelKey = NormalizeModelKey(modelId);
            if (!_journal.ModelBudgets.TryGetValue(normalizedModelKey, out var budget))
            {
                budget = new AiModelBudgetState
                {
                    Model = modelId
                };
                _journal.ModelBudgets[normalizedModelKey] = budget;
            }

            budget.Model = modelId;
            if (hasSnapshotData)
            {
                budget.ServerLimitRequests = snapshot.ServerLimitRequests ?? budget.ServerLimitRequests;
                budget.ServerLimitTokens = snapshot.ServerLimitTokens ?? budget.ServerLimitTokens;
                budget.ServerRemainingRequests = snapshot.ServerRemainingRequests ?? budget.ServerRemainingRequests;
                budget.ServerRemainingTokens = snapshot.ServerRemainingTokens ?? budget.ServerRemainingTokens;
                budget.ServerResetRequests = !string.IsNullOrWhiteSpace(snapshot.ServerResetRequests)
                    ? snapshot.ServerResetRequests
                    : budget.ServerResetRequests;
                budget.ServerResetTokens = !string.IsNullOrWhiteSpace(snapshot.ServerResetTokens)
                    ? snapshot.ServerResetTokens
                    : budget.ServerResetTokens;
                budget.ObservedAt = NowIso();
            }

            if (!string.IsNullOrWhiteSpace(resolvedServiceTier))
            {
                budget.LastResolvedServiceTier = resolvedServiceTier;
                if (budget.ObservedAt is null)
                {
                    budget.ObservedAt = NowIso();
                }
            }

            if (hasSnapshotData || !string.IsNullOrWhiteSpace(resolvedServiceTier))
            {
                await _stateStore.SaveAsync(_journal, cancellationToken);
            }
        }
        finally
        {
            _stateLock.Release();
        }
    }

    private async Task EnsureCurrentModelBudgetTelemetryAsync(CancellationToken cancellationToken)
    {
        AiModelSelection? selection;

        await _stateLock.WaitAsync(cancellationToken);
        try
        {
            selection = NormalizeModelSelection(_journal.AiConfig.Chat.Model);
            if (selection is null || !_openAiClient.HasApiKey || !ShouldRefreshModelBudgetLocked(selection))
            {
                return;
            }
        }
        finally
        {
            _stateLock.Release();
        }

        try
        {
            var snapshot = await _openAiClient.ProbeRateLimitsAsync(selection, cancellationToken);
            await ApplyRateLimitsAsync(selection.Model, resolvedServiceTier: null, snapshot, cancellationToken);
            await EmitLogAsync(
                "debug",
                "ai.rate_limits.probe",
                "Refreshed OpenAI rate-limit telemetry for the configured model.",
                new
                {
                    model = selection.Model,
                    tier = selection.Tier,
                    snapshot = BuildAiRateLimitPayload(snapshot)
                },
                cancellationToken
            );
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception error)
        {
            await EmitLogAsync(
                "warn",
                "ai.rate_limits.probe.failed",
                "Failed to refresh OpenAI rate-limit telemetry.",
                new
                {
                    model = selection.Model,
                    tier = selection.Tier,
                    error = error.Message
                },
                cancellationToken
            );
        }
    }

    private AiModelBudgetState? GetModelBudgetLocked(string? modelId)
    {
        if (string.IsNullOrWhiteSpace(modelId))
        {
            return null;
        }

        _journal.ModelBudgets.TryGetValue(NormalizeModelKey(modelId), out var budget);
        return budget;
    }

    private bool ShouldRefreshModelBudgetLocked(AiModelSelection selection)
    {
        var budget = GetModelBudgetLocked(selection.Model);
        if (budget is null || !HasRateLimitData(budget))
        {
            return true;
        }

        var observedAt = ParseTimestamp(budget.ObservedAt);
        if (observedAt is null)
        {
            return true;
        }

        var refreshAfter = ParseResetDuration(budget.ServerResetRequests);
        if (refreshAfter <= TimeSpan.Zero)
        {
            refreshAfter = ParseResetDuration(budget.ServerResetTokens);
        }

        if (refreshAfter <= TimeSpan.Zero)
        {
            refreshAfter = TimeSpan.FromMinutes(1);
        }

        return DateTimeOffset.UtcNow >= observedAt.Value.Add(refreshAfter);
    }

    private static bool HasRateLimitData(AiRateLimitSnapshot snapshot) =>
        snapshot.ServerLimitRequests is not null ||
        snapshot.ServerLimitTokens is not null ||
        snapshot.ServerRemainingRequests is not null ||
        snapshot.ServerRemainingTokens is not null ||
        !string.IsNullOrWhiteSpace(snapshot.ServerResetRequests) ||
        !string.IsNullOrWhiteSpace(snapshot.ServerResetTokens);

    private void UpdateModelBudgetResolvedTierLocked(string? modelId, string resolvedServiceTier)
    {
        var budget = GetModelBudgetLocked(modelId);
        if (budget is null)
        {
            return;
        }

        budget.LastResolvedServiceTier = resolvedServiceTier;
        budget.ObservedAt = NowIso();
    }

    private AiPageSessionRecord FindPageSession(string pageKey)
    {
        _stateLock.Wait();
        try
        {
            return GetOrCreatePageSessionLocked(pageKey, pageUrl: null);
        }
        finally
        {
            _stateLock.Release();
        }
    }

    private AiPageSessionRecord? FindPageSessionLocked(string pageKey) =>
        _journal.AiSessions.FirstOrDefault(session => session.PageKey == pageKey);

    private AiPageSessionRecord GetOrCreatePageSessionLocked(string pageKey, string? pageUrl)
    {
        var session = FindPageSessionLocked(pageKey);
        if (session is not null)
        {
            NormalizeSessionState(session);
            if (!string.IsNullOrWhiteSpace(pageUrl))
            {
                session.PageUrlSample = pageUrl;
            }
            return session;
        }

        session = new AiPageSessionRecord
        {
            PageKey = pageKey,
            PageUrlSample = pageUrl
        };
        NormalizeSessionState(session);
        _journal.AiSessions.Add(session);
        return session;
    }

    internal static int GetVisibleQueueCount(AiPageSessionRecord session)
    {
        var retryableCount = session.RetryableItem is null ? 0 : 1;
        return retryableCount + session.PendingQueue.Count;
    }

    internal static int GetQueuedWorkCount(AiPageSessionRecord session)
    {
        var activeCount = session.ActiveItem is null ? 0 : 1;
        return activeCount + GetVisibleQueueCount(session);
    }

    internal static bool TryTakeNextPendingQueueItemForExecution(
        AiPageSessionRecord session,
        DateTimeOffset now,
        out AiQueueItemRecord? activeItem,
        out DateTimeOffset? nextRetryAt
    )
    {
        activeItem = null;
        nextRetryAt = null;

        if (session.PendingQueue.Count == 0)
        {
            return false;
        }

        var candidate = session.PendingQueue[0];
        nextRetryAt = GetQueueItemNotBeforeAt(candidate);
        if (nextRetryAt is not null && nextRetryAt > now)
        {
            return false;
        }

        session.PendingQueue.RemoveAt(0);
        candidate.NotBeforeAt = null;
        activeItem = candidate;
        return true;
    }

    private int GetVisibleQueueCountLocked(AiPageSessionRecord session) => GetVisibleQueueCount(session);

    private int GetSessionQueuedWorkCountLocked(AiPageSessionRecord session) => GetQueuedWorkCount(session);

    private int GetGlobalQueuedWorkCountLocked() =>
        _journal.AiSessions.Sum(GetQueuedWorkCount);

    private AiQueueItemRecord[] GetQueueSnapshot(AiPageSessionRecord session)
    {
        var queue = new List<AiQueueItemRecord>();
        if (session.RetryableItem is not null)
        {
            queue.Add(session.RetryableItem);
        }

        foreach (var item in session.PendingQueue)
        {
            if (item is not null)
            {
                queue.Add(item);
            }
        }
        return queue.ToArray();
    }

    private static void ActivateQueuedItem(AiPageSessionRecord session, AiQueueItemRecord activeItem)
    {
        session.ActiveItem = activeItem;
        activeItem.State = "running";
        if (string.IsNullOrWhiteSpace(activeItem.OpenAiResponseId))
        {
            activeItem.ModelId = null;
        }
        activeItem.AttemptCount += 1;
        MarkMessageState(session, activeItem.UserMessageId, "completed");
    }

    private static TimeSpan GetWaitDelay(DateTimeOffset? nextRetryAt)
    {
        var fallbackDelay = TimeSpan.FromMilliseconds(250);
        if (nextRetryAt is null)
        {
            return fallbackDelay;
        }

        var delay = nextRetryAt.Value - DateTimeOffset.UtcNow;
        return delay > TimeSpan.Zero ? delay : fallbackDelay;
    }

    private static string? GetSessionNextRetryAt(AiPageSessionRecord session) =>
        NormalizeOptionalIsoTimestamp(session.PendingQueue.FirstOrDefault(item => item is not null && GetQueueItemNotBeforeAt(item) is not null)?.NotBeforeAt);

    private AiChatMessageRecord EnsureAssistantDraftMessage(AiPageSessionRecord session, AiQueueItemRecord activeItem)
    {
        if (!string.IsNullOrWhiteSpace(activeItem.AssistantMessageId))
        {
            var existing = session.Messages.FirstOrDefault(message => message.Id == activeItem.AssistantMessageId);
            if (existing is not null)
            {
                return existing;
            }
        }

        var assistantMessage = new AiChatMessageRecord
        {
            PageKey = session.PageKey,
            RequestId = activeItem.RequestId,
            Origin = "assistant",
            Role = "assistant",
            Kind = "assistant",
            Text = string.Empty,
            State = _journal.AiConfig.Chat.StreamingEnabled ? "streaming" : "pending"
        };
        session.Messages.Add(assistantMessage);
        activeItem.AssistantMessageId = assistantMessage.Id;
        return assistantMessage;
    }

    private static void MarkMessageState(AiPageSessionRecord session, string messageId, string state)
    {
        var message = session.Messages.FirstOrDefault(candidate => candidate.Id == messageId);
        if (message is not null)
        {
            message.State = state;
        }
    }

    private List<string> BuildInputItemsForRequest(AiPageSessionRecord session, AiQueueItemRecord activeItem)
    {
        var inputItems = new List<string>(session.CanonicalContextJsonItems);
        inputItems.Add(SerializeUserMessageInputJson(activeItem.Origin, activeItem.Text));
        return inputItems;
    }

    private static string SerializeUserMessageInputJson(string _origin, string text) =>
        SerializeCanonicalContextJson(new
        {
            type = "message",
            role = "user",
            content = new[]
            {
                new
                {
                    type = "input_text",
                    text
                }
            }
        });

    private static string SerializeAssistantMessageOutputJson(string text) =>
        SerializeCanonicalContextJson(new
        {
            type = "message",
            role = "assistant",
            content = new[]
            {
                new
                {
                    type = "output_text",
                    text
                }
            }
        });

    private static string SerializeCanonicalContextJson(object value) =>
        JsonSerializer.Serialize(value, CanonicalContextJsonSerializerOptions);

    internal static List<string> NormalizeCanonicalContextJsonItems(IEnumerable<string> items)
    {
        var normalized = new List<string>();
        foreach (var item in items)
        {
            var normalizedItem = NormalizeCanonicalContextItemJson(item);
            if (!string.IsNullOrWhiteSpace(normalizedItem) &&
                !normalized.Contains(normalizedItem, StringComparer.Ordinal))
            {
                normalized.Add(normalizedItem);
            }
        }

        return normalized;
    }

    internal static string NormalizeCanonicalContextItemJson(string itemJson)
    {
        if (string.IsNullOrWhiteSpace(itemJson))
        {
            return string.Empty;
        }

        try
        {
            using var itemDocument = JsonDocument.Parse(itemJson);
            return NormalizeCanonicalContextItemJson(itemDocument.RootElement);
        }
        catch (JsonException)
        {
            return itemJson.Trim();
        }
    }

    private static string NormalizeCanonicalContextItemJson(JsonElement itemElement)
    {
        var type = GetOptionalString(itemElement, "type");
        return type switch
        {
            "message" => NormalizeCanonicalMessageItemJson(itemElement),
            "compaction" => NormalizeCanonicalCompactionItemJson(itemElement),
            _ => JsonSerializer.Serialize(itemElement, CanonicalContextJsonSerializerOptions)
        };
    }

    private static string NormalizeCanonicalMessageItemJson(JsonElement itemElement)
    {
        var normalizedContent = new List<Dictionary<string, object?>>();
        if (itemElement.TryGetProperty("content", out var contentProperty) && contentProperty.ValueKind == JsonValueKind.Array)
        {
            foreach (var contentItem in contentProperty.EnumerateArray())
            {
                var contentType = GetOptionalString(contentItem, "type");
                if (string.IsNullOrWhiteSpace(contentType))
                {
                    continue;
                }

                var normalizedContentItem = new Dictionary<string, object?>
                {
                    ["type"] = contentType
                };

                var text = GetOptionalString(contentItem, "text");
                if (text is not null)
                {
                    normalizedContentItem["text"] = text;
                }

                normalizedContent.Add(normalizedContentItem);
            }
        }

        return SerializeCanonicalContextJson(new
        {
            type = "message",
            role = GetOptionalString(itemElement, "role") ?? "assistant",
            content = normalizedContent
        });
    }

    private static string NormalizeCanonicalCompactionItemJson(JsonElement itemElement) =>
        SerializeCanonicalContextJson(new
        {
            type = "compaction",
            encrypted_content = GetOptionalString(itemElement, "encrypted_content") ?? string.Empty
        });

    private static List<string> MergeCanonicalContext(
        IReadOnlyList<string> compactedItems,
        IReadOnlyList<string> preservedTailItems
    )
    {
        var merged = new List<string>();
        foreach (var item in compactedItems.Concat(preservedTailItems))
        {
            if (!merged.Contains(item, StringComparer.Ordinal))
            {
                merged.Add(item);
            }
        }

        return merged;
    }

    internal static List<AiChatMessageRecord> GetCompactionEligibleMessages(AiPageSessionRecord session) =>
        session.Messages
            .Where(message =>
                message.State == "completed" &&
                message.Kind is "user" or "assistant" or "code" &&
                GetMessageCompactedBy(message) is null)
            .ToList();

    internal static List<AiChatMessageRecord> GetCompactionAffectedMessages(AiPageSessionRecord session, int preserveRecentTurns)
    {
        var eligibleMessages = GetCompactionEligibleMessages(session);
        var preservedTailCount = GetCompactionPreservedTailCount(eligibleMessages.Count, preserveRecentTurns);
        var affectedCount = Math.Max(0, eligibleMessages.Count - preservedTailCount);
        return eligibleMessages.Take(affectedCount).ToList();
    }

    internal static string? GetMessageCompactedBy(AiChatMessageRecord message)
    {
        if (message.Meta is AiCompactedMessageMeta typedMeta && !string.IsNullOrWhiteSpace(typedMeta.CompactedBy))
        {
            return typedMeta.CompactedBy;
        }

        if (message.Meta is JsonElement metaElement &&
            metaElement.ValueKind == JsonValueKind.Object &&
            metaElement.TryGetProperty("compactedBy", out var compactedByProperty) &&
            compactedByProperty.ValueKind == JsonValueKind.String)
        {
            var compactedBy = compactedByProperty.GetString();
            return string.IsNullOrWhiteSpace(compactedBy) ? null : compactedBy;
        }

        return null;
    }

    private static void MarkMessagesCompacted(
        AiPageSessionRecord session,
        IReadOnlyCollection<string> affectedMessageIds,
        string compactionId
    )
    {
        if (affectedMessageIds.Count == 0)
        {
            return;
        }

        var idSet = new HashSet<string>(affectedMessageIds, StringComparer.Ordinal);
        foreach (var message in session.Messages)
        {
            if (idSet.Contains(message.Id))
            {
                message.Meta = new AiCompactedMessageMeta
                {
                    CompactedBy = compactionId
                };
            }
        }
    }

    private static List<string> GetPreservedTailContextJson(AiPageSessionRecord session, int preserveRecentTurns)
    {
        if (preserveRecentTurns <= 0)
        {
            return [];
        }

        return GetCompactionEligibleMessages(session)
            .TakeLast(Math.Max(1, preserveRecentTurns * 2))
            .Select(message => message.Role == "assistant"
                ? SerializeAssistantMessageOutputJson(message.Text)
                : SerializeUserMessageInputJson(message.Origin, message.Text))
            .ToList();
    }

    internal static List<string> GetCompactionInputItems(AiPageSessionRecord session, int preserveRecentTurns) =>
        GetCompactionInputItems(session, GetPreservedTailContextJson(session, preserveRecentTurns));

    private static List<string> GetCompactionInputItems(
        AiPageSessionRecord session,
        IReadOnlyList<string> preservedTailItems
    )
    {
        var inputItems = new List<string>(session.CanonicalContextJsonItems);
        foreach (var preservedTailItem in preservedTailItems)
        {
            var index = FindLastIndex(inputItems, preservedTailItem);
            if (index >= 0)
            {
                inputItems.RemoveAt(index);
            }
        }

        return inputItems;
    }

    private static int FindLastIndex(IReadOnlyList<string> items, string value)
    {
        for (var index = items.Count - 1; index >= 0; index--)
        {
            if (string.Equals(items[index], value, StringComparison.Ordinal))
            {
                return index;
            }
        }

        return -1;
    }

    private int EstimateBudgetTokenCost(AiPageSessionRecord session, string pendingText)
    {
        return ApplyReserveOutputTokens(
            EstimateCompactionPromptTokenCost(session, pendingText),
            _journal.AiConfig.RateLimits.ReserveOutputTokens
        );
    }

    private int EstimateCompactionPromptTokenCost(AiPageSessionRecord session, string pendingText) =>
        EstimatePromptTokenCost(session.CanonicalContextJsonItems, pendingText, _journal.AiConfig.Chat.Instructions);

    internal static int EstimatePromptTokenCost(
        IEnumerable<string> canonicalContextJsonItems,
        string pendingText,
        string instructions
    )
    {
        var promptBytes = canonicalContextJsonItems.Sum(item => item.Length) +
                          pendingText.Length +
                          instructions.Length;
        return promptBytes <= 0 ? 0 : (int)Math.Ceiling(promptBytes / 4.0);
    }

    internal static int ApplyReserveOutputTokens(int promptTokens, int reserveOutputTokens) =>
        promptTokens + reserveOutputTokens;

    internal static int EstimateStatusContextPromptTokens(AiPageSessionRecord session, string instructions)
    {
        var pendingText = session.ActiveItem?.Text ??
                          session.RetryableItem?.Text ??
                          session.PendingQueue.FirstOrDefault()?.Text ??
                          string.Empty;
        return EstimatePromptTokenCost(session.CanonicalContextJsonItems, pendingText, instructions);
    }

    private static string ResolveCompactionInstructions(AiRuntimeConfig config) =>
        AiCompactionDefaults.ResolveInstructions(config.Compaction.Instructions);

    private static List<string> GetOutputItemsAsJsonStrings(JsonElement responseElement)
    {
        var outputItems = new List<string>();
        if (responseElement.TryGetProperty("output", out var outputProperty) && outputProperty.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in outputProperty.EnumerateArray())
            {
                outputItems.Add(NormalizeCanonicalContextItemJson(item));
            }
        }

        return NormalizeCanonicalContextJsonItems(outputItems);
    }

    internal static string BuildCompactionResultPreview(IReadOnlyList<string> compactedItems)
    {
        if (compactedItems.Count == 0)
        {
            return string.Empty;
        }

        var textParts = new List<string>();
        foreach (var itemJson in compactedItems)
        {
            try
            {
                using var itemDocument = JsonDocument.Parse(itemJson);
                var text = ExtractOutputItemText(itemDocument.RootElement);
                if (!string.IsNullOrWhiteSpace(text))
                {
                    textParts.Add(text.Trim());
                }
            }
            catch (JsonException)
            {
                // Fall back to JSON preview below.
            }
        }

        if (textParts.Count > 0)
        {
            return TrimPreviewText(string.Join(Environment.NewLine + Environment.NewLine, textParts), 1600);
        }

        var prettyJsonItems = compactedItems
            .Take(3)
            .Select(itemJson =>
            {
                try
                {
                    using var itemDocument = JsonDocument.Parse(itemJson);
                    return JsonSerializer.Serialize(itemDocument.RootElement, new JsonSerializerOptions
                    {
                        WriteIndented = true
                    });
                }
                catch (JsonException)
                {
                    return itemJson;
                }
            });

        return TrimPreviewText(string.Join(Environment.NewLine + Environment.NewLine, prettyJsonItems), 1600);
    }

    private static string ExtractAssistantText(JsonElement responseElement)
    {
        if (!responseElement.TryGetProperty("output", out var outputProperty) || outputProperty.ValueKind != JsonValueKind.Array)
        {
            return string.Empty;
        }

        var parts = new List<string>();
        foreach (var item in outputProperty.EnumerateArray())
        {
            if (GetOptionalString(item, "role") != "assistant")
            {
                continue;
            }

            if (!item.TryGetProperty("content", out var contentProperty) || contentProperty.ValueKind != JsonValueKind.Array)
            {
                continue;
            }

            foreach (var contentItem in contentProperty.EnumerateArray())
            {
                var text = GetOptionalString(contentItem, "text");
                if (!string.IsNullOrWhiteSpace(text))
                {
                    parts.Add(text);
                }
            }
        }

        return string.Concat(parts);
    }

    private static int GetCompactionPreservedTailCount(int eligibleMessageCount, int preserveRecentTurns)
    {
        if (eligibleMessageCount <= 0 || preserveRecentTurns <= 0)
        {
            return 0;
        }

        return Math.Min(eligibleMessageCount, Math.Max(1, preserveRecentTurns * 2));
    }

    private static string ExtractOutputItemText(JsonElement outputItem)
    {
        if (!outputItem.TryGetProperty("content", out var contentProperty) || contentProperty.ValueKind != JsonValueKind.Array)
        {
            return string.Empty;
        }

        var parts = new List<string>();
        foreach (var contentItem in contentProperty.EnumerateArray())
        {
            var text = GetOptionalString(contentItem, "text");
            if (!string.IsNullOrWhiteSpace(text))
            {
                parts.Add(text);
            }
        }

        return string.Join(Environment.NewLine, parts);
    }

    private static string TrimPreviewText(string text, int maxLength)
    {
        var normalized = text.Trim();
        if (normalized.Length <= maxLength)
        {
            return normalized;
        }

        return $"{normalized[..Math.Max(0, maxLength - 3)]}...";
    }

    private static string? GetResponseId(JsonElement responseElement) =>
        responseElement.ValueKind == JsonValueKind.Object ? GetOptionalString(responseElement, "id") : null;

    private static string GetResponseStatus(JsonElement responseElement) =>
        responseElement.ValueKind == JsonValueKind.Object
            ? GetOptionalString(responseElement, "status") ?? "unknown"
            : "unknown";

    private static int? GetTotalTokens(JsonElement responseElement)
    {
        if (!responseElement.TryGetProperty("usage", out var usageProperty) || usageProperty.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        return GetOptionalInt(usageProperty, "total_tokens");
    }

    private static string? GetResponseServiceTier(JsonElement responseElement) =>
        responseElement.ValueKind == JsonValueKind.Object ? GetOptionalString(responseElement, "service_tier") : null;

    private static JsonElement? GetOptionalElement(JsonElement payload, string propertyName)
    {
        if (payload.ValueKind == JsonValueKind.Object && payload.TryGetProperty(propertyName, out var property))
        {
            return property;
        }

        return null;
    }

    private static void ApplyAiConfig(HostJournal journal, OpenAiClient openAiClient, JsonElement payload)
    {
        if (payload.ValueKind != JsonValueKind.Object || !payload.TryGetProperty("config", out var configElement))
        {
            return;
        }

        if (!configElement.TryGetProperty("ai", out var aiElement) || aiElement.ValueKind != JsonValueKind.Object)
        {
            return;
        }

        if (aiElement.TryGetProperty("openAiApiKey", out var openAiApiKeyElement))
        {
            if (openAiApiKeyElement.ValueKind == JsonValueKind.String)
            {
                openAiClient.ConfigureManagedApiKey(openAiApiKeyElement.GetString());
            }
            else if (openAiApiKeyElement.ValueKind == JsonValueKind.Null)
            {
                openAiClient.ReloadApiKeyFromEnvironment();
            }
        }

        if (aiElement.TryGetProperty("chat", out var chatElement) && chatElement.ValueKind == JsonValueKind.Object)
        {
            if (chatElement.TryGetProperty("model", out var chatModelElement))
            {
                journal.AiConfig.Chat.Model = chatModelElement.ValueKind == JsonValueKind.Null
                    ? null
                    : GetOptionalModelSelection(chatElement, "model") ?? journal.AiConfig.Chat.Model;
            }
            journal.AiConfig.Chat.StreamingEnabled = GetOptionalBoolean(chatElement, "streamingEnabled") ?? journal.AiConfig.Chat.StreamingEnabled;
            journal.AiConfig.Chat.Instructions = GetOptionalString(chatElement, "instructions") ?? journal.AiConfig.Chat.Instructions;
            if (chatElement.TryGetProperty("structuredOutput", out var structuredOutputElement) && structuredOutputElement.ValueKind == JsonValueKind.Object)
            {
                journal.AiConfig.Chat.StructuredOutput.Name = GetOptionalString(structuredOutputElement, "name") ?? journal.AiConfig.Chat.StructuredOutput.Name;
                journal.AiConfig.Chat.StructuredOutput.Description = GetOptionalString(structuredOutputElement, "description") ?? journal.AiConfig.Chat.StructuredOutput.Description;
                journal.AiConfig.Chat.StructuredOutput.Schema = GetOptionalString(structuredOutputElement, "schema") ?? journal.AiConfig.Chat.StructuredOutput.Schema;
                journal.AiConfig.Chat.StructuredOutput.Strict = GetOptionalBoolean(structuredOutputElement, "strict") ?? journal.AiConfig.Chat.StructuredOutput.Strict;
            }
        }
        else
        {
            if (aiElement.TryGetProperty("model", out var legacyChatModelElement))
            {
                journal.AiConfig.Chat.Model = legacyChatModelElement.ValueKind == JsonValueKind.Null
                    ? null
                    : GetOptionalModelSelection(aiElement, "model") ?? journal.AiConfig.Chat.Model;
            }
            journal.AiConfig.Chat.StreamingEnabled = GetOptionalBoolean(aiElement, "streamingEnabled") ?? journal.AiConfig.Chat.StreamingEnabled;
            journal.AiConfig.Chat.Instructions = GetOptionalString(aiElement, "instructions") ?? journal.AiConfig.Chat.Instructions;
        }

        if (aiElement.TryGetProperty("compaction", out var compactionElement) && compactionElement.ValueKind == JsonValueKind.Object)
        {
            journal.AiConfig.Compaction.Enabled = GetOptionalBoolean(compactionElement, "enabled") ?? journal.AiConfig.Compaction.Enabled;
            journal.AiConfig.Compaction.StreamingEnabled = GetOptionalBoolean(compactionElement, "streamingEnabled") ?? journal.AiConfig.Compaction.StreamingEnabled;
            if (compactionElement.TryGetProperty("modelOverride", out var modelOverrideElement))
            {
                journal.AiConfig.Compaction.ModelOverride = modelOverrideElement.ValueKind == JsonValueKind.Null
                    ? null
                    : GetOptionalModelSelection(compactionElement, "modelOverride") ?? journal.AiConfig.Compaction.ModelOverride;
            }
            var compactionInstructions = GetOptionalString(compactionElement, "instructions");
            if (compactionInstructions is not null)
            {
                journal.AiConfig.Compaction.Instructions = AiCompactionDefaults.ResolveInstructions(compactionInstructions);
            }
            journal.AiConfig.Compaction.TriggerPromptTokens = GetOptionalInt(compactionElement, "triggerPromptTokens") ?? journal.AiConfig.Compaction.TriggerPromptTokens;
            journal.AiConfig.Compaction.PreserveRecentTurns = GetOptionalInt(compactionElement, "preserveRecentTurns") ?? journal.AiConfig.Compaction.PreserveRecentTurns;
            journal.AiConfig.Compaction.MaxPassesPerPage = GetOptionalInt(compactionElement, "maxPassesPerPage") ?? journal.AiConfig.Compaction.MaxPassesPerPage;
        }

        if (aiElement.TryGetProperty("promptCaching", out var promptCachingElement) && promptCachingElement.ValueKind == JsonValueKind.Object)
        {
            journal.AiConfig.PromptCaching.Routing = PromptCaching.NormalizeRouting(
                GetOptionalString(promptCachingElement, "routing") ?? journal.AiConfig.PromptCaching.Routing
            );
            journal.AiConfig.PromptCaching.Retention = PromptCaching.NormalizeRetention(
                GetOptionalString(promptCachingElement, "retention") ?? journal.AiConfig.PromptCaching.Retention
            );
        }

        if (aiElement.TryGetProperty("retries", out var retriesElement) && retriesElement.ValueKind == JsonValueKind.Object)
        {
            journal.AiConfig.Retries.MaxRetries = GetOptionalInt(retriesElement, "maxRetries") ?? journal.AiConfig.Retries.MaxRetries;
            journal.AiConfig.Retries.BaseDelayMs = GetOptionalInt(retriesElement, "baseDelayMs") ?? journal.AiConfig.Retries.BaseDelayMs;
            journal.AiConfig.Retries.MaxDelayMs = GetOptionalInt(retriesElement, "maxDelayMs") ?? journal.AiConfig.Retries.MaxDelayMs;
        }

        if (aiElement.TryGetProperty("rateLimits", out var rateLimitElement) && rateLimitElement.ValueKind == JsonValueKind.Object)
        {
            journal.AiConfig.RateLimits.ReserveOutputTokens = GetOptionalInt(rateLimitElement, "reserveOutputTokens") ?? journal.AiConfig.RateLimits.ReserveOutputTokens;
            journal.AiConfig.RateLimits.MaxQueuedPerPage = GetOptionalInt(rateLimitElement, "maxQueuedPerPage") ?? journal.AiConfig.RateLimits.MaxQueuedPerPage;
            journal.AiConfig.RateLimits.MaxQueuedGlobal = GetOptionalInt(rateLimitElement, "maxQueuedGlobal") ?? journal.AiConfig.RateLimits.MaxQueuedGlobal;
        }
    }

    private bool ShouldAutoResumeSession(AiPageSessionRecord session) =>
        session.ActiveItem is not null ||
        session.PendingQueue.Count > 0 ||
        session.RetryableItem?.State == "blocked" ||
        (!string.IsNullOrWhiteSpace(session.OpenAiResponseId) && session.RequestState is "running" or "streaming" or "queued");

    private async Task PersistSessionAsync(CancellationToken cancellationToken) =>
        await PersistJournalAsync(cancellationToken);

    private async Task PersistJournalAsync(CancellationToken cancellationToken)
    {
        await _stateLock.WaitAsync(cancellationToken);
        try
        {
            await _stateStore.SaveAsync(_journal, cancellationToken);
        }
        finally
        {
            _stateLock.Release();
        }
    }

    private object BuildAiSessionPayload(AiPageSessionRecord session)
    {
        var status = BuildAiStatusPayload(session);
        var queue = GetQueueSnapshot(session);
        return new
        {
            pageKey = session.PageKey,
            pageUrlSample = session.PageUrlSample,
            attachedViewIds = Array.Empty<string>(),
            state = session.RequestState,
            activeRequestId = session.ActiveItem?.RequestId,
            openaiResponseId = session.OpenAiResponseId,
            lastSequenceNumber = session.LastSequenceNumber,
            nextRetryAt = GetSessionNextRetryAt(session),
            queuedCount = queue.Length,
            recoverable = session.Recoverable,
            lastCheckpointAt = session.LastCheckpointAt,
            lastError = session.LastError,
            messages = session.Messages.Select(BuildAiMessagePayload).ToArray(),
            queue = queue.Select(BuildAiQueuePayload).ToArray(),
            status
        };
    }

    private async Task<object> CaptureAiSessionPayloadAsync(
        string pageKey,
        string? pageUrl,
        CancellationToken cancellationToken
    )
    {
        await _stateLock.WaitAsync(cancellationToken);
        try
        {
            var session = GetOrCreatePageSessionLocked(pageKey, pageUrl);
            return BuildAiSessionPayload(session);
        }
        finally
        {
            _stateLock.Release();
        }
    }

    private object BuildAiStatusPayload(AiPageSessionRecord session)
    {
        var currentModelSelection = NormalizeModelSelection(_journal.AiConfig.Chat.Model);
        var currentModel = GetConfiguredModelId(currentModelSelection);
        var currentModelBudget = GetModelBudgetLocked(currentModel);
        var modelBudgets = _journal.ModelBudgets.Values
            .OrderBy(entry => entry.Model, StringComparer.OrdinalIgnoreCase)
            .ToDictionary(
                entry => entry.Model,
                BuildAiModelBudgetPayload,
                StringComparer.OrdinalIgnoreCase
            );

        return new
        {
            provider = "openai",
            apiKeyPresent = _openAiClient.HasApiKey,
            model = BuildAiModelSelectionPayload(currentModelSelection),
            resolvedServiceTier = session.LastResolvedServiceTier,
            streamingEnabled = _journal.AiConfig.Chat.StreamingEnabled,
            structuredOutputEnabled = !string.IsNullOrWhiteSpace(_journal.AiConfig.Chat.StructuredOutput.Schema),
            structuredOutputName = string.IsNullOrWhiteSpace(_journal.AiConfig.Chat.StructuredOutput.Name)
                ? null
                : _journal.AiConfig.Chat.StructuredOutput.Name,
            structuredOutputStrict = _journal.AiConfig.Chat.StructuredOutput.Strict,
            requestState = session.RequestState,
            lastError = session.LastError,
            historyScope = "page",
            pageKey = session.PageKey,
            pageUrlSample = session.PageUrlSample,
            queueCount = GetVisibleQueueCountLocked(session),
            contextPromptTokens = EstimateStatusContextPromptTokens(session, _journal.AiConfig.Chat.Instructions),
            activeRequestId = session.ActiveItem?.RequestId,
            openaiResponseId = session.OpenAiResponseId,
            lastSequenceNumber = session.LastSequenceNumber,
            nextRetryAt = GetSessionNextRetryAt(session),
            recoverable = session.Recoverable,
            rateLimits = BuildAiRateLimitPayload(currentModelBudget),
            currentModelBudget = currentModelBudget is null ? null : BuildAiModelBudgetPayload(currentModelBudget),
            modelBudgets,
            promptCaching = BuildAiPromptCachingPayload(session),
            availableActions = new
            {
                canSend = _openAiClient.HasApiKey &&
                          !string.IsNullOrWhiteSpace(GetConfiguredModelId(_journal.AiConfig.Chat.Model)) &&
                          GetSessionQueuedWorkCountLocked(session) < _journal.AiConfig.RateLimits.MaxQueuedPerPage &&
                          GetGlobalQueuedWorkCountLocked() < _journal.AiConfig.RateLimits.MaxQueuedGlobal,
                canResume = session.RetryableItem is not null ||
                            (!string.IsNullOrWhiteSpace(session.OpenAiResponseId) && session.RequestState is "running" or "streaming" or "queued" or "paused" or "blocked"),
                canReset = session.Messages.Count > 0 ||
                           session.PendingQueue.Count > 0 ||
                           session.ActiveItem is not null ||
                           session.RetryableItem is not null
            }
        };
    }

    private static object BuildAiMessagePayload(AiChatMessageRecord message) => new
    {
        id = message.Id,
        pageKey = message.PageKey,
        requestId = message.RequestId,
        openaiResponseId = message.OpenAiResponseId,
        origin = message.Origin,
        role = message.Role,
        kind = message.Kind,
        text = message.Text,
        summary = message.Summary,
        ts = message.Ts,
        state = message.State,
        meta = message.Meta
    };

    private static object BuildAiQueuePayload(AiQueueItemRecord? item) => new
    {
        id = item?.Id ?? string.Empty,
        requestId = item?.RequestId ?? string.Empty,
        pageKey = item?.PageKey ?? string.Empty,
        origin = item?.Origin ?? "user",
        text = item?.Text ?? string.Empty,
        createdAt = item?.CreatedAt ?? DateTimeOffset.UtcNow.ToString("O"),
        state = item?.State ?? "queued",
        attemptCount = item?.AttemptCount ?? 0,
        nextRetryAt = NormalizeOptionalIsoTimestamp(item?.NotBeforeAt)
    };

    private static object? BuildPromptCacheTelemetryDetails(
        AiPageSessionRecord session,
        string? fallbackReason = null
    )
    {
        var lastRequest = session.PromptCaching?.LastRequest;
        if (lastRequest is null && string.IsNullOrWhiteSpace(fallbackReason))
        {
            return null;
        }

        return new
        {
            fallbackReason,
            lastRequest = lastRequest is null
                ? null
                : new
                {
                    source = lastRequest.Source,
                    promptTokens = lastRequest.PromptTokens,
                    cachedTokens = lastRequest.CachedTokens,
                    hitRatePct = lastRequest.HitRatePct,
                    status = lastRequest.Status,
                    retentionApplied = lastRequest.RetentionApplied,
                    routingApplied = lastRequest.RoutingApplied,
                    updatedAt = lastRequest.UpdatedAt
                },
            session = session.PromptCaching?.Session is null
                ? null
                : new
                {
                    requestCount = session.PromptCaching.Session.RequestCount,
                    chatRequestCount = session.PromptCaching.Session.ChatRequestCount,
                    compactionRequestCount = session.PromptCaching.Session.CompactionRequestCount,
                    promptTokens = session.PromptCaching.Session.PromptTokens,
                    cachedTokens = session.PromptCaching.Session.CachedTokens,
                    hitRatePct = session.PromptCaching.Session.HitRatePct
                }
        };
    }

    private static object BuildAiModelBudgetPayload(AiModelBudgetState budget) => new
    {
        model = budget.Model,
        observedAt = budget.ObservedAt,
        lastResolvedServiceTier = budget.LastResolvedServiceTier,
        serverLimitRequests = budget.ServerLimitRequests,
        serverLimitTokens = budget.ServerLimitTokens,
        serverRemainingRequests = budget.ServerRemainingRequests,
        serverRemainingTokens = budget.ServerRemainingTokens,
        serverResetRequests = budget.ServerResetRequests,
        serverResetTokens = budget.ServerResetTokens
    };

    private static object BuildAiRateLimitPayload(AiRateLimitSnapshot? snapshot) => new
    {
        serverLimitRequests = snapshot?.ServerLimitRequests,
        serverLimitTokens = snapshot?.ServerLimitTokens,
        serverRemainingRequests = snapshot?.ServerRemainingRequests,
        serverRemainingTokens = snapshot?.ServerRemainingTokens,
        serverResetRequests = snapshot?.ServerResetRequests,
        serverResetTokens = snapshot?.ServerResetTokens
    };

    private object BuildAiPromptCachingPayload(AiPageSessionRecord session)
    {
        session.PromptCaching ??= new AiPromptCachingState();
        session.PromptCaching.Session ??= new AiPromptCacheSessionState();
        var configuredRouting = PromptCaching.NormalizeRouting(_journal.AiConfig.PromptCaching.Routing);
        var configuredRetention = PromptCaching.NormalizeRetention(_journal.AiConfig.PromptCaching.Retention);

        return new
        {
            routing = configuredRouting,
            retention = configuredRetention,
            lastRequest = session.PromptCaching.LastRequest is null
                ? null
                : new
                {
                    source = session.PromptCaching.LastRequest.Source,
                    promptTokens = session.PromptCaching.LastRequest.PromptTokens,
                    cachedTokens = session.PromptCaching.LastRequest.CachedTokens,
                    hitRatePct = session.PromptCaching.LastRequest.HitRatePct,
                    status = session.PromptCaching.LastRequest.Status,
                    retentionApplied = session.PromptCaching.LastRequest.RetentionApplied,
                    routingApplied = session.PromptCaching.LastRequest.RoutingApplied,
                    updatedAt = session.PromptCaching.LastRequest.UpdatedAt
                },
            session = new
            {
                requestCount = session.PromptCaching.Session.RequestCount,
                chatRequestCount = session.PromptCaching.Session.ChatRequestCount,
                compactionRequestCount = session.PromptCaching.Session.CompactionRequestCount,
                promptTokens = session.PromptCaching.Session.PromptTokens,
                cachedTokens = session.PromptCaching.Session.CachedTokens,
                hitRatePct = session.PromptCaching.Session.HitRatePct
            }
        };
    }

    private static object? BuildAiModelSelectionPayload(AiModelSelection? selection) =>
        NormalizeModelSelection(selection) is { } normalized
            ? new
            {
                model = normalized.Model,
                tier = normalized.Tier
            }
            : null;

    private static AiModelSelection? NormalizeModelSelection(AiModelSelection? selection)
    {
        if (selection is null || string.IsNullOrWhiteSpace(selection.Model))
        {
            return null;
        }

        return new AiModelSelection
        {
            Model = selection.Model.Trim(),
            Tier = string.IsNullOrWhiteSpace(selection.Tier) ? "standard" : selection.Tier.Trim().ToLowerInvariant()
        };
    }

    private static string? GetConfiguredModelId(AiModelSelection? selection) =>
        NormalizeModelSelection(selection)?.Model;

    private string? GetExecutionModel(AiQueueItemRecord activeItem) =>
        string.IsNullOrWhiteSpace(activeItem.ModelId) ? GetConfiguredModelId(_journal.AiConfig.Chat.Model) : activeItem.ModelId;

    private static string NormalizeModelKey(string modelId) =>
        modelId.Trim().ToLowerInvariant();

    private sealed record RateLimitBlockInfo(string Model, AiModelBudgetState Budget);

    private HostStatus BuildStatus() =>
        new(
            Running: _journal.Running,
            SessionId: _journal.SessionId,
            HostConnected: true,
            TaskId: _journal.TaskId,
            StartedAt: _journal.StartedAt,
            LastHeartbeatAt: _journal.LastHeartbeatAt,
            ReconnectAttempt: 0,
            NativeHostPid: Environment.ProcessId
        );

    private async Task SendStatusAsync(string summary, CancellationToken cancellationToken)
    {
        await _transport.SendAsync(
            new
            {
                stream = "runtime",
                @event = "runtime.status",
                level = "info",
                summary,
                details = new
                {
                    _journal.SessionId,
                    _journal.TaskId,
                    _journal.TickCount
                },
                ts = NowIso(),
                correlationId = (string?)null,
                status = BuildStatus()
            },
            cancellationToken
        );
    }

    private async Task EmitAiEventAsync(
        string eventName,
        string summary,
        AiPageSessionRecord session,
        CancellationToken cancellationToken,
        object? details = null,
        string level = "info",
        AiChatMessageRecord? messageRecord = null,
        string? delta = null,
        string? correlationId = null
    )
    {
        var queue = GetQueueSnapshot(session);
        await _transport.SendAsync(
            new
            {
                stream = "ai",
                @event = eventName,
                level,
                summary,
                details,
                ts = NowIso(),
                correlationId,
                pageKey = session.PageKey,
                pageUrl = session.PageUrlSample,
                requestId = messageRecord?.RequestId ?? session.ActiveItem?.RequestId,
                sequenceNumber = session.LastSequenceNumber,
                status = BuildAiStatusPayload(session),
                session = BuildAiSessionPayload(session),
                message = messageRecord is null ? null : BuildAiMessagePayload(messageRecord),
                queue = queue.Select(BuildAiQueuePayload).ToArray(),
                delta
            },
            cancellationToken
        );
    }

    private async Task EmitLogAsync(
        string level,
        string eventName,
        string summary,
        object? details,
        CancellationToken cancellationToken,
        string? correlationId = null
    )
    {
        var now = NowIso();
        var serializedDetails = details switch
        {
            null => string.Empty,
            string detailText => detailText,
            _ => JsonSerializer.Serialize(details)
        };

        await _transport.SendAsync(
            new
            {
                stream = "runtime",
                @event = "runtime.log",
                level,
                summary,
                details,
                ts = now,
                correlationId,
                logEntry = new
                {
                    id = Guid.NewGuid().ToString("D"),
                    ts = now,
                    level,
                    source = "native-host",
                    @event = eventName,
                    summary,
                    details,
                    correlationId,
                    collapsedByDefault = summary.Length > 160 || serializedDetails.Length > 160
                }
            },
            cancellationToken
        );
    }

    private static string GetRequiredString(JsonElement payload, string propertyName) =>
        GetOptionalString(payload, propertyName)
        ?? throw new InvalidOperationException($"Missing string payload property '{propertyName}'.");

    private static string? GetOptionalString(JsonElement payload, string propertyName)
    {
        if (payload.ValueKind == JsonValueKind.Object &&
            payload.TryGetProperty(propertyName, out var property) &&
            property.ValueKind == JsonValueKind.String)
        {
            return property.GetString();
        }

        return null;
    }

    private static AiModelSelection? GetOptionalModelSelection(JsonElement payload, string propertyName)
    {
        if (payload.ValueKind != JsonValueKind.Object || !payload.TryGetProperty(propertyName, out var property))
        {
            return null;
        }

        if (property.ValueKind == JsonValueKind.Null)
        {
            return null;
        }

        if (property.ValueKind == JsonValueKind.String)
        {
            var modelId = property.GetString();
            return string.IsNullOrWhiteSpace(modelId)
                ? null
                : new AiModelSelection
                {
                    Model = modelId,
                    Tier = "standard"
                };
        }

        if (property.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        var modelIdValue = GetOptionalString(property, "model");
        if (string.IsNullOrWhiteSpace(modelIdValue))
        {
            return null;
        }

        return NormalizeModelSelection(new AiModelSelection
        {
            Model = modelIdValue,
            Tier = GetOptionalString(property, "tier") ?? "standard"
        });
    }

    private static int? GetOptionalInt(JsonElement payload, string propertyName)
    {
        if (payload.ValueKind == JsonValueKind.Object &&
            payload.TryGetProperty(propertyName, out var property) &&
            property.ValueKind == JsonValueKind.Number)
        {
            return property.GetInt32();
        }

        return null;
    }

    private static bool? GetOptionalBoolean(JsonElement payload, string propertyName)
    {
        if (payload.ValueKind == JsonValueKind.Object &&
            payload.TryGetProperty(propertyName, out var property) &&
            (property.ValueKind == JsonValueKind.True || property.ValueKind == JsonValueKind.False))
        {
            return property.GetBoolean();
        }

        return null;
    }

    private static DateTimeOffset? ParseTimestamp(string? value) =>
        DateTimeOffset.TryParse(value, out var parsedValue) ? parsedValue : null;

    private static string? NormalizeOptionalIsoTimestamp(string? value) =>
        ParseTimestamp(value)?.ToString("O");

    private static DateTimeOffset? GetQueueItemNotBeforeAt(AiQueueItemRecord? item) =>
        ParseTimestamp(item?.NotBeforeAt);

    private static TimeSpan ParseResetDuration(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return TimeSpan.Zero;
        }

        var normalizedValue = value.Trim().ToLowerInvariant();
        var total = TimeSpan.Zero;
        var remaining = normalizedValue;
        while (remaining.Length > 0)
        {
            var matched = false;
            foreach (var suffix in new[] { "ms", "h", "m", "s" })
            {
                var suffixIndex = remaining.IndexOf(suffix, StringComparison.Ordinal);
                if (suffixIndex <= 0)
                {
                    continue;
                }

                var numericPart = remaining[..suffixIndex];
                if (!double.TryParse(numericPart, out var componentValue))
                {
                    continue;
                }

                total += suffix switch
                {
                    "ms" => TimeSpan.FromMilliseconds(componentValue),
                    "h" => TimeSpan.FromHours(componentValue),
                    "m" => TimeSpan.FromMinutes(componentValue),
                    "s" => TimeSpan.FromSeconds(componentValue),
                    _ => TimeSpan.Zero
                };

                remaining = remaining[(suffixIndex + suffix.Length)..];
                matched = true;
                break;
            }

            if (!matched)
            {
                return TimeSpan.Zero;
            }
        }

        return total;
    }

    private static string NowIso() => DateTimeOffset.UtcNow.ToString("O");
}
