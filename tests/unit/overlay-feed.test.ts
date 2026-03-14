import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { LogEntry } from "../../extension/src/shared/logging";
import {
  buildOverlayActivityFeed,
  type OverlayConsoleEntry
} from "../../extension/src/shared/overlay-feed";

function createConsoleEntry(
  overrides: Partial<OverlayConsoleEntry> = {}
): OverlayConsoleEntry {
  return {
    id: overrides.id ?? randomUUID(),
    ts: overrides.ts ?? "2026-03-14T10:00:00.000Z",
    kind: overrides.kind ?? "system",
    text: overrides.text ?? "system message",
    sequence: overrides.sequence ?? 0
  };
}

function createLogEntry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    id: overrides.id ?? randomUUID(),
    ts: overrides.ts ?? "2026-03-14T10:00:00.000Z",
    level: overrides.level ?? "info",
    source: overrides.source ?? "background",
    event: overrides.event ?? "runtime.tick",
    summary: overrides.summary ?? "Tick",
    details: overrides.details,
    correlationId: overrides.correlationId ?? null,
    collapsedByDefault: overrides.collapsedByDefault ?? true
  };
}

describe("overlay activity feed", () => {
  it("merges terminal entries and runtime logs in ascending timestamp order", () => {
    const consoleEntries = [
      createConsoleEntry({
        id: "cmd-1",
        ts: "2026-03-14T10:00:03.000Z",
        kind: "command",
        text: "NT3> worker.start",
        sequence: 7
      }),
      createConsoleEntry({
        id: "res-1",
        ts: "2026-03-14T10:00:05.000Z",
        kind: "result",
        text: "{\"ok\":true}",
        sequence: 9
      })
    ];

    const runtimeLogs = [
      createLogEntry({
        id: "log-1",
        ts: "2026-03-14T10:00:02.000Z",
        summary: "Worker booted"
      }),
      createLogEntry({
        id: "log-2",
        ts: "2026-03-14T10:00:04.000Z",
        summary: "Heartbeat"
      })
    ];

    const items = buildOverlayActivityFeed(
      consoleEntries,
      runtimeLogs,
      new Map([
        ["log-1", 6],
        ["log-2", 8]
      ])
    );

    expect(items.map((item) => item.id)).toEqual(["log-1", "cmd-1", "log-2", "res-1"]);
    expect(items.map((item) => item.type)).toEqual(["log", "terminal", "log", "terminal"]);
  });

  it("keeps runtime log collapsed semantics intact in the unified feed", () => {
    const collapsedLog = createLogEntry({
      id: "collapsed-log",
      collapsedByDefault: true
    });
    const expandedLog = createLogEntry({
      id: "expanded-log",
      ts: "2026-03-14T10:00:01.000Z",
      collapsedByDefault: false
    });

    const items = buildOverlayActivityFeed([], [collapsedLog, expandedLog]);
    const logItems = items.filter((item) => item.type === "log");

    expect(logItems).toHaveLength(2);
    expect(logItems[0]?.logEntry.collapsedByDefault).toBe(true);
    expect(logItems[1]?.logEntry.collapsedByDefault).toBe(false);
  });
});
