using System.Text.Json;
using Xunit;

namespace LexTrace.NativeHost.Tests;

public sealed class PromptCachingTests
{
    [Fact]
    public void ResolveChatRequestFallsBackToInMemoryForUnsupportedExtendedRetentionModels()
    {
        var config = CreateConfig("gpt-4o-mini", PromptCaching.Retention24Hours);
        var session = new AiPageSessionRecord
        {
            PageKey = "https://example.com/page"
        };

        var request = PromptCaching.ResolveChatRequest(config, session, config.Chat.Model);

        Assert.Equal(PromptCaching.RetentionInMemory, request.RetentionApplied);
        Assert.Equal("model_does_not_support_extended_prompt_cache_retention", request.FallbackReason);
    }

    [Fact]
    public void ResolveChatRequestKeepsExtendedRetentionForSupportedModels()
    {
        var config = CreateConfig("gpt-5-mini", PromptCaching.Retention24Hours);
        var session = new AiPageSessionRecord
        {
            PageKey = "https://example.com/page"
        };

        var request = PromptCaching.ResolveChatRequest(config, session, config.Chat.Model);

        Assert.Equal(PromptCaching.Retention24Hours, request.RetentionApplied);
        Assert.Null(request.FallbackReason);
    }

    [Fact]
    public void StableSessionPrefixKeysStayStableUntilCompactionEpochChanges()
    {
        var config = CreateConfig("gpt-5-mini", PromptCaching.RetentionInMemory);
        var session = new AiPageSessionRecord
        {
            PageKey = "https://example.com/page",
            CompactionPassCount = 0
        };

        var first = PromptCaching.ResolveChatRequest(config, session, config.Chat.Model);
        var second = PromptCaching.ResolveChatRequest(config, session, config.Chat.Model);
        session.CompactionPassCount = 1;
        var third = PromptCaching.ResolveChatRequest(config, session, config.Chat.Model);

        Assert.Equal(first.CacheKey, second.CacheKey);
        Assert.NotEqual(first.CacheKey, third.CacheKey);
    }

    [Fact]
    public void ResolveCompactionRequestAlwaysUsesInMemoryRetentionBecauseCompactEndpointDoesNotExposeRetention()
    {
        var config = CreateConfig("gpt-5-mini", PromptCaching.Retention24Hours);
        var session = new AiPageSessionRecord
        {
            PageKey = "https://example.com/page"
        };

        var request = PromptCaching.ResolveCompactionRequest(config, session, config.Chat.Model!);

        Assert.Equal(PromptCaching.RetentionInMemory, request.RetentionApplied);
        Assert.Equal("responses_compact_does_not_document_prompt_cache_retention", request.FallbackReason);
    }

    [Fact]
    public void ResolveCompactionRequestFallsBackToDefaultInstructionsWhenConfigValueIsBlank()
    {
        var config = CreateConfig("gpt-5-mini", PromptCaching.RetentionInMemory);
        config.Compaction.Instructions = string.Empty;
        var session = new AiPageSessionRecord
        {
            PageKey = "https://example.com/page"
        };

        var fallbackRequest = PromptCaching.ResolveCompactionRequest(config, session, config.Chat.Model!);

        config.Compaction.Instructions = AiCompactionDefaults.DefaultInstructions;
        var explicitRequest = PromptCaching.ResolveCompactionRequest(config, session, config.Chat.Model!);

        Assert.Equal(explicitRequest.CacheKey, fallbackRequest.CacheKey);
    }

    [Fact]
    public void ResolveChatRequestChangesCacheKeyWhenStructuredDescriptionChanges()
    {
        var config = CreateConfig("gpt-5-mini", PromptCaching.RetentionInMemory);
        var session = new AiPageSessionRecord
        {
            PageKey = "https://example.com/page"
        };

        var first = PromptCaching.ResolveChatRequest(config, session, config.Chat.Model);
        config.Chat.StructuredOutput.Description = "Updated description that changes the prompt prefix.";
        var second = PromptCaching.ResolveChatRequest(config, session, config.Chat.Model);

        Assert.NotEqual(first.CacheKey, second.CacheKey);
    }

    [Theory]
    [InlineData(512, 0, PromptCaching.StatusBelowThreshold)]
    [InlineData(2048, 0, PromptCaching.StatusMiss)]
    [InlineData(2048, 1024, PromptCaching.StatusPartialHit)]
    [InlineData(2048, 2048, PromptCaching.StatusFullHit)]
    public void ClassifyUsageMatchesExpectedStatus(int promptTokens, int cachedTokens, string expectedStatus)
    {
        Assert.Equal(expectedStatus, PromptCaching.Classify(promptTokens, cachedTokens));
    }

    [Fact]
    public void RecordUsageAggregatesSessionMetricsAndResetClearsThem()
    {
        var session = new AiPageSessionRecord
        {
            PageKey = "https://example.com/page"
        };
        var chatRequest = new PromptCaching.PromptCacheRequestSettings(
            PromptCaching.SourceChat,
            PromptCaching.RoutingStableSessionPrefix,
            PromptCaching.RetentionInMemory,
            "ltpc_chat",
            null
        );
        var compactionRequest = new PromptCaching.PromptCacheRequestSettings(
            PromptCaching.SourceCompaction,
            PromptCaching.RoutingStableSessionPrefix,
            PromptCaching.RetentionInMemory,
            "ltpc_compaction",
            null
        );

        PromptCaching.RecordUsage(
            session,
            chatRequest,
            new PromptCaching.PromptCacheUsageSnapshot(2048, 1024, 50, PromptCaching.StatusPartialHit),
            "2026-03-21T12:00:00.000Z"
        );
        PromptCaching.RecordUsage(
            session,
            compactionRequest,
            new PromptCaching.PromptCacheUsageSnapshot(4096, 2048, 50, PromptCaching.StatusPartialHit),
            "2026-03-21T12:01:00.000Z"
        );

        Assert.Equal(2, session.PromptCaching.Session.RequestCount);
        Assert.Equal(1, session.PromptCaching.Session.ChatRequestCount);
        Assert.Equal(1, session.PromptCaching.Session.CompactionRequestCount);
        Assert.Equal(6144, session.PromptCaching.Session.PromptTokens);
        Assert.Equal(3072, session.PromptCaching.Session.CachedTokens);
        Assert.Equal(50, session.PromptCaching.Session.HitRatePct);

        PromptCaching.ResetSessionState(session);

        Assert.Null(session.PromptCaching.LastRequest);
        Assert.Equal(0, session.PromptCaching.Session.RequestCount);
        Assert.Equal(0, session.PromptCaching.Session.ChatRequestCount);
        Assert.Equal(0, session.PromptCaching.Session.CompactionRequestCount);
        Assert.Equal(0, session.PromptCaching.Session.PromptTokens);
        Assert.Equal(0, session.PromptCaching.Session.CachedTokens);
        Assert.Null(session.PromptCaching.Session.HitRatePct);
    }

    [Fact]
    public void ReadUsageAcceptsResponsesUsageShapeWithCachedTokens()
    {
        using var response = JsonDocument.Parse("""
        {
          "usage": {
            "input_tokens": 4096,
            "input_tokens_details": {
              "cached_tokens": 3072
            }
          }
        }
        """);

        var usage = PromptCaching.ReadUsage(response.RootElement);

        Assert.Equal(4096, usage.PromptTokens);
        Assert.Equal(3072, usage.CachedTokens);
        Assert.Equal(75, usage.HitRatePct);
        Assert.Equal(PromptCaching.StatusPartialHit, usage.Status);
    }

    private static AiRuntimeConfig CreateConfig(string modelId, string retention) => new()
    {
        Chat = new AiChatConfig
        {
            Model = new AiModelSelection
            {
                Model = modelId,
                Tier = "standard"
            },
            Instructions = "Reply tersely.",
            StructuredOutput = new AiStructuredOutputConfig
            {
                Name = "chat_response",
                Schema = "{\"type\":\"object\"}",
                Strict = true
            }
        },
        PromptCaching = new AiPromptCachingConfig
        {
            Routing = PromptCaching.RoutingStableSessionPrefix,
            Retention = retention
        },
        Compaction = new AiCompactionConfig()
    };
}
