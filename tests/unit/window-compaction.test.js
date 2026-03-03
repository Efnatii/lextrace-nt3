import { describe, expect, it } from "vitest";
import { BatchWindowManager } from "../../src/shared/batch-window.js";

describe("BatchWindowManager", () => {
  it("returns previous window and creates compactions", () => {
    const manager = new BatchWindowManager({
      batchWindow: {
        prevBatchesCount: 2,
        compactAfter: 3
      }
    });

    const translated = [
      { index: 0, batchId: "b0", summary: "zero" },
      { index: 1, batchId: "b1", summary: "one" },
      { index: 2, batchId: "b2", summary: "two" },
      { index: 3, batchId: "b3", summary: "three" }
    ];

    const w = manager.buildWindow(translated, 4);
    expect(w.map((x) => x.batchId)).toEqual(["b2", "b3"]);

    manager.pushCompactionIfNeeded(translated, 4);
    const compacted = manager.getCompactionContext();
    expect(compacted.length).toBeGreaterThan(0);
    expect(compacted[0].text.length).toBeGreaterThan(0);
  });
});