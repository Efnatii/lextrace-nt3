import { describe, expect, it } from "vitest";
import { createBatches } from "../../src/shared/batching.js";

describe("createBatches boundaries", () => {
  it("keeps batch size and token target boundaries for regular blocks", () => {
    const blocks = Array.from({ length: 40 }, (_, i) => ({
      blockId: `blk_${i}`,
      text: `Segment ${i} `.repeat(18),
      order: i,
      category: "paragraph"
    }));

    const settings = {
      batching: {
        blockLimits: { minChars: 1, maxChars: 2000 },
        batchTokenTarget: 180,
        maxBlocksPerBatch: 6
      }
    };

    const batches = createBatches({
      blocks,
      pageSessionId: "ps_bounds",
      settings
    });

    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches) {
      expect(batch.blocks.length).toBeLessThanOrEqual(6);
      if (batch.blocks.length > 1) {
        expect(batch.tokensEstimate).toBeLessThanOrEqual(180);
      }
    }
  });

  it("cuts oversized blocks by maxChars before estimating tokens", () => {
    const hugeText = "A".repeat(10_000);
    const batches = createBatches({
      blocks: [{ blockId: "blk_huge", text: hugeText, order: 0, category: "long_text" }],
      pageSessionId: "ps_huge",
      settings: {
        batching: {
          blockLimits: { minChars: 1, maxChars: 1200 },
          batchTokenTarget: 100,
          maxBlocksPerBatch: 4
        }
      }
    });

    expect(batches).toHaveLength(1);
    expect(batches[0].blocks[0].text.length).toBe(1200);
  });
});