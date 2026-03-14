using System.Text.Json;

namespace LexTrace.NativeHost;

internal sealed record ProtocolEnvelope(
    string Id,
    int Version,
    string Scope,
    string Action,
    string Source,
    string Target,
    DateTimeOffset Ts,
    JsonElement Payload,
    string? CorrelationId
);

internal sealed record ProtocolError(string Code, string Message, object? Details);

internal sealed record ProtocolResponse(
    string Id,
    bool Ok,
    object? Result,
    ProtocolError? Error,
    string Ts
);

internal sealed record HostStatus(
    bool Running,
    string? SessionId,
    bool HostConnected,
    string? TaskId,
    string? StartedAt,
    string? LastHeartbeatAt,
    int ReconnectAttempt,
    int? NativeHostPid
);

internal sealed class HostJournal
{
    public bool Running { get; set; }
    public string? SessionId { get; set; }
    public string? TaskId { get; set; }
    public string? StartedAt { get; set; }
    public string? LastHeartbeatAt { get; set; }
    public int TickCount { get; set; }
    public int HeartbeatMs { get; set; } = 1000;
    public int? NativeHostPid { get; set; }
}

