import { z } from "zod";

import {
  AiAllowedModelRuleSchema,
  AiModelSelectionSchema,
  normalizeAiModelSelection,
  normalizeAllowedModelRules
} from "./ai";
import { NATIVE_HOST_NAME, PROTOCOL_VERSION } from "./constants";

const AllowedModelsSchema = z
  .array(z.union([AiAllowedModelRuleSchema, z.string().min(1)]))
  .transform((value) => normalizeAllowedModelRules(value));
const NullableModelSelectionSchema = z
  .union([AiModelSelectionSchema, z.string(), z.null()])
  .transform((value) => normalizeAiModelSelection(value));
const JsonSchemaTextSchema = z.string().superRefine((value, context) => {
  const trimmed = value.trim();
  if (!trimmed) {
    return;
  }

  try {
    const parsedValue = JSON.parse(trimmed);
    if (!parsedValue || typeof parsedValue !== "object" || Array.isArray(parsedValue)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Structured output schema must be a JSON object."
      });
    }
  } catch {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Structured output schema must be valid JSON."
    });
  }
});

export const LogLevelSchema = z.enum(["debug", "info", "warn", "error"]);
export const PopupTabSchema = z.enum(["control", "config"]);
export const OverlayTabSchema = z.enum(["console", "chat"]);

export const ReconnectPolicySchema = z.object({
  baseDelayMs: z.number().int().min(250),
  maxDelayMs: z.number().int().min(500),
  maxAttempts: z.number().int().min(1)
});

export const OverlayUiConfigSchema = z.object({
  width: z.number().int().min(480),
  height: z.number().int().min(320),
  left: z.number().int().min(0),
  top: z.number().int().min(0),
  visible: z.boolean(),
  activeTab: OverlayTabSchema
});

export const ExtensionConfigSchema = z.object({
  ui: z.object({
    popupActiveTab: PopupTabSchema,
    overlay: OverlayUiConfigSchema
  }),
  logging: z.object({
    level: LogLevelSchema,
    maxEntries: z.number().int().min(100),
    collapseThreshold: z.number().int().min(80)
  }),
  runtime: z.object({
    nativeHostName: z.string().min(1),
    reconnectPolicy: ReconnectPolicySchema,
    heartbeatMs: z.number().int().min(250),
    commandTimeoutMs: z.number().int().min(1000)
  }),
  protocol: z.object({
    testCommandsEnabled: z.boolean()
  }),
  ai: z.object({
    allowedModels: AllowedModelsSchema,
    chat: z.object({
      model: NullableModelSelectionSchema,
      streamingEnabled: z.boolean(),
      instructions: z.string(),
      structuredOutput: z.object({
        name: z.string(),
        description: z.string(),
        schema: JsonSchemaTextSchema,
        strict: z.boolean()
      })
    }),
    compaction: z.object({
      enabled: z.boolean(),
      streamingEnabled: z.boolean(),
      modelOverride: NullableModelSelectionSchema,
      instructions: z.string(),
      triggerPromptTokens: z.number().int().min(32),
      preserveRecentTurns: z.number().int().min(0),
      maxPassesPerPage: z.number().int().min(1)
    }),
    rateLimits: z.object({
      reserveOutputTokens: z.number().int().min(1),
      maxQueuedPerPage: z.number().int().min(1),
      maxQueuedGlobal: z.number().int().min(1)
    })
  }),
  test: z.object({
    demoHeartbeatMs: z.number().int().min(250),
    allowHostCrashCommand: z.boolean()
  })
});

export const ExtensionConfigPatchSchema = z.object({
  ui: z
    .object({
      popupActiveTab: PopupTabSchema.optional(),
      overlay: z
        .object({
          width: z.number().int().min(480).optional(),
          height: z.number().int().min(320).optional(),
          left: z.number().int().min(0).optional(),
          top: z.number().int().min(0).optional(),
          visible: z.boolean().optional(),
          activeTab: OverlayTabSchema.optional()
        })
        .optional()
    })
    .optional(),
  logging: z
    .object({
      level: LogLevelSchema.optional(),
      maxEntries: z.number().int().min(100).optional(),
      collapseThreshold: z.number().int().min(80).optional()
    })
    .optional(),
  runtime: z
    .object({
      nativeHostName: z.string().min(1).optional(),
      reconnectPolicy: z
        .object({
          baseDelayMs: z.number().int().min(250).optional(),
          maxDelayMs: z.number().int().min(500).optional(),
          maxAttempts: z.number().int().min(1).optional()
        })
        .optional(),
      heartbeatMs: z.number().int().min(250).optional(),
      commandTimeoutMs: z.number().int().min(1000).optional()
    })
    .optional(),
  protocol: z
    .object({
      testCommandsEnabled: z.boolean().optional()
    })
    .optional(),
  ai: z
    .object({
      allowedModels: AllowedModelsSchema.optional(),
      chat: z
        .object({
          model: NullableModelSelectionSchema.optional(),
          streamingEnabled: z.boolean().optional(),
          instructions: z.string().optional(),
          structuredOutput: z
            .object({
              name: z.string().optional(),
              description: z.string().optional(),
              schema: JsonSchemaTextSchema.optional(),
              strict: z.boolean().optional()
            })
            .optional()
        })
        .optional(),
      compaction: z
        .object({
          enabled: z.boolean().optional(),
          streamingEnabled: z.boolean().optional(),
          modelOverride: NullableModelSelectionSchema.optional(),
          instructions: z.string().optional(),
          triggerPromptTokens: z.number().int().min(32).optional(),
          preserveRecentTurns: z.number().int().min(0).optional(),
          maxPassesPerPage: z.number().int().min(1).optional()
        })
        .optional(),
      rateLimits: z
        .object({
          reserveOutputTokens: z.number().int().min(1).optional(),
          maxQueuedPerPage: z.number().int().min(1).optional(),
          maxQueuedGlobal: z.number().int().min(1).optional()
        })
        .optional()
    })
    .optional(),
  test: z
    .object({
      demoHeartbeatMs: z.number().int().min(250).optional(),
      allowHostCrashCommand: z.boolean().optional()
    })
    .optional()
});

export type LogLevel = z.infer<typeof LogLevelSchema>;
export type PopupTab = z.infer<typeof PopupTabSchema>;
export type OverlayTab = z.infer<typeof OverlayTabSchema>;
export type ExtensionConfig = z.infer<typeof ExtensionConfigSchema>;
export type ExtensionConfigPatch = z.infer<typeof ExtensionConfigPatchSchema>;

export const defaultConfig: ExtensionConfig = {
  ui: {
    popupActiveTab: "control",
    overlay: {
      width: 920,
      height: 620,
      left: 32,
      top: 32,
      visible: false,
      activeTab: "console"
    }
  },
  logging: {
    level: "debug",
    maxEntries: 1000,
    collapseThreshold: 220
  },
  runtime: {
    nativeHostName: NATIVE_HOST_NAME,
    reconnectPolicy: {
      baseDelayMs: 1000,
      maxDelayMs: 30000,
      maxAttempts: 10
    },
    heartbeatMs: 1000,
    commandTimeoutMs: 60000
  },
  protocol: {
    testCommandsEnabled: true
  },
  ai: {
    allowedModels: [],
    chat: {
      model: null,
      streamingEnabled: true,
      instructions: "",
      structuredOutput: {
        name: "chat_response",
        description: "",
        schema: "",
        strict: true
      }
    },
    compaction: {
      enabled: true,
      streamingEnabled: true,
      modelOverride: null,
      instructions: "",
      triggerPromptTokens: 131072,
      preserveRecentTurns: 24,
      maxPassesPerPage: 16
    },
    rateLimits: {
      reserveOutputTokens: 32768,
      maxQueuedPerPage: 250,
      maxQueuedGlobal: 1000
    }
  },
  test: {
    demoHeartbeatMs: 1000,
    allowHostCrashCommand: true
  }
};

export function mergeConfig(base: ExtensionConfig, patch?: ExtensionConfigPatch | null): ExtensionConfig {
  const safePatch = normalizeConfigPatch(patch ?? {});

  const merged: ExtensionConfig = {
    ...base,
    ui: {
      ...base.ui,
      ...safePatch.ui,
      overlay: {
        ...base.ui.overlay,
        ...(safePatch.ui?.overlay ?? {})
      }
    },
    logging: {
      ...base.logging,
      ...(safePatch.logging ?? {})
    },
    runtime: {
      ...base.runtime,
      ...(safePatch.runtime ?? {}),
      reconnectPolicy: {
        ...base.runtime.reconnectPolicy,
        ...(safePatch.runtime?.reconnectPolicy ?? {})
      }
    },
    protocol: {
      ...base.protocol,
      ...(safePatch.protocol ?? {})
    },
    ai: {
      ...base.ai,
      ...(safePatch.ai ?? {}),
      chat: {
        ...base.ai.chat,
        ...(safePatch.ai?.chat ?? {}),
        structuredOutput: {
          ...base.ai.chat.structuredOutput,
          ...(safePatch.ai?.chat?.structuredOutput ?? {})
        }
      },
      compaction: {
        ...base.ai.compaction,
        ...(safePatch.ai?.compaction ?? {})
      },
      rateLimits: {
        ...base.ai.rateLimits,
        ...(safePatch.ai?.rateLimits ?? {})
      }
    },
    test: {
      ...base.test,
      ...(safePatch.test ?? {})
    }
  };

  return ExtensionConfigSchema.parse(merged);
}

export function mergeConfigPatch(
  basePatch?: ExtensionConfigPatch | null,
  nextPatch?: ExtensionConfigPatch | null
): ExtensionConfigPatch {
  const safeBasePatch = normalizeConfigPatch(basePatch ?? {});
  const safeNextPatch = normalizeConfigPatch(nextPatch ?? {});

  return normalizeConfigPatch({
    ...safeBasePatch,
    ...safeNextPatch,
    ui: {
      ...(safeBasePatch.ui ?? {}),
      ...(safeNextPatch.ui ?? {}),
      overlay: {
        ...(safeBasePatch.ui?.overlay ?? {}),
        ...(safeNextPatch.ui?.overlay ?? {})
      }
    },
    logging: {
      ...(safeBasePatch.logging ?? {}),
      ...(safeNextPatch.logging ?? {})
    },
    runtime: {
      ...(safeBasePatch.runtime ?? {}),
      ...(safeNextPatch.runtime ?? {}),
      reconnectPolicy: {
        ...(safeBasePatch.runtime?.reconnectPolicy ?? {}),
        ...(safeNextPatch.runtime?.reconnectPolicy ?? {})
      }
    },
    protocol: {
      ...(safeBasePatch.protocol ?? {}),
      ...(safeNextPatch.protocol ?? {})
    },
    ai: {
      ...(safeBasePatch.ai ?? {}),
      ...(safeNextPatch.ai ?? {}),
      chat: {
        ...(safeBasePatch.ai?.chat ?? {}),
        ...(safeNextPatch.ai?.chat ?? {}),
        structuredOutput: {
          ...(safeBasePatch.ai?.chat?.structuredOutput ?? {}),
          ...(safeNextPatch.ai?.chat?.structuredOutput ?? {})
        }
      },
      compaction: {
        ...(safeBasePatch.ai?.compaction ?? {}),
        ...(safeNextPatch.ai?.compaction ?? {})
      },
      rateLimits: {
        ...(safeBasePatch.ai?.rateLimits ?? {}),
        ...(safeNextPatch.ai?.rateLimits ?? {})
      }
    },
    test: {
      ...(safeBasePatch.test ?? {}),
      ...(safeNextPatch.test ?? {})
    }
  });
}

export function buildEffectiveConfig(localPatch?: ExtensionConfigPatch | null, sessionPatch?: ExtensionConfigPatch | null): ExtensionConfig {
  return mergeConfig(mergeConfig(defaultConfig, localPatch), sessionPatch);
}

export function normalizeConfigPatch(value: unknown): ExtensionConfigPatch {
  return ExtensionConfigPatchSchema.parse(migrateLegacyAiConfigShape(value));
}

function migrateLegacyAiConfigShape(value: unknown): unknown {
  if (!value || typeof value !== "object") {
    return value;
  }

  const patch = structuredClone(value as Record<string, unknown>);
  const ai = patch.ai;
  if (!ai || typeof ai !== "object") {
    return patch;
  }

  const aiPatch = ai as Record<string, unknown>;
  const chatPatch =
    aiPatch.chat && typeof aiPatch.chat === "object"
      ? (aiPatch.chat as Record<string, unknown>)
      : ((aiPatch.chat = {}) as Record<string, unknown>);
  const legacyTier = typeof aiPatch.serviceTier === "string" ? aiPatch.serviceTier : "standard";
  if ("model" in aiPatch) {
    if (!("model" in chatPatch)) {
      chatPatch.model = migrateLegacyModelSelection(aiPatch.model, legacyTier);
    }
    delete aiPatch.model;
  }

  if ("streamingEnabled" in aiPatch) {
    if (!("streamingEnabled" in chatPatch)) {
      chatPatch.streamingEnabled = aiPatch.streamingEnabled;
    }
    delete aiPatch.streamingEnabled;
  }

  if ("instructions" in aiPatch) {
    if (!("instructions" in chatPatch)) {
      chatPatch.instructions = aiPatch.instructions;
    }
    delete aiPatch.instructions;
  }

  if (aiPatch.compaction && typeof aiPatch.compaction === "object") {
    const compactionPatch = aiPatch.compaction as Record<string, unknown>;
    if ("modelOverride" in compactionPatch) {
      compactionPatch.modelOverride = migrateLegacyModelSelection(compactionPatch.modelOverride, legacyTier);
    }
  }

  delete aiPatch.serviceTier;
  return patch;
}

function migrateLegacyModelSelection(value: unknown, fallbackTier: string): unknown {
  if (typeof value === "string") {
    return normalizeAiModelSelection(value, fallbackTier === "flex" || fallbackTier === "priority" ? fallbackTier : "standard");
  }

  if (value && typeof value === "object") {
    const candidate = value as { model?: unknown; tier?: unknown };
    if (typeof candidate.model === "string") {
      return normalizeAiModelSelection({
        model: candidate.model,
        tier: candidate.tier === "flex" || candidate.tier === "priority" ? candidate.tier : "standard"
      });
    }
  }

  return value;
}

