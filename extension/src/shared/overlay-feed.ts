import type { LogEntry } from "./logging";

export type OverlayConsoleEntryKind = "command" | "result" | "system" | "error";

export type OverlayConsoleEntry = {
  id: string;
  ts: string;
  kind: OverlayConsoleEntryKind;
  text: string;
  sequence: number;
};

export type OverlayTerminalActivity = {
  type: "terminal";
  id: string;
  ts: string;
  sequence: number;
  terminalKind: OverlayConsoleEntryKind;
  text: string;
};

export type OverlayLogActivity = {
  type: "log";
  id: string;
  ts: string;
  sequence: number;
  logEntry: LogEntry;
};

export type OverlayActivityItem = OverlayTerminalActivity | OverlayLogActivity;

function parseActivityTimestamp(ts: string): number {
  const parsed = Date.parse(ts);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function buildOverlayActivityFeed(
  consoleEntries: readonly OverlayConsoleEntry[],
  runtimeLogs: readonly LogEntry[],
  runtimeLogSequences: ReadonlyMap<string, number> = new Map()
): OverlayActivityItem[] {
  const items: OverlayActivityItem[] = [
    ...consoleEntries.map((entry) => ({
      type: "terminal" as const,
      id: entry.id,
      ts: entry.ts,
      sequence: entry.sequence,
      terminalKind: entry.kind,
      text: entry.text
    })),
    ...runtimeLogs.map((entry, index) => ({
      type: "log" as const,
      id: entry.id,
      ts: entry.ts,
      sequence: runtimeLogSequences.get(entry.id) ?? consoleEntries.length + index,
      logEntry: entry
    }))
  ];

  items.sort((left, right) => {
    const timestampDelta = parseActivityTimestamp(left.ts) - parseActivityTimestamp(right.ts);
    if (timestampDelta !== 0) {
      return timestampDelta;
    }

    const sequenceDelta = left.sequence - right.sequence;
    if (sequenceDelta !== 0) {
      return sequenceDelta;
    }

    return left.id.localeCompare(right.id);
  });

  return items;
}
