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
}
