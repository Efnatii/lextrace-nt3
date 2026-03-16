import { z } from "zod";

import {
  AiChatListResultSchema,
  AiChatResetPayloadSchema,
  AiChatResumePayloadSchema,
  AiChatSendPayloadSchema,
  AiChatStatusPayloadSchema,
  AiModelsCatalogPayloadSchema,
  AiStreamMessageSchema
} from "./ai";
import { COMMANDS, PROTOCOL_VERSION, STREAM_EVENTS } from "./constants";
import { ExtensionConfigPatchSchema } from "./config";
import { LogEntryInputSchema, LogEntrySchema } from "./logging";

export const MessageSourceSchema = z.enum([
  "popup",
  "overlay",
  "content",
  "background",
  "native-host",
  "tests",
  "config-store",
  "protocol-router"
]);

export const MessageTargetSchema = z.enum([
  "popup",
  "overlay",
  "content",
  "background",
  "native-host",
  "tests"
]);

export const ConfigPatchPayloadSchema = z.object({
  scope: z.enum(["local", "session"]).default("local"),
  patch: ExtensionConfigPatchSchema
});

const EmptyPayloadSchema = z.object({}).passthrough().optional().default({});
const OverlayTargetPayloadSchema = z
  .object({
    tabId: z.number().int().positive().optional(),
    expectedUrl: z.string().min(1).optional()
  })
  .optional()
  .default({});

export const CommandPayloadSchemas = {
  [COMMANDS.ping]: EmptyPayloadSchema,
  [COMMANDS.overlayProbe]: OverlayTargetPayloadSchema,
  [COMMANDS.overlayOpen]: OverlayTargetPayloadSchema,
  [COMMANDS.overlayClose]: OverlayTargetPayloadSchema,
  [COMMANDS.workerStart]: z
    .object({
      reason: z.string().optional()
    })
    .optional()
    .default({}),
  [COMMANDS.workerStop]: z
    .object({
      reason: z.string().optional()
    })
    .optional()
    .default({}),
  [COMMANDS.workerStatus]: EmptyPayloadSchema,
  [COMMANDS.configGet]: EmptyPayloadSchema,
  [COMMANDS.configPatch]: ConfigPatchPayloadSchema,
  [COMMANDS.logList]: z
    .object({
      limit: z.number().int().min(1).max(500).optional()
    })
    .optional()
    .default({}),
  [COMMANDS.logSubscribe]: z.object({
    since: z.string().datetime().nullable().optional()
  }),
  [COMMANDS.logRecord]: LogEntryInputSchema,
  [COMMANDS.aiModelsCatalog]: AiModelsCatalogPayloadSchema,
  [COMMANDS.aiChatStatus]: AiChatStatusPayloadSchema,
  [COMMANDS.aiChatSend]: AiChatSendPayloadSchema,
  [COMMANDS.aiChatResume]: AiChatResumePayloadSchema,
  [COMMANDS.aiChatReset]: AiChatResetPayloadSchema,
  [COMMANDS.aiChatList]: z.object({}).passthrough().optional().default({}),
  [COMMANDS.taskDemoStart]: z
    .object({
      taskId: z.string().min(1).optional()
    })
    .optional()
    .default({}),
  [COMMANDS.taskDemoStop]: z
    .object({
      taskId: z.string().min(1).optional()
    })
    .optional()
    .default({}),
  [COMMANDS.testHostCrash]: EmptyPayloadSchema
} as const satisfies Record<string, z.ZodTypeAny>;

export const SupportedActionSchema = z.enum(
  Object.values(COMMANDS) as [string, ...string[]]
);

export const ProtocolEnvelopeSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().min(1),
  scope: z.enum(["command", "event"]),
  action: z.string().min(1),
  source: MessageSourceSchema,
  target: MessageTargetSchema,
  ts: z.string().min(1),
  payload: z.unknown().optional(),
  correlationId: z.string().nullable().optional()
});

export const ProtocolErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  details: z.unknown().optional()
});

export const ProtocolResponseSchema = z.object({
  id: z.string().min(1),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: ProtocolErrorSchema.nullable().optional(),
  ts: z.string().min(1)
});

export const RuntimeStreamMessageSchema = z.object({
  stream: z.literal("runtime"),
  event: z.enum([
    STREAM_EVENTS.snapshot,
    STREAM_EVENTS.log,
    STREAM_EVENTS.status,
    STREAM_EVENTS.config
  ]),
  level: z.enum(["debug", "info", "warn", "error"]),
  summary: z.string().min(1),
  details: z.unknown().optional(),
  ts: z.string().min(1),
  correlationId: z.string().nullable().optional(),
  status: z.unknown().optional(),
  logEntry: LogEntrySchema.optional(),
  config: z.unknown().optional(),
  logs: z.array(LogEntrySchema).optional(),
  desired: z.unknown().optional()
});

export const ExtensionStreamMessageSchema = z.union([
  RuntimeStreamMessageSchema,
  AiStreamMessageSchema
]);

export type MessageSource = z.infer<typeof MessageSourceSchema>;
export type MessageTarget = z.infer<typeof MessageTargetSchema>;
export type ProtocolEnvelope = z.infer<typeof ProtocolEnvelopeSchema>;
export type ProtocolResponse = z.infer<typeof ProtocolResponseSchema>;
export type RuntimeStreamMessage = z.infer<typeof RuntimeStreamMessageSchema>;
export type ExtensionStreamMessage = z.infer<typeof ExtensionStreamMessageSchema>;
export type SupportedAction = z.infer<typeof SupportedActionSchema>;

export function createEnvelope(action: string, source: MessageSource, target: MessageTarget, payload?: unknown, correlationId?: string | null): ProtocolEnvelope {
  return {
    id: crypto.randomUUID(),
    version: PROTOCOL_VERSION,
    scope: "command",
    action,
    source,
    target,
    ts: new Date().toISOString(),
    payload,
    correlationId: correlationId ?? null
  };
}

export function validateEnvelope(input: unknown): ProtocolEnvelope {
  const envelope = ProtocolEnvelopeSchema.parse(input);
  if (!SupportedActionSchema.options.includes(envelope.action)) {
    throw new Error(`Unsupported action: ${envelope.action}`);
  }
  return envelope;
}

export function validateEnvelopePayload(envelope: ProtocolEnvelope): unknown {
  const schema = CommandPayloadSchemas[envelope.action as keyof typeof CommandPayloadSchemas];
  if (!schema) {
    throw new Error(`No payload schema for action ${envelope.action}`);
  }
  return schema.parse(envelope.payload);
}

export function createOkResponse(id: string, result?: unknown): ProtocolResponse {
  return {
    id,
    ok: true,
    result,
    ts: new Date().toISOString()
  };
}

export function createErrorResponse(id: string, code: string, message: string, details?: unknown): ProtocolResponse {
  return {
    id,
    ok: false,
    error: {
      code,
      message,
      details
    },
    ts: new Date().toISOString()
  };
}
