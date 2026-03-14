import { z } from "zod";

import { NATIVE_HOST_NAME, PROTOCOL_VERSION } from "./constants";

export const LogLevelSchema = z.enum(["debug", "info", "warn", "error"]);
export const PopupTabSchema = z.enum(["control", "config"]);

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
  visible: z.boolean()
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
          visible: z.boolean().optional()
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
  test: z
    .object({
      demoHeartbeatMs: z.number().int().min(250).optional(),
      allowHostCrashCommand: z.boolean().optional()
    })
    .optional()
});

export type LogLevel = z.infer<typeof LogLevelSchema>;
export type PopupTab = z.infer<typeof PopupTabSchema>;
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
      visible: false
    }
  },
  logging: {
    level: "debug",
    maxEntries: 400,
    collapseThreshold: 220
  },
  runtime: {
    nativeHostName: NATIVE_HOST_NAME,
    reconnectPolicy: {
      baseDelayMs: 1000,
      maxDelayMs: 10000,
      maxAttempts: 5
    },
    heartbeatMs: 1000,
    commandTimeoutMs: 10000
  },
  protocol: {
    testCommandsEnabled: true
  },
  test: {
    demoHeartbeatMs: 1000,
    allowHostCrashCommand: true
  }
};

export function mergeConfig(base: ExtensionConfig, patch?: ExtensionConfigPatch | null): ExtensionConfig {
  const safePatch = patch ?? {};

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
  return ExtensionConfigPatchSchema.parse(value);
}

