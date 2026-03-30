import { describe, expect, it } from "vitest";

import {
  beginConfigEdit,
  cancelConfigEdit,
  commitConfigEdit,
  updateConfigEdit
} from "../../extension/src/shared/config-editor";
import {
  buildConfigPatchFromPath,
  getConfigFieldDisplayValue,
  getConfigFieldTooltipValue,
  isSensitiveConfigPath,
  parseConfigFieldDraft,
  redactSensitiveConfigData
} from "../../extension/src/shared/config-fields";
import {
  buildEffectiveConfig,
  defaultConfig,
  mergeConfigPatch,
  normalizeConfigPatch
} from "../../extension/src/shared/config";

describe("config edit workflow", () => {
  it("starts editing from the formatted display value", () => {
    expect(beginConfigEdit("runtime.commandTimeoutMs", 2500)).toMatchObject({
      path: "runtime.commandTimeoutMs",
      draft: "2500",
      initialDisplayValue: "2500",
      error: null
    });
  });

  it("starts modal-text editing with a null placeholder", () => {
    expect(beginConfigEdit("ai.chat.instructions", "")).toMatchObject({
      draft: "null",
      initialDisplayValue: "null"
    });
  });

  it("updates the draft and clears any stale error", () => {
    expect(
      updateConfigEdit(
        {
          path: "runtime.commandTimeoutMs",
          draft: "2500",
          initialDisplayValue: "2500",
          error: "old"
        },
        "3000"
      )
    ).toMatchObject({
      draft: "3000",
      error: null
    });
  });

  it("cancels editing by returning null", () => {
    expect(cancelConfigEdit()).toBeNull();
  });

  it("commits a valid inline number edit", () => {
    expect(
      commitConfigEdit(
        beginConfigEdit("runtime.commandTimeoutMs", 60000)
      )
    ).toMatchObject({
      ok: true,
      scope: "local",
      value: 60000,
      patch: {
        runtime: {
          commandTimeoutMs: 60000
        }
      }
    });
  });

  it("returns a rollback result for unknown config paths", () => {
    expect(
      commitConfigEdit({
        path: "missing.path",
        draft: "value",
        initialDisplayValue: "value",
        error: null
      })
    ).toMatchObject({
      ok: false,
      path: "missing.path",
      rollbackDisplayValue: "value"
    });
  });

  it("returns a rollback result for invalid drafts", () => {
    expect(
      commitConfigEdit({
        path: "runtime.commandTimeoutMs",
        draft: "broken",
        initialDisplayValue: "2500",
        error: null
      })
    ).toMatchObject({
      ok: false,
      path: "runtime.commandTimeoutMs",
      rollbackDisplayValue: "2500"
    });
  });
});

describe("config field parsing and formatting", () => {
  it.each([
    ["ui.overlay.visible", "true", true],
    ["protocol.testCommandsEnabled", "false", false],
    ["runtime.commandTimeoutMs", "2500", 2500],
    ["runtime.nativeHostName", "com.lextrace.custom", "com.lextrace.custom"],
    ["ai.promptCaching.routing", "provider_default", "provider_default"],
    ["ai.promptCaching.retention", "24h", "24h"],
    ["ai.retries.maxRetries", "2", 2],
    ["ai.queueRetries.maxRetries", "4", 4],
    ["ai.chat.model", '{"model":"gpt-5","tier":"flex"}', { model: "gpt-5", tier: "flex" }],
    ["ai.chat.model", "null", null],
    ["ai.allowedModels", '["gpt-5","gpt-5-mini"]', [
      { model: "gpt-5", tier: "standard" },
      { model: "gpt-5-mini", tier: "standard" }
    ]],
    ["ai.allowedModels", '[{"model":"gpt-4.1","tier":"priority"}]', [
      { model: "gpt-4.1", tier: "priority" }
    ]]
  ])("parses field %s from %s", (path, rawValue, expected) => {
    expect(parseConfigFieldDraft(path, rawValue)).toEqual(expected);
  });

  it.each([
    ["ui.overlay.visible", "yes"],
    ["runtime.commandTimeoutMs", "12.5"],
    ["logging.maxEntries", "abc"],
    ["ai.allowedModels", "{}"],
    ["ai.chat.streamingEnabled", "enabled"],
    ["missing.path", "value"]
  ])("rejects invalid draft for %s", (path, rawValue) => {
    expect(() => parseConfigFieldDraft(path, rawValue)).toThrow();
  });

  it("builds nested patches for deep config paths", () => {
    expect(
      buildConfigPatchFromPath("ai.chat.structuredOutput.strict", false)
    ).toEqual({
      ai: {
        chat: {
          structuredOutput: {
            strict: false
          }
        }
      }
    });
  });

  it.each([
    ["runtime.commandTimeoutMs", 2500, "2500"],
    ["ui.overlay.visible", true, "true"],
    ["ai.chat.instructions", "", "null"],
    ["ai.openAiApiKey", "sk-secret", "[скрыто]"],
    ["ai.chat.model", { model: "gpt-5", tier: "standard" }, '{"model":"gpt-5","tier":"standard"}']
  ])("formats display value for %s", (path, value, expected) => {
    expect(getConfigFieldDisplayValue(path, value)).toBe(expected);
  });

  it.each([
    ["runtime.commandTimeoutMs", 2500, "2500"],
    ["ui.overlay.visible", false, "false"],
    ["ai.chat.instructions", "", "null"],
    ["ai.openAiApiKey", "sk-secret", "OPENAI_API_KEY"],
    ["ai.allowedModels", [{ model: "gpt-5", tier: "standard" }], '"model": "gpt-5"']
  ])("formats tooltip value for %s", (path, value, expectedSubstring) => {
    expect(getConfigFieldTooltipValue(path, value)).toContain(expectedSubstring);
  });

  it.each([
    ["ai.openAiApiKey", true],
    ["runtime.nativeHostName", false],
    ["ai.chat.instructions", false],
    ["missing.path", false]
  ])("marks sensitivity for %s", (path, expected) => {
    expect(isSensitiveConfigPath(path)).toBe(expected);
  });

  it("redacts sensitive values inside nested config trees", () => {
    expect(
      redactSensitiveConfigData({
        ai: {
          openAiApiKey: "sk-secret",
          chat: {
            instructions: "keep",
            model: { model: "gpt-5", tier: "standard" }
          }
        }
      })
    ).toEqual({
      ai: {
        openAiApiKey: "[скрыто]",
        chat: {
          instructions: "keep",
          model: { model: "gpt-5", tier: "standard" }
        }
      }
    });
  });

  it("keeps null sensitive values intact during redaction", () => {
    expect(
      redactSensitiveConfigData({
        ai: {
          openAiApiKey: null
        }
      })
    ).toEqual({
      ai: {
        openAiApiKey: null
      }
    });
  });
});

describe("config normalization and patch composition", () => {
  it("migrates legacy AI model fields into ai.chat", () => {
    const normalized = normalizeConfigPatch({
      ai: {
        serviceTier: "priority",
        model: "gpt-4.1",
        streamingEnabled: false,
        instructions: "legacy"
      }
    });

    expect(normalized.ai?.chat).toEqual({
      model: { model: "gpt-4.1", tier: "priority" },
      streamingEnabled: false,
      instructions: "legacy"
    });
  });

  it("migrates legacy compaction modelOverride strings", () => {
    const normalized = normalizeConfigPatch({
      ai: {
        serviceTier: "flex",
        compaction: {
          modelOverride: "gpt-5-mini"
        }
      }
    });

    expect(normalized.ai?.compaction?.modelOverride).toEqual({
      model: "gpt-5-mini",
      tier: "flex"
    });
  });

  it("composes nested UI and AI patches without dropping siblings", () => {
    expect(
      mergeConfigPatch(
        {
          ui: {
            popupActiveTab: "config"
          },
          ai: {
            chat: {
              streamingEnabled: false
            }
          }
        },
        {
          ui: {
            overlay: {
              activeTab: "chat"
            }
          },
          ai: {
            rateLimits: {
              maxQueuedPerPage: 8
            },
            retries: {
              maxRetries: 2
            },
            queueRetries: {
              maxRetries: 2
            }
          }
        }
      )
    ).toMatchObject({
      ui: {
        popupActiveTab: "config",
        overlay: {
          activeTab: "chat"
        }
      },
        ai: {
          chat: {
            streamingEnabled: false
          },
          retries: {
            maxRetries: 2
          },
          queueRetries: {
            maxRetries: 2
          },
          rateLimits: {
            maxQueuedPerPage: 8
          }
        }
    });
  });

  it("lets session patches override local patches in the effective config", () => {
    const effective = buildEffectiveConfig(
      {
        ui: {
          overlay: {
            activeTab: "console"
          }
        }
      },
      {
        ui: {
          overlay: {
            activeTab: "chat"
          }
        }
      }
    );

    expect(effective.ui.overlay.activeTab).toBe("chat");
  });

  it("keeps unrelated defaults while applying a focused patch", () => {
    const effective = buildEffectiveConfig(
      {
        runtime: {
          commandTimeoutMs: 2500
        }
      },
      null
    );

    expect(effective.runtime.commandTimeoutMs).toBe(2500);
    expect(effective.ai.compaction.enabled).toBe(defaultConfig.ai.compaction.enabled);
    expect(effective.ui.overlay.width).toBe(defaultConfig.ui.overlay.width);
  });
});
