import { describe, expect, it } from "vitest";

import {
  buildEffectiveConfig,
  defaultConfig,
  mergeConfig,
  mergeConfigPatch,
  normalizeConfigPatch
} from "../../extension/src/shared/config";

describe("config merge", () => {
  it("merges nested overlay and reconnect settings without dropping defaults", () => {
    const merged = mergeConfig(defaultConfig, {
      ui: {
        overlay: {
          width: 1200
        }
      },
      runtime: {
        reconnectPolicy: {
          maxAttempts: 9
        }
      }
    });

    expect(merged.ui.overlay.width).toBe(1200);
    expect(merged.ui.overlay.height).toBe(defaultConfig.ui.overlay.height);
    expect(merged.runtime.reconnectPolicy.maxAttempts).toBe(9);
    expect(merged.runtime.reconnectPolicy.baseDelayMs).toBe(
      defaultConfig.runtime.reconnectPolicy.baseDelayMs
    );
  });

  it("builds effective config from local and session patches", () => {
    const effective = buildEffectiveConfig(
      {
        logging: {
          maxEntries: 800
        }
      },
      {
        ui: {
          popupActiveTab: "config"
        }
      }
    );

    expect(effective.logging.maxEntries).toBe(800);
    expect(effective.ui.popupActiveTab).toBe("config");
    expect(effective.ui.overlay.activeTab).toBe(defaultConfig.ui.overlay.activeTab);
    expect(effective.runtime.nativeHostName).toBe(defaultConfig.runtime.nativeHostName);
    expect(effective.ai.chat.streamingEnabled).toBe(defaultConfig.ai.chat.streamingEnabled);
    expect(effective.ai.chat.model).toBe(defaultConfig.ai.chat.model);
    expect(effective.ai.chat.structuredOutput).toEqual(defaultConfig.ai.chat.structuredOutput);
  });

  it("uses the new conservative defaults for runtime, logging and ai capacity reserves", () => {
    expect(defaultConfig.runtime.commandTimeoutMs).toBe(60000);
    expect(defaultConfig.runtime.reconnectPolicy.maxDelayMs).toBe(30000);
    expect(defaultConfig.runtime.reconnectPolicy.maxAttempts).toBe(10);
    expect(defaultConfig.logging.maxEntries).toBe(1000);
    expect(defaultConfig.ai.compaction.streamingEnabled).toBe(true);
    expect(defaultConfig.ai.compaction.triggerPromptTokens).toBe(131072);
    expect(defaultConfig.ai.compaction.preserveRecentTurns).toBe(24);
    expect(defaultConfig.ai.compaction.maxPassesPerPage).toBe(16);
    expect(defaultConfig.ai.rateLimits.reserveOutputTokens).toBe(32768);
    expect(defaultConfig.ai.rateLimits.maxQueuedPerPage).toBe(250);
    expect(defaultConfig.ai.rateLimits.maxQueuedGlobal).toBe(1000);
  });

  it("merges nested ai config without dropping sibling defaults", () => {
    const merged = mergeConfig(defaultConfig, {
      ai: {
        allowedModels: [
          { model: "gpt-5", tier: "standard" },
          { model: "gpt-4.1", tier: "priority" }
        ],
        chat: {
          model: {
            model: "gpt-5",
            tier: "flex"
          },
          structuredOutput: {
            schema: '{"type":"object","properties":{"translation":{"type":"string"}},"required":["translation"],"additionalProperties":false}'
          }
        },
        rateLimits: {
          maxQueuedPerPage: 8
        }
      }
    });

    expect(merged.ai.chat.model).toEqual({
      model: "gpt-5",
      tier: "flex"
    });
    expect(merged.ai.chat.structuredOutput.schema).toContain('"translation"');
    expect(merged.ai.chat.structuredOutput.strict).toBe(defaultConfig.ai.chat.structuredOutput.strict);
    expect(merged.ai.compaction.streamingEnabled).toBe(defaultConfig.ai.compaction.streamingEnabled);
    expect(merged.ai.allowedModels).toEqual([
      { model: "gpt-5", tier: "standard" },
      { model: "gpt-4.1", tier: "priority" }
    ]);
    expect(merged.ai.rateLimits.maxQueuedPerPage).toBe(8);
    expect(merged.ai.rateLimits.reserveOutputTokens).toBe(defaultConfig.ai.rateLimits.reserveOutputTokens);
    expect(merged.ai.compaction.enabled).toBe(defaultConfig.ai.compaction.enabled);
  });

  it("normalizes legacy string arrays in allowedModels", () => {
    const normalized = normalizeConfigPatch({
      ai: {
        allowedModels: ["gpt-5", "gpt-4.1"]
      }
    } as unknown);
    const effective = buildEffectiveConfig(normalized, null);

    expect(effective.ai.allowedModels).toEqual([
      { model: "gpt-4.1", tier: "standard" },
      { model: "gpt-5", tier: "standard" }
    ]);
  });

  it("migrates legacy serviceTier + string model fields into model-rule objects", () => {
    const normalized = normalizeConfigPatch({
      ai: {
        serviceTier: "flex",
        model: "gpt-5-mini",
        streamingEnabled: false,
        instructions: "chat system",
        chat: {
          structuredOutput: {
            schema: '{"type":"object"}',
            strict: false
          }
        },
        compaction: {
          modelOverride: "gpt-4.1",
          instructions: "compact system"
        }
      }
    } as unknown);

    const effective = buildEffectiveConfig(normalized, null);

    expect("serviceTier" in effective.ai).toBe(false);
    expect(effective.ai.chat.model).toEqual({
      model: "gpt-5-mini",
      tier: "flex"
    });
    expect(effective.ai.chat.streamingEnabled).toBe(false);
    expect(effective.ai.chat.instructions).toBe("chat system");
    expect(effective.ai.chat.structuredOutput.schema).toBe('{"type":"object"}');
    expect(effective.ai.chat.structuredOutput.strict).toBe(false);
    expect(effective.ai.compaction.modelOverride).toEqual({
      model: "gpt-4.1",
      tier: "flex"
    });
    expect(effective.ai.compaction.instructions).toBe("compact system");
  });

  it("ignores removed local ai RPM/TPM caps during normalization", () => {
    const normalized = normalizeConfigPatch({
      ai: {
        rateLimits: {
          localRpmCap: 999,
          localTpmCap: 999999,
          reserveOutputTokens: 4096
        }
      }
    });

    const effective = buildEffectiveConfig(normalized, null);
    expect("localRpmCap" in effective.ai.rateLimits).toBe(false);
    expect("localTpmCap" in effective.ai.rateLimits).toBe(false);
    expect(effective.ai.rateLimits.reserveOutputTokens).toBe(4096);
  });

  it("preserves overlay activeTab patches during normalization", () => {
    const normalized = normalizeConfigPatch({
      ui: {
        overlay: {
          activeTab: "chat",
          width: 1111
        }
      }
    });

    const effective = buildEffectiveConfig(normalized, null);

    expect(effective.ui.overlay.activeTab).toBe("chat");
    expect(effective.ui.overlay.width).toBe(1111);
  });

  it("deep-merges nested config patches without dropping sibling ui state", () => {
    const mergedPatch = mergeConfigPatch(
      {
        ui: {
          popupActiveTab: "config"
        }
      },
      {
        ui: {
          overlay: {
            visible: true
          }
        }
      }
    );

    expect(mergedPatch.ui?.popupActiveTab).toBe("config");
    expect(mergedPatch.ui?.overlay?.visible).toBe(true);
  });

  it("ignores legacy protocol.supportedVersion patches during normalization", () => {
    const normalized = normalizeConfigPatch({
      protocol: {
        supportedVersion: 99,
        testCommandsEnabled: false
      }
    });

    const effective = buildEffectiveConfig(null, normalized);

    expect("supportedVersion" in effective.protocol).toBe(false);
    expect(effective.protocol.testCommandsEnabled).toBe(false);
  });
});
