import { COMMANDS, RUNTIME_STREAM_PORT } from "./constants";
import { ProtocolResponseSchema, createEnvelope, type ExtensionStreamMessage, type MessageSource, type MessageTarget } from "./protocol";

type RuntimeStreamHandler = (message: ExtensionStreamMessage | Record<string, unknown>) => void;

export class ProtocolCommandError extends Error {
  readonly code: string;
  readonly details: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ProtocolCommandError";
    this.code = code;
    this.details = details;
  }
}

export async function sendCommand<T = unknown>(
  action: string,
  source: MessageSource,
  target: MessageTarget,
  payload?: unknown
): Promise<T> {
  const envelope = createEnvelope(action, source, target, payload);
  const response = ProtocolResponseSchema.parse(await chrome.runtime.sendMessage(envelope));
  if (!response.ok) {
    throw new ProtocolCommandError(
      response.error?.code ?? "command_failed",
      response.error?.message ?? `Command ${action} failed.`,
      response.error?.details
    );
  }

  return response.result as T;
}

export async function recordLog(
  source: MessageSource,
  event: string,
  summary: string,
  details?: unknown,
  level: "debug" | "info" | "warn" | "error" = "info"
): Promise<void> {
  try {
    await sendCommand(COMMANDS.logRecord, source, "background", {
      level,
      source,
      event,
      summary,
      details
    });
  } catch {
    // Logging should never block the UX path.
  }
}

export function connectRuntimeStream(handler: RuntimeStreamHandler): chrome.runtime.Port {
  const port = chrome.runtime.connect({
    name: RUNTIME_STREAM_PORT
  });

  port.onMessage.addListener((message) => {
    handler(message as ExtensionStreamMessage | Record<string, unknown>);
  });

  return port;
}

export function formatUserFacingCommandError(error: unknown, fallbackMessage: string): string {
  if (error instanceof ProtocolCommandError) {
    if (error.code === "unsupported_tab") {
      return "Терминал недоступен: переключитесь на обычную http(s)-страницу.";
    }
    if (error.code === "content_not_ready") {
      return "Терминал недоступен: перезагрузите страницу и повторите попытку.";
    }
  }

  const openAiError = extractOpenAiErrorPayload(error);
  if (openAiError?.code === "unsupported_country_region_territory") {
    return "OpenAI API недоступен для текущей страны, региона или территории. Сетевые AI-запросы из этого окружения не выполнятся.";
  }
  if (openAiError?.message) {
    return `OpenAI: ${openAiError.message}`;
  }

  return error instanceof Error && error.message ? error.message : fallbackMessage;
}

function extractOpenAiErrorPayload(error: unknown): { code?: string; message?: string } | null {
  const direct = extractOpenAiErrorPayloadFromUnknown(error);
  if (direct) {
    return direct;
  }

  if (error instanceof ProtocolCommandError) {
    const nested = extractOpenAiErrorPayloadFromUnknown(error.details);
    if (nested) {
      return nested;
    }

    return extractOpenAiErrorPayloadFromText(error.message);
  }

  if (error instanceof Error) {
    return extractOpenAiErrorPayloadFromText(error.message);
  }

  return null;
}

function extractOpenAiErrorPayloadFromUnknown(value: unknown): { code?: string; message?: string } | null {
  if (!value || typeof value !== "object") {
    if (typeof value === "string") {
      return extractOpenAiErrorPayloadFromText(value);
    }
    return null;
  }

  const record = value as Record<string, unknown>;
  if ("error" in record) {
    const nestedError = record.error;
    if (nestedError && typeof nestedError === "object") {
      const errorRecord = nestedError as Record<string, unknown>;
      const code = typeof errorRecord.code === "string" ? errorRecord.code : undefined;
      const message = typeof errorRecord.message === "string" ? errorRecord.message : undefined;
      if (code || message) {
        return { code, message };
      }
    }
  }

  for (const key of ["details", "cause", "body", "message"] as const) {
    if (key in record) {
      const nested = extractOpenAiErrorPayloadFromUnknown(record[key]);
      if (nested) {
        return nested;
      }
    }
  }

  return null;
}

function extractOpenAiErrorPayloadFromText(text: string): { code?: string; message?: string } | null {
  const jsonStart = text.indexOf("{");
  if (jsonStart === -1) {
    return null;
  }

  try {
    return extractOpenAiErrorPayloadFromUnknown(JSON.parse(text.slice(jsonStart)));
  } catch {
    return null;
  }
}
