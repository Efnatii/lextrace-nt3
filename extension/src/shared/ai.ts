import { z } from "zod";

export const AiServiceTierSchema = z.enum(["standard", "flex", "priority"]);
export const OpenAiResolvedServiceTierSchema = z.enum(["default", "flex", "priority", "auto"]);
export const AiModelCatalogMatchSchema = z.enum(["exact", "family", "unavailable"]);
export const AiAllowedModelRuleSchema = z.object({
  model: z.string().min(1),
  tier: AiServiceTierSchema
});
export const AiModelSelectionSchema = AiAllowedModelRuleSchema;

export const AiMessageOriginSchema = z.enum(["user", "assistant", "code", "system"]);
export const AiMessageRoleSchema = z.enum(["user", "assistant", "system"]);
export const AiMessageStateSchema = z.enum(["pending", "streaming", "completed", "error"]);
export const AiRequestStateSchema = z.enum([
  "idle",
  "queued",
  "running",
  "streaming",
  "blocked",
  "detached",
  "paused",
  "error"
]);
export const AiEventKindSchema = z.enum([
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
export const AiPromptCacheRoutingSchema = z.enum(["stable_session_prefix", "provider_default"]);
export const AiPromptCacheRetentionSchema = z.enum(["in_memory", "24h"]);
export const AiPromptCacheSourceSchema = z.enum(["chat", "compaction"]);
export const AiPromptCacheStatusSchema = z.enum([
  "unknown",
  "below_threshold",
  "miss",
  "partial_hit",
  "full_hit"
]);

function createAiModelPricingTierSchema(tier: z.infer<typeof AiServiceTierSchema>) {
  return z.object({
    tier: z.literal(tier),
    pricingModelId: z.string().min(1).nullable(),
    inputUsdPer1M: z.number().nonnegative().nullable(),
    cachedInputUsdPer1M: z.number().nonnegative().nullable(),
    outputUsdPer1M: z.number().nonnegative().nullable(),
    trainingUsdPer1M: z.number().nonnegative().nullable(),
    trainingUsdPerHour: z.number().nonnegative().nullable(),
    summaryUsdPer1M: z.number().nonnegative().nullable()
  });
}

const AiModelPricingStandardSchema = createAiModelPricingTierSchema("standard");
const AiModelPricingFlexSchema = createAiModelPricingTierSchema("flex");
const AiModelPricingPrioritySchema = createAiModelPricingTierSchema("priority");
export const AiModelPricingTierSchema = z.union([
  AiModelPricingStandardSchema,
  AiModelPricingFlexSchema,
  AiModelPricingPrioritySchema
]);
export const AiModelPricingSchema = z.object({
  sourceUrl: z.string().url(),
  standard: AiModelPricingStandardSchema,
  flex: AiModelPricingFlexSchema,
  priority: AiModelPricingPrioritySchema
});

export const AiModelCatalogItemSchema = z.object({
  id: z.string().min(1),
  created: z.number().int().min(0).nullable(),
  ownedBy: z.string().min(1).nullable(),
  pricing: AiModelPricingSchema,
  family: z.string().min(1),
  matchedBy: z.object({
    standard: AiModelCatalogMatchSchema,
    flex: AiModelCatalogMatchSchema,
    priority: AiModelCatalogMatchSchema
  })
});

export const AiModelCatalogResultSchema = z.object({
  fetchedAt: z.string().min(1),
  models: z.array(AiModelCatalogItemSchema),
  warning: z.string().min(1).nullable().optional()
});

export const AiRateLimitSnapshotSchema = z.object({
  serverLimitRequests: z.number().int().min(0).nullable(),
  serverLimitTokens: z.number().int().min(0).nullable(),
  serverRemainingRequests: z.number().int().min(0).nullable(),
  serverRemainingTokens: z.number().int().min(0).nullable(),
  serverResetRequests: z.string().nullable(),
  serverResetTokens: z.string().nullable()
});

export const AiModelBudgetStateSchema = AiRateLimitSnapshotSchema.extend({
  model: z.string().min(1),
  observedAt: z.string().nullable(),
  lastResolvedServiceTier: OpenAiResolvedServiceTierSchema.nullable()
});

export const AiModelBudgetMapSchema = z.record(z.string().min(1), AiModelBudgetStateSchema);

export const AiCompactedMessageMetaSchema = z
  .object({
    compactedBy: z.string().min(1).nullable().optional()
  })
  .passthrough();

export const AiCompactionRangeMetaSchema = z
  .object({
    compactionId: z.string().min(1),
    affectedMessageIds: z.array(z.string().min(1)),
    rangeStartMessageId: z.string().min(1),
    rangeEndMessageId: z.string().min(1)
  })
  .passthrough();

export const AiCompactionRequestMetaSchema = AiCompactionRangeMetaSchema.extend({
  instructionsText: z.string().optional()
}).passthrough();

export const AiCompactionResultMetaSchema = AiCompactionRangeMetaSchema.extend({
  resultPreviewText: z.string().optional(),
  compactedItemCount: z.number().int().min(0).optional(),
  preservedTailCount: z.number().int().min(0).optional()
}).passthrough();

export const AiChatMessageMetaSchema = z
  .union([
    AiCompactedMessageMetaSchema,
    AiCompactionRequestMetaSchema,
    AiCompactionResultMetaSchema,
    z.record(z.string(), z.unknown())
  ])
  .nullable()
  .optional();

export const AiChatMessageSchema = z.object({
  id: z.string().min(1),
  pageKey: z.string().min(1),
  requestId: z.string().nullable(),
  openaiResponseId: z.string().nullable().optional(),
  origin: AiMessageOriginSchema,
  role: AiMessageRoleSchema,
  kind: AiEventKindSchema,
  text: z.string(),
  summary: z.string().nullable().optional(),
  ts: z.string().min(1),
  state: AiMessageStateSchema,
  meta: AiChatMessageMetaSchema
});

export const AiChatQueueItemSchema = z.object({
  id: z.string().min(1),
  requestId: z.string().min(1),
  pageKey: z.string().min(1),
  origin: z.enum(["user", "code"]),
  text: z.string().min(1),
  createdAt: z.string().min(1),
  state: z.enum(["queued", "running", "retryable", "blocked"])
});

export const AiAvailableActionsSchema = z.object({
  canSend: z.boolean(),
  canResume: z.boolean(),
  canReset: z.boolean()
});

export const AiPromptCacheLastRequestSchema = z.object({
  source: AiPromptCacheSourceSchema,
  promptTokens: z.number().int().min(0).nullable(),
  cachedTokens: z.number().int().min(0).nullable(),
  hitRatePct: z.number().min(0).max(100).nullable(),
  status: AiPromptCacheStatusSchema,
  retentionApplied: AiPromptCacheRetentionSchema,
  routingApplied: AiPromptCacheRoutingSchema,
  updatedAt: z.string().nullable()
});

export const AiPromptCacheSessionSchema = z.object({
  requestCount: z.number().int().min(0),
  chatRequestCount: z.number().int().min(0),
  compactionRequestCount: z.number().int().min(0),
  promptTokens: z.number().int().min(0),
  cachedTokens: z.number().int().min(0),
  hitRatePct: z.number().min(0).max(100).nullable()
});

export const AiPromptCachingSchema = z.object({
  routing: AiPromptCacheRoutingSchema,
  retention: AiPromptCacheRetentionSchema,
  lastRequest: AiPromptCacheLastRequestSchema.nullable(),
  session: AiPromptCacheSessionSchema
});

export const AiChatStatusSchema = z.object({
  provider: z.literal("openai"),
  apiKeyPresent: z.boolean(),
  model: AiModelSelectionSchema.nullable(),
  resolvedServiceTier: OpenAiResolvedServiceTierSchema.nullable(),
  streamingEnabled: z.boolean(),
  structuredOutputEnabled: z.boolean(),
  structuredOutputName: z.string().nullable(),
  structuredOutputStrict: z.boolean(),
  requestState: AiRequestStateSchema,
  lastError: z.string().nullable(),
  historyScope: z.literal("page"),
  pageKey: z.string().nullable(),
  pageUrlSample: z.string().nullable(),
  queueCount: z.number().int().min(0),
  contextPromptTokens: z.number().int().min(0).nullable(),
  activeRequestId: z.string().nullable(),
  openaiResponseId: z.string().nullable(),
  lastSequenceNumber: z.number().int().min(0).nullable(),
  recoverable: z.boolean(),
  rateLimits: AiRateLimitSnapshotSchema.optional(),
  currentModelBudget: AiModelBudgetStateSchema.nullable(),
  modelBudgets: AiModelBudgetMapSchema,
  promptCaching: AiPromptCachingSchema,
  availableActions: AiAvailableActionsSchema
});

export const AiChatPageSessionSchema = z.object({
  pageKey: z.string().min(1),
  pageUrlSample: z.string().nullable(),
  attachedViewIds: z.array(z.string().min(1)),
  state: AiRequestStateSchema,
  activeRequestId: z.string().nullable(),
  openaiResponseId: z.string().nullable(),
  lastSequenceNumber: z.number().int().min(0).nullable(),
  queuedCount: z.number().int().min(0),
  recoverable: z.boolean(),
  lastCheckpointAt: z.string().nullable(),
  lastError: z.string().nullable(),
  messages: z.array(AiChatMessageSchema),
  queue: z.array(AiChatQueueItemSchema),
  status: AiChatStatusSchema
});

export const AiChatSendPayloadSchema = z.object({
  pageKey: z.string().min(1),
  pageUrl: z.string().min(1),
  origin: z.enum(["user", "code"]),
  text: z.string().min(1),
  requestId: z.string().min(1).optional()
});

export const AiChatStatusPayloadSchema = z.object({
  pageKey: z.string().min(1),
  pageUrl: z.string().min(1).optional()
});

export const AiChatCompactPayloadSchema = z.object({
  pageKey: z.string().min(1),
  pageUrl: z.string().min(1).optional(),
  mode: z.enum(["safe", "force"]).optional()
});

export const AiModelsCatalogPayloadSchema = z.object({}).passthrough().optional().default({});

export const AiChatResetPayloadSchema = z.object({
  pageKey: z.string().min(1)
});

export const AiChatResumePayloadSchema = z.object({
  pageKey: z.string().min(1)
});

export const AiChatListResultSchema = z.object({
  sessions: z.array(AiChatPageSessionSchema)
});

export const AiChatStatusResultSchema = z.object({
  session: AiChatPageSessionSchema
});

export const AiChatCompactResultSchema = z.object({
  session: AiChatPageSessionSchema,
  triggered: z.boolean(),
  mode: z.enum(["safe", "force"]),
  compactionId: z.string().min(1).nullable().optional(),
  reason: z.string().min(1).nullable().optional(),
  affectedMessageCount: z.number().int().min(0).optional(),
  compactedItemCount: z.number().int().min(0).optional(),
  preservedTailCount: z.number().int().min(0).optional()
});

export const AiStreamEventSchema = z.enum([
  "ai.chat.snapshot",
  "ai.chat.status",
  "ai.chat.delta",
  "ai.chat.completed",
  "ai.chat.error",
  "ai.chat.compaction.started",
  "ai.chat.compaction.completed",
  "ai.chat.rate_limit.waiting"
]);

export const AiStreamMessageSchema = z.object({
  stream: z.literal("ai"),
  event: AiStreamEventSchema,
  level: z.enum(["debug", "info", "warn", "error"]),
  summary: z.string().min(1),
  details: z.unknown().optional(),
  ts: z.string().min(1),
  correlationId: z.string().nullable().optional(),
  pageKey: z.string().min(1),
  pageUrl: z.string().nullable().optional(),
  requestId: z.string().nullable().optional(),
  sequenceNumber: z.number().int().min(0).nullable().optional(),
  status: AiChatStatusSchema.optional(),
  session: AiChatPageSessionSchema.optional(),
  message: AiChatMessageSchema.optional(),
  queue: z.array(AiChatQueueItemSchema).optional(),
  delta: z.string().optional()
});

export type AiServiceTier = z.infer<typeof AiServiceTierSchema>;
export type OpenAiResolvedServiceTier = z.infer<typeof OpenAiResolvedServiceTierSchema>;
export type AiMessageOrigin = z.infer<typeof AiMessageOriginSchema>;
export type AiRequestState = z.infer<typeof AiRequestStateSchema>;
export type AiEventKind = z.infer<typeof AiEventKindSchema>;
export type AiAllowedModelRule = z.infer<typeof AiAllowedModelRuleSchema>;
export type AiModelSelection = z.infer<typeof AiModelSelectionSchema>;
export type AiChatMessage = z.infer<typeof AiChatMessageSchema>;
export type AiChatQueueItem = z.infer<typeof AiChatQueueItemSchema>;
export type AiRateLimitSnapshot = z.infer<typeof AiRateLimitSnapshotSchema>;
export type AiModelBudgetState = z.infer<typeof AiModelBudgetStateSchema>;
export type AiModelBudgetMap = z.infer<typeof AiModelBudgetMapSchema>;
export type AiCompactedMessageMeta = z.infer<typeof AiCompactedMessageMetaSchema>;
export type AiCompactionRangeMeta = z.infer<typeof AiCompactionRangeMetaSchema>;
export type AiCompactionRequestMeta = z.infer<typeof AiCompactionRequestMetaSchema>;
export type AiCompactionResultMeta = z.infer<typeof AiCompactionResultMetaSchema>;
export type AiChatMessageMeta = z.infer<typeof AiChatMessageMetaSchema>;
export type AiPromptCacheStatus = z.infer<typeof AiPromptCacheStatusSchema>;
export type AiPromptCacheRetention = z.infer<typeof AiPromptCacheRetentionSchema>;
export type AiPromptCacheRouting = z.infer<typeof AiPromptCacheRoutingSchema>;
export type AiPromptCacheSource = z.infer<typeof AiPromptCacheSourceSchema>;
export type AiPromptCacheLastRequest = z.infer<typeof AiPromptCacheLastRequestSchema>;
export type AiPromptCacheSession = z.infer<typeof AiPromptCacheSessionSchema>;
export type AiPromptCaching = z.infer<typeof AiPromptCachingSchema>;
export type AiChatStatus = z.infer<typeof AiChatStatusSchema>;
export type AiChatPageSession = z.infer<typeof AiChatPageSessionSchema>;
export type AiStreamMessage = z.infer<typeof AiStreamMessageSchema>;
export type AiModelPricingTier = z.infer<typeof AiModelPricingTierSchema>;
export type AiModelCatalogItem = z.infer<typeof AiModelCatalogItemSchema>;
export type AiModelCatalogResult = z.infer<typeof AiModelCatalogResultSchema>;

export type AiTranscriptSystemPromptItem = {
  type: "system-prompt";
  id: "system-prompt";
  promptText: string;
  isEmpty: boolean;
};

export type AiTranscriptMessageItem = {
  type: "message";
  id: string;
  message: AiChatMessage;
  dimmed: boolean;
};

export type AiTranscriptCompactedRangeItem = {
  type: "compacted-range";
  id: string;
  compactionId: string;
  affectedMessageIds: string[];
  rangeStartMessageId: string | null;
  rangeEndMessageId: string | null;
  messages: AiChatMessage[];
};

export type AiTranscriptCompactionRequestItem = {
  type: "compaction-request";
  id: string;
  message: AiChatMessage;
  meta: AiCompactionRequestMeta | null;
};

export type AiTranscriptCompactionResultItem = {
  type: "compaction-result";
  id: string;
  message: AiChatMessage;
  meta: AiCompactionResultMeta | null;
};

export type AiChatTranscriptItem =
  | AiTranscriptSystemPromptItem
  | AiTranscriptMessageItem
  | AiTranscriptCompactedRangeItem
  | AiTranscriptCompactionRequestItem
  | AiTranscriptCompactionResultItem;

export function isAiConversationalKind(kind: AiEventKind): kind is "user" | "assistant" | "code" {
  return kind === "user" || kind === "assistant" || kind === "code";
}

export function isAiTranscriptKind(
  kind: AiEventKind
): kind is "user" | "assistant" | "code" | "compaction" | "compaction-request" | "compaction-result" {
  return (
    kind === "user" ||
    kind === "assistant" ||
    kind === "code" ||
    kind === "compaction" ||
    kind === "compaction-request" ||
    kind === "compaction-result"
  );
}

export function getAiCompactedBy(message: AiChatMessage): string | null {
  const parsedMeta = AiCompactedMessageMetaSchema.safeParse(message.meta);
  const compactedBy = parsedMeta.success ? parsedMeta.data.compactedBy : undefined;
  return compactedBy && compactedBy.trim().length > 0 ? compactedBy : null;
}

export function getAiCompactionRequestMeta(message: AiChatMessage): AiCompactionRequestMeta | null {
  const parsedMeta = AiCompactionRequestMetaSchema.safeParse(message.meta);
  return parsedMeta.success ? parsedMeta.data : null;
}

export function getAiCompactionResultMeta(message: AiChatMessage): AiCompactionResultMeta | null {
  const parsedMeta = AiCompactionResultMetaSchema.safeParse(message.meta);
  return parsedMeta.success ? parsedMeta.data : null;
}

export function buildAiChatTranscriptItems(
  messages: readonly AiChatMessage[],
  instructions: string | null | undefined
): AiChatTranscriptItem[] {
  const transcript: AiChatTranscriptItem[] = [
    {
      type: "system-prompt",
      id: "system-prompt",
      promptText: instructions ?? "",
      isEmpty: !instructions || instructions.trim().length === 0
    }
  ];

  const compactionMetaById = new Map<string, AiCompactionRangeMeta>();
  for (const message of messages) {
    if (message.kind === "compaction-request") {
      const meta = getAiCompactionRequestMeta(message);
      if (meta) {
        compactionMetaById.set(meta.compactionId, meta);
      }
      continue;
    }

    if (message.kind === "compaction-result") {
      const meta = getAiCompactionResultMeta(message);
      if (meta) {
        compactionMetaById.set(meta.compactionId, meta);
      }
    }
  }

  let activeRange: AiTranscriptCompactedRangeItem | null = null;
  for (const message of messages) {
    if (!isAiTranscriptKind(message.kind)) {
      continue;
    }

    if (isAiConversationalKind(message.kind)) {
      const compactedBy = getAiCompactedBy(message);
      if (!compactedBy) {
        activeRange = null;
        transcript.push({
          type: "message",
          id: message.id,
          message,
          dimmed: false
        });
        continue;
      }

      if (activeRange && activeRange.compactionId === compactedBy) {
        activeRange.messages.push(message);
        if (!activeRange.affectedMessageIds.includes(message.id)) {
          activeRange.affectedMessageIds.push(message.id);
        }
        continue;
      }

      const meta = compactionMetaById.get(compactedBy);
      activeRange = {
        type: "compacted-range",
        id: `compacted:${compactedBy}`,
        compactionId: compactedBy,
        affectedMessageIds: meta?.affectedMessageIds?.length ? [...meta.affectedMessageIds] : [message.id],
        rangeStartMessageId: meta?.rangeStartMessageId ?? message.id,
        rangeEndMessageId: meta?.rangeEndMessageId ?? message.id,
        messages: [message]
      };
      transcript.push(activeRange);
      continue;
    }

    activeRange = null;
    if (message.kind === "compaction") {
      transcript.push({
        type: "message",
        id: message.id,
        message,
        dimmed: false
      });
      continue;
    }

    if (message.kind === "compaction-request") {
      transcript.push({
        type: "compaction-request",
        id: message.id,
        message,
        meta: getAiCompactionRequestMeta(message)
      });
      continue;
    }

    transcript.push({
      type: "compaction-result",
      id: message.id,
      message,
      meta: getAiCompactionResultMeta(message)
    });
  }

  return transcript;
}

export function formatAiServiceTierLabel(
  tier: AiServiceTier | OpenAiResolvedServiceTier | null | undefined
): string {
  switch (tier) {
    case "standard":
      return "стандарт";
    case "flex":
      return "flex";
    case "priority":
      return "приоритет";
    case "default":
      return "по умолчанию";
    case "auto":
      return "авто";
    default:
      return "н/д";
  }
}

export function formatAiMessageOriginLabel(origin: AiMessageOrigin): string {
  switch (origin) {
    case "user":
      return "пользователь";
    case "assistant":
      return "ассистент";
    case "code":
      return "код";
    case "system":
      return "система";
    default:
      return origin;
  }
}

export function formatAiEventKindLabel(kind: AiEventKind): string {
  switch (kind) {
    case "user":
      return "пользователь";
    case "assistant":
      return "ассистент";
    case "code":
      return "код";
    case "system":
      return "система";
    case "queue":
      return "очередь";
    case "compaction":
      return "сжатие";
    case "compaction-request":
      return "запрос сжатия";
    case "compaction-result":
      return "результат сжатия";
    case "rate-limit":
      return "лимит";
    case "resume":
      return "возобновление";
    case "reset":
      return "сброс";
    case "error":
      return "ошибка";
    default:
      return kind;
  }
}

export function formatAiRequestStateLabel(state: AiRequestState): string {
  switch (state) {
    case "idle":
      return "ожидание";
    case "queued":
      return "в очереди";
    case "running":
      return "в работе";
    case "streaming":
      return "поток";
    case "blocked":
      return "заблокировано";
    case "detached":
      return "отсоединено";
    case "paused":
      return "пауза";
    case "error":
      return "ошибка";
    default:
      return state;
  }
}

export function formatAiPromptCacheStatusLabel(status: AiPromptCacheStatus): string {
  switch (status) {
    case "below_threshold":
      return "ниже порога";
    case "miss":
      return "промах";
    case "partial_hit":
      return "частичное попадание";
    case "full_hit":
      return "полное попадание";
    case "unknown":
    default:
      return "неизвестно";
  }
}

export function formatAiPromptCacheRetentionLabel(retention: AiPromptCacheRetention): string {
  switch (retention) {
    case "24h":
      return "24 часа";
    case "in_memory":
    default:
      return "в памяти";
  }
}

export function formatAiPromptCacheRoutingLabel(routing: AiPromptCacheRouting): string {
  switch (routing) {
    case "provider_default":
      return "по умолчанию провайдера";
    case "stable_session_prefix":
    default:
      return "стабильный префикс сессии";
  }
}

export function formatAiPromptCacheSourceLabel(source: AiPromptCacheSource): string {
  switch (source) {
    case "compaction":
      return "сжатие";
    case "chat":
    default:
      return "чат";
  }
}

export function formatAiStatusLabel(label: string): string {
  switch (label) {
    case "provider":
      return "провайдер";
    case "key":
      return "ключ";
    case "model":
      return "модель";
    case "rpm":
      return "rpm";
    case "tpm":
      return "tpm";
    case "reset":
      return "сброс";
    case "served":
      return "тариф";
    case "format":
      return "формат";
    case "stream":
      return "поток";
    case "state":
      return "состояние";
    case "page":
      return "страница";
    case "queue":
      return "очередь";
    case "cache":
      return "кэш";
    case "cache-s":
      return "кэш/сессия";
    case "cache-state":
      return "статус кэша";
    case "cache-ret":
      return "хранение";
    case "cache-src":
      return "источник кэша";
    default:
      return label;
  }
}

export function createEmptyAiRateLimitSnapshot(): AiRateLimitSnapshot {
  return {
    serverLimitRequests: null,
    serverLimitTokens: null,
    serverRemainingRequests: null,
    serverRemainingTokens: null,
    serverResetRequests: null,
    serverResetTokens: null
  };
}

export function createEmptyAiModelBudgetState(model: string): AiModelBudgetState {
  return {
    model,
    observedAt: null,
    lastResolvedServiceTier: null,
    ...createEmptyAiRateLimitSnapshot()
  };
}

export function createDefaultAiStatus(pageKey: string, pageUrlSample: string | null, apiKeyPresent = false): AiChatStatus {
  return {
    provider: "openai",
    apiKeyPresent,
    model: null,
    resolvedServiceTier: null,
    streamingEnabled: true,
    structuredOutputEnabled: false,
    structuredOutputName: null,
    structuredOutputStrict: true,
    requestState: "idle",
    lastError: null,
    historyScope: "page",
    pageKey,
    pageUrlSample,
    queueCount: 0,
    contextPromptTokens: null,
    activeRequestId: null,
    openaiResponseId: null,
    lastSequenceNumber: null,
    recoverable: false,
    rateLimits: createEmptyAiRateLimitSnapshot(),
    currentModelBudget: null,
    modelBudgets: {},
    promptCaching: {
      routing: "stable_session_prefix",
      retention: "in_memory",
      lastRequest: null,
      session: {
        requestCount: 0,
        chatRequestCount: 0,
        compactionRequestCount: 0,
        promptTokens: 0,
        cachedTokens: 0,
        hitRatePct: null
      }
    },
    availableActions: {
      canSend: false,
      canResume: false,
      canReset: false
    }
  };
}

export function normalizeAiModelSelection(
  value: AiModelSelection | string | null | undefined,
  fallbackTier: AiServiceTier = "standard"
): AiModelSelection | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }

    const parsedRule = AiModelSelectionSchema.safeParse({
      model: trimmed,
      tier: fallbackTier
    });
    return parsedRule.success ? parsedRule.data : null;
  }

  const parsedRule = AiModelSelectionSchema.safeParse(value);
  return parsedRule.success ? parsedRule.data : null;
}

export function normalizeAllowedModelRules(
  value: readonly (AiAllowedModelRule | string)[],
  fallbackTier: AiServiceTier = "standard"
): AiAllowedModelRule[] {
  const normalized = new Map<string, AiAllowedModelRule>();

  for (const item of value) {
    const nextRule =
      typeof item === "string"
        ? {
            model: item,
            tier: fallbackTier
          }
        : item;

    const parsedRule = AiAllowedModelRuleSchema.safeParse(nextRule);
    if (!parsedRule.success) {
      continue;
    }

    const rule = parsedRule.data;
    normalized.set(`${rule.tier}::${rule.model.toLowerCase()}`, rule);
  }

  return [...normalized.values()].sort((left, right) => {
    const tierOrder = compareTier(left.tier, right.tier);
    if (tierOrder !== 0) {
      return tierOrder;
    }

    return left.model.localeCompare(right.model, "en", {
      sensitivity: "base",
      numeric: true
    });
  });
}

function compareTier(left: AiServiceTier, right: AiServiceTier): number {
  const order: Record<AiServiceTier, number> = {
    standard: 0,
    flex: 1,
    priority: 2
  };

  return order[left] - order[right];
}

export function formatAiPromptCachePercent(value: number | null): string {
  return value === null ? "-" : `${Math.round(value)}%`;
}

export function buildAiChatStatusFragments(status: AiChatStatus): Array<[string, string]> {
  const budget = status.currentModelBudget ?? status.rateLimits ?? null;
  const rpmText =
    budget && budget.serverRemainingRequests !== null && budget.serverLimitRequests !== null
      ? `${budget.serverRemainingRequests}/${budget.serverLimitRequests}`
      : "-";
  const tpmText =
    budget && budget.serverRemainingTokens !== null && budget.serverLimitTokens !== null
      ? `${budget.serverRemainingTokens}/${budget.serverLimitTokens}`
      : "-";
  const resetText = budget?.serverResetRequests ?? budget?.serverResetTokens ?? "-";
  const contextPromptTokensText =
    typeof status.contextPromptTokens === "number" ? String(status.contextPromptTokens) : "-";
  const configuredModelText = status.model
    ? `${status.model.model} [${formatAiServiceTierLabel(status.model.tier)}]`
    : "не задана";
  const formatText = status.structuredOutputEnabled
    ? `${status.structuredOutputName ?? "json_schema"}${status.structuredOutputStrict ? ", строго" : ""}`
    : "текст";
  const fragments: Array<[string, string]> = [
    ["provider", "OpenAI"],
    ["key", status.apiKeyPresent ? "задан" : "отсутствует"],
    ["model", configuredModelText],
    ["rpm", rpmText],
    ["tpm", tpmText],
    ["reset", resetText],
    ["format", formatText],
    ["stream", status.streamingEnabled ? "вкл" : "выкл"],
    ["state", formatAiRequestStateLabel(status.requestState)],
    ["tokens", contextPromptTokensText],
    ["page", status.pageKey ?? "-"],
    ["queue", String(status.queueCount)],
    ["cache", formatAiPromptCachePercent(status.promptCaching.lastRequest?.hitRatePct ?? null)],
    ["cache-s", formatAiPromptCachePercent(status.promptCaching.session.hitRatePct)],
    [
      "cache-state",
      formatAiPromptCacheStatusLabel(status.promptCaching.lastRequest?.status ?? "unknown")
    ],
    [
      "cache-ret",
      formatAiPromptCacheRetentionLabel(
        status.promptCaching.lastRequest?.retentionApplied ?? status.promptCaching.retention
      )
    ]
  ];

  if (status.resolvedServiceTier) {
    fragments.splice(6, 0, ["served", formatAiServiceTierLabel(status.resolvedServiceTier)]);
  }

  if (status.promptCaching.lastRequest?.source) {
    fragments.push(["cache-src", formatAiPromptCacheSourceLabel(status.promptCaching.lastRequest.source)]);
  }

  return fragments;
}
