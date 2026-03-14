import { describe, expect, it } from "vitest";

import { createLogEntry, isLogLevelEnabled, serializeLogDetails, shouldCollapseLog } from "../../extension/src/shared/logging";

describe("logging helpers", () => {
  it("collapses long details by default", () => {
    const details = {
      payload: "x".repeat(300)
    };

    expect(shouldCollapseLog("short", details, 120)).toBe(true);
  });

  it("creates structured log entries", () => {
    const entry = createLogEntry(
      {
        level: "info",
        source: "tests",
        event: "test.event",
        summary: "A structured log",
        details: {
          ok: true
        }
      },
      120
    );

    expect(entry.level).toBe("info");
    expect(entry.source).toBe("tests");
    expect(entry.collapsedByDefault).toBe(false);
    expect(serializeLogDetails(entry.details)).toContain('"ok": true');
  });

  it("filters log levels against the configured threshold", () => {
    expect(isLogLevelEnabled("error", "warn")).toBe(true);
    expect(isLogLevelEnabled("warn", "warn")).toBe(true);
    expect(isLogLevelEnabled("info", "warn")).toBe(false);
    expect(isLogLevelEnabled("debug", "info")).toBe(false);
  });
});
