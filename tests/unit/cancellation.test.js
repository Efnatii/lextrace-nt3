import { describe, expect, it } from "vitest";
import { CancellationRegistry } from "../../src/shared/cancellation-registry.js";

describe("CancellationRegistry", () => {
  it("cancels all requests in session", () => {
    const registry = new CancellationRegistry();
    const signal = registry.createSession("ps1");
    registry.registerRequest("ps1", "r1");
    registry.registerRequest("ps1", "r2");

    const result = registry.cancelSession("ps1");

    expect(signal.aborted).toBe(true);
    expect(result.requestIds).toEqual(["r1", "r2"]);
    expect(registry.getSignal("ps1")).toBeNull();
  });
});