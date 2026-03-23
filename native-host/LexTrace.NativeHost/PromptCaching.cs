using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace LexTrace.NativeHost;

internal static class PromptCaching
{
    public const string RoutingStableSessionPrefix = "stable_session_prefix";
    public const string RoutingProviderDefault = "provider_default";

    public const string RetentionInMemory = "in_memory";
    public const string Retention24Hours = "24h";

    public const string SourceChat = "chat";
    public const string SourceCompaction = "compaction";

    public const string StatusUnknown = "unknown";
    public const string StatusBelowThreshold = "below_threshold";
    public const string StatusMiss = "miss";
    public const string StatusPartialHit = "partial_hit";
    public const string StatusFullHit = "full_hit";

    private const int MinimumPromptTokensForCacheHitClassification = 1024;
    private const string CacheKeyPrefix = "ltpc_";
    private static readonly HashSet<string> ExtendedRetentionModels = new(StringComparer.OrdinalIgnoreCase)
    {
        "gpt-4.1",
        "gpt-4.1-mini",
        "gpt-4.1-nano",
        "gpt-5",
        "gpt-5-mini",
        "gpt-5-nano",
        "o4-mini"
    };

    internal sealed record PromptCacheRequestSettings(
        string Source,
        string RoutingApplied,
        string RetentionApplied,
        string? CacheKey,
        string? FallbackReason
    );

    internal sealed record PromptCacheUsageSnapshot(
        int? PromptTokens,
        int? CachedTokens,
        double? HitRatePct,
        string Status
    );

    public static string NormalizeRouting(string? routing) =>
        string.Equals(routing, RoutingProviderDefault, StringComparison.OrdinalIgnoreCase)
            ? RoutingProviderDefault
            : RoutingStableSessionPrefix;

    public static string NormalizeRetention(string? retention) =>
        string.Equals(retention, Retention24Hours, StringComparison.OrdinalIgnoreCase)
            ? Retention24Hours
            : RetentionInMemory;

    public static bool SupportsExtendedRetention(string? modelId) =>
        !string.IsNullOrWhiteSpace(modelId) &&
        ExtendedRetentionModels.Contains(modelId.Trim());

    public static PromptCacheRequestSettings ResolveChatRequest(
        AiRuntimeConfig config,
        AiPageSessionRecord session,
        AiModelSelection? selection
    )
    {
        var normalizedSelection = NormalizeSelection(selection);
        var routingApplied = NormalizeRouting(config.PromptCaching.Routing);
        var retentionApplied = ResolveChatRetention(config.PromptCaching.Retention, normalizedSelection?.Model, out var fallbackReason);
        var cacheKey = routingApplied == RoutingStableSessionPrefix
            ? BuildCacheKey(
                kind: SourceChat,
                pageKey: session.PageKey,
                selection: normalizedSelection,
                epoch: session.CompactionPassCount,
                instructions: config.Chat.Instructions,
                schemaName: config.Chat.StructuredOutput.Name,
                schema: config.Chat.StructuredOutput.Schema,
                strict: config.Chat.StructuredOutput.Strict
            )
            : null;

        return new PromptCacheRequestSettings(SourceChat, routingApplied, retentionApplied, cacheKey, fallbackReason);
    }

    public static PromptCacheRequestSettings ResolveCompactionRequest(
        AiRuntimeConfig config,
        AiPageSessionRecord session,
        AiModelSelection selection
    )
    {
        var resolvedInstructions = AiCompactionDefaults.ResolveInstructions(config.Compaction.Instructions);
        var normalizedSelection = NormalizeSelection(selection);
        var routingApplied = NormalizeRouting(config.PromptCaching.Routing);
        var requestedRetention = NormalizeRetention(config.PromptCaching.Retention);
        var fallbackReason = requestedRetention == Retention24Hours
            ? "responses_compact_does_not_document_prompt_cache_retention"
            : null;
        var cacheKey = routingApplied == RoutingStableSessionPrefix
            ? BuildCacheKey(
                kind: SourceCompaction,
                pageKey: session.PageKey,
                selection: normalizedSelection,
                epoch: session.CompactionPassCount,
                instructions: resolvedInstructions,
                schemaName: null,
                schema: null,
                strict: false
            )
            : null;

        return new PromptCacheRequestSettings(SourceCompaction, routingApplied, RetentionInMemory, cacheKey, fallbackReason);
    }

    public static PromptCacheUsageSnapshot ReadUsage(JsonElement responseElement)
    {
        if (responseElement.ValueKind != JsonValueKind.Object ||
            !responseElement.TryGetProperty("usage", out var usageElement) ||
            usageElement.ValueKind != JsonValueKind.Object)
        {
            return new PromptCacheUsageSnapshot(null, null, null, StatusUnknown);
        }

        var promptTokens = GetOptionalUsageInt(usageElement, "input_tokens") ?? GetOptionalUsageInt(usageElement, "prompt_tokens");
        var cachedTokens = GetNestedOptionalUsageInt(usageElement, "input_tokens_details", "cached_tokens") ??
                           GetNestedOptionalUsageInt(usageElement, "prompt_tokens_details", "cached_tokens");
        var hitRatePct = CalculateHitRatePct(promptTokens, cachedTokens);
        return new PromptCacheUsageSnapshot(
            promptTokens,
            cachedTokens,
            hitRatePct,
            Classify(promptTokens, cachedTokens)
        );
    }

    public static void RecordUsage(
        AiPageSessionRecord session,
        PromptCacheRequestSettings request,
        PromptCacheUsageSnapshot usage,
        string updatedAt
    )
    {
        session.PromptCaching ??= new AiPromptCachingState();
        session.PromptCaching.Session ??= new AiPromptCacheSessionState();

        var summary = session.PromptCaching.Session;
        summary.RequestCount += 1;
        if (request.Source == SourceCompaction)
        {
            summary.CompactionRequestCount += 1;
        }
        else
        {
            summary.ChatRequestCount += 1;
        }

        if (usage.PromptTokens is int promptTokens)
        {
            summary.PromptTokens += promptTokens;
        }

        if (usage.CachedTokens is int cachedTokens)
        {
            summary.CachedTokens += cachedTokens;
        }

        summary.HitRatePct = CalculateHitRatePct(summary.PromptTokens, summary.CachedTokens);
        session.PromptCaching.LastRequest = new AiPromptCacheLastRequestState
        {
            Source = request.Source,
            PromptTokens = usage.PromptTokens,
            CachedTokens = usage.CachedTokens,
            HitRatePct = usage.HitRatePct,
            Status = usage.Status,
            RetentionApplied = request.RetentionApplied,
            RoutingApplied = request.RoutingApplied,
            UpdatedAt = updatedAt
        };
    }

    public static void ResetSessionState(AiPageSessionRecord session) =>
        session.PromptCaching = new AiPromptCachingState();

    public static double? CalculateHitRatePct(int? promptTokens, int? cachedTokens)
    {
        if (promptTokens is not int promptTokenCount ||
            cachedTokens is not int cachedTokenCount ||
            promptTokenCount <= 0)
        {
            return null;
        }

        var ratio = (double)cachedTokenCount / promptTokenCount * 100.0;
        return Math.Round(Math.Clamp(ratio, 0.0, 100.0), 1, MidpointRounding.AwayFromZero);
    }

    public static string Classify(int? promptTokens, int? cachedTokens)
    {
        if (promptTokens is not int promptTokenCount || cachedTokens is not int cachedTokenCount)
        {
            return StatusUnknown;
        }

        if (promptTokenCount < MinimumPromptTokensForCacheHitClassification)
        {
            return StatusBelowThreshold;
        }

        if (cachedTokenCount <= 0)
        {
            return StatusMiss;
        }

        if (cachedTokenCount >= promptTokenCount)
        {
            return StatusFullHit;
        }

        return StatusPartialHit;
    }

    private static string ResolveChatRetention(string? retention, string? modelId, out string? fallbackReason)
    {
        fallbackReason = null;
        var normalizedRetention = NormalizeRetention(retention);
        if (normalizedRetention == RetentionInMemory)
        {
            return RetentionInMemory;
        }

        if (SupportsExtendedRetention(modelId))
        {
            return Retention24Hours;
        }

        fallbackReason = string.IsNullOrWhiteSpace(modelId)
            ? "extended_retention_requires_a_resolved_model"
            : "model_does_not_support_extended_prompt_cache_retention";
        return RetentionInMemory;
    }

    private static AiModelSelection? NormalizeSelection(AiModelSelection? selection)
    {
        if (selection is null || string.IsNullOrWhiteSpace(selection.Model))
        {
            return null;
        }

        return new AiModelSelection
        {
            Model = selection.Model.Trim(),
            Tier = string.IsNullOrWhiteSpace(selection.Tier)
                ? "standard"
                : selection.Tier.Trim().ToLowerInvariant()
        };
    }

    private static string BuildCacheKey(
        string kind,
        string? pageKey,
        AiModelSelection? selection,
        int epoch,
        string? instructions,
        string? schemaName,
        string? schema,
        bool strict
    )
    {
        var canonical = string.Join("|",
        [
            "v1",
            NormalizeComponent(kind),
            NormalizeComponent(selection?.Model),
            NormalizeComponent(selection?.Tier),
            NormalizeComponent(pageKey),
            epoch.ToString(),
            ComputeFingerprint(instructions),
            ComputeFingerprint(schemaName),
            ComputeFingerprint(schema),
            strict ? "1" : "0"
        ]);

        var hashBytes = SHA256.HashData(Encoding.UTF8.GetBytes(canonical));
        var hashText = Convert.ToHexString(hashBytes).ToLowerInvariant();
        return $"{CacheKeyPrefix}{hashText[..56]}";
    }

    private static string ComputeFingerprint(string? value)
    {
        var normalized = NormalizeComponent(value);
        if (normalized.Length == 0)
        {
            return "0";
        }

        var hashBytes = SHA256.HashData(Encoding.UTF8.GetBytes(normalized));
        return Convert.ToHexString(hashBytes).ToLowerInvariant()[..16];
    }

    private static string NormalizeComponent(string? value) =>
        string.IsNullOrWhiteSpace(value) ? string.Empty : value.Trim();

    private static int? GetOptionalUsageInt(JsonElement element, string propertyName) =>
        element.TryGetProperty(propertyName, out var property) && property.ValueKind == JsonValueKind.Number
            ? property.GetInt32()
            : null;

    private static int? GetNestedOptionalUsageInt(JsonElement element, string propertyName, string nestedPropertyName)
    {
        if (!element.TryGetProperty(propertyName, out var property) || property.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        return GetOptionalUsageInt(property, nestedPropertyName);
    }
}
