using System.Net;
using Xunit;

namespace LexTrace.NativeHost.Tests;

public sealed class RuntimeEngineQueueTests
{
    [Fact]
    public void VisibleQueueCountExcludesActiveItem()
    {
        var session = new AiPageSessionRecord
        {
            ActiveItem = new AiQueueItemRecord
            {
                State = "running"
            },
            RetryableItem = new AiQueueItemRecord
            {
                State = "retryable"
            },
            PendingQueue =
            [
                new AiQueueItemRecord
                {
                    State = "queued"
                }
            ]
        };

        Assert.Equal(2, RuntimeEngine.GetVisibleQueueCount(session));
    }

    [Fact]
    public void QueuedWorkCountIncludesActiveItemForCapacityChecks()
    {
        var session = new AiPageSessionRecord
        {
            ActiveItem = new AiQueueItemRecord
            {
                State = "running"
            },
            RetryableItem = new AiQueueItemRecord
            {
                State = "blocked"
            },
            PendingQueue =
            [
                new AiQueueItemRecord
                {
                    State = "queued"
                }
            ]
        };

        Assert.Equal(3, RuntimeEngine.GetQueuedWorkCount(session));
    }

    [Fact]
    public void TryTakeNextPendingQueueItemForExecutionLeavesDelayedItemQueuedUntilDue()
    {
        var scheduledAt = DateTimeOffset.Parse("2026-03-24T10:00:05.0000000+00:00");
        var session = new AiPageSessionRecord
        {
            PendingQueue =
            [
                new AiQueueItemRecord
                {
                    State = "queued",
                    NotBeforeAt = scheduledAt.ToString("O")
                }
            ]
        };

        var takenEarly = RuntimeEngine.TryTakeNextPendingQueueItemForExecution(
            session,
            DateTimeOffset.Parse("2026-03-24T10:00:00.0000000+00:00"),
            out var earlyItem,
            out var nextRetryAt
        );

        Assert.False(takenEarly);
        Assert.Null(earlyItem);
        Assert.Equal(scheduledAt, nextRetryAt);
        Assert.Single(session.PendingQueue);

        var takenOnTime = RuntimeEngine.TryTakeNextPendingQueueItemForExecution(
            session,
            DateTimeOffset.Parse("2026-03-24T10:00:06.0000000+00:00"),
            out var activeItem,
            out var _
        );

        Assert.True(takenOnTime);
        Assert.NotNull(activeItem);
        Assert.Empty(session.PendingQueue);
        Assert.Null(activeItem!.NotBeforeAt);
    }

    [Fact]
    public void DetermineRetryHandlingRestartsFreshForExpiredResponseId()
    {
        var activeItem = new AiQueueItemRecord
        {
            OpenAiResponseId = "resp_123"
        };

        var decision = RuntimeEngine.DetermineRetryHandling(
            new OpenAiClient.OpenAiHttpException(
                HttpStatusCode.BadRequest,
                "{\"error\":{\"message\":\"This response can no longer be streamed because it is more than 5 minutes old.\"}}",
                errorCode: null,
                errorMessage: "This response can no longer be streamed because it is more than 5 minutes old.",
                errorType: null,
                errorParam: null
            ),
            activeItem,
            new AiRetryConfig()
        );

        Assert.Equal(RuntimeEngine.RetryHandlingDecision.ActionAutoRetry, decision.Action);
        Assert.Equal("expired_response_id", decision.FailureClassification);
        Assert.Equal("restart", decision.RetryMode);
        Assert.True(decision.ClearResponseState);
        Assert.Equal(1000, decision.DelayMs);
    }

    [Fact]
    public void DetermineRetryHandlingResumesTransientErrorsWithinBudget()
    {
        var activeItem = new AiQueueItemRecord
        {
            OpenAiResponseId = "resp_123",
            AutoRetryCount = 1
        };

        var decision = RuntimeEngine.DetermineRetryHandling(
            new HttpRequestException("temporary network failure"),
            activeItem,
            new AiRetryConfig()
        );

        Assert.Equal(RuntimeEngine.RetryHandlingDecision.ActionAutoRetry, decision.Action);
        Assert.Equal("transport_http", decision.FailureClassification);
        Assert.Equal("resume", decision.RetryMode);
        Assert.False(decision.ClearResponseState);
        Assert.Equal(2000, decision.DelayMs);
    }

    [Fact]
    public void DetermineRetryHandlingResumesWrappedResponseEndedTransportFailures()
    {
        var activeItem = new AiQueueItemRecord
        {
            OpenAiResponseId = "resp_123"
        };

        var decision = RuntimeEngine.DetermineRetryHandling(
            new InvalidOperationException("The response ended prematurely. (ResponseEnded)"),
            activeItem,
            new AiRetryConfig()
        );

        Assert.Equal(RuntimeEngine.RetryHandlingDecision.ActionAutoRetry, decision.Action);
        Assert.Equal("stream_disconnect", decision.FailureClassification);
        Assert.Equal("resume", decision.RetryMode);
        Assert.False(decision.ClearResponseState);
        Assert.Equal(1000, decision.DelayMs);
    }

    [Fact]
    public void DetermineRetryHandlingStopsAutoRetryWhenBudgetIsExhausted()
    {
        var activeItem = new AiQueueItemRecord
        {
            OpenAiResponseId = "resp_123",
            AutoRetryCount = 3
        };

        var decision = RuntimeEngine.DetermineRetryHandling(
            new HttpRequestException("temporary network failure"),
            activeItem,
            new AiRetryConfig
            {
                MaxRetries = 3,
                BaseDelayMs = 1000,
                MaxDelayMs = 30000
            }
        );

        Assert.Equal(RuntimeEngine.RetryHandlingDecision.ActionManualPause, decision.Action);
        Assert.Equal("transport_http", decision.FailureClassification);
        Assert.Equal("resume", decision.RetryMode);
        Assert.False(decision.ClearResponseState);
        Assert.Equal(0, decision.DelayMs);
    }

    [Fact]
    public void ClassifyRetryTreatsInsufficientQuotaAsManualPause()
    {
        var disposition = RuntimeEngine.ClassifyRetry(
            new OpenAiClient.OpenAiHttpException(
                HttpStatusCode.TooManyRequests,
                "{\"error\":{\"code\":\"insufficient_quota\",\"message\":\"Quota exceeded.\"}}",
                errorCode: "insufficient_quota",
                errorMessage: "Quota exceeded.",
                errorType: null,
                errorParam: null
            )
        );

        Assert.Equal(RuntimeEngine.RetryDisposition.DecisionManualPause, disposition.Decision);
        Assert.Equal("insufficient_quota", disposition.FailureClassification);
    }

    [Fact]
    public void ResetRetryCycleForManualResumeClearsBackoffWithoutResettingAttemptCount()
    {
        var item = new AiQueueItemRecord
        {
            State = "retryable",
            AttemptCount = 4,
            AutoRetryCount = 3,
            NotBeforeAt = "2026-03-24T10:00:05.0000000+00:00"
        };

        RuntimeEngine.ResetRetryCycleForManualResume(item);

        Assert.Equal("queued", item.State);
        Assert.Equal(4, item.AttemptCount);
        Assert.Equal(0, item.AutoRetryCount);
        Assert.Null(item.NotBeforeAt);
    }

    [Fact]
    public void PrepareQueueItemForRetryClearsAssistantDraftForFreshRestart()
    {
        var activeItem = new AiQueueItemRecord
        {
            AssistantMessageId = "assistant-1",
            OpenAiResponseId = "resp_123",
            LastSequenceNumber = 42,
            ModelId = "gpt-4.1"
        };
        var assistantMessage = new AiChatMessageRecord
        {
            Id = "assistant-1",
            Text = "partial answer",
            State = "streaming",
            OpenAiResponseId = "resp_123"
        };
        var session = new AiPageSessionRecord
        {
            OpenAiResponseId = "resp_123",
            LastSequenceNumber = 42,
            Messages = [assistantMessage]
        };

        RuntimeEngine.PrepareQueueItemForRetry(session, activeItem, retryMode: "restart", messageState: "pending");

        Assert.Null(activeItem.OpenAiResponseId);
        Assert.Null(activeItem.LastSequenceNumber);
        Assert.Null(activeItem.ModelId);
        Assert.Null(session.OpenAiResponseId);
        Assert.Null(session.LastSequenceNumber);
        Assert.Equal(string.Empty, assistantMessage.Text);
        Assert.Null(assistantMessage.OpenAiResponseId);
        Assert.Equal("pending", assistantMessage.State);
    }
}
