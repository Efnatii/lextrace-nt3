using System.Diagnostics;
using System.Text.Json;

namespace LexTrace.NativeHost;

internal sealed class RuntimeEngine
{
    private readonly NativeMessagingTransport _transport;
    private readonly HostStateStore _stateStore;
    private readonly OpenAiClient _openAiClient;
    private readonly SemaphoreSlim _stateLock = new(1, 1);
    private readonly Dictionary<string, CancellationTokenSource> _aiProcessingTokens = [];
    private readonly Dictionary<string, Task> _aiProcessingTasks = [];

    private HostJournal _journal = new();
    private CancellationTokenSource? _heartbeatLoopCts;
    private Task? _heartbeatLoopTask;

    public RuntimeEngine(NativeMessagingTransport transport, HostStateStore stateStore)
    {
        _transport = transport;
        _stateStore = stateStore;
        _openAiClient = new OpenAiClient();
    }

    public async Task InitializeAsync(CancellationToken cancellationToken)
    {
        _journal = await _stateStore.LoadAsync(cancellationToken);
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

    private async Task<object> SyncConfigAsync(ProtocolEnvelope envelope, CancellationToken cancellationToken)
    {
        await _stateLock.WaitAsync(cancellationToken);
        try
        {
            ApplyAiConfig(_journal, envelope.Payload);
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
            models = catalog.Models
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
            session = BuildAiSessionPayload(session)
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
                throw new InvalidOperationException("OPENAI_API_KEY environment variable is missing.");
            }

            if (GetGlobalQueuedCountLocked() >= _journal.AiConfig.RateLimits.MaxQueuedGlobal)
            {
                throw new InvalidOperationException("Global AI queue limit has been reached.");
            }

            session = GetOrCreatePageSessionLocked(pageKey, pageUrl);
            if (GetSessionQueuedCountLocked(session) >= _journal.AiConfig.RateLimits.MaxQueuedPerPage)
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

            session.Messages.Add(new AiChatMessageRecord
            {
                PageKey = pageKey,
                RequestId = requestId,
                Origin = "system",
                Role = "system",
                Kind = "queue",
                Text = session.ActiveItem is null
                    ? "AI request accepted."
                    : $"AI request queued at position {session.PendingQueue.Count}.",
                State = "completed"
            });

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
                queueCount = session.PendingQueue.Count
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
                queueCount = session.PendingQueue.Count
            },
            cancellationToken,
            envelope.CorrelationId
        );

        return new
        {
            session = BuildAiSessionPayload(session)
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
                session.PendingQueue.Insert(0, session.RetryableItem);
                session.RetryableItem = null;
                session.RequestState = "queued";
                session.LastError = null;
                session.Messages.Add(new AiChatMessageRecord
                {
                    PageKey = pageKey,
                    Origin = "system",
                    Role = "system",
                    Kind = "resume",
                    Text = "AI request resumed from checkpoint.",
                    State = "completed"
                });
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
            cancellationToken,
            messageRecord: session.Messages.LastOrDefault()
        );

        return new
        {
            session = BuildAiSessionPayload(session)
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
            session.OpenAiResponseId = null;
            session.LastSequenceNumber = null;
            session.LastResolvedServiceTier = null;
            session.RequestState = "idle";
            session.LastError = null;
            session.Recoverable = false;
            session.LastCheckpointAt = NowIso();
            session.Messages.Add(new AiChatMessageRecord
            {
                PageKey = pageKey,
                Origin = "system",
                Role = "system",
                Kind = "reset",
                Text = "AI page session reset.",
                State = "completed"
            });
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
            cancellationToken,
            messageRecord: session.Messages.LastOrDefault()
        );

        return new
        {
            session = BuildAiSessionPayload(session)
        };
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
                        var estimatedTokenCost = EstimateRequestTokenCost(session, blockedItem.Text);
                        if (TryGetRateLimitBlockInfoLocked(GetConfiguredModelId(_journal.AiConfig.Chat.Model), estimatedTokenCost, out _))
                        {
                            session.RequestState = "blocked";
                            session.LastCheckpointAt = NowIso();
                            await _stateStore.SaveAsync(_journal, cancellationToken);
                            return;
                        }

                        session.PendingQueue.Insert(0, blockedItem);
                        session.RetryableItem = null;
                        activeItem = session.PendingQueue[0];
                        session.PendingQueue.RemoveAt(0);
                        session.ActiveItem = activeItem;
                        activeItem.State = "running";
                        activeItem.ModelId = null;
                        session.RequestState = "running";
                        session.LastError = null;
                        session.LastCheckpointAt = NowIso();
                        await _stateStore.SaveAsync(_journal, cancellationToken);
                    }
                    else if (session.PendingQueue.Count > 0)
                    {
                        activeItem = session.PendingQueue[0];
                        session.PendingQueue.RemoveAt(0);
                        session.ActiveItem = activeItem;
                        activeItem.State = "running";
                        activeItem.ModelId = null;
                        session.RequestState = "running";
                        session.LastCheckpointAt = NowIso();
                        MarkMessageState(session, activeItem.UserMessageId, "completed");
                        await _stateStore.SaveAsync(_journal, cancellationToken);
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

        await MaybeCompactContextAsync(session, activeItem, cancellationToken);
        var executionModel = string.IsNullOrWhiteSpace(activeItem.ModelId)
            ? GetConfiguredModelId(_journal.AiConfig.Chat.Model)
            : activeItem.ModelId;
        var estimatedTokenCost = EstimateRequestTokenCost(session, activeItem.Text);
        if (await TryBlockActiveItemByRateLimitAsync(pageKey, activeItem, executionModel, estimatedTokenCost, cancellationToken))
        {
            return;
        }

        var assistantMessage = EnsureAssistantDraftMessage(session, activeItem);
        await PersistSessionAsync(cancellationToken);

        var inputItems = BuildInputItemsForRequest(session, activeItem);

        try
        {
            activeItem.ModelId = executionModel;
            await PersistJournalAsync(cancellationToken);

            if (_journal.AiConfig.Chat.StreamingEnabled)
            {
                await using var streamResponse = await _openAiClient.CreateResponseStreamAsync(
                    _journal.AiConfig,
                    inputItems,
                    background: true,
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
            await MarkRetryableAsync(pageKey, activeItem, error.Message, cancellationToken);
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
            await MarkRetryableAsync(pageKey, activeItem, error.Message, cancellationToken);
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
                    throw new InvalidOperationException("OpenAI stream reported response.failed.");
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
                throw new InvalidOperationException($"OpenAI background response ended with status {responseStatus}.");
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
                    resolvedServiceTier = session.LastResolvedServiceTier
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
                    responseId,
                    resolvedServiceTier = session.LastResolvedServiceTier,
                    queueRemaining = session.PendingQueue.Count
                },
                cancellationToken
            );
        }
        finally
        {
            _stateLock.Release();
        }
    }

    private async Task MarkRetryableAsync(
        string pageKey,
        AiQueueItemRecord activeItem,
        string errorMessage,
        CancellationToken cancellationToken
    )
    {
        await _stateLock.WaitAsync(cancellationToken);
        try
        {
            var session = GetOrCreatePageSessionLocked(pageKey, pageUrl: null);
            session.ActiveItem = null;
            activeItem.State = "retryable";
            session.RetryableItem = activeItem;
            session.RequestState = "paused";
            session.LastError = errorMessage;
            session.Recoverable = true;
            session.LastCheckpointAt = NowIso();

            var assistantMessage = session.Messages.FirstOrDefault(message => message.Id == activeItem.AssistantMessageId);
            if (assistantMessage is not null && assistantMessage.State == "streaming")
            {
                assistantMessage.State = "error";
            }

            session.Messages.Add(new AiChatMessageRecord
            {
                PageKey = pageKey,
                RequestId = activeItem.RequestId,
                Origin = "system",
                Role = "system",
                Kind = "error",
                Text = errorMessage,
                State = "completed"
            });

            await _stateStore.SaveAsync(_journal, cancellationToken);

            await EmitAiEventAsync(
                "ai.chat.error",
                "AI request moved to retryable state.",
                session,
                cancellationToken,
                details: new
                {
                    activeItem.RequestId,
                    errorMessage
                },
                messageRecord: session.Messages.LastOrDefault()
            );
        }
        finally
        {
            _stateLock.Release();
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

        var estimatedPromptTokens = EstimateRequestTokenCost(session, activeItem.Text);
        var shouldCompact = estimatedPromptTokens >= config.Compaction.TriggerPromptTokens ||
                            NeedsTpmHeadroom(estimatedPromptTokens);
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

        AiChatMessageRecord? compactionMessage = null;
        if (config.Compaction.StreamingEnabled)
        {
            compactionMessage = new AiChatMessageRecord
            {
                PageKey = session.PageKey,
                Origin = "system",
                Role = "system",
                Kind = "compaction",
                Text = "Compacting context before the next AI request.",
                State = "pending"
            };
            session.Messages.Add(compactionMessage);
            await PersistSessionAsync(cancellationToken);
            await EmitAiEventAsync(
                "ai.chat.compaction.started",
                "AI context compaction started.",
                session,
                cancellationToken,
                messageRecord: compactionMessage
            );
        }

        var response = await _openAiClient.CompactAsync(
            compactionSelection,
            session.CanonicalContextJsonItems,
            config.Compaction.Instructions,
            cancellationToken
        );
        await ApplyRateLimitsAsync(compactionModel, resolvedServiceTier: null, response.RateLimits, cancellationToken);

        await _stateLock.WaitAsync(cancellationToken);
        try
        {
            session = GetOrCreatePageSessionLocked(session.PageKey, session.PageUrlSample);
            var compactedItems = GetOutputItemsAsJsonStrings(response.Document.RootElement);
            var preservedTailItems = GetPreservedTailContextJson(session, _journal.AiConfig.Compaction.PreserveRecentTurns);
            session.CanonicalContextJsonItems = MergeCanonicalContext(compactedItems, preservedTailItems);
            session.CompactionPassCount += 1;
            session.LastCheckpointAt = NowIso();

            compactionMessage = session.Messages.LastOrDefault(message => message.Kind == "compaction" && message.State == "pending");
            if (compactionMessage is not null)
            {
                compactionMessage.Text = "Context compaction completed.";
                compactionMessage.State = "completed";
            }
            else
            {
                compactionMessage = new AiChatMessageRecord
                {
                    PageKey = session.PageKey,
                    Origin = "system",
                    Role = "system",
                    Kind = "compaction",
                    Text = "Context compaction completed.",
                    State = "completed"
                };
                session.Messages.Add(compactionMessage);
            }

            await _stateStore.SaveAsync(_journal, cancellationToken);

            await EmitAiEventAsync(
                "ai.chat.compaction.completed",
                "AI context compaction completed.",
                session,
                cancellationToken,
                details: new
                {
                    compactedItemCount = compactedItems.Count,
                    preservedTailCount = preservedTailItems.Count
                },
                messageRecord: compactionMessage
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

            session.Messages.Add(new AiChatMessageRecord
            {
                PageKey = pageKey,
                RequestId = activeItem.RequestId,
                Origin = "system",
                Role = "system",
                Kind = "rate-limit",
                Text = $"Current model {blockInfo.Model} is blocked by rate limits.",
                State = "completed",
                Meta = new
                {
                    code = "rate_limit_blocked",
                    model = blockInfo.Model,
                    remainingRequests = blockInfo.Budget.ServerRemainingRequests,
                    remainingTokens = blockInfo.Budget.ServerRemainingTokens,
                    resetRequests = blockInfo.Budget.ServerResetRequests,
                    resetTokens = blockInfo.Budget.ServerResetTokens
                }
            });

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
                level: "warn",
                messageRecord: session.Messages.LastOrDefault()
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
        _journal.AiSessions.Add(session);
        return session;
    }

    private int GetSessionQueuedCountLocked(AiPageSessionRecord session)
    {
        var activeCount = session.ActiveItem is null ? 0 : 1;
        var retryableCount = session.RetryableItem is null ? 0 : 1;
        return activeCount + retryableCount + session.PendingQueue.Count;
    }

    private int GetGlobalQueuedCountLocked() =>
        _journal.AiSessions.Sum(GetSessionQueuedCountLocked);

    private AiQueueItemRecord[] GetQueueSnapshot(AiPageSessionRecord session)
    {
        var queue = new List<AiQueueItemRecord>();
        if (session.RetryableItem is not null)
        {
            queue.Add(session.RetryableItem);
        }

        queue.AddRange(session.PendingQueue);
        return queue.ToArray();
    }

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
        JsonSerializer.Serialize(new
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
        JsonSerializer.Serialize(new
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

    private static List<string> GetPreservedTailContextJson(AiPageSessionRecord session, int preserveRecentTurns)
    {
        if (preserveRecentTurns <= 0)
        {
            return [];
        }

        return session.Messages
            .Where(message =>
                message.State == "completed" &&
                message.Role is "user" or "assistant" &&
                message.Kind is "user" or "assistant" or "code")
            .TakeLast(Math.Max(1, preserveRecentTurns * 2))
            .Select(message => message.Role == "assistant"
                ? SerializeAssistantMessageOutputJson(message.Text)
                : SerializeUserMessageInputJson(message.Origin, message.Text))
            .ToList();
    }

    private int EstimateRequestTokenCost(AiPageSessionRecord session, string pendingText)
    {
        var promptBytes = session.CanonicalContextJsonItems.Sum(item => item.Length) +
                          pendingText.Length +
                          _journal.AiConfig.Chat.Instructions.Length;
        var estimatedPromptTokens = Math.Max(1, (int)Math.Ceiling(promptBytes / 4.0));
        return estimatedPromptTokens + _journal.AiConfig.RateLimits.ReserveOutputTokens;
    }

    private static List<string> GetOutputItemsAsJsonStrings(JsonElement responseElement)
    {
        var outputItems = new List<string>();
        if (responseElement.TryGetProperty("output", out var outputProperty) && outputProperty.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in outputProperty.EnumerateArray())
            {
                outputItems.Add(item.GetRawText());
            }
        }

        return outputItems;
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

    private static void ApplyAiConfig(HostJournal journal, JsonElement payload)
    {
        if (payload.ValueKind != JsonValueKind.Object || !payload.TryGetProperty("config", out var configElement))
        {
            return;
        }

        if (!configElement.TryGetProperty("ai", out var aiElement) || aiElement.ValueKind != JsonValueKind.Object)
        {
            return;
        }

        if (aiElement.TryGetProperty("chat", out var chatElement) && chatElement.ValueKind == JsonValueKind.Object)
        {
            journal.AiConfig.Chat.Model = GetOptionalModelSelection(chatElement, "model") ?? journal.AiConfig.Chat.Model;
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
            journal.AiConfig.Chat.Model = GetOptionalModelSelection(aiElement, "model") ?? journal.AiConfig.Chat.Model;
            journal.AiConfig.Chat.StreamingEnabled = GetOptionalBoolean(aiElement, "streamingEnabled") ?? journal.AiConfig.Chat.StreamingEnabled;
            journal.AiConfig.Chat.Instructions = GetOptionalString(aiElement, "instructions") ?? journal.AiConfig.Chat.Instructions;
        }

        if (aiElement.TryGetProperty("compaction", out var compactionElement) && compactionElement.ValueKind == JsonValueKind.Object)
        {
            journal.AiConfig.Compaction.Enabled = GetOptionalBoolean(compactionElement, "enabled") ?? journal.AiConfig.Compaction.Enabled;
            journal.AiConfig.Compaction.StreamingEnabled = GetOptionalBoolean(compactionElement, "streamingEnabled") ?? journal.AiConfig.Compaction.StreamingEnabled;
            journal.AiConfig.Compaction.ModelOverride = GetOptionalModelSelection(compactionElement, "modelOverride") ?? journal.AiConfig.Compaction.ModelOverride;
            journal.AiConfig.Compaction.Instructions = GetOptionalString(compactionElement, "instructions") ?? journal.AiConfig.Compaction.Instructions;
            journal.AiConfig.Compaction.TriggerPromptTokens = GetOptionalInt(compactionElement, "triggerPromptTokens") ?? journal.AiConfig.Compaction.TriggerPromptTokens;
            journal.AiConfig.Compaction.PreserveRecentTurns = GetOptionalInt(compactionElement, "preserveRecentTurns") ?? journal.AiConfig.Compaction.PreserveRecentTurns;
            journal.AiConfig.Compaction.MaxPassesPerPage = GetOptionalInt(compactionElement, "maxPassesPerPage") ?? journal.AiConfig.Compaction.MaxPassesPerPage;
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
            queuedCount = session.PendingQueue.Count,
            recoverable = session.Recoverable,
            lastCheckpointAt = session.LastCheckpointAt,
            lastError = session.LastError,
            messages = session.Messages.Select(BuildAiMessagePayload).ToArray(),
            queue = queue.Select(BuildAiQueuePayload).ToArray(),
            status
        };
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
            queueCount = GetSessionQueuedCountLocked(session),
            activeRequestId = session.ActiveItem?.RequestId,
            openaiResponseId = session.OpenAiResponseId,
            lastSequenceNumber = session.LastSequenceNumber,
            recoverable = session.Recoverable,
            rateLimits = BuildAiRateLimitPayload(currentModelBudget),
            currentModelBudget = currentModelBudget is null ? null : BuildAiModelBudgetPayload(currentModelBudget),
            modelBudgets,
            availableActions = new
            {
                canSend = _openAiClient.HasApiKey &&
                          !string.IsNullOrWhiteSpace(GetConfiguredModelId(_journal.AiConfig.Chat.Model)) &&
                          GetSessionQueuedCountLocked(session) < _journal.AiConfig.RateLimits.MaxQueuedPerPage &&
                          GetGlobalQueuedCountLocked() < _journal.AiConfig.RateLimits.MaxQueuedGlobal,
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

    private static object BuildAiQueuePayload(AiQueueItemRecord item) => new
    {
        id = item.Id,
        requestId = item.RequestId,
        pageKey = item.PageKey,
        origin = item.Origin,
        text = item.Text,
        createdAt = item.CreatedAt,
        state = item.State
    };

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
