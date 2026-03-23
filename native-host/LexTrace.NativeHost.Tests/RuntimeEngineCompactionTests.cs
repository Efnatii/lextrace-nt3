using System.Text.Json;
using Xunit;

namespace LexTrace.NativeHost.Tests;

public sealed class RuntimeEngineCompactionTests
{
    [Fact]
    public void CompactionAffectedMessagesExcludeAlreadyCompactedAndPreservedTail()
    {
        var compactedMeta = JsonDocument.Parse("{\"compactedBy\":\"cmp-old\"}").RootElement.Clone();
        var session = new AiPageSessionRecord
        {
            Messages =
            [
                new AiChatMessageRecord
                {
                    Id = "user-0",
                    Kind = "user",
                    Origin = "user",
                    Role = "user",
                    Text = "old compacted user",
                    State = "completed",
                    Meta = compactedMeta
                },
                new AiChatMessageRecord
                {
                    Id = "assistant-0",
                    Kind = "assistant",
                    Origin = "assistant",
                    Role = "assistant",
                    Text = "old compacted assistant",
                    State = "completed",
                    Meta = compactedMeta
                },
                new AiChatMessageRecord
                {
                    Id = "user-1",
                    Kind = "user",
                    Origin = "user",
                    Role = "user",
                    Text = "first fresh user",
                    State = "completed"
                },
                new AiChatMessageRecord
                {
                    Id = "assistant-1",
                    Kind = "assistant",
                    Origin = "assistant",
                    Role = "assistant",
                    Text = "first fresh assistant",
                    State = "completed"
                },
                new AiChatMessageRecord
                {
                    Id = "user-2",
                    Kind = "user",
                    Origin = "user",
                    Role = "user",
                    Text = "preserved user",
                    State = "completed"
                },
                new AiChatMessageRecord
                {
                    Id = "assistant-2",
                    Kind = "assistant",
                    Origin = "assistant",
                    Role = "assistant",
                    Text = "preserved assistant",
                    State = "completed"
                }
            ]
        };

        var affected = RuntimeEngine.GetCompactionAffectedMessages(session, preserveRecentTurns: 1);

        Assert.Equal(["user-1", "assistant-1"], affected.Select(message => message.Id).ToArray());
    }

    [Fact]
    public void GetMessageCompactedByReadsPersistedJsonMeta()
    {
        var message = new AiChatMessageRecord
        {
            Kind = "assistant",
            Origin = "assistant",
            Role = "assistant",
            State = "completed",
            Meta = JsonDocument.Parse("{\"compactedBy\":\"cmp-json\"}").RootElement.Clone()
        };

        Assert.Equal("cmp-json", RuntimeEngine.GetMessageCompactedBy(message));
    }

    [Fact]
    public void BuildCompactionResultPreviewPrefersExtractedText()
    {
        var preview = RuntimeEngine.BuildCompactionResultPreview(
        [
            """
            {"type":"message","role":"assistant","content":[{"type":"output_text","text":"Condensed summary line 1."},{"type":"output_text","text":"Condensed summary line 2."}]}
            """
        ]);

        Assert.Contains("Condensed summary line 1.", preview);
        Assert.Contains("Condensed summary line 2.", preview);
    }

    [Fact]
    public void BuildCompactionResultPreviewFallsBackToPrettyJson()
    {
        var preview = RuntimeEngine.BuildCompactionResultPreview(
        [
            """
            {"type":"reasoning","summary":[]}
            """
        ]);

        Assert.Contains("\"type\": \"reasoning\"", preview);
    }

    [Fact]
    public void PromptTokenEstimateExcludesReserveButBudgetPathKeepsIt()
    {
        var promptTokens = RuntimeEngine.EstimatePromptTokenCost(
            [new string('x', 4000)],
            pendingText: string.Empty,
            instructions: string.Empty
        );

        Assert.Equal(1000, promptTokens);
        Assert.Equal(33768, RuntimeEngine.ApplyReserveOutputTokens(promptTokens, reserveOutputTokens: 32768));
    }

    [Fact]
    public void StatusContextPromptTokensFollowActiveThenRetryableThenQueuedThenIdle()
    {
        var session = new AiPageSessionRecord
        {
            CanonicalContextJsonItems = [new string('c', 4000)],
            PendingQueue =
            [
                new AiQueueItemRecord
                {
                    Text = new string('q', 400)
                }
            ]
        };

        Assert.Equal(1100, RuntimeEngine.EstimateStatusContextPromptTokens(session, instructions: string.Empty));

        session.RetryableItem = new AiQueueItemRecord
        {
            Text = new string('r', 200)
        };
        Assert.Equal(1050, RuntimeEngine.EstimateStatusContextPromptTokens(session, instructions: string.Empty));

        session.ActiveItem = new AiQueueItemRecord
        {
            Text = new string('a', 80)
        };
        Assert.Equal(1020, RuntimeEngine.EstimateStatusContextPromptTokens(session, instructions: string.Empty));

        session.ActiveItem = null;
        session.RetryableItem = null;
        session.PendingQueue.Clear();
        Assert.Equal(1000, RuntimeEngine.EstimateStatusContextPromptTokens(session, instructions: string.Empty));
    }
}
