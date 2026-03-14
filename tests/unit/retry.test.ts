import { describe, expect, it } from "vitest";

import { canReconnect, getReconnectDelayMs } from "../../extension/src/shared/retry";

const policy = {
  baseDelayMs: 1000,
  maxDelayMs: 8000,
  maxAttempts: 4
};

describe("retry policy", () => {
  it("backs off exponentially and caps at max delay", () => {
    expect(getReconnectDelayMs(1, policy)).toBe(1000);
    expect(getReconnectDelayMs(2, policy)).toBe(2000);
    expect(getReconnectDelayMs(3, policy)).toBe(4000);
    expect(getReconnectDelayMs(5, policy)).toBe(8000);
  });

  it("stops reconnecting after max attempts", () => {
    expect(canReconnect(4, policy)).toBe(true);
    expect(canReconnect(5, policy)).toBe(false);
  });
});

