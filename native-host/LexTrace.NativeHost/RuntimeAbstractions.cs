namespace LexTrace.NativeHost;

internal interface INativeMessagingTransport
{
    Task SendAsync(object payload, CancellationToken cancellationToken);
}

internal interface IHostStateStore
{
    Task<HostJournal> LoadAsync(CancellationToken cancellationToken);

    Task SaveAsync(HostJournal journal, CancellationToken cancellationToken);
}

internal interface IOpenAiStreamResponse : IAsyncDisposable
{
    AiRateLimitSnapshot RateLimits { get; }

    IAsyncEnumerable<OpenAiSseEvent> ReadEventsAsync(CancellationToken cancellationToken);
}

internal interface IOpenAiClient
{
    bool HasApiKey { get; }

    void ReloadApiKeyFromEnvironment();

    void ConfigureManagedApiKey(string? apiKey);

    Task<OpenAiModelCatalogResult> ListChatModelsAsync(CancellationToken cancellationToken);

    Task<OpenAiJsonResponse> CreateResponseAsync(
        AiRuntimeConfig config,
        IReadOnlyList<string> inputItemsJson,
        bool background,
        bool stream,
        PromptCaching.PromptCacheRequestSettings? promptCaching,
        CancellationToken cancellationToken
    );

    Task<IOpenAiStreamResponse> CreateResponseStreamAsync(
        AiRuntimeConfig config,
        IReadOnlyList<string> inputItemsJson,
        bool background,
        PromptCaching.PromptCacheRequestSettings? promptCaching,
        CancellationToken cancellationToken
    );

    Task<OpenAiJsonResponse> RetrieveResponseAsync(string responseId, CancellationToken cancellationToken);

    Task<IOpenAiStreamResponse> ResumeResponseStreamAsync(
        string responseId,
        int? startingAfter,
        CancellationToken cancellationToken
    );

    Task<OpenAiJsonResponse> CancelResponseAsync(string responseId, CancellationToken cancellationToken);

    Task<OpenAiJsonResponse> CompactAsync(
        AiModelSelection selection,
        IReadOnlyList<string> inputItemsJson,
        string instructions,
        PromptCaching.PromptCacheRequestSettings? promptCaching,
        CancellationToken cancellationToken
    );

    Task<AiRateLimitSnapshot> ProbeRateLimitsAsync(
        AiModelSelection selection,
        CancellationToken cancellationToken
    );
}
