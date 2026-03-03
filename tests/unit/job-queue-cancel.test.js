import { describe, expect, it } from "vitest";
import { JobQueue } from "../../src/shared/job-queue.js";

describe("JobQueue cancellation", () => {
  it("rejects pending jobs when stopped", async () => {
    const queue = new JobQueue({ concurrency: 1 });

    const started = [];
    const p1 = queue.push(async () => {
      started.push("job1");
      await new Promise((resolve) => setTimeout(resolve, 30));
      return 1;
    });

    const p2 = queue.push(async () => {
      started.push("job2");
      return 2;
    });
    p2.catch(() => {});

    queue.stop(new Error("cancelled"));

    await expect(p1).resolves.toBe(1);
    await expect(p2).rejects.toThrow("cancelled");
    expect(started).toEqual(["job1"]);
  });
});
