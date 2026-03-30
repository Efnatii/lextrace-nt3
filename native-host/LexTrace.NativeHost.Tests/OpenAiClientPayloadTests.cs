using System.Text.Json.Nodes;
using Xunit;

namespace LexTrace.NativeHost.Tests;

public sealed class OpenAiClientPayloadTests
{
    [Fact]
    public void BuildResponsesPayloadIncludesPromptCacheKeyAndRetention()
    {
        var config = CreateConfig();
        var request = PromptCaching.ResolveChatRequest(config, new AiPageSessionRecord
        {
            PageKey = "https://example.com/page"
        }, config.Chat.Model);

        var payload = OpenAiClient.BuildResponsesPayload(
            config,
            ["{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"hello\"}]}"],
            background: true,
            stream: false,
            request
        );

        Assert.Equal(request.CacheKey, payload["prompt_cache_key"]?.GetValue<string>());
        Assert.Equal("in_memory", payload["prompt_cache_retention"]?.GetValue<string>());
    }

    [Fact]
    public void BuildResponsesPayloadOmitsPromptCacheKeyForProviderDefaultRouting()
    {
        var config = CreateConfig();
        config.PromptCaching.Routing = PromptCaching.RoutingProviderDefault;
        var request = PromptCaching.ResolveChatRequest(config, new AiPageSessionRecord
        {
            PageKey = "https://example.com/page"
        }, config.Chat.Model);

        var payload = OpenAiClient.BuildResponsesPayload(
            config,
            ["{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"hello\"}]}"],
            background: true,
            stream: false,
            request
        );

        Assert.Null(payload["prompt_cache_key"]);
        Assert.Equal("in_memory", payload["prompt_cache_retention"]?.GetValue<string>());
    }

    [Fact]
    public void BuildCompactPayloadIncludesPromptCacheKeyWithoutRetention()
    {
        var config = CreateConfig();
        var session = new AiPageSessionRecord
        {
            PageKey = "https://example.com/page"
        };
        var request = PromptCaching.ResolveCompactionRequest(config, session, config.Chat.Model!);

        var payload = OpenAiClient.BuildCompactPayload(
            config.Chat.Model!,
            ["{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"hello\"}]}"],
            "compact",
            request
        );

        Assert.Equal(request.CacheKey, payload["prompt_cache_key"]?.GetValue<string>());
        Assert.Null(payload["prompt_cache_retention"]);
    }

    [Fact]
    public void BuildCompactPayloadDoesNotSetMaxOutputTokensWhenNoExplicitLimitIsConfigured()
    {
        var config = CreateConfig();
        var session = new AiPageSessionRecord
        {
            PageKey = "https://example.com/page"
        };
        var request = PromptCaching.ResolveCompactionRequest(config, session, config.Chat.Model!);

        var payload = OpenAiClient.BuildCompactPayload(
            config.Chat.Model!,
            ["{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"hello\"}]}"],
            "compact",
            request
        );

        Assert.Null(payload["max_output_tokens"]);
    }

    private static AiRuntimeConfig CreateConfig() => new()
    {
        Chat = new AiChatConfig
        {
            Model = new AiModelSelection
            {
                Model = "gpt-5-mini",
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
            Retention = PromptCaching.RetentionInMemory
        }
    };
}
