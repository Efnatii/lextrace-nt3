import { z } from "zod";

import { MAX_LOG_DETAILS_PREVIEW } from "./constants";
import { LogLevelSchema } from "./config";

export const LogEntrySchema = z.object({
  id: z.string().min(1),
  ts: z.string().min(1),
  level: LogLevelSchema,
  source: z.string().min(1),
  event: z.string().min(1),
  summary: z.string().min(1),
  details: z.unknown().optional(),
  correlationId: z.string().nullable().optional(),
  collapsedByDefault: z.boolean()
});

export const LogEntryInputSchema = z.object({
  level: LogLevelSchema,
  source: z.string().min(1),
  event: z.string().min(1),
  summary: z.string().min(1),
  details: z.unknown().optional(),
  correlationId: z.string().nullable().optional()
});

export type LogEntry = z.infer<typeof LogEntrySchema>;
export type LogEntryInput = z.infer<typeof LogEntryInputSchema>;
export type LogLevel = z.infer<typeof LogLevelSchema>;

const LOG_LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

export function serializeLogDetails(details: unknown): string {
  if (details === undefined) {
    return "";
  }

  if (typeof details === "string") {
    return details;
  }

  try {
    return JSON.stringify(details, null, 2);
  } catch {
    return String(details);
  }
}

export function shouldCollapseLog(summary: string, details: unknown, threshold: number): boolean {
  const serialized = serializeLogDetails(details);
  return summary.length > threshold || serialized.length > threshold;
}

export function createLogEntry(input: LogEntryInput, collapseThreshold: number): LogEntry {
  const safeInput = LogEntryInputSchema.parse(input);
  return {
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    level: safeInput.level,
    source: safeInput.source,
    event: safeInput.event,
    summary: safeInput.summary,
    details: safeInput.details,
    correlationId: safeInput.correlationId ?? null,
    collapsedByDefault: shouldCollapseLog(safeInput.summary, safeInput.details, collapseThreshold)
  };
}

export function isLogLevelEnabled(entryLevel: LogLevel, thresholdLevel: LogLevel): boolean {
  return LOG_LEVEL_RANK[entryLevel] >= LOG_LEVEL_RANK[thresholdLevel];
}

export function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const extendedError = error as Error & {
      code?: unknown;
      details?: unknown;
      cause?: unknown;
    };
    return {
      name: error.name,
      message: error.message,
      stack: error.stack ?? null,
      ...(extendedError.code !== undefined ? { code: extendedError.code } : {}),
      ...(extendedError.details !== undefined ? { details: extendedError.details } : {}),
      ...(extendedError.cause !== undefined ? { cause: extendedError.cause } : {})
    };
  }

  return {
    message: typeof error === "string" ? error : String(error)
  };
}

export function getLogPreview(entry: LogEntry): string {
  const details = serializeLogDetails(entry.details);
  if (!details) {
    return entry.summary;
  }

  return details.length > MAX_LOG_DETAILS_PREVIEW
    ? `${details.slice(0, MAX_LOG_DETAILS_PREVIEW)}...`
    : details;
}
