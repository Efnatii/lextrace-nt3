import { afterEach, describe, expect, it } from "vitest";
import { InflightRequestStore } from "../../src/shared/inflight-request-store.js";

function createStorageMock(initial = {}) {
  const data = { ...initial };
  return {
    data,
    storage: {
      local: {
        async get(keys) {
          if (!Array.isArray(keys)) {
            return { ...data };
          }
          const result = {};
          for (const key of keys) {
            result[key] = data[key];
          }
          return result;
        },
        async set(patch) {
          Object.assign(data, patch);
        }
      }
    }
  };
}

describe("InflightRequestStore", () => {
  afterEach(() => {
    delete global.chrome;
  });

  it("persists metadata and can clear by session", async () => {
    const mock = createStorageMock();
    global.chrome = mock;

    const store = new InflightRequestStore({ storageKey: "testInflight", maxRecords: 3 });
    await store.init();

    store.add({ requestId: "r1", pageSessionId: "s1", tabId: 1 });
    store.add({ requestId: "r2", pageSessionId: "s1", tabId: 1 });
    store.add({ requestId: "r3", pageSessionId: "s2", tabId: 2 });
    store.add({ requestId: "r4", pageSessionId: "s2", tabId: 2 });
    await store.flush();

    expect(Array.isArray(mock.data.testInflight)).toBe(true);
    expect(mock.data.testInflight.length).toBe(3);

    const restored = new InflightRequestStore({ storageKey: "testInflight", maxRecords: 3 });
    await restored.init();

    expect(restored.list().length).toBe(3);
    restored.clearSession("s2");
    await restored.flush();

    expect(restored.listBySession("s2").length).toBe(0);
    expect(restored.list().length).toBe(1);
  });
});
