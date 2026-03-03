import { describe, expect, it } from "vitest";
import { EventLogStore } from "../../src/shared/event-log-store.js";

describe("EventLogStore", () => {
  it("gc removes old records when maxBytes limit is exceeded", async () => {
    const store = new EventLogStore({
      maxRecords: 1000,
      maxAgeMs: 1000 * 60 * 60,
      maxBytes: 1800
    });
    await store.clear();

    for (let i = 0; i < 12; i += 1) {
      await store.append({
        ts: new Date(Date.now() + i).toISOString(),
        category: "ui.action",
        name: `evt_${i}`,
        data: {
          text: "x".repeat(180),
          i
        }
      });
    }

    const before = await store.query({ sort: "asc", limit: 1000 });
    expect(before.total).toBe(12);

    const result = await store.gc();
    expect(result.removedByMaxBytes).toBeGreaterThan(0);

    const after = await store.query({ sort: "asc", limit: 1000 });
    expect(after.total).toBeLessThan(12);
    expect(after.items[0].name).not.toBe("evt_0");
  });
});
