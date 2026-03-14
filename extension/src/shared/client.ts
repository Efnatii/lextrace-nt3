import { COMMANDS, RUNTIME_STREAM_PORT } from "./constants";
import { ProtocolResponseSchema, createEnvelope, type MessageSource, type MessageTarget, type RuntimeStreamMessage } from "./protocol";

type RuntimeStreamHandler = (message: RuntimeStreamMessage | Record<string, unknown>) => void;

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
    handler(message as RuntimeStreamMessage | Record<string, unknown>);
  });

  return port;
}
