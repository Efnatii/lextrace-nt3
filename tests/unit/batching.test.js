import { describe, expect, it } from "vitest";
import { createBatches } from "../../src/shared/batching.js";

describe("createBatches", () => {
  it("is deterministic for same input", () => {
    const blocks = Array.from({ length: 30 }, (_, idx) => ({
      blockId: `blk_${idx}`,
      text: `Text block number ${idx} with repeated repeated repeated words.`,
      order: idx,
      category: "generic"
    }));

    const settings = {
      batching: {
        blockLimits: { minChars: 1, maxChars: 3000 },
        batchTokenTarget: 90,
        maxBlocksPerBatch: 5
      }
    };

    const a = createBatches({ blocks, pageSessionId: "ps_1", settings });
    const b = createBatches({ blocks, pageSessionId: "ps_1", settings });

    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
    expect(a.every((batch) => batch.blocks.length <= 5)).toBe(true);
  });
});