import { z } from "zod";

import {
  AiChatCompactPayloadSchema,
  AiChatListResultSchema,
  AiChatResetPayloadSchema,
  AiChatResumePayloadSchema,
  AiChatSendPayloadSchema,
  AiChatStatusPayloadSchema,
  AiModelsCatalogPayloadSchema,
  AiStreamMessageSchema,
  createDefaultAiStatus,
  createEmptyAiModelBudgetState,
  normalizeAiModelSelection
} from "./ai";
import { COMMANDS, PROTOCOL_VERSION, STREAM_EVENTS } from "./constants";
import { normalizeConfigPatch } from "./config";
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
  patch: z.unknown().transform((value) => normalizeConfigPatch(value))
});
export const ConfigResetPayloadSchema = z.object({
  scope: z.enum(["local", "session"]).default("local")
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
  [COMMANDS.hostConnect]: z
    .object({
      reason: z.string().optional()
    })
    .optional()
    .default({}),
  [COMMANDS.hostDisconnect]: z
    .object({
      reason: z.string().optional()
    })
    .optional()
    .default({}),
  [COMMANDS.hostStatus]: EmptyPayloadSchema,
  [COMMANDS.hostRestart]: z
    .object({
      reason: z.string().optional()
    })
    .optional()
    .default({}),
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
  [COMMANDS.configReset]: ConfigResetPayloadSchema,
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
  [COMMANDS.aiChatCompact]: AiChatCompactPayloadSchema,
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
  workerStatus: z.unknown().optional(),
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
export type ParsedNativeHostMessage =
  | {
    kind: "response";
    message: ProtocolResponse;
    normalized: boolean;
  }
  | {
    kind: "stream";
    message: ExtensionStreamMessage;
    normalized: boolean;
  };

const AI_REQUEST_STATES = new Set([
  "idle",
  "queued",
  "running",
  "streaming",
  "blocked",
  "detached",
  "paused",
  "error"
]);
const AI_MESSAGE_ORIGINS = new Set(["user", "assistant", "code", "system"]);
const AI_MESSAGE_ROLES = new Set(["user", "assistant", "system"]);
const AI_MESSAGE_KINDS = new Set([
  "user",
  "assistant",
  "code",
  "system",
  "queue",
  "compaction",
  "compaction-request",
  "compaction-result",
  "rate-limit",
  "resume",
  "reset",
  "error"
]);
const AI_MESSAGE_STATES = new Set(["pending", "streaming", "completed", "error"]);
const AI_QUEUE_STATES = new Set(["queued", "running", "retryable", "blocked"]);
const OPENAI_SERVICE_TIERS = new Set(["default", "flex", "priority", "auto"]);
const PROMPT_CACHE_ROUTINGS = new Set(["stable_session_prefix", "provider_default"]);
const PROMPT_CACHE_RETENTIONS = new Set(["in_memory", "24h"]);
const PROMPT_CACHE_SOURCES = new Set(["chat", "compaction"]);
const PROMPT_CACHE_STATUSES = new Set(["unknown", "below_threshold", "miss", "partial_hit", "full_hit"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function getNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function getNullableInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function getNonNegativeInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}

function getBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeResolvedServiceTier(value: unknown): "default" | "flex" | "priority" | "auto" | null {
  if (value === "standard") {
    return "default";
  }

  return typeof value === "string" && OPENAI_SERVICE_TIERS.has(value)
    ? value as "default" | "flex" | "priority" | "auto"
    : null;
}

function normalizeAiRequestState(value: unknown, fallback: "idle" | "queued" | "running" | "streaming" | "blocked" | "detached" | "paused" | "error" = "idle"): "idle" | "queued" | "running" | "streaming" | "blocked" | "detached" | "paused" | "error" {
  if (value === "waiting") {
    return "queued";
  }

  if (value === "active") {
    return "running";
  }

  if (value === "complete" || value === "completed" || value === "done" || value === "success") {
    return "idle";
  }

  if (value === "failed") {
    return "error";
  }

  return typeof value === "string" && AI_REQUEST_STATES.has(value)
    ? value as "idle" | "queued" | "running" | "streaming" | "blocked" | "detached" | "paused" | "error"
    : fallback;
}

function normalizeAiOrigin(value: unknown, role: unknown, kind: unknown): "user" | "assistant" | "code" | "system" {
  if (value === "tool") {
    return "code";
  }

  if (typeof value === "string" && AI_MESSAGE_ORIGINS.has(value)) {
    return value as "user" | "assistant" | "code" | "system";
  }

  if (role === "assistant" || kind === "assistant") {
    return "assistant";
  }

  if (kind === "code") {
    return "code";
  }

  if (role === "user" || kind === "user") {
    return "user";
  }

  return "system";
}

function normalizeAiRole(value: unknown, origin: "user" | "assistant" | "code" | "system"): "user" | "assistant" | "system" {
  if (typeof value === "string" && AI_MESSAGE_ROLES.has(value)) {
    return value as "user" | "assistant" | "system";
  }

  if (origin === "assistant") {
    return "assistant";
  }

  return origin === "system" ? "system" : "user";
}

function normalizeAiKind(
  value: unknown,
  origin: "user" | "assistant" | "code" | "system",
  role: "user" | "assistant" | "system"
): "user" | "assistant" | "code" | "system" | "queue" | "compaction" | "compaction-request" | "compaction-result" | "rate-limit" | "resume" | "reset" | "error" {
  if (value === "compaction_started") {
    return "compaction-request";
  }

  if (value === "compaction_completed") {
    return "compaction-result";
  }

  if (typeof value === "string" && AI_MESSAGE_KINDS.has(value)) {
    return value as "user" | "assistant" | "code" | "system" | "queue" | "compaction" | "compaction-request" | "compaction-result" | "rate-limit" | "resume" | "reset" | "error";
  }

  if (origin === "assistant" || role === "assistant") {
    return "assistant";
  }

  if (origin === "code") {
    return "code";
  }

  if (origin === "user" || role === "user") {
    return "user";
  }

  return "system";
}

function normalizeAiMessageState(value: unknown): "pending" | "streaming" | "completed" | "error" {
  if (typeof value === "string" && AI_MESSAGE_STATES.has(value)) {
    return value as "pending" | "streaming" | "completed" | "error";
  }

  if (value === "queued") {
    return "pending";
  }

  if (value === "running") {
    return "streaming";
  }

  if (value === "failed" || value === "blocked") {
    return "error";
  }

  return "completed";
}

function normalizeAiQueueState(value: unknown): "queued" | "running" | "retryable" | "blocked" {
  if (typeof value === "string" && AI_QUEUE_STATES.has(value)) {
    return value as "queued" | "running" | "retryable" | "blocked";
  }

  if (value === "pending") {
    return "queued";
  }

  if (value === "streaming" || value === "active") {
    return "running";
  }

  if (value === "error" || value === "failed") {
    return "retryable";
  }

  return "queued";
}

function normalizePromptCaching(value: unknown, pageKey: string, pageUrlSample: string | null): Record<string, unknown> {
  const defaults = createDefaultAiStatus(pageKey, pageUrlSample).promptCaching;
  const defaultLastRequest = {
    source: "chat",
    promptTokens: null,
    cachedTokens: null,
    hitRatePct: null,
    status: "unknown",
    retentionApplied: defaults.retention,
    routingApplied: defaults.routing,
    updatedAt: null
  };
  if (!isRecord(value)) {
    return defaults;
  }

  const session = isRecord(value.session) ? value.session : {};
  const lastRequest = value.lastRequest === null
    ? null
    : isRecord(value.lastRequest)
      ? value.lastRequest
      : null;

  return {
    ...defaults,
    ...value,
    routing: typeof value.routing === "string" && PROMPT_CACHE_ROUTINGS.has(value.routing)
      ? value.routing
      : defaults.routing,
    retention: typeof value.retention === "string" && PROMPT_CACHE_RETENTIONS.has(value.retention)
      ? value.retention
      : defaults.retention,
    lastRequest: lastRequest
      ? {
        ...defaultLastRequest,
        ...lastRequest,
        source: typeof lastRequest.source === "string" && PROMPT_CACHE_SOURCES.has(lastRequest.source)
          ? lastRequest.source
          : defaultLastRequest.source,
        status: typeof lastRequest.status === "string" && PROMPT_CACHE_STATUSES.has(lastRequest.status)
          ? lastRequest.status
          : "unknown",
        retentionApplied: typeof lastRequest.retentionApplied === "string" && PROMPT_CACHE_RETENTIONS.has(lastRequest.retentionApplied)
          ? lastRequest.retentionApplied
          : defaults.retention,
        routingApplied: typeof lastRequest.routingApplied === "string" && PROMPT_CACHE_ROUTINGS.has(lastRequest.routingApplied)
          ? lastRequest.routingApplied
          : defaults.routing,
        promptTokens: typeof lastRequest.promptTokens === "number" ? lastRequest.promptTokens : null,
        cachedTokens: typeof lastRequest.cachedTokens === "number" ? lastRequest.cachedTokens : null,
        hitRatePct: typeof lastRequest.hitRatePct === "number" ? lastRequest.hitRatePct : null,
        updatedAt: getNullableString(lastRequest.updatedAt)
      }
      : null,
    session: {
      ...defaults.session,
      ...session,
      requestCount: getNonNegativeInteger(session.requestCount, defaults.session.requestCount),
      chatRequestCount: getNonNegativeInteger(session.chatRequestCount, defaults.session.chatRequestCount),
      compactionRequestCount: getNonNegativeInteger(session.compactionRequestCount, defaults.session.compactionRequestCount),
      promptTokens: getNonNegativeInteger(session.promptTokens, defaults.session.promptTokens),
      cachedTokens: getNonNegativeInteger(session.cachedTokens, defaults.session.cachedTokens),
      hitRatePct: typeof session.hitRatePct === "number" ? session.hitRatePct : null
    }
  };
}

function normalizeAiModelBudget(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) {
    return null;
  }

  const model = getNonEmptyString(value.model);
  if (!model) {
    return null;
  }

  return {
    ...createEmptyAiModelBudgetState(model),
    ...value,
    model,
    observedAt: getNullableString(value.observedAt),
    lastResolvedServiceTier: normalizeResolvedServiceTier(value.lastResolvedServiceTier)
  };
}

function normalizeAiModelBudgetMap(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    return {};
  }

  const normalizedEntries = Object.entries(value)
    .map(([key, entry]) => [key, normalizeAiModelBudget(entry)] as const)
    .filter((entry): entry is readonly [string, Record<string, unknown>] => entry[1] !== null);

  return Object.fromEntries(normalizedEntries);
}

function normalizeAiStatusPayload(value: unknown, pageKey: string, pageUrlSample: string | null): Record<string, unknown> {
  const raw = isRecord(value) ? value : {};
  const defaults = createDefaultAiStatus(pageKey, pageUrlSample, getBoolean(raw.apiKeyPresent, false));

  return {
    ...defaults,
    ...raw,
    provider: "openai",
    model: normalizeAiModelSelection(
      (typeof raw.model === "string" || isRecord(raw.model) || raw.model === null || raw.model === undefined
        ? raw.model
        : null) as string | {
        model: string;
        tier: "standard" | "flex" | "priority";
      } | null | undefined
    ),
    resolvedServiceTier: normalizeResolvedServiceTier(raw.resolvedServiceTier),
    requestState: normalizeAiRequestState(raw.requestState, defaults.requestState),
    historyScope: "page",
    pageKey: getNullableString(raw.pageKey) ?? pageKey,
    pageUrlSample: getNullableString(raw.pageUrlSample) ?? pageUrlSample,
    queueCount: getNonNegativeInteger(raw.queueCount, defaults.queueCount),
    contextPromptTokens: getNullableInteger(raw.contextPromptTokens) ?? defaults.contextPromptTokens,
    activeRequestId: getNullableString(raw.activeRequestId),
    openaiResponseId: getNullableString(raw.openaiResponseId),
    lastSequenceNumber: getNullableInteger(raw.lastSequenceNumber),
    lastError: getNullableString(raw.lastError),
    recoverable: getBoolean(raw.recoverable, defaults.recoverable),
    rateLimits: isRecord(raw.rateLimits)
      ? {
        ...defaults.rateLimits,
        ...raw.rateLimits
      }
      : defaults.rateLimits,
    currentModelBudget: normalizeAiModelBudget(raw.currentModelBudget),
    modelBudgets: normalizeAiModelBudgetMap(raw.modelBudgets),
    promptCaching: normalizePromptCaching(raw.promptCaching, pageKey, pageUrlSample),
    availableActions: {
      ...defaults.availableActions,
      ...(isRecord(raw.availableActions) ? raw.availableActions : {}),
      canSend: getBoolean(isRecord(raw.availableActions) ? raw.availableActions.canSend : undefined, defaults.availableActions.canSend),
      canResume: getBoolean(isRecord(raw.availableActions) ? raw.availableActions.canResume : undefined, defaults.availableActions.canResume),
      canReset: getBoolean(isRecord(raw.availableActions) ? raw.availableActions.canReset : undefined, defaults.availableActions.canReset)
    }
  };
}

function normalizeAiMessagePayload(value: unknown, fallbackPageKey: string): Record<string, unknown> | null {
  if (!isRecord(value)) {
    return null;
  }

  const origin = normalizeAiOrigin(value.origin, value.role, value.kind);
  const role = normalizeAiRole(value.role, origin);
  const kind = normalizeAiKind(value.kind, origin, role);
  const pageKey = getNonEmptyString(value.pageKey) ?? fallbackPageKey;
  const text = typeof value.text === "string" ? value.text : String(value.text ?? "");
  const summary = value.summary === undefined
    ? undefined
    : value.summary === null
      ? null
      : typeof value.summary === "string"
        ? value.summary
        : String(value.summary);

  return {
    ...value,
    id: getNonEmptyString(value.id) ?? `legacy-${crypto.randomUUID()}`,
    pageKey,
    requestId: getNullableString(value.requestId),
    openaiResponseId: getNullableString(value.openaiResponseId),
    origin,
    role,
    kind,
    text,
    summary,
    ts: getNonEmptyString(value.ts) ?? new Date().toISOString(),
    state: normalizeAiMessageState(value.state),
    meta: isRecord(value.meta) || value.meta === null || value.meta === undefined ? value.meta : null
  };
}

function normalizeAiQueueItemPayload(value: unknown, fallbackPageKey: string): Record<string, unknown> | null {
  if (!isRecord(value)) {
    return null;
  }

  const pageKey = getNonEmptyString(value.pageKey) ?? fallbackPageKey;
  const origin = value.origin === "code" ? "code" : "user";
  const text = getNonEmptyString(value.text) ?? "(legacy queue item)";
  const requestId = getNonEmptyString(value.requestId) ?? `legacy-${crypto.randomUUID()}`;

  return {
    ...value,
    id: getNonEmptyString(value.id) ?? `legacy-${crypto.randomUUID()}`,
    requestId,
    pageKey,
    origin,
    text,
    createdAt: getNonEmptyString(value.createdAt) ?? new Date().toISOString(),
    state: normalizeAiQueueState(value.state)
  };
}

function normalizeAiSessionPayload(value: unknown, fallbackPageKey: string, fallbackPageUrlSample: string | null): Record<string, unknown> | null {
  if (!isRecord(value)) {
    return null;
  }

  const pageKey = getNonEmptyString(value.pageKey) ?? fallbackPageKey;
  const pageUrlSample = getNullableString(value.pageUrlSample) ?? fallbackPageUrlSample;
  const status = normalizeAiStatusPayload(value.status, pageKey, pageUrlSample);
  const attachedViewIds = Array.isArray(value.attachedViewIds)
    ? value.attachedViewIds.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
  const messages = Array.isArray(value.messages)
    ? value.messages
      .map((item) => normalizeAiMessagePayload(item, pageKey))
      .filter((item): item is Record<string, unknown> => item !== null)
    : [];
  const queue = Array.isArray(value.queue)
    ? value.queue
      .map((item) => normalizeAiQueueItemPayload(item, pageKey))
      .filter((item): item is Record<string, unknown> => item !== null)
    : [];

  return {
    ...value,
    pageKey,
    pageUrlSample,
    attachedViewIds,
    state: normalizeAiRequestState(value.state, normalizeAiRequestState(status.requestState)),
    activeRequestId: getNullableString(value.activeRequestId),
    openaiResponseId: getNullableString(value.openaiResponseId),
    lastSequenceNumber: getNullableInteger(value.lastSequenceNumber),
    queuedCount: getNonNegativeInteger(value.queuedCount, queue.length),
    recoverable: getBoolean(value.recoverable, false),
    lastCheckpointAt: getNullableString(value.lastCheckpointAt),
    lastError: getNullableString(value.lastError),
    messages,
    queue,
    status
  };
}

function normalizeLegacyNativeHostMessage(input: unknown): unknown {
  if (!isRecord(input)) {
    return input;
  }

  const normalized: Record<string, unknown> = { ...input };
  if (normalized.event === undefined && typeof input.eventName === "string") {
    normalized.event = input.eventName;
  }
  if (normalized.ts === undefined && typeof input.timestamp === "string") {
    normalized.ts = input.timestamp;
  }

  if (normalized.stream === "runtime" && normalized.event === STREAM_EVENTS.log) {
    const logEntry = isRecord(normalized.logEntry) ? normalized.logEntry : {};
    normalized.logEntry = {
      id: getNonEmptyString(logEntry.id) ?? `legacy-${crypto.randomUUID()}`,
      ts: getNonEmptyString(logEntry.ts) ?? getNonEmptyString(normalized.ts) ?? new Date().toISOString(),
      level: typeof logEntry.level === "string" ? logEntry.level : normalized.level,
      source: getNonEmptyString(logEntry.source) ?? "native-host",
      event: getNonEmptyString(logEntry.event) ?? getNonEmptyString(normalized.event) ?? "runtime.log",
      summary: getNonEmptyString(logEntry.summary) ?? getNonEmptyString(normalized.summary) ?? "Native host log",
      details: logEntry.details ?? normalized.details,
      correlationId: logEntry.correlationId ?? normalized.correlationId ?? null,
      collapsedByDefault: typeof logEntry.collapsedByDefault === "boolean" ? logEntry.collapsedByDefault : false
    };
  }

  if (normalized.stream !== "ai") {
    return normalized;
  }

  if (normalized.event === "ai.chat.rate_limit_blocked") {
    normalized.event = "ai.chat.status";
  }

  const pageKey = getNonEmptyString(normalized.pageKey);
  if (!pageKey) {
    return normalized;
  }

  const pageUrlSample = getNullableString(normalized.pageUrl);
  if ("status" in normalized) {
    normalized.status = normalizeAiStatusPayload(normalized.status, pageKey, pageUrlSample);
  }
  if ("session" in normalized) {
    normalized.session = normalizeAiSessionPayload(normalized.session, pageKey, pageUrlSample);
  }
  if (normalized.message === null) {
    delete normalized.message;
  } else if ("message" in normalized) {
    normalized.message = normalizeAiMessagePayload(normalized.message, pageKey);
  }
  if (normalized.delta === null) {
    delete normalized.delta;
  }
  if (Array.isArray(normalized.queue)) {
    normalized.queue = normalized.queue
      .map((item) => normalizeAiQueueItemPayload(item, pageKey))
      .filter((item): item is Record<string, unknown> => item !== null);
  }

  return normalized;
}

export function parseNativeHostMessage(input: unknown): ParsedNativeHostMessage | null {
  const responseResult = ProtocolResponseSchema.safeParse(input);
  if (responseResult.success) {
    return {
      kind: "response",
      message: responseResult.data,
      normalized: false
    };
  }

  const streamResult = ExtensionStreamMessageSchema.safeParse(input);
  if (streamResult.success) {
    return {
      kind: "stream",
      message: streamResult.data,
      normalized: false
    };
  }

  const normalized = normalizeLegacyNativeHostMessage(input);
  const normalizedResponseResult = ProtocolResponseSchema.safeParse(normalized);
  if (normalizedResponseResult.success) {
    return {
      kind: "response",
      message: normalizedResponseResult.data,
      normalized: true
    };
  }

  const normalizedStreamResult = ExtensionStreamMessageSchema.safeParse(normalized);
  if (normalizedStreamResult.success) {
    return {
      kind: "stream",
      message: normalizedStreamResult.data,
      normalized: true
    };
  }

  return null;
}

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
