using System.Diagnostics;
using System.Text.Json;

namespace LexTrace.NativeHost;

internal sealed class RuntimeEngine
{
    private readonly NativeMessagingTransport _transport;
    private readonly HostStateStore _stateStore;
    private readonly SemaphoreSlim _stateLock = new(1, 1);

    private HostJournal _journal = new();
    private CancellationTokenSource? _heartbeatLoopCts;
    private Task? _heartbeatLoopTask;

    public RuntimeEngine(NativeMessagingTransport transport, HostStateStore stateStore)
    {
        _transport = transport;
        _stateStore = stateStore;
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
                snapshot = BuildStatus()
            },
            cancellationToken
        );
        }

        await SendStatusAsync("Host initialized.", cancellationToken);
    }

    public async Task<object?> HandleCommandAsync(ProtocolEnvelope envelope, CancellationToken cancellationToken)
    {
        return envelope.Action switch
        {
            "worker.start" => await StartWorkerAsync(envelope, cancellationToken),
            "worker.stop" => await StopWorkerAsync(envelope, cancellationToken),
            "worker.status" => BuildStatus(),
            "task.demo.start" => await StartDemoTaskAsync(envelope, cancellationToken),
            "task.demo.stop" => await StopDemoTaskAsync(envelope, cancellationToken),
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

    private static string NowIso() => DateTimeOffset.UtcNow.ToString("O");
}
