using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace LexTrace.NativeHost;

internal sealed class OpenAiClient : IOpenAiClient
{
    public const string ApiKeyEnvironmentVariableName = "OPENAI_API_KEY";
    private const string ResponsesPath = "https://api.openai.com/v1/responses";
    private const string ModelsPath = "https://api.openai.com/v1/models";
    private const string PricingPageUrl = "https://developers.openai.com/api/docs/pricing";
    private readonly HttpClient _httpClient;
    private string? _apiKey;
    private readonly SemaphoreSlim _catalogLock = new(1, 1);
    private OpenAiModelCatalogResult? _catalogCache;
    private DateTimeOffset _catalogCacheExpiresAt = DateTimeOffset.MinValue;

    public OpenAiClient()
        : this(CreateConfiguredHttpClient())
    {
    }

    internal OpenAiClient(HttpClient httpClient)
    {
        ReloadApiKeyFromEnvironment();
        _httpClient = httpClient;
        ConfigureDefaultHeaders(_httpClient);
    }

    public bool HasApiKey => !string.IsNullOrWhiteSpace(_apiKey);

    public void ReloadApiKeyFromEnvironment()
    {
        _apiKey = NormalizeApiKey(Environment.GetEnvironmentVariable(ApiKeyEnvironmentVariableName));
    }

    public void ConfigureManagedApiKey(string? apiKey)
    {
        var normalizedApiKey = NormalizeApiKey(apiKey);

        try
        {
            Environment.SetEnvironmentVariable(ApiKeyEnvironmentVariableName, normalizedApiKey);
            Environment.SetEnvironmentVariable(ApiKeyEnvironmentVariableName, normalizedApiKey, EnvironmentVariableTarget.User);
            _apiKey = normalizedApiKey;
        }
        catch (Exception error)
        {
            throw new InvalidOperationException(
                $"Failed to update {ApiKeyEnvironmentVariableName}: {error.Message}",
                error
            );
        }
    }

    public async Task<OpenAiModelCatalogResult> ListChatModelsAsync(CancellationToken cancellationToken)
    {
        var now = DateTimeOffset.UtcNow;
        if (_catalogCache is not null && now < _catalogCacheExpiresAt)
        {
            return _catalogCache;
        }

        await _catalogLock.WaitAsync(cancellationToken);
        try
        {
            now = DateTimeOffset.UtcNow;
            if (_catalogCache is not null && now < _catalogCacheExpiresAt)
            {
                return _catalogCache;
            }

            var pricingHtml = await TryGetPricingHtmlAsync(cancellationToken);

            try
            {
                using var request = BuildJsonRequest(HttpMethod.Get, ModelsPath, payload: null);
                using var response = await SendAsync(request, HttpCompletionOption.ResponseContentRead, cancellationToken);
                var modelsJson = await response.Content.ReadAsStringAsync(cancellationToken);
                var apiModels = OpenAiModelCatalogBuilder.ParseModelsJson(modelsJson);
                _catalogCache = OpenAiModelCatalogBuilder.Build(apiModels, pricingHtml, now);
            }
            catch (OpenAiHttpException error) when (
                error.StatusCode == HttpStatusCode.Forbidden &&
                string.Equals(error.ErrorCode, "unsupported_country_region_territory", StringComparison.Ordinal))
            {
                _catalogCache = OpenAiModelCatalogBuilder.BuildFromPricingOnly(
                    pricingHtml,
                    now,
                    warning: "Каталог открыт из локального fallback по прайс-листу: OpenAI API недоступен для текущей страны, региона или территории."
                );
            }

            _catalogCacheExpiresAt = now.AddMinutes(10);
            return _catalogCache;
        }
        finally
        {
            _catalogLock.Release();
        }
    }

    public async Task<OpenAiJsonResponse> CreateResponseAsync(
        AiRuntimeConfig config,
        IReadOnlyList<string> inputItemsJson,
        bool background,
        bool stream,
        PromptCaching.PromptCacheRequestSettings? promptCaching,
        CancellationToken cancellationToken
    )
    {
        using var request = BuildJsonRequest(
            HttpMethod.Post,
            ResponsesPath,
            BuildResponsesPayload(config, inputItemsJson, background, stream, promptCaching)
        );
        using var response = await SendAsync(request, HttpCompletionOption.ResponseContentRead, cancellationToken);
        return await OpenAiJsonResponse.FromHttpResponseAsync(response, cancellationToken);
    }

    public async Task<IOpenAiStreamResponse> CreateResponseStreamAsync(
        AiRuntimeConfig config,
        IReadOnlyList<string> inputItemsJson,
        bool background,
        PromptCaching.PromptCacheRequestSettings? promptCaching,
        CancellationToken cancellationToken
    )
    {
        var request = BuildJsonRequest(
            HttpMethod.Post,
            ResponsesPath,
            BuildResponsesPayload(config, inputItemsJson, background, stream: true, promptCaching)
        );
        var response = await SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        return await OpenAiStreamResponse.CreateAsync(response, cancellationToken);
    }

    public async Task<OpenAiJsonResponse> RetrieveResponseAsync(string responseId, CancellationToken cancellationToken)
    {
        using var request = BuildJsonRequest(HttpMethod.Get, $"{ResponsesPath}/{responseId}", payload: null);
        using var response = await SendAsync(request, HttpCompletionOption.ResponseContentRead, cancellationToken);
        return await OpenAiJsonResponse.FromHttpResponseAsync(response, cancellationToken);
    }

    public async Task<IOpenAiStreamResponse> ResumeResponseStreamAsync(
        string responseId,
        int? startingAfter,
        CancellationToken cancellationToken
    )
    {
        var url = startingAfter is > 0
            ? $"{ResponsesPath}/{responseId}?stream=true&starting_after={startingAfter.Value}"
            : $"{ResponsesPath}/{responseId}?stream=true";
        var request = BuildJsonRequest(HttpMethod.Get, url, payload: null);
        var response = await SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        return await OpenAiStreamResponse.CreateAsync(response, cancellationToken);
    }

    public async Task<OpenAiJsonResponse> CancelResponseAsync(string responseId, CancellationToken cancellationToken)
    {
        using var request = BuildJsonRequest(HttpMethod.Post, $"{ResponsesPath}/{responseId}/cancel", new { });
        using var response = await SendAsync(request, HttpCompletionOption.ResponseContentRead, cancellationToken);
        return await OpenAiJsonResponse.FromHttpResponseAsync(response, cancellationToken);
    }

    public async Task<OpenAiJsonResponse> CompactAsync(
        AiModelSelection selection,
        IReadOnlyList<string> inputItemsJson,
        string instructions,
        PromptCaching.PromptCacheRequestSettings? promptCaching,
        CancellationToken cancellationToken
    )
    {
        using var request = BuildJsonRequest(
            HttpMethod.Post,
            $"{ResponsesPath}/compact",
            BuildCompactPayload(selection, inputItemsJson, instructions, promptCaching)
        );
        using var response = await SendAsync(request, HttpCompletionOption.ResponseContentRead, cancellationToken);
        return await OpenAiJsonResponse.FromHttpResponseAsync(response, cancellationToken);
    }

    public async Task<AiRateLimitSnapshot> ProbeRateLimitsAsync(
        AiModelSelection selection,
        CancellationToken cancellationToken
    )
    {
        using var request = BuildJsonRequest(
            HttpMethod.Post,
            ResponsesPath,
            new JsonObject
            {
                ["model"] = selection.Model,
                ["input"] = BuildInputArray(
                    [
                        "{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"Reply with exact token OK and nothing else.\"}]}"
                    ]
                ),
                ["service_tier"] = MapServiceTier(selection.Tier),
                ["background"] = false,
                ["stream"] = false,
                ["store"] = false,
                ["max_output_tokens"] = 256
            }
        );

        using var response = await SendAsync(request, HttpCompletionOption.ResponseContentRead, cancellationToken);
        return OpenAiHeaderParser.ParseRateLimitHeaders(response);
    }

    private HttpRequestMessage BuildJsonRequest(HttpMethod method, string url, object? payload)
    {
        if (!HasApiKey)
        {
            throw new InvalidOperationException($"{ApiKeyEnvironmentVariableName} environment variable is missing.");
        }

        var request = new HttpRequestMessage(method, url);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _apiKey);

        if (payload is not null)
        {
            request.Content = new StringContent(JsonSerializer.Serialize(payload), Encoding.UTF8, "application/json");
        }

        return request;
    }

    private async Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request,
        HttpCompletionOption completionOption,
        CancellationToken cancellationToken
    )
    {
        var response = await _httpClient.SendAsync(request, completionOption, cancellationToken);
        if (response.IsSuccessStatusCode)
        {
            return response;
        }

        var body = await response.Content.ReadAsStringAsync(cancellationToken);
        var statusCode = response.StatusCode;
        response.Dispose();
        throw CreateHttpException(statusCode, body);
    }

    private static HttpClient CreateConfiguredHttpClient()
    {
        var httpClient = new HttpClient();
        ConfigureDefaultHeaders(httpClient);
        return httpClient;
    }

    private static void ConfigureDefaultHeaders(HttpClient httpClient)
    {
        if (!httpClient.DefaultRequestHeaders.Accept.Any(
            header => string.Equals(header.MediaType, "application/json", StringComparison.OrdinalIgnoreCase)))
        {
            httpClient.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        }

        if (!httpClient.DefaultRequestHeaders.Contains("OpenAI-Beta"))
        {
            httpClient.DefaultRequestHeaders.Add("OpenAI-Beta", "assistants=v2");
        }
    }

    private async Task<string> TryGetPricingHtmlAsync(CancellationToken cancellationToken)
    {
        try
        {
            return await _httpClient.GetStringAsync(PricingPageUrl, cancellationToken);
        }
        catch
        {
            return string.Empty;
        }
    }

    private static OpenAiHttpException CreateHttpException(HttpStatusCode statusCode, string body)
    {
        string? errorCode = null;
        string? errorMessage = null;
        string? errorType = null;
        string? errorParam = null;

        try
        {
            using var document = JsonDocument.Parse(body);
            if (document.RootElement.TryGetProperty("error", out var errorElement) &&
                errorElement.ValueKind == JsonValueKind.Object)
            {
                if (errorElement.TryGetProperty("code", out var codeElement) && codeElement.ValueKind == JsonValueKind.String)
                {
                    errorCode = codeElement.GetString();
                }

                if (errorElement.TryGetProperty("message", out var messageElement) && messageElement.ValueKind == JsonValueKind.String)
                {
                    errorMessage = messageElement.GetString();
                }

                if (errorElement.TryGetProperty("type", out var typeElement) && typeElement.ValueKind == JsonValueKind.String)
                {
                    errorType = typeElement.GetString();
                }

                if (errorElement.TryGetProperty("param", out var paramElement) && paramElement.ValueKind == JsonValueKind.String)
                {
                    errorParam = paramElement.GetString();
                }
            }
        }
        catch
        {
            // Keep the raw body when it is not valid JSON.
        }

        return new OpenAiHttpException(statusCode, body, errorCode, errorMessage, errorType, errorParam);
    }

    internal static JsonObject BuildResponsesPayload(
        AiRuntimeConfig config,
        IReadOnlyList<string> inputItemsJson,
        bool background,
        bool stream,
        PromptCaching.PromptCacheRequestSettings? promptCaching = null
    )
    {
        var payload = new JsonObject
        {
            ["model"] = string.IsNullOrWhiteSpace(config.Chat.Model?.Model) ? null : config.Chat.Model.Model,
            ["input"] = BuildInputArray(inputItemsJson),
            ["service_tier"] = MapServiceTier(config.Chat.Model?.Tier),
            ["background"] = background,
            ["stream"] = stream,
            ["store"] = true
        };

        if (!string.IsNullOrWhiteSpace(promptCaching?.CacheKey))
        {
            payload["prompt_cache_key"] = promptCaching.CacheKey;
        }

        if (!string.IsNullOrWhiteSpace(promptCaching?.RetentionApplied))
        {
            payload["prompt_cache_retention"] = promptCaching.RetentionApplied;
        }

        if (!string.IsNullOrWhiteSpace(config.Chat.Instructions))
        {
            payload["instructions"] = config.Chat.Instructions;
        }

        var textPayload = BuildTextFormatPayload(config.Chat.StructuredOutput);
        if (textPayload is not null)
        {
            payload["text"] = JsonSerializer.SerializeToNode(textPayload);
        }

        return payload;
    }

    internal static JsonObject BuildCompactPayload(
        AiModelSelection selection,
        IReadOnlyList<string> inputItemsJson,
        string instructions,
        PromptCaching.PromptCacheRequestSettings? promptCaching = null
    )
    {
        var payload = new JsonObject
        {
            ["model"] = selection.Model,
            ["input"] = BuildInputArray(inputItemsJson),
            ["instructions"] = string.IsNullOrWhiteSpace(instructions) ? null : instructions
        };

        if (!string.IsNullOrWhiteSpace(promptCaching?.CacheKey))
        {
            payload["prompt_cache_key"] = promptCaching.CacheKey;
        }

        return payload;
    }

    private static object? BuildTextFormatPayload(AiStructuredOutputConfig config)
    {
        var trimmedSchema = config.Schema.Trim();
        if (trimmedSchema.Length == 0)
        {
            return null;
        }

        JsonNode? parsedSchema;
        try
        {
            parsedSchema = JsonNode.Parse(trimmedSchema);
        }
        catch (Exception error)
        {
            throw new InvalidOperationException($"Structured output schema is invalid JSON: {error.Message}", error);
        }

        if (parsedSchema is not JsonObject schemaObject)
        {
            throw new InvalidOperationException("Structured output schema must be a JSON object.");
        }

        return new
        {
            format = new
            {
                type = "json_schema",
                name = string.IsNullOrWhiteSpace(config.Name) ? "chat_response" : config.Name.Trim(),
                description = string.IsNullOrWhiteSpace(config.Description) ? null : config.Description.Trim(),
                schema = schemaObject,
                strict = config.Strict
            }
        };
    }

    private static string MapServiceTier(string? serviceTier) =>
        string.Equals(serviceTier, "priority", StringComparison.OrdinalIgnoreCase)
            ? "priority"
            : string.Equals(serviceTier, "flex", StringComparison.OrdinalIgnoreCase)
                ? "flex"
                : "default";

    private static string? NormalizeApiKey(string? apiKey)
    {
        var trimmedApiKey = apiKey?.Trim();
        return string.IsNullOrWhiteSpace(trimmedApiKey) ? null : trimmedApiKey;
    }

    private static JsonArray BuildInputArray(IReadOnlyList<string> inputItemsJson)
    {
        var array = new JsonArray();
        foreach (var itemJson in inputItemsJson)
        {
            if (string.IsNullOrWhiteSpace(itemJson))
            {
                continue;
            }

            if (JsonNode.Parse(itemJson) is JsonNode node)
            {
                array.Add(node);
            }
        }

        return array;
    }

    internal sealed class OpenAiHttpException : InvalidOperationException
    {
        public OpenAiHttpException(
            HttpStatusCode statusCode,
            string responseBody,
            string? errorCode,
            string? errorMessage,
            string? errorType,
            string? errorParam
        )
            : base($"OpenAI HTTP {(int)statusCode}: {responseBody}")
        {
            StatusCode = statusCode;
            ResponseBody = responseBody;
            ErrorCode = errorCode;
            ErrorMessage = errorMessage;
            ErrorType = errorType;
            ErrorParam = errorParam;
        }

        public HttpStatusCode StatusCode { get; }

        public string ResponseBody { get; }

        public string? ErrorCode { get; }

        public string? ErrorMessage { get; }

        public string? ErrorType { get; }

        public string? ErrorParam { get; }
    }
}

internal sealed record OpenAiJsonResponse(JsonDocument Document, AiRateLimitSnapshot RateLimits)
{
    public static async Task<OpenAiJsonResponse> FromHttpResponseAsync(
        HttpResponseMessage response,
        CancellationToken cancellationToken
    )
    {
        var content = await response.Content.ReadAsStringAsync(cancellationToken);
        return new OpenAiJsonResponse(
            JsonDocument.Parse(content),
            OpenAiHeaderParser.ParseRateLimitHeaders(response)
        );
    }
}

internal sealed class OpenAiStreamResponse : IOpenAiStreamResponse
{
    private readonly HttpResponseMessage _response;
    private readonly StreamReader _reader;

    private OpenAiStreamResponse(HttpResponseMessage response, StreamReader reader, AiRateLimitSnapshot rateLimits)
    {
        _response = response;
        _reader = reader;
        RateLimits = rateLimits;
    }

    public AiRateLimitSnapshot RateLimits { get; }

    public static async Task<OpenAiStreamResponse> CreateAsync(
        HttpResponseMessage response,
        CancellationToken cancellationToken
    )
    {
        var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        return new OpenAiStreamResponse(
            response,
            new StreamReader(stream, Encoding.UTF8, detectEncodingFromByteOrderMarks: false, leaveOpen: false),
            OpenAiHeaderParser.ParseRateLimitHeaders(response)
        );
    }

    public async IAsyncEnumerable<OpenAiSseEvent> ReadEventsAsync(
        [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken cancellationToken
    )
    {
        string? eventName = null;
        var dataLines = new List<string>();

        while (!cancellationToken.IsCancellationRequested && !_reader.EndOfStream)
        {
            var line = await _reader.ReadLineAsync(cancellationToken);
            if (line is null)
            {
                break;
            }

            if (line.Length == 0)
            {
                if (eventName is not null && dataLines.Count > 0)
                {
                    var json = string.Join("\n", dataLines);
                    using var document = JsonDocument.Parse(json);
                    yield return new OpenAiSseEvent(eventName, document.RootElement.Clone());
                }

                eventName = null;
                dataLines.Clear();
                continue;
            }

            if (line.StartsWith("event:", StringComparison.Ordinal))
            {
                eventName = line["event:".Length..].Trim();
                continue;
            }

            if (line.StartsWith("data:", StringComparison.Ordinal))
            {
                dataLines.Add(line["data:".Length..].TrimStart());
            }
        }
    }

    public ValueTask DisposeAsync()
    {
        _reader.Dispose();
        _response.Dispose();
        return ValueTask.CompletedTask;
    }
}

internal sealed record OpenAiSseEvent(string EventName, JsonElement Data);

internal static class OpenAiHeaderParser
{
    public static AiRateLimitSnapshot ParseRateLimitHeaders(HttpResponseMessage response)
    {
        return new AiRateLimitSnapshot
        {
            ServerLimitRequests = ReadIntHeader(response, "x-ratelimit-limit-requests"),
            ServerLimitTokens = ReadIntHeader(response, "x-ratelimit-limit-tokens"),
            ServerRemainingRequests = ReadIntHeader(response, "x-ratelimit-remaining-requests"),
            ServerRemainingTokens = ReadIntHeader(response, "x-ratelimit-remaining-tokens"),
            ServerResetRequests = ReadStringHeader(response, "x-ratelimit-reset-requests"),
            ServerResetTokens = ReadStringHeader(response, "x-ratelimit-reset-tokens")
        };
    }

    private static int? ReadIntHeader(HttpResponseMessage response, string name)
    {
        return response.Headers.TryGetValues(name, out var values) &&
               int.TryParse(values.FirstOrDefault(), out var parsedValue)
            ? parsedValue
            : null;
    }

    private static string? ReadStringHeader(HttpResponseMessage response, string name)
    {
        return response.Headers.TryGetValues(name, out var values)
            ? values.FirstOrDefault()
            : null;
    }
}
