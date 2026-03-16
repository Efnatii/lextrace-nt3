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
  "rate-limit",
  "resume",
  "reset",
  "error"
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
  models: z.array(AiModelCatalogItemSchema)
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
  meta: z.unknown().optional()
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
  activeRequestId: z.string().nullable(),
  openaiResponseId: z.string().nullable(),
  lastSequenceNumber: z.number().int().min(0).nullable(),
  recoverable: z.boolean(),
  rateLimits: AiRateLimitSnapshotSchema.optional(),
  currentModelBudget: AiModelBudgetStateSchema.nullable(),
  modelBudgets: AiModelBudgetMapSchema,
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
export type AiAllowedModelRule = z.infer<typeof AiAllowedModelRuleSchema>;
export type AiModelSelection = z.infer<typeof AiModelSelectionSchema>;
export type AiChatMessage = z.infer<typeof AiChatMessageSchema>;
export type AiChatQueueItem = z.infer<typeof AiChatQueueItemSchema>;
export type AiRateLimitSnapshot = z.infer<typeof AiRateLimitSnapshotSchema>;
export type AiModelBudgetState = z.infer<typeof AiModelBudgetStateSchema>;
export type AiModelBudgetMap = z.infer<typeof AiModelBudgetMapSchema>;
export type AiChatStatus = z.infer<typeof AiChatStatusSchema>;
export type AiChatPageSession = z.infer<typeof AiChatPageSessionSchema>;
export type AiStreamMessage = z.infer<typeof AiStreamMessageSchema>;
export type AiModelPricingTier = z.infer<typeof AiModelPricingTierSchema>;
export type AiModelCatalogItem = z.infer<typeof AiModelCatalogItemSchema>;
export type AiModelCatalogResult = z.infer<typeof AiModelCatalogResultSchema>;

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
    activeRequestId: null,
    openaiResponseId: null,
    lastSequenceNumber: null,
    recoverable: false,
    rateLimits: createEmptyAiRateLimitSnapshot(),
    currentModelBudget: null,
    modelBudgets: {},
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
