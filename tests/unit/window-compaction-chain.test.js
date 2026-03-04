import { describe, expect, it } from "vitest";
import { BatchWindowManager } from "../../src/shared/batch-window.js";

describe("BatchWindowManager chain", () => {
  it("keeps compacted context bounded across multiple pushes", () => {
    const manager = new BatchWindowManager({
      batchWindow: {
        prevBatchesCount: 2,
        compactAfter: 2
      },
      compaction: {
        thresholds: {
          tokenTarget: 90
        }
      }
    });

    const translated = Array.from({ length: 35 }, (_, i) => ({
      index: i,
      batchId: `b_${i}`,
      summary: `summary_${i}`
    }));

    for (let i = 0; i < translated.length; i += 1) {
      manager.pushCompactionIfNeeded(translated.slice(0, i + 1), i);
    }

    const compacted = manager.getCompactionContext();
    expect(compacted.length).toBeLessThanOrEqual(3);
    expect(compacted.every((item) => item.tokenEstimate > 0)).toBe(true);
    expect(compacted.every((item) => item.tokenEstimate <= 90)).toBe(true);
    expect(compacted[compacted.length - 1].sourceIndexes[0]).toBe(0);
  });
});
