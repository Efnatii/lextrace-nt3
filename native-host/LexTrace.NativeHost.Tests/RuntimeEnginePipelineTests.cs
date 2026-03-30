using System.Text.Json;
using Xunit;

namespace LexTrace.NativeHost.Tests;

public sealed class RuntimeEnginePipelineTests
{
    [Fact]
    public async Task RequestResponseRoundTripCompletesAndPersistsContext()
    {
        var transport = new FakeTransport();
        var store = new FakeHostStateStore();
        var client = new FakeOpenAiClient
        {
            CreateResponseAsyncHandler = (config, inputItems, _, _, promptCaching, _) =>
            {
                Assert.Equal("stable_session_prefix", promptCaching?.RoutingApplied);
                return Task.FromResult(CreateCompletedChatResponse("resp_roundtrip", "EDGE_PIPELINE_OK"));
            }
        };
        var runtime = new RuntimeEngine(transport, store, client);
        const string pageKey = "https://example.com/chat";

        await runtime.InitializeAsync(CancellationToken.None);
        await SyncChatConfigAsync(runtime, streamingEnabled: false, compactionEnabled: false);

        await ExecuteAsync(runtime, "ai.chat.send", new
        {
            pageKey,
            pageUrl = pageKey,
            origin = "user",
            text = "Reply with EDGE_PIPELINE_OK."
        });

        var session = await WaitForSessionAsync(
            runtime,
            pageKey,
            candidate => GetRequestState(candidate) == "idle" &&
                         GetAssistantTexts(candidate).Contains("EDGE_PIPELINE_OK"));

        Assert.Single(client.ChatCalls);
        Assert.Contains("Reply with EDGE_PIPELINE_OK.", FlattenInputText(client.ChatCalls[0].InputItemsJson));
        Assert.Equal(2, GetMessages(session).GetArrayLength());

        var storedSession = store.FindSession(pageKey);
        Assert.NotNull(storedSession);
        Assert.Equal(2, storedSession!.CanonicalContextJsonItems.Count);
        Assert.Contains("Reply with EDGE_PIPELINE_OK.", string.Join("\n", storedSession.CanonicalContextJsonItems));
        Assert.True(transport.SentPayloads.Count > 0);
    }

    [Fact]
    public async Task QueueProcessesRequestsSequentiallyOnTheSamePage()
    {
        var firstCallStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseFirstCall = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var transport = new FakeTransport();
        var store = new FakeHostStateStore();
        var client = new FakeOpenAiClient
        {
            CreateResponseAsyncHandler = async (_, inputItems, _, _, _, cancellationToken) =>
            {
                var lastUserText = ExtractLastUserText(inputItems);
                if (lastUserText.Contains("FIRST", StringComparison.Ordinal))
                {
                    firstCallStarted.TrySetResult();
                    await releaseFirstCall.Task.WaitAsync(cancellationToken);
                    return CreateCompletedChatResponse("resp_first", "EDGE_QUEUE_FIRST_OK");
                }

                return CreateCompletedChatResponse("resp_second", "EDGE_QUEUE_SECOND_OK");
            }
        };
        var runtime = new RuntimeEngine(transport, store, client);
        const string pageKey = "https://example.com/queue";

        await runtime.InitializeAsync(CancellationToken.None);
        await SyncChatConfigAsync(runtime, streamingEnabled: false, compactionEnabled: false);

        await ExecuteAsync(runtime, "ai.chat.send", new
        {
            pageKey,
            pageUrl = pageKey,
            origin = "user",
            text = "Reply with EDGE_QUEUE_FIRST_OK and label FIRST."
        });
        await firstCallStarted.Task.WaitAsync(CancellationToken.None);

        await ExecuteAsync(runtime, "ai.chat.send", new
        {
            pageKey,
            pageUrl = pageKey,
            origin = "user",
            text = "Reply with EDGE_QUEUE_SECOND_OK and label SECOND."
        });

        var queuedSession = await WaitForSessionAsync(
            runtime,
            pageKey,
            candidate => GetRequestState(candidate) == "running" && GetQueueCount(candidate) == 1);
        Assert.Equal(1, GetQueueCount(queuedSession));

        releaseFirstCall.TrySetResult();

        var completedSession = await WaitForSessionAsync(
            runtime,
            pageKey,
            candidate => GetRequestState(candidate) == "idle" &&
                         GetAssistantTexts(candidate).Contains("EDGE_QUEUE_FIRST_OK") &&
                         GetAssistantTexts(candidate).Contains("EDGE_QUEUE_SECOND_OK"));

        Assert.Equal(2, client.ChatCalls.Count);
        Assert.Contains("FIRST", ExtractLastUserText(client.ChatCalls[0].InputItemsJson));
        Assert.Contains("SECOND", ExtractLastUserText(client.ChatCalls[1].InputItemsJson));
        Assert.Equal(0, GetQueueCount(completedSession));
    }

    [Fact]
    public async Task QueuedRequestsKeepUserAndAssistantMessagesPairedWhileWaiting()
    {
        var firstCallStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseFirstCall = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var client = new FakeOpenAiClient
        {
            CreateResponseAsyncHandler = async (_, inputItems, _, _, _, cancellationToken) =>
            {
                var lastUserText = ExtractLastUserText(inputItems);
                if (lastUserText.Contains("FIRST", StringComparison.Ordinal))
                {
                    firstCallStarted.TrySetResult();
                    await releaseFirstCall.Task.WaitAsync(cancellationToken);
                    return CreateCompletedChatResponse("resp_first_placeholder", "EDGE_QUEUE_PLACEHOLDER_FIRST_OK");
                }

                return CreateCompletedChatResponse("resp_second_placeholder", "EDGE_QUEUE_PLACEHOLDER_SECOND_OK");
            }
        };
        var runtime = new RuntimeEngine(new FakeTransport(), new FakeHostStateStore(), client);
        const string pageKey = "https://example.com/queue-placeholders";

        await runtime.InitializeAsync(CancellationToken.None);
        await SyncChatConfigAsync(runtime, streamingEnabled: false, compactionEnabled: false);

        await ExecuteAsync(runtime, "ai.chat.send", new
        {
            pageKey,
            pageUrl = pageKey,
            origin = "user",
            text = "Reply with EDGE_QUEUE_PLACEHOLDER_FIRST_OK and label FIRST."
        });
        await firstCallStarted.Task.WaitAsync(CancellationToken.None);

        await ExecuteAsync(runtime, "ai.chat.send", new
        {
            pageKey,
            pageUrl = pageKey,
            origin = "user",
            text = "Reply with EDGE_QUEUE_PLACEHOLDER_SECOND_OK and label SECOND."
        });

        var queuedSession = await WaitForSessionAsync(
            runtime,
            pageKey,
            candidate => GetRequestState(candidate) == "running" &&
                         GetQueueCount(candidate) == 1 &&
                         GetMessages(candidate).GetArrayLength() == 4);

        var queuedMessages = GetMessages(queuedSession).EnumerateArray().ToArray();
        Assert.Equal(["user", "assistant", "user", "assistant"], queuedMessages.Select(message => GetNullableString(message, "origin") ?? string.Empty).ToArray());
        Assert.Equal(GetNullableString(queuedMessages[0], "requestId"), GetNullableString(queuedMessages[1], "requestId"));
        Assert.Equal(GetNullableString(queuedMessages[2], "requestId"), GetNullableString(queuedMessages[3], "requestId"));
        Assert.Equal(string.Empty, GetNullableString(queuedMessages[3], "text") ?? string.Empty);
        Assert.Equal("pending", GetNullableString(queuedMessages[3], "state"));

        releaseFirstCall.TrySetResult();

        var completedSession = await WaitForSessionAsync(
            runtime,
            pageKey,
            candidate => GetRequestState(candidate) == "idle" &&
                         GetAssistantTexts(candidate).Contains("EDGE_QUEUE_PLACEHOLDER_FIRST_OK") &&
                         GetAssistantTexts(candidate).Contains("EDGE_QUEUE_PLACEHOLDER_SECOND_OK"));

        var completedMessages = GetMessages(completedSession).EnumerateArray().ToArray();
        Assert.Equal(["user", "assistant", "user", "assistant"], completedMessages.Select(message => GetNullableString(message, "origin") ?? string.Empty).ToArray());
        Assert.Equal(["EDGE_QUEUE_PLACEHOLDER_FIRST_OK", "EDGE_QUEUE_PLACEHOLDER_SECOND_OK"], GetAssistantTexts(completedSession));
    }

    [Fact]
    public async Task ResetWaitsForCancellationCancelsProviderAndAllowsFreshRequest()
    {
        var cleanupStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseCleanup = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var transport = new FakeTransport();
        var store = new FakeHostStateStore();
        var client = new FakeOpenAiClient
        {
            CreateResponseStreamAsyncHandler = (_, inputItems, _, _, cancellationToken) =>
            {
                var lastUserText = ExtractLastUserText(inputItems);
                if (lastUserText.Contains("FIRST", StringComparison.Ordinal))
                {
                    return Task.FromResult<IOpenAiStreamResponse>(
                        new FakeOpenAiStreamResponse(
                            token => ReadBlockingResetStreamAsync("resp_reset", cleanupStarted, releaseCleanup, token),
                            cancellationToken));
                }

                return Task.FromResult<IOpenAiStreamResponse>(
                    new FakeOpenAiStreamResponse(
                        token => ReadCompletedStreamAsync("resp_second", "EDGE_RESET_SECOND_OK", token),
                        cancellationToken));
            }
        };
        var runtime = new RuntimeEngine(transport, store, client);
        const string pageKey = "https://example.com/reset";

        await runtime.InitializeAsync(CancellationToken.None);
        await SyncChatConfigAsync(runtime, streamingEnabled: true, compactionEnabled: false);

        await ExecuteAsync(runtime, "ai.chat.send", new
        {
            pageKey,
            pageUrl = pageKey,
            origin = "user",
            text = "Reply with EDGE_RESET_FIRST_OK and label FIRST."
        });

        await WaitForSessionAsync(
            runtime,
            pageKey,
            candidate => GetRequestState(candidate) == "streaming" &&
                         GetOpenAiResponseId(candidate) == "resp_reset");

        var resetTask = ExecuteAsync(runtime, "ai.chat.reset", new { pageKey });
        await cleanupStarted.Task.WaitAsync(CancellationToken.None);
        Assert.False(resetTask.IsCompleted, "Reset returned before the cancelled request fully stopped.");

        releaseCleanup.TrySetResult();
        await resetTask;

        Assert.Contains("resp_reset", client.CancelledResponseIds);

        await ExecuteAsync(runtime, "ai.chat.send", new
        {
            pageKey,
            pageUrl = pageKey,
            origin = "user",
            text = "Reply with EDGE_RESET_SECOND_OK and label SECOND."
        });

        var completedSession = await WaitForSessionAsync(
            runtime,
            pageKey,
            candidate => GetRequestState(candidate) == "idle" &&
                         GetAssistantTexts(candidate).SequenceEqual(["EDGE_RESET_SECOND_OK"]));

        Assert.Equal(2, client.ChatCalls.Count);
        Assert.DoesNotContain("EDGE_RESET_FIRST_OK", string.Join("\n", GetAssistantTexts(completedSession)));
        Assert.Equal(0, GetQueueCount(completedSession));
    }

    [Fact]
    public async Task TransientTransportFailureAutoRetriesAndCompletesWithoutDuplicateTranscript()
    {
        var attempt = 0;
        var transport = new FakeTransport();
        var store = new FakeHostStateStore();
        var client = new FakeOpenAiClient
        {
            CreateResponseAsyncHandler = (_, _, _, _, _, _) =>
            {
                attempt += 1;
                if (attempt == 1)
                {
                    throw new HttpRequestException("temporary network failure");
                }

                return Task.FromResult(CreateCompletedChatResponse("resp_retry", "EDGE_RETRY_OK"));
            }
        };
        var runtime = new RuntimeEngine(transport, store, client);
        const string pageKey = "https://example.com/retry";

        await runtime.InitializeAsync(CancellationToken.None);
        await SyncChatConfigAsync(
            runtime,
            streamingEnabled: false,
            compactionEnabled: false,
            retries: new { maxRetries = 1, baseDelayMs = 1, maxDelayMs = 1 });

        await ExecuteAsync(runtime, "ai.chat.send", new
        {
            pageKey,
            pageUrl = pageKey,
            origin = "user",
            text = "Reply with EDGE_RETRY_OK."
        });

        var completedSession = await WaitForSessionAsync(
            runtime,
            pageKey,
            candidate => GetRequestState(candidate) == "idle" &&
                         GetAssistantTexts(candidate).Contains("EDGE_RETRY_OK"));

        Assert.Equal(2, client.ChatCalls.Count);
        Assert.Equal(1, CountMessagesByOrigin(completedSession, "user"));
        Assert.Equal(1, CountMessagesByOrigin(completedSession, "assistant"));
        Assert.Null(GetNullableString(completedSession, "status", "lastError"));
    }

    [Fact]
    public async Task FailedBackgroundResponsesAutoRetryAndCompleteWithoutDuplicateTranscript()
    {
        var attempt = 0;
        var transport = new FakeTransport();
        var store = new FakeHostStateStore();
        var client = new FakeOpenAiClient
        {
            CreateResponseStreamAsyncHandler = (_, _, _, _, cancellationToken) =>
            {
                attempt += 1;
                if (attempt == 1)
                {
                    return Task.FromResult<IOpenAiStreamResponse>(
                        new FakeOpenAiStreamResponse(
                            token => ReadFailedStreamAsync(
                                "resp_failed_once",
                                "server_error",
                                "Temporary upstream failure",
                                token),
                            cancellationToken));
                }

                return Task.FromResult<IOpenAiStreamResponse>(
                    new FakeOpenAiStreamResponse(
                        token => ReadCompletedStreamAsync("resp_failed_retry", "EDGE_FAILED_RETRY_OK", token),
                        cancellationToken));
            }
        };
        var runtime = new RuntimeEngine(transport, store, client);
        const string pageKey = "https://example.com/failed-retry";

        await runtime.InitializeAsync(CancellationToken.None);
        await SyncChatConfigAsync(
            runtime,
            streamingEnabled: true,
            compactionEnabled: false,
            retries: new { maxRetries = 1, baseDelayMs = 1, maxDelayMs = 1 });

        await ExecuteAsync(runtime, "ai.chat.send", new
        {
            pageKey,
            pageUrl = pageKey,
            origin = "user",
            text = "Reply with EDGE_FAILED_RETRY_OK."
        });

        var completedSession = await WaitForSessionAsync(
            runtime,
            pageKey,
            candidate => GetRequestState(candidate) == "idle" &&
                         GetAssistantTexts(candidate).Contains("EDGE_FAILED_RETRY_OK"));

        Assert.Equal(2, client.ChatCalls.Count);
        Assert.Equal(1, CountMessagesByOrigin(completedSession, "user"));
        Assert.Equal(1, CountMessagesByOrigin(completedSession, "assistant"));
        Assert.Null(GetNullableString(completedSession, "status", "lastError"));
    }

    [Fact]
    public async Task SingleRequestsKeepUsingGlobalRetryPolicyWhenQueueOverrideExists()
    {
        var attempt = 0;
        var runtime = new RuntimeEngine(new FakeTransport(), new FakeHostStateStore(), new FakeOpenAiClient
        {
            CreateResponseAsyncHandler = (_, _, _, _, _, _) =>
            {
                attempt += 1;
                throw new HttpRequestException("temporary network failure");
            }
        });
        const string pageKey = "https://example.com/single-retry-policy";

        await runtime.InitializeAsync(CancellationToken.None);
        await SyncChatConfigAsync(
            runtime,
            streamingEnabled: false,
            compactionEnabled: false,
            retries: new { maxRetries = 0, baseDelayMs = 1, maxDelayMs = 1 },
            queueRetries: new { maxRetries = 1, baseDelayMs = 1, maxDelayMs = 1 });

        await ExecuteAsync(runtime, "ai.chat.send", new
        {
            pageKey,
            pageUrl = pageKey,
            origin = "user",
            text = "Reply with EDGE_SINGLE_POLICY_OK."
        });

        var pausedSession = await WaitForSessionAsync(
            runtime,
            pageKey,
            candidate => GetRequestState(candidate) == "paused");

        Assert.Equal(1, attempt);
        Assert.Equal("temporary network failure", GetNullableString(pausedSession, "status", "lastError"));
        Assert.Equal(1, CountMessagesByOrigin(pausedSession, "user"));
        Assert.Equal(1, CountMessagesByOrigin(pausedSession, "assistant"));
    }

    [Fact]
    public async Task QueuedRequestsUseQueueRetryPolicyOverride()
    {
        var firstStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseFirst = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var secondAttempts = 0;
        var client = new FakeOpenAiClient
        {
            CreateResponseAsyncHandler = async (_, inputItems, _, _, _, cancellationToken) =>
            {
                var lastUserText = ExtractLastUserText(inputItems);
                if (lastUserText.Contains("FIRST", StringComparison.Ordinal))
                {
                    firstStarted.TrySetResult();
                    await releaseFirst.Task.WaitAsync(cancellationToken);
                    return CreateCompletedChatResponse("resp_first_policy", "EDGE_QUEUE_POLICY_FIRST_OK");
                }

                secondAttempts += 1;
                if (secondAttempts == 1)
                {
                    throw new HttpRequestException("temporary network failure");
                }

                return CreateCompletedChatResponse("resp_second_policy", "EDGE_QUEUE_POLICY_SECOND_OK");
            }
        };
        var runtime = new RuntimeEngine(new FakeTransport(), new FakeHostStateStore(), client);
        const string pageKey = "https://example.com/queue-retry-policy";

        await runtime.InitializeAsync(CancellationToken.None);
        await SyncChatConfigAsync(
            runtime,
            streamingEnabled: false,
            compactionEnabled: false,
            retries: new { maxRetries = 0, baseDelayMs = 1, maxDelayMs = 1 },
            queueRetries: new { maxRetries = 1, baseDelayMs = 1, maxDelayMs = 1 });

        await ExecuteAsync(runtime, "ai.chat.send", new
        {
            pageKey,
            pageUrl = pageKey,
            origin = "user",
            text = "Reply with EDGE_QUEUE_POLICY_FIRST_OK and label FIRST."
        });
        await firstStarted.Task.WaitAsync(CancellationToken.None);

        await ExecuteAsync(runtime, "ai.chat.send", new
        {
            pageKey,
            pageUrl = pageKey,
            origin = "user",
            text = "Reply with EDGE_QUEUE_POLICY_SECOND_OK and label SECOND."
        });

        await WaitForSessionAsync(
            runtime,
            pageKey,
            candidate => GetRequestState(candidate) == "running" && GetQueueCount(candidate) == 1);

        releaseFirst.TrySetResult();

        var completedSession = await WaitForSessionAsync(
            runtime,
            pageKey,
            candidate => GetRequestState(candidate) == "idle" &&
                         GetAssistantTexts(candidate).Contains("EDGE_QUEUE_POLICY_FIRST_OK") &&
                         GetAssistantTexts(candidate).Contains("EDGE_QUEUE_POLICY_SECOND_OK"));

        Assert.Equal(3, client.ChatCalls.Count);
        Assert.Equal(2, CountMessagesByOrigin(completedSession, "user"));
        Assert.Equal(2, CountMessagesByOrigin(completedSession, "assistant"));
        Assert.Equal(2, secondAttempts);
        Assert.Null(GetNullableString(completedSession, "status", "lastError"));
    }

    [Fact]
    public async Task WrappedResponseEndedStreamFailureAutoResumesAndCompletes()
    {
        var store = new FakeHostStateStore();
        var client = new FakeOpenAiClient
        {
            CreateResponseStreamAsyncHandler = (_, _, _, _, cancellationToken) =>
                Task.FromResult<IOpenAiStreamResponse>(
                    new FakeOpenAiStreamResponse(
                        token => ReadResponseEndedStreamAsync("resp_response_ended", token),
                        cancellationToken)),
            ResumeResponseStreamAsyncHandler = (responseId, _, cancellationToken) =>
                Task.FromResult<IOpenAiStreamResponse>(
                    new FakeOpenAiStreamResponse(
                        token => ReadCompletedStreamAsync(responseId, "EDGE_RESPONSE_ENDED_OK", token),
                        cancellationToken))
        };
        var runtime = new RuntimeEngine(new FakeTransport(), store, client);
        const string pageKey = "https://example.com/response-ended";

        await runtime.InitializeAsync(CancellationToken.None);
        await SyncChatConfigAsync(
            runtime,
            streamingEnabled: true,
            compactionEnabled: false,
            retries: new { maxRetries = 1, baseDelayMs = 1, maxDelayMs = 1 });

        await ExecuteAsync(runtime, "ai.chat.send", new
        {
            pageKey,
            pageUrl = pageKey,
            origin = "user",
            text = "Reply with EDGE_RESPONSE_ENDED_OK."
        });

        var completedSession = await WaitForSessionAsync(
            runtime,
            pageKey,
            candidate => GetRequestState(candidate) == "idle" &&
                         GetAssistantTexts(candidate).Contains("EDGE_RESPONSE_ENDED_OK"));

        Assert.Single(client.ResumeCalls);
        Assert.Equal("resp_response_ended", client.ResumeCalls[0].ResponseId);
        Assert.Equal(1, client.ResumeCalls[0].StartingAfter);
        Assert.Equal(1, CountMessagesByOrigin(completedSession, "user"));
        Assert.Equal(1, CountMessagesByOrigin(completedSession, "assistant"));
        Assert.Null(GetNullableString(completedSession, "status", "lastError"));
    }

    [Fact]
    public async Task HostRestartAutoResumesStreamingResponseFromPersistedState()
    {
        var streamCancelled = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var store = new FakeHostStateStore();
        var firstClient = new FakeOpenAiClient
        {
            CreateResponseStreamAsyncHandler = (_, _, _, _, cancellationToken) =>
                Task.FromResult<IOpenAiStreamResponse>(
                    new FakeOpenAiStreamResponse(
                        token => ReadStreamingUntilShutdownAsync("resp_resume", streamCancelled, token),
                        cancellationToken))
        };
        var firstRuntime = new RuntimeEngine(new FakeTransport(), store, firstClient);
        const string pageKey = "https://example.com/recover";

        await firstRuntime.InitializeAsync(CancellationToken.None);
        await SyncChatConfigAsync(firstRuntime, streamingEnabled: true, compactionEnabled: false);

        await ExecuteAsync(firstRuntime, "ai.chat.send", new
        {
            pageKey,
            pageUrl = pageKey,
            origin = "user",
            text = "Reply with EDGE_RESUME_OK."
        });

        await WaitForSessionAsync(
            firstRuntime,
            pageKey,
            candidate => GetRequestState(candidate) == "streaming" &&
                         GetOpenAiResponseId(candidate) == "resp_resume");

        await firstRuntime.ShutdownAsync(CancellationToken.None);
        await streamCancelled.Task.WaitAsync(CancellationToken.None);

        var secondClient = new FakeOpenAiClient
        {
            ResumeResponseStreamAsyncHandler = (responseId, _, cancellationToken) =>
                Task.FromResult<IOpenAiStreamResponse>(
                    new FakeOpenAiStreamResponse(
                        token => ReadCompletedStreamAsync(responseId, "EDGE_RESUME_OK", token),
                        cancellationToken))
        };
        var secondRuntime = new RuntimeEngine(new FakeTransport(), store, secondClient);

        await secondRuntime.InitializeAsync(CancellationToken.None);

        var completedSession = await WaitForSessionAsync(
            secondRuntime,
            pageKey,
            candidate => GetRequestState(candidate) == "idle" &&
                         GetAssistantTexts(candidate).Contains("EDGE_RESUME_OK"));

        Assert.Single(secondClient.ResumeCalls);
        Assert.Equal("resp_resume", secondClient.ResumeCalls[0].ResponseId);
        Assert.Equal(1, CountMessagesByOrigin(completedSession, "user"));
        Assert.Equal(1, CountMessagesByOrigin(completedSession, "assistant"));

        await secondRuntime.ShutdownAsync(CancellationToken.None);
    }

    [Fact]
    public async Task ParallelPagesStayIndependentWhileOnePageIsReset()
    {
        var pageAStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var pageBStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var releasePageA = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var releasePageB = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var store = new FakeHostStateStore();
        var client = new FakeOpenAiClient
        {
            CreateResponseAsyncHandler = async (_, inputItems, _, _, _, cancellationToken) =>
            {
                var lastUserText = ExtractLastUserText(inputItems);
                if (lastUserText.Contains("PAGE_A", StringComparison.Ordinal))
                {
                    pageAStarted.TrySetResult();
                    await releasePageA.Task.WaitAsync(cancellationToken);
                    return CreateCompletedChatResponse("resp_a", "EDGE_PAGE_A_OK");
                }

                pageBStarted.TrySetResult();
                await releasePageB.Task.WaitAsync(cancellationToken);
                return CreateCompletedChatResponse("resp_b", "EDGE_PAGE_B_OK");
            }
        };
        var runtime = new RuntimeEngine(new FakeTransport(), store, client);
        const string pageKeyA = "https://example.com/page-a";
        const string pageKeyB = "https://example.com/page-b";

        await runtime.InitializeAsync(CancellationToken.None);
        await SyncChatConfigAsync(runtime, streamingEnabled: false, compactionEnabled: false);

        await ExecuteAsync(runtime, "ai.chat.send", new
        {
            pageKey = pageKeyA,
            pageUrl = pageKeyA,
            origin = "user",
            text = "Reply with EDGE_PAGE_A_OK and label PAGE_A."
        });
        await ExecuteAsync(runtime, "ai.chat.send", new
        {
            pageKey = pageKeyB,
            pageUrl = pageKeyB,
            origin = "user",
            text = "Reply with EDGE_PAGE_B_OK and label PAGE_B."
        });

        await Task.WhenAll(pageAStarted.Task, pageBStarted.Task).WaitAsync(CancellationToken.None);

        releasePageB.TrySetResult();
        var completedPageB = await WaitForSessionAsync(
            runtime,
            pageKeyB,
            candidate => GetRequestState(candidate) == "idle" &&
                         GetAssistantTexts(candidate).Contains("EDGE_PAGE_B_OK"));

        await ExecuteAsync(runtime, "ai.chat.reset", new { pageKey = pageKeyA });
        releasePageA.TrySetResult();

        var resetPageA = await WaitForSessionAsync(
            runtime,
            pageKeyA,
            candidate => GetRequestState(candidate) == "idle" && GetMessages(candidate).GetArrayLength() == 0);

        Assert.Contains("EDGE_PAGE_B_OK", GetAssistantTexts(completedPageB));
        Assert.Equal(0, GetMessages(resetPageA).GetArrayLength());
        Assert.Contains("EDGE_PAGE_B_OK", GetAssistantTexts(await GetSessionAsync(runtime, pageKeyB)));
    }

    [Fact]
    public async Task ProviderRequestLogsCaptureSerializedChatAndCompactionJson()
    {
        var transport = new FakeTransport();
        var client = new FakeOpenAiClient
        {
            CreateResponseAsyncHandler = (_, _, _, _, _, _) =>
                Task.FromResult(CreateCompletedChatResponse("resp_provider_logs", new string('p', 2400))),
            CompactAsyncHandler = (_, _, _, _, _) =>
                Task.FromResult(CreateCompactionResponse("summary-pass-1", cachedTokens: 1536))
        };
        var runtime = new RuntimeEngine(transport, new FakeHostStateStore(), client);
        const string pageKey = "https://example.com/provider-logs";

        await runtime.InitializeAsync(CancellationToken.None);
        await SyncChatConfigAsync(
            runtime,
            streamingEnabled: false,
            compactionEnabled: true,
            compaction: new
            {
                enabled = true,
                triggerPromptTokens = 1,
                preserveRecentTurns = 0,
                maxPassesPerPage = 1
            });

        await ExecuteAsync(runtime, "ai.chat.send", new
        {
            pageKey,
            pageUrl = pageKey,
            origin = "user",
            text = "Reply with EDGE_PROVIDER_LOGS_OK."
        });

        await WaitForSessionAsync(
            runtime,
            pageKey,
            candidate => GetRequestState(candidate) == "idle" &&
                         CountMessagesByOrigin(candidate, "assistant") == 1);

        var compactionResponse = await ExecuteAsync(runtime, "ai.chat.compact", new
        {
            pageKey,
            pageUrl = pageKey
        });

        Assert.True(compactionResponse.GetProperty("triggered").GetBoolean());
        Assert.Single(client.CompactionCalls);

        var chatLog = GetRuntimeLogEntry(transport, "ai.provider.request.chat");
        Assert.Equal("POST", GetNullableString(chatLog, "details", "method"));
        Assert.Equal("/v1/responses", GetNullableString(chatLog, "details", "endpoint"));
        var chatBody = GetRequiredProperty(chatLog, "details", "body");
        Assert.Equal("gpt-5-mini", GetNullableString(chatBody, "model"));
        Assert.Equal(JsonValueKind.Array, GetRequiredProperty(chatBody, "input").ValueKind);
        Assert.DoesNotContain("sk-", chatBody.GetRawText(), StringComparison.OrdinalIgnoreCase);

        var compactionLog = GetRuntimeLogEntry(transport, "ai.provider.request.compaction");
        Assert.Equal("POST", GetNullableString(compactionLog, "details", "method"));
        Assert.Equal("/v1/responses/compact", GetNullableString(compactionLog, "details", "endpoint"));
        var compactionBody = GetRequiredProperty(compactionLog, "details", "body");
        Assert.Equal("gpt-5-mini", GetNullableString(compactionBody, "model"));
        Assert.StartsWith("Summarize the conversation history", GetNullableString(compactionBody, "instructions") ?? string.Empty, StringComparison.Ordinal);
        Assert.Equal(JsonValueKind.Array, GetRequiredProperty(compactionBody, "input").ValueKind);
        Assert.DoesNotContain("authorization", compactionBody.GetRawText(), StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task CompactionAfterThreePassesUsesSummariesInsteadOfCompactedRawTurnsAndRotatesPromptCacheEpoch()
    {
        var compactionPass = 0;
        var store = new FakeHostStateStore();
        FakeOpenAiClient? client = null;
        client = new FakeOpenAiClient
        {
            CreateResponseAsyncHandler = (_, _, _, _, promptCaching, _) =>
            {
                var replyToken = $"assistant-{client!.ChatCalls.Count + 1}";
                Assert.NotNull(promptCaching?.CacheKey);
                return Task.FromResult(CreateCompletedChatResponse($"resp_{client!.ChatCalls.Count + 1}", replyToken));
            },
            CompactAsyncHandler = (_, _, _, promptCaching, _) =>
            {
                compactionPass += 1;
                Assert.NotNull(promptCaching?.CacheKey);
                return Task.FromResult(CreateCompactionResponse($"summary-pass-{compactionPass}", cachedTokens: 1536));
            }
        };
        var runtime = new RuntimeEngine(new FakeTransport(), store, client);
        const string pageKey = "https://example.com/compact";

        await runtime.InitializeAsync(CancellationToken.None);
        await SyncChatConfigAsync(
            runtime,
            streamingEnabled: false,
            compactionEnabled: true,
            compaction: new
            {
                enabled = true,
                triggerPromptTokens = 1,
                preserveRecentTurns = 1,
                maxPassesPerPage = 3
            });

        foreach (var turn in Enumerable.Range(1, 7))
        {
            var marker = $"raw-turn-{turn}";
            await ExecuteAsync(runtime, "ai.chat.send", new
            {
                pageKey,
                pageUrl = pageKey,
                origin = "user",
                text = marker
            });

            await WaitForSessionAsync(
                runtime,
                pageKey,
                candidate => GetRequestState(candidate) == "idle" &&
                             CountMessagesByOrigin(candidate, "assistant") == turn);
        }

        Assert.True(client.CompactionCalls.Count >= 3);

        var chatCacheKeys = client.ChatCalls.Select(call => call.PromptCacheKey).ToArray();
        Assert.Equal(7, chatCacheKeys.Length);
        Assert.True(chatCacheKeys.Distinct().Count() >= 3);
        Assert.NotEqual(chatCacheKeys[0], chatCacheKeys[^1]);

        var finalChatInput = FlattenInputText(client.ChatCalls[^1].InputItemsJson);
        Assert.Contains("raw-turn-6", finalChatInput);
        Assert.Contains("raw-turn-7", finalChatInput);
        Assert.DoesNotContain("raw-turn-1", finalChatInput);
        Assert.DoesNotContain("raw-turn-2", finalChatInput);
        Assert.DoesNotContain("raw-turn-3", finalChatInput);
        Assert.DoesNotContain("raw-turn-4", finalChatInput);
        Assert.DoesNotContain("raw-turn-5", finalChatInput);
        Assert.Contains(client.ChatCalls[^1].InputItemsJson, item => item.Contains("\"type\":\"compaction\"", StringComparison.Ordinal));

        var storedSession = store.FindSession(pageKey);
        Assert.NotNull(storedSession);
        Assert.Equal(3, storedSession!.CompactionPassCount);
        Assert.True(storedSession.PromptCaching.Session.CompactionRequestCount >= 3);
        Assert.Contains(storedSession.CanonicalContextJsonItems, item => item.Contains("\"type\":\"compaction\"", StringComparison.Ordinal));
        Assert.DoesNotContain(storedSession.CanonicalContextJsonItems, item => item.Contains("summary-pass-2", StringComparison.Ordinal));
        Assert.DoesNotContain(storedSession.CanonicalContextJsonItems, item => item.Contains("raw-turn-1", StringComparison.Ordinal));
        Assert.DoesNotContain(storedSession.CanonicalContextJsonItems, item => item.Contains("raw-turn-2", StringComparison.Ordinal));
        Assert.DoesNotContain(storedSession.CanonicalContextJsonItems, item => item.Contains("raw-turn-3", StringComparison.Ordinal));
        Assert.DoesNotContain(storedSession.CanonicalContextJsonItems, item => item.Contains("raw-turn-4", StringComparison.Ordinal));
        Assert.DoesNotContain(storedSession.CanonicalContextJsonItems, item => item.Contains("raw-turn-5", StringComparison.Ordinal));
    }

    [Fact]
    public async Task CompactionRejectsLegacyMessageOnlyOutputAndLeavesCanonicalContextUntouched()
    {
        var store = new FakeHostStateStore();
        var client = new FakeOpenAiClient
        {
            CreateResponseAsyncHandler = (_, _, _, _, _, _) =>
                Task.FromResult(CreateCompletedChatResponse("resp_compaction_reject_legacy", "EDGE_COMPACTION_REJECT_OK")),
            CompactAsyncHandler = (_, _, _, _, _) =>
                Task.FromResult(CreateLegacyMessageOnlyCompactionResponse("legacy-summary", cachedTokens: 1536))
        };
        var runtime = new RuntimeEngine(new FakeTransport(), store, client);
        const string pageKey = "https://example.com/compaction-reject-legacy";

        await runtime.InitializeAsync(CancellationToken.None);
        await SyncChatConfigAsync(
            runtime,
            streamingEnabled: false,
            compactionEnabled: true,
            compaction: new
            {
                enabled = true,
                triggerPromptTokens = 1,
                preserveRecentTurns = 0,
                maxPassesPerPage = 1
            });

        await ExecuteAsync(runtime, "ai.chat.send", new
        {
            pageKey,
            pageUrl = pageKey,
            origin = "user",
            text = "raw-turn-legacy"
        });

        await WaitForSessionAsync(
            runtime,
            pageKey,
            candidate => GetRequestState(candidate) == "idle" &&
                         GetAssistantTexts(candidate).Contains("EDGE_COMPACTION_REJECT_OK"));

        var compactionResponse = await ExecuteAsync(runtime, "ai.chat.compact", new
        {
            pageKey,
            pageUrl = pageKey
        });

        Assert.False(compactionResponse.GetProperty("triggered").GetBoolean());
        Assert.Single(client.CompactionCalls);

        var storedSession = store.FindSession(pageKey);
        Assert.NotNull(storedSession);
        Assert.Equal(0, storedSession!.CompactionPassCount);
        Assert.DoesNotContain(storedSession.Messages, message => message.Kind == "compaction-result");

        var requestMessage = Assert.Single(storedSession.Messages, message => message.Kind == "compaction-request");
        Assert.Equal("error", requestMessage.State);
        Assert.Contains("rejected", requestMessage.Text, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain(storedSession.CanonicalContextJsonItems, item => item.Contains("legacy-summary", StringComparison.Ordinal));
        Assert.Contains(storedSession.CanonicalContextJsonItems, item => item.Contains("raw-turn-legacy", StringComparison.Ordinal));
        Assert.Contains(storedSession.CanonicalContextJsonItems, item => item.Contains("EDGE_COMPACTION_REJECT_OK", StringComparison.Ordinal));
    }

    [Fact]
    public async Task CompactionRejectsNonShrinkingOutputAndKeepsPreviousRawTurns()
    {
        var store = new FakeHostStateStore();
        var client = new FakeOpenAiClient
        {
            CreateResponseAsyncHandler = (_, _, _, _, _, _) =>
                Task.FromResult(CreateCompletedChatResponse("resp_compaction_reject_large", "EDGE_COMPACTION_LARGE_OK")),
            CompactAsyncHandler = (_, _, _, _, _) =>
                Task.FromResult(CreateCompactionResponse(new string('x', 16000), cachedTokens: 1536))
        };
        var runtime = new RuntimeEngine(new FakeTransport(), store, client);
        const string pageKey = "https://example.com/compaction-reject-large";

        await runtime.InitializeAsync(CancellationToken.None);
        await SyncChatConfigAsync(
            runtime,
            streamingEnabled: false,
            compactionEnabled: true,
            compaction: new
            {
                enabled = true,
                triggerPromptTokens = 1,
                preserveRecentTurns = 0,
                maxPassesPerPage = 1
            });

        await ExecuteAsync(runtime, "ai.chat.send", new
        {
            pageKey,
            pageUrl = pageKey,
            origin = "user",
            text = "raw-turn-large"
        });

        await WaitForSessionAsync(
            runtime,
            pageKey,
            candidate => GetRequestState(candidate) == "idle" &&
                         GetAssistantTexts(candidate).Contains("EDGE_COMPACTION_LARGE_OK"));

        var compactionResponse = await ExecuteAsync(runtime, "ai.chat.compact", new
        {
            pageKey,
            pageUrl = pageKey
        });

        Assert.False(compactionResponse.GetProperty("triggered").GetBoolean());
        Assert.Single(client.CompactionCalls);

        var storedSession = store.FindSession(pageKey);
        Assert.NotNull(storedSession);
        Assert.Equal(0, storedSession!.CompactionPassCount);
        Assert.DoesNotContain(storedSession.Messages, message => message.Kind == "compaction-result");
        Assert.DoesNotContain(storedSession.CanonicalContextJsonItems, item => item.Contains("\"type\":\"compaction\"", StringComparison.Ordinal));
        Assert.Contains(storedSession.CanonicalContextJsonItems, item => item.Contains("raw-turn-large", StringComparison.Ordinal));
        Assert.Contains(storedSession.CanonicalContextJsonItems, item => item.Contains("EDGE_COMPACTION_LARGE_OK", StringComparison.Ordinal));
    }

    [Fact]
    public void PromptEstimatorTreatsOpaqueCompactionCheckpointAsCheaperThanEquivalentRawHistory()
    {
        var rawItems = new List<string>();
        for (var turn = 1; turn <= 4; turn += 1)
        {
            rawItems.Add(
                JsonSerializer.Serialize(new
                {
                    type = "message",
                    role = "user",
                    content = new object[]
                    {
                        new
                        {
                            type = "input_text",
                            text = $"opaque-turn-{turn}"
                        }
                    }
                }));
            rawItems.Add(
                JsonSerializer.Serialize(new
                {
                    type = "message",
                    role = "assistant",
                    content = new object[]
                    {
                        new
                        {
                            type = "output_text",
                            text = new string('a', 3200)
                        }
                    }
                }));
        }

        var compactedItems = new List<string>
        {
            JsonSerializer.Serialize(new
            {
                type = "compaction",
                encrypted_content = new string('c', 12000)
            }),
            rawItems[^2],
            rawItems[^1]
        };

        var rawPromptTokens = RuntimeEngine.EstimatePromptTokenCost(rawItems, "next turn", string.Empty);
        var compactedPromptTokens = RuntimeEngine.EstimatePromptTokenCost(compactedItems, "next turn", string.Empty);

        Assert.True(
            compactedPromptTokens < rawPromptTokens,
            $"Expected compaction estimate to shrink prompt tokens, but got {rawPromptTokens} -> {compactedPromptTokens}.");
    }

    [Fact]
    public async Task AutoCompactionWaitsForMoreCompletedTurnsAfterRejectedAttempt()
    {
        FakeOpenAiClient? client = null;
        client = new FakeOpenAiClient
        {
            CreateResponseAsyncHandler = (_, inputItems, _, _, _, _) =>
            {
                var lastUserText = ExtractLastUserText(inputItems);
                return Task.FromResult(
                    CreateCompletedChatResponse(
                        $"resp_auto_reject_{client!.ChatCalls.Count + 1}",
                        $"assistant-for-{lastUserText}",
                        promptTokens: 2048));
            },
            CompactAsyncHandler = (_, _, _, _, _) =>
                Task.FromResult(CreateCompactionResponse(new string('x', 16000), cachedTokens: 1536))
        };
        var store = new FakeHostStateStore();
        var runtime = new RuntimeEngine(new FakeTransport(), store, client);
        const string pageKey = "https://example.com/auto-compaction-retry-spacing";

        await runtime.InitializeAsync(CancellationToken.None);
        await SyncChatConfigAsync(
            runtime,
            streamingEnabled: false,
            compactionEnabled: true,
            compaction: new
            {
                enabled = true,
                triggerPromptTokens = 1,
                preserveRecentTurns = 2,
                maxPassesPerPage = 10
            });

        for (var turn = 1; turn <= 7; turn += 1)
        {
            await ExecuteAsync(runtime, "ai.chat.send", new
            {
                pageKey,
                pageUrl = pageKey,
                origin = "user",
                text = $"auto-turn-{turn}"
            });

            await WaitForSessionAsync(
                runtime,
                pageKey,
                candidate => GetRequestState(candidate) == "idle" &&
                             CountMessagesByOrigin(candidate, "assistant") == turn);

            if (turn == 4)
            {
                Assert.Single(client.CompactionCalls);
            }

            if (turn == 5)
            {
                Assert.Single(client.CompactionCalls);
            }

            if (turn == 6)
            {
                Assert.Equal(2, client.CompactionCalls.Count);
            }
        }

        Assert.Equal(2, client.CompactionCalls.Count);

        var storedSession = store.FindSession(pageKey);
        Assert.NotNull(storedSession);
        Assert.Equal(3, storedSession!.LastRejectedAutoCompactionAffectedTurnCount);

        var compactionRequests = storedSession.Messages
            .Where(message => message.Kind == "compaction-request")
            .ToArray();
        Assert.Equal(2, compactionRequests.Length);
        Assert.All(compactionRequests, message => Assert.Equal("error", message.State));
        Assert.DoesNotContain(storedSession.Messages, message => message.Kind == "compaction-result");
    }

    private static async Task SyncChatConfigAsync(
        RuntimeEngine runtime,
        bool streamingEnabled,
        bool compactionEnabled,
        object? retries = null,
        object? compaction = null,
        object? queueRetries = null)
    {
        await ExecuteAsync(runtime, "config.sync", new
        {
            config = new
            {
                ai = new
                {
                    chat = new
                    {
                        model = new
                        {
                            model = "gpt-5-mini",
                            tier = "standard"
                        },
                        streamingEnabled,
                        instructions = "Reply tersely.",
                        structuredOutput = new
                        {
                            name = "chat_response",
                            description = "Structured reply description.",
                            schema = "",
                            strict = true
                        }
                    },
                    compaction = compaction ?? new
                    {
                        enabled = compactionEnabled,
                        streamingEnabled = false,
                        modelOverride = new
                        {
                            model = "gpt-5-mini",
                            tier = "standard"
                        },
                        instructions = "Compress previous turns faithfully.",
                        triggerPromptTokens = 4096,
                        preserveRecentTurns = 1,
                        maxPassesPerPage = 8
                    },
                    promptCaching = new
                    {
                        routing = "stable_session_prefix",
                        retention = "in_memory"
                    },
                    retries = retries ?? new
                    {
                        maxRetries = 3,
                        baseDelayMs = 1000,
                        maxDelayMs = 30000
                    },
                    queueRetries = queueRetries ?? new
                    {
                        maxRetries = 3,
                        baseDelayMs = 1000,
                        maxDelayMs = 30000
                    },
                    rateLimits = new
                    {
                        reserveOutputTokens = 1,
                        maxQueuedPerPage = 8,
                        maxQueuedGlobal = 16
                    }
                }
            }
        });
    }

    private static async Task<JsonElement> ExecuteAsync(RuntimeEngine runtime, string action, object payload)
    {
        var result = await runtime.HandleCommandAsync(BuildEnvelope(action, payload), CancellationToken.None);
        return result is null
            ? default
            : JsonSerializer.SerializeToElement(result);
    }

    private static ProtocolEnvelope BuildEnvelope(string action, object payload) => new(
        Guid.NewGuid().ToString("D"),
        1,
        "command",
        action,
        "tests",
        "native-host",
        DateTimeOffset.UtcNow,
        JsonSerializer.SerializeToElement(payload),
        null);

    private static async Task<JsonElement> GetSessionAsync(RuntimeEngine runtime, string pageKey)
    {
        var result = await ExecuteAsync(runtime, "ai.chat.status", new
        {
            pageKey,
            pageUrl = pageKey
        });
        return result.GetProperty("session");
    }

    private static async Task<JsonElement> WaitForSessionAsync(
        RuntimeEngine runtime,
        string pageKey,
        Func<JsonElement, bool> predicate,
        int timeoutMs = 5000)
    {
        var startedAt = DateTimeOffset.UtcNow;
        JsonElement latest = default;
        while (DateTimeOffset.UtcNow - startedAt < TimeSpan.FromMilliseconds(timeoutMs))
        {
            latest = await GetSessionAsync(runtime, pageKey);
            if (predicate(latest))
            {
                return latest;
            }

            await Task.Delay(25);
        }

        throw new TimeoutException($"Session {pageKey} did not reach the expected state. Latest state: {GetRequestState(latest)}");
    }

    private static string GetRequestState(JsonElement session) =>
        session.GetProperty("status").GetProperty("requestState").GetString() ?? string.Empty;

    private static int GetQueueCount(JsonElement session) =>
        session.GetProperty("status").GetProperty("queueCount").GetInt32();

    private static string? GetOpenAiResponseId(JsonElement session) =>
        GetNullableString(session, "status", "openaiResponseId");

    private static JsonElement GetMessages(JsonElement session) => session.GetProperty("messages");

    private static List<string> GetAssistantTexts(JsonElement session) =>
        GetMessages(session)
            .EnumerateArray()
            .Where(message => string.Equals(GetNullableString(message, "origin"), "assistant", StringComparison.Ordinal))
            .Select(message => GetNullableString(message, "text") ?? string.Empty)
            .Where(text => text.Length > 0)
            .ToList();

    private static int CountMessagesByOrigin(JsonElement session, string origin) =>
        GetMessages(session)
            .EnumerateArray()
            .Count(message => string.Equals(GetNullableString(message, "origin"), origin, StringComparison.Ordinal));

    private static int CountMessagesByKind(JsonElement session, string kind) =>
        GetMessages(session)
            .EnumerateArray()
            .Count(message => string.Equals(GetNullableString(message, "kind"), kind, StringComparison.Ordinal));

    private static JsonElement GetRuntimeLogEntry(FakeTransport transport, string eventName)
    {
        foreach (var payload in transport.SentPayloads)
        {
            if (!string.Equals(GetNullableString(payload, "stream"), "runtime", StringComparison.Ordinal) ||
                !string.Equals(GetNullableString(payload, "event"), "runtime.log", StringComparison.Ordinal) ||
                !payload.TryGetProperty("logEntry", out var logEntry) ||
                !string.Equals(GetNullableString(logEntry, "event"), eventName, StringComparison.Ordinal))
            {
                continue;
            }

            return logEntry;
        }

        throw new InvalidOperationException($"Runtime log entry '{eventName}' was not emitted.");
    }

    private static JsonElement GetRequiredProperty(JsonElement element, params string[] path)
    {
        var current = element;
        foreach (var segment in path)
        {
            if (!current.TryGetProperty(segment, out current))
            {
                throw new InvalidOperationException($"Expected property path '{string.Join(".", path)}'.");
            }
        }

        return current;
    }

    private static string? GetNullableString(JsonElement element, params string[] path)
    {
        var current = element;
        foreach (var segment in path)
        {
            if (!current.TryGetProperty(segment, out current))
            {
                return null;
            }
        }

        return current.ValueKind == JsonValueKind.String ? current.GetString() : null;
    }

    private static string FlattenInputText(IReadOnlyList<string> inputItemsJson) =>
        string.Join("\n", inputItemsJson.Select(ExtractText));

    private static string ExtractLastUserText(IReadOnlyList<string> inputItemsJson)
    {
        foreach (var itemJson in inputItemsJson.Reverse())
        {
            using var document = JsonDocument.Parse(itemJson);
            var role = GetNullableString(document.RootElement, "role");
            if (!string.Equals(role, "user", StringComparison.Ordinal))
            {
                continue;
            }

            return ExtractText(itemJson);
        }

        return string.Empty;
    }

    private static string ExtractText(string itemJson)
    {
        using var document = JsonDocument.Parse(itemJson);
        if (!document.RootElement.TryGetProperty("content", out var content) || content.ValueKind != JsonValueKind.Array)
        {
            return string.Empty;
        }

        return string.Concat(
            content.EnumerateArray()
                .Select(part => GetNullableString(part, "text") ?? string.Empty));
    }

    private static OpenAiJsonResponse CreateCompletedChatResponse(
        string responseId,
        string assistantText,
        int promptTokens = 2048,
        int cachedTokens = 0) =>
        CreateJsonResponse(new
        {
            id = responseId,
            status = "completed",
            service_tier = "default",
            output = new object[]
            {
                new
                {
                    type = "message",
                    role = "assistant",
                    content = new object[]
                    {
                        new
                        {
                            type = "output_text",
                            text = assistantText
                        }
                    }
                }
            },
            usage = new
            {
                input_tokens = promptTokens,
                input_tokens_details = new
                {
                    cached_tokens = cachedTokens
                },
                total_tokens = promptTokens + 64
            }
        });

    private static OpenAiJsonResponse CreateCompactionResponse(string summaryText, int cachedTokens) =>
        CreateJsonResponse(new
        {
            status = "completed",
            output = new object[]
            {
                new
                {
                    type = "message",
                    role = "assistant",
                    content = new object[]
                    {
                        new
                        {
                            type = "output_text",
                            text = summaryText
                        }
                    }
                },
                new
                {
                    type = "compaction",
                    encrypted_content = summaryText
                }
            },
            usage = new
            {
                input_tokens = 2048,
                input_tokens_details = new
                {
                    cached_tokens = cachedTokens
                }
            }
        });

    private static OpenAiJsonResponse CreateLegacyMessageOnlyCompactionResponse(string summaryText, int cachedTokens) =>
        CreateJsonResponse(new
        {
            status = "completed",
            output = new object[]
            {
                new
                {
                    type = "message",
                    role = "assistant",
                    content = new object[]
                    {
                        new
                        {
                            type = "output_text",
                            text = summaryText
                        }
                    }
                }
            },
            usage = new
            {
                input_tokens = 2048,
                input_tokens_details = new
                {
                    cached_tokens = cachedTokens
                }
            }
        });

    private static bool IsCompactionItem(string itemJson, string expectedEncryptedContent)
    {
        using var document = JsonDocument.Parse(itemJson);
        return string.Equals(GetNullableString(document.RootElement, "type"), "compaction", StringComparison.Ordinal) &&
               string.Equals(
                   GetNullableString(document.RootElement, "encrypted_content"),
                   expectedEncryptedContent,
                   StringComparison.Ordinal);
    }

    private static OpenAiJsonResponse CreateJsonResponse(object payload) =>
        new(JsonDocument.Parse(JsonSerializer.Serialize(payload)), new AiRateLimitSnapshot());

    private static async IAsyncEnumerable<OpenAiSseEvent> ReadCompletedStreamAsync(
        string responseId,
        string assistantText,
        [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken cancellationToken)
    {
        await Task.Yield();
        cancellationToken.ThrowIfCancellationRequested();
        yield return new OpenAiSseEvent(
            "response.completed",
            JsonDocument.Parse(JsonSerializer.Serialize(new
            {
                response = new
                {
                    id = responseId,
                    status = "completed",
                    service_tier = "default",
                    output = new object[]
                    {
                        new
                        {
                            type = "message",
                            role = "assistant",
                            content = new object[]
                            {
                                new
                                {
                                    type = "output_text",
                                    text = assistantText
                                }
                            }
                        }
                    },
                    usage = new
                    {
                        input_tokens = 2048,
                        input_tokens_details = new
                        {
                            cached_tokens = 1024
                        }
                    }
                }
            })).RootElement.Clone());
    }

    private static async IAsyncEnumerable<OpenAiSseEvent> ReadBlockingResetStreamAsync(
        string responseId,
        TaskCompletionSource cleanupStarted,
        TaskCompletionSource releaseCleanup,
        [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken cancellationToken)
    {
        yield return new OpenAiSseEvent(
            "response.output_text.delta",
            JsonDocument.Parse(JsonSerializer.Serialize(new
            {
                response_id = responseId,
                sequence_number = 1,
                delta = "partial"
            })).RootElement.Clone());

        try
        {
            await Task.Delay(Timeout.Infinite, cancellationToken);
        }
        catch (OperationCanceledException)
        {
            cleanupStarted.TrySetResult();
            await releaseCleanup.Task.WaitAsync(CancellationToken.None);
            throw;
        }
    }

    private static async IAsyncEnumerable<OpenAiSseEvent> ReadStreamingUntilShutdownAsync(
        string responseId,
        TaskCompletionSource cancelled,
        [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken cancellationToken)
    {
        yield return new OpenAiSseEvent(
            "response.output_text.delta",
            JsonDocument.Parse(JsonSerializer.Serialize(new
            {
                response_id = responseId,
                sequence_number = 1,
                delta = "partial"
            })).RootElement.Clone());

        try
        {
            await Task.Delay(Timeout.Infinite, cancellationToken);
        }
        catch (OperationCanceledException)
        {
            cancelled.TrySetResult();
            throw;
        }
    }

    private static async IAsyncEnumerable<OpenAiSseEvent> ReadResponseEndedStreamAsync(
        string responseId,
        [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken cancellationToken)
    {
        await Task.Yield();
        cancellationToken.ThrowIfCancellationRequested();
        yield return new OpenAiSseEvent(
            "response.output_text.delta",
            JsonDocument.Parse(JsonSerializer.Serialize(new
            {
                response_id = responseId,
                sequence_number = 1,
                delta = "partial"
            })).RootElement.Clone());

        throw new InvalidOperationException("The response ended prematurely. (ResponseEnded)");
    }

    private static async IAsyncEnumerable<OpenAiSseEvent> ReadFailedStreamAsync(
        string responseId,
        string errorCode,
        string errorMessage,
        [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken cancellationToken)
    {
        await Task.Yield();
        cancellationToken.ThrowIfCancellationRequested();
        yield return new OpenAiSseEvent(
            "response.failed",
            JsonDocument.Parse(JsonSerializer.Serialize(new
            {
                response = new
                {
                    id = responseId,
                    status = "failed",
                    error = new
                    {
                        code = errorCode,
                        message = errorMessage
                    }
                }
            })).RootElement.Clone());
    }

    private sealed class FakeTransport : INativeMessagingTransport
    {
        public List<JsonElement> SentPayloads { get; } = [];

        public Task SendAsync(object payload, CancellationToken cancellationToken)
        {
            SentPayloads.Add(JsonSerializer.SerializeToElement(payload));
            return Task.CompletedTask;
        }
    }

    private sealed class FakeHostStateStore : IHostStateStore
    {
        private HostJournal _journal = new();

        public Task<HostJournal> LoadAsync(CancellationToken cancellationToken) =>
            Task.FromResult(Clone(_journal));

        public Task SaveAsync(HostJournal journal, CancellationToken cancellationToken)
        {
            _journal = Clone(journal);
            return Task.CompletedTask;
        }

        public AiPageSessionRecord? FindSession(string pageKey) =>
            Clone(_journal).AiSessions.FirstOrDefault(session => session.PageKey == pageKey);

        private static HostJournal Clone(HostJournal journal) =>
            JsonSerializer.Deserialize<HostJournal>(JsonSerializer.Serialize(journal)) ?? new HostJournal();
    }

    private sealed class FakeOpenAiStreamResponse : IOpenAiStreamResponse
    {
        private readonly Func<CancellationToken, IAsyncEnumerable<OpenAiSseEvent>> _readEvents;
        private readonly CancellationToken _cancellationToken;

        public FakeOpenAiStreamResponse(
            Func<CancellationToken, IAsyncEnumerable<OpenAiSseEvent>> readEvents,
            CancellationToken cancellationToken)
        {
            _readEvents = readEvents;
            _cancellationToken = cancellationToken;
        }

        public AiRateLimitSnapshot RateLimits { get; } = new();

        public IAsyncEnumerable<OpenAiSseEvent> ReadEventsAsync(CancellationToken cancellationToken) =>
            _readEvents(CancellationTokenSource.CreateLinkedTokenSource(_cancellationToken, cancellationToken).Token);

        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }

    private sealed class FakeOpenAiClient : IOpenAiClient
    {
        public bool HasApiKey { get; set; } = true;

        public List<ChatCall> ChatCalls { get; } = [];

        public List<CompactionCall> CompactionCalls { get; } = [];

        public List<ResumeCall> ResumeCalls { get; } = [];

        public List<string> CancelledResponseIds { get; } = [];

        public Func<AiRuntimeConfig, IReadOnlyList<string>, bool, bool, PromptCaching.PromptCacheRequestSettings?, CancellationToken, Task<OpenAiJsonResponse>>? CreateResponseAsyncHandler { get; set; }

        public Func<AiRuntimeConfig, IReadOnlyList<string>, bool, PromptCaching.PromptCacheRequestSettings?, CancellationToken, Task<IOpenAiStreamResponse>>? CreateResponseStreamAsyncHandler { get; set; }

        public Func<string, CancellationToken, Task<OpenAiJsonResponse>>? RetrieveResponseAsyncHandler { get; set; }

        public Func<string, int?, CancellationToken, Task<IOpenAiStreamResponse>>? ResumeResponseStreamAsyncHandler { get; set; }

        public Func<string, CancellationToken, Task<OpenAiJsonResponse>>? CancelResponseAsyncHandler { get; set; }

        public Func<AiModelSelection, IReadOnlyList<string>, string, PromptCaching.PromptCacheRequestSettings?, CancellationToken, Task<OpenAiJsonResponse>>? CompactAsyncHandler { get; set; }

        public void ReloadApiKeyFromEnvironment()
        {
        }

        public void ConfigureManagedApiKey(string? apiKey) =>
            HasApiKey = !string.IsNullOrWhiteSpace(apiKey);

        public Task<OpenAiModelCatalogResult> ListChatModelsAsync(CancellationToken cancellationToken) =>
            Task.FromResult(
                new OpenAiModelCatalogResult(
                    DateTimeOffset.UtcNow.ToString("O"),
                    []
                ));

        public async Task<OpenAiJsonResponse> CreateResponseAsync(
            AiRuntimeConfig config,
            IReadOnlyList<string> inputItemsJson,
            bool background,
            bool stream,
            PromptCaching.PromptCacheRequestSettings? promptCaching,
            CancellationToken cancellationToken)
        {
            ChatCalls.Add(new ChatCall([.. inputItemsJson], promptCaching?.CacheKey, false));
            if (CreateResponseAsyncHandler is null)
            {
                throw new InvalidOperationException("CreateResponseAsyncHandler is not configured.");
            }

            return await CreateResponseAsyncHandler(config, inputItemsJson, background, stream, promptCaching, cancellationToken);
        }

        public async Task<IOpenAiStreamResponse> CreateResponseStreamAsync(
            AiRuntimeConfig config,
            IReadOnlyList<string> inputItemsJson,
            bool background,
            PromptCaching.PromptCacheRequestSettings? promptCaching,
            CancellationToken cancellationToken)
        {
            ChatCalls.Add(new ChatCall([.. inputItemsJson], promptCaching?.CacheKey, true));
            if (CreateResponseStreamAsyncHandler is null)
            {
                throw new InvalidOperationException("CreateResponseStreamAsyncHandler is not configured.");
            }

            return await CreateResponseStreamAsyncHandler(config, inputItemsJson, background, promptCaching, cancellationToken);
        }

        public Task<OpenAiJsonResponse> RetrieveResponseAsync(string responseId, CancellationToken cancellationToken)
        {
            if (RetrieveResponseAsyncHandler is null)
            {
                throw new InvalidOperationException("RetrieveResponseAsyncHandler is not configured.");
            }

            return RetrieveResponseAsyncHandler(responseId, cancellationToken);
        }

        public async Task<IOpenAiStreamResponse> ResumeResponseStreamAsync(
            string responseId,
            int? startingAfter,
            CancellationToken cancellationToken)
        {
            ResumeCalls.Add(new ResumeCall(responseId, startingAfter));
            if (ResumeResponseStreamAsyncHandler is null)
            {
                throw new InvalidOperationException("ResumeResponseStreamAsyncHandler is not configured.");
            }

            return await ResumeResponseStreamAsyncHandler(responseId, startingAfter, cancellationToken);
        }

        public async Task<OpenAiJsonResponse> CancelResponseAsync(string responseId, CancellationToken cancellationToken)
        {
            CancelledResponseIds.Add(responseId);
            if (CancelResponseAsyncHandler is not null)
            {
                return await CancelResponseAsyncHandler(responseId, cancellationToken);
            }

            return CreateJsonResponse(new
            {
                id = responseId,
                status = "cancelled"
            });
        }

        public async Task<OpenAiJsonResponse> CompactAsync(
            AiModelSelection selection,
            IReadOnlyList<string> inputItemsJson,
            string instructions,
            PromptCaching.PromptCacheRequestSettings? promptCaching,
            CancellationToken cancellationToken)
        {
            CompactionCalls.Add(new CompactionCall([.. inputItemsJson], instructions, promptCaching?.CacheKey));
            if (CompactAsyncHandler is null)
            {
                throw new InvalidOperationException("CompactAsyncHandler is not configured.");
            }

            return await CompactAsyncHandler(selection, inputItemsJson, instructions, promptCaching, cancellationToken);
        }

        public Task<AiRateLimitSnapshot> ProbeRateLimitsAsync(AiModelSelection selection, CancellationToken cancellationToken) =>
            Task.FromResult(new AiRateLimitSnapshot());

        public sealed record ChatCall(IReadOnlyList<string> InputItemsJson, string? PromptCacheKey, bool Streaming);

        public sealed record CompactionCall(IReadOnlyList<string> InputItemsJson, string Instructions, string? PromptCacheKey);

        public sealed record ResumeCall(string ResponseId, int? StartingAfter);
    }
}
