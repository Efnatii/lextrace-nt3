import { describe, expect, it } from "vitest";
import { BudgetThroughputController, RateLimitError } from "../../src/shared/rate-limit-controller.js";

describe("BudgetThroughputController", () => {
  it("retries with backoff on rate limit", async () => {
    const controller = new BudgetThroughputController({
      modelLimits: {
        m1: { tpm: 100000, rpm: 1000, concurrency: 1 }
      }
    });

    let attempts = 0;

    const result = await controller.retryWithBackoff(
      async () => {
        attempts += 1;
        if (attempts < 3) {
          throw new RateLimitError("429", { retryAfterMs: 1 });
        }
        return "ok";
      },
      {
        maxAttempts: 4,
        minDelayMs: 1,
        jitterMs: 1
      }
    );

    expect(result).toBe("ok");
    expect(attempts).toBe(3);
  });

  it("enforces concurrency", async () => {
    const controller = new BudgetThroughputController({
      modelLimits: {
        m2: { tpm: 100000, rpm: 1000, concurrency: 1 }
      }
    });

    const starts = [];

    const p1 = controller.runWithBudget({
      model: "m2",
      tokensEstimate: 10,
      fn: async () => {
        starts.push("a");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    });

    const p2 = controller.runWithBudget({
      model: "m2",
      tokensEstimate: 10,
      fn: async () => {
        starts.push("b");
      }
    });

    await Promise.all([p1, p2]);
    expect(starts).toEqual(["a", "b"]);
  });

  it("decreases dynamic concurrency on rate limit", async () => {
    const controller = new BudgetThroughputController({
      modelLimits: {
        m3: { tpm: 100000, rpm: 1000, concurrency: 3 }
      }
    });

    const initial = controller.getSnapshot("m3");
    expect(initial.dynamicConcurrency).toBe(3);

    await expect(
      controller.runWithBudget({
        model: "m3",
        tokensEstimate: 10,
        fn: async () => {
          throw new RateLimitError("429", { retryAfterMs: 1 });
        }
      })
    ).rejects.toThrow("429");

    const after = controller.getSnapshot("m3");
    expect(after.dynamicConcurrency).toBe(2);
    expect(after.lastRateLimitAt).toBeGreaterThan(0);
  });

  it("tracks separate concurrency windows for different roles", async () => {
    const controller = new BudgetThroughputController({
      modelLimits: {
        mx: { tpm: 100000, rpm: 1000, concurrency: 3 }
      }
    });

    await expect(
      controller.runWithBudget({
        model: "mx",
        role: "context",
        tokensEstimate: 10,
        fn: async () => {
          throw new RateLimitError("429", { retryAfterMs: 1 });
        }
      })
    ).rejects.toThrow("429");

    const contextSnapshot = controller.getSnapshot("mx", { role: "context" });
    const translationSnapshot = controller.getSnapshot("mx", { role: "translation" });

    expect(contextSnapshot.dynamicConcurrency).toBe(2);
    expect(translationSnapshot.dynamicConcurrency).toBe(3);
  });
});
