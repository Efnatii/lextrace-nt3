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
    public AiRuntimeConfig AiConfig { get; set; } = AiRuntimeConfig.CreateDefault();
    public Dictionary<string, AiModelBudgetState> ModelBudgets { get; set; } = [];
    public List<AiPageSessionRecord> AiSessions { get; set; } = [];
}

internal sealed class AiRuntimeConfig
{
    public AiChatConfig Chat { get; set; } = new();
    public AiCompactionConfig Compaction { get; set; } = new();
    public AiRateLimitConfig RateLimits { get; set; } = new();

    public static AiRuntimeConfig CreateDefault() => new();
}

internal sealed class AiChatConfig
{
    public AiModelSelection? Model { get; set; }
    public bool StreamingEnabled { get; set; } = true;
    public string Instructions { get; set; } = string.Empty;
    public AiStructuredOutputConfig StructuredOutput { get; set; } = new();
}

internal sealed class AiStructuredOutputConfig
{
    public string Name { get; set; } = "chat_response";
    public string Description { get; set; } = string.Empty;
    public string Schema { get; set; } = string.Empty;
    public bool Strict { get; set; } = true;
}

internal sealed class AiModelSelection
{
    public string Model { get; set; } = string.Empty;
    public string Tier { get; set; } = "standard";
}

internal sealed class AiCompactionConfig
{
    public bool Enabled { get; set; } = true;
    public bool StreamingEnabled { get; set; } = true;
    public AiModelSelection? ModelOverride { get; set; }
    public string Instructions { get; set; } = string.Empty;
    public int TriggerPromptTokens { get; set; } = 131072;
    public int PreserveRecentTurns { get; set; } = 24;
    public int MaxPassesPerPage { get; set; } = 16;
}

internal sealed class AiRateLimitConfig
{
    public int ReserveOutputTokens { get; set; } = 32768;
    public int MaxQueuedPerPage { get; set; } = 250;
    public int MaxQueuedGlobal { get; set; } = 1000;
}

internal class AiRateLimitSnapshot
{
    public int? ServerLimitRequests { get; set; }
    public int? ServerLimitTokens { get; set; }
    public int? ServerRemainingRequests { get; set; }
    public int? ServerRemainingTokens { get; set; }
    public string? ServerResetRequests { get; set; }
    public string? ServerResetTokens { get; set; }
}

internal sealed class AiModelBudgetState : AiRateLimitSnapshot
{
    public string Model { get; set; } = string.Empty;
    public string? ObservedAt { get; set; }
    public string? LastResolvedServiceTier { get; set; }
}

internal sealed class AiChatMessageRecord
{
    public string Id { get; set; } = Guid.NewGuid().ToString("D");
    public string PageKey { get; set; } = string.Empty;
    public string? RequestId { get; set; }
    public string? OpenAiResponseId { get; set; }
    public string Origin { get; set; } = "system";
    public string Role { get; set; } = "system";
    public string Kind { get; set; } = "system";
    public string Text { get; set; } = string.Empty;
    public string? Summary { get; set; }
    public string Ts { get; set; } = DateTimeOffset.UtcNow.ToString("O");
    public string State { get; set; } = "completed";
    public object? Meta { get; set; }
}

internal sealed class AiQueueItemRecord
{
    public string Id { get; set; } = Guid.NewGuid().ToString("D");
    public string RequestId { get; set; } = Guid.NewGuid().ToString("D");
    public string PageKey { get; set; } = string.Empty;
    public string Origin { get; set; } = "user";
    public string Text { get; set; } = string.Empty;
    public string CreatedAt { get; set; } = DateTimeOffset.UtcNow.ToString("O");
    public string State { get; set; } = "queued";
    public string UserMessageId { get; set; } = string.Empty;
    public string? AssistantMessageId { get; set; }
    public string? OpenAiResponseId { get; set; }
    public string? ModelId { get; set; }
    public int? LastSequenceNumber { get; set; }
    public int AttemptCount { get; set; }
}

internal sealed class AiPageSessionRecord
{
    public string PageKey { get; set; } = string.Empty;
    public string? PageUrlSample { get; set; }
    public string RequestState { get; set; } = "idle";
    public string? LastError { get; set; }
    public bool Recoverable { get; set; }
    public string? LastCheckpointAt { get; set; }
    public string? OpenAiResponseId { get; set; }
    public int? LastSequenceNumber { get; set; }
    public string? LastResolvedServiceTier { get; set; }
    public int CompactionPassCount { get; set; }
    public List<AiChatMessageRecord> Messages { get; set; } = [];
    public List<AiQueueItemRecord> PendingQueue { get; set; } = [];
    public AiQueueItemRecord? ActiveItem { get; set; }
    public AiQueueItemRecord? RetryableItem { get; set; }
    public List<string> CanonicalContextJsonItems { get; set; } = [];
}
