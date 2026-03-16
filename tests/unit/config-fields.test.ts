import { describe, expect, it } from "vitest";

import {
  buildConfigPatchFromPath,
  getConfigFieldTooltipValue,
  getEditableConfigField,
  getOrderedConfigEntries,
  parseConfigFieldDraft,
  redactSensitiveConfigData
} from "../../extension/src/shared/config-fields";

describe("editable config fields", () => {
  it("maps config paths to editor metadata and scope", () => {
    expect(getEditableConfigField("ui.popupActiveTab")).toMatchObject({
      scope: "session",
      valueType: "enum",
      editorType: "select"
    });

    expect(getEditableConfigField("ui.overlay.activeTab")).toMatchObject({
      scope: "session",
      valueType: "enum",
      editorType: "select"
    });

    expect(getEditableConfigField("runtime.nativeHostName")).toMatchObject({
      scope: "local",
      valueType: "string",
      editorType: "inline"
    });

    expect(getEditableConfigField("ai.chat.streamingEnabled")).toMatchObject({
      scope: "local",
      valueType: "boolean",
      editorType: "select"
    });

    expect(getEditableConfigField("ai.allowedModels")).toMatchObject({
      scope: "local",
      valueType: "model-rule-array",
      editorType: "model-multiselect"
    });

    expect(getEditableConfigField("ai.openAiApiKey")).toMatchObject({
      scope: "local",
      valueType: "string",
      editorType: "modal-text",
      sensitive: true
    });

    expect(getEditableConfigField("ai.chat.model")).toMatchObject({
      scope: "local",
      valueType: "model-rule",
      editorType: "model-select-panel"
    });

    expect(getEditableConfigField("ai.chat.instructions")).toMatchObject({
      scope: "local",
      valueType: "string",
      editorType: "modal-text"
    });

    expect(getEditableConfigField("ai.chat.structuredOutput.schema")).toMatchObject({
      scope: "local",
      valueType: "string",
      editorType: "modal-text"
    });

    expect(getEditableConfigField("ai.chat.structuredOutput.strict")).toMatchObject({
      scope: "local",
      valueType: "boolean",
      editorType: "select"
    });

    expect(getEditableConfigField("ai.compaction.instructions")).toMatchObject({
      scope: "local",
      valueType: "string",
      editorType: "modal-text"
    });

    expect(getEditableConfigField("ai.compaction.streamingEnabled")).toMatchObject({
      scope: "local",
      valueType: "boolean",
      editorType: "select"
    });
  });

  it("builds nested config patches from field paths", () => {
    expect(buildConfigPatchFromPath("runtime.commandTimeoutMs", 2500)).toEqual({
      runtime: {
        commandTimeoutMs: 2500
      }
    });
  });

  it("parses inline number/string values and rejects invalid numeric drafts", () => {
    expect(parseConfigFieldDraft("logging.maxEntries", "800")).toBe(800);
    expect(parseConfigFieldDraft("runtime.nativeHostName", "com.lextrace.custom")).toBe(
      "com.lextrace.custom"
    );
    expect(parseConfigFieldDraft("ai.openAiApiKey", "sk-test")).toBe("sk-test");
    expect(parseConfigFieldDraft("protocol.testCommandsEnabled", "true")).toBe(true);
    expect(parseConfigFieldDraft("ai.chat.model", '{"model":"gpt-5","tier":"priority"}')).toEqual({
      model: "gpt-5",
      tier: "priority"
    });
    expect(
      parseConfigFieldDraft(
        "ai.chat.structuredOutput.schema",
        '{\n  "type": "object",\n  "properties": {\n    "translation": { "type": "string" }\n  },\n  "required": ["translation"],\n  "additionalProperties": false\n}'
      )
    ).toContain('"translation"');
    expect(
      parseConfigFieldDraft(
        "ai.allowedModels",
        '[{"model":"gpt-5","tier":"standard"},{"model":"gpt-4.1","tier":"priority"}]'
      )
    ).toEqual([
      { model: "gpt-5", tier: "standard" },
      { model: "gpt-4.1", tier: "priority" }
    ]);
    expect(parseConfigFieldDraft("ai.allowedModels", '["gpt-5","gpt-4.1"]')).toEqual([
      { model: "gpt-4.1", tier: "standard" },
      { model: "gpt-5", tier: "standard" }
    ]);
    expect(() => parseConfigFieldDraft("logging.maxEntries", "8.5")).toThrow(/integer/i);
    expect(() => parseConfigFieldDraft("ai.chat.structuredOutput.schema", "[]")).toThrow(/JSON object/i);
  });

  it("orders config groups and nested keys by the explicit viewer registry", () => {
    expect(
      getOrderedConfigEntries(
        {
          runtime: {},
          test: {},
          ai: {},
          ui: {},
          protocol: {},
          logging: {}
        },
        ""
      ).map(([key]) => key)
    ).toEqual(["ui", "ai", "logging", "runtime", "protocol", "test"]);

    expect(
      getOrderedConfigEntries(
        {
          width: 920,
          top: 12,
          visible: false,
          left: 8,
          height: 620,
          activeTab: "chat"
        },
        "ui.overlay"
      ).map(([key]) => key)
    ).toEqual(["activeTab", "visible", "width", "height", "left", "top"]);

    expect(
      getOrderedConfigEntries(
        {
          enabled: true,
          streamingEnabled: true,
          modelOverride: null,
          instructions: "",
          triggerPromptTokens: 131072,
          preserveRecentTurns: 24,
          maxPassesPerPage: 16
        },
        "ai.compaction"
      ).map(([key]) => key)
    ).toEqual(["enabled", "streamingEnabled", "modelOverride", "instructions", "triggerPromptTokens", "preserveRecentTurns", "maxPassesPerPage"]);

    expect(
      getOrderedConfigEntries(
        {
          allowedModels: [],
          chat: {},
          openAiApiKey: null,
          compaction: {},
          rateLimits: {}
        },
        "ai"
      ).map(([key]) => key)
    ).toEqual(["openAiApiKey", "allowedModels", "chat", "compaction", "rateLimits"]);

    expect(
      getOrderedConfigEntries(
        {
          instructions: "",
          model: null,
          structuredOutput: {},
          streamingEnabled: true
        },
        "ai.chat"
      ).map(([key]) => key)
    ).toEqual(["model", "streamingEnabled", "instructions", "structuredOutput"]);
  });

  it("formats multiline config tooltip text without collapsing the original value", () => {
    expect(getConfigFieldTooltipValue("ai.chat.instructions", "line 1\nline 2")).toBe("line 1\nline 2");
    expect(getConfigFieldTooltipValue("ai.compaction.instructions", "line 3\nline 4")).toBe("line 3\nline 4");
    expect(getConfigFieldTooltipValue("ai.chat.structuredOutput.schema", "{\n  \"type\": \"object\"\n}")).toContain("\"type\"");
    expect(getConfigFieldTooltipValue("ai.chat.model", { model: "gpt-5", tier: "flex" })).toContain("\"tier\": \"flex\"");
    expect(getConfigFieldTooltipValue("ai.allowedModels", [{ model: "gpt-5", tier: "standard" }])).toContain(
      "\"model\": \"gpt-5\""
    );
    expect(getConfigFieldTooltipValue("ai.openAiApiKey", "sk-secret-value")).toContain("OPENAI_API_KEY");
    expect(getConfigFieldTooltipValue("ai.openAiApiKey", "sk-secret-value")).not.toContain("sk-secret-value");
  });

  it("redacts sensitive config values before they hit logs", () => {
    expect(
      redactSensitiveConfigData({
        ai: {
          openAiApiKey: "sk-secret-value",
          chat: {
            instructions: "keep me"
          }
        }
      })
    ).toEqual({
      ai: {
        openAiApiKey: "[redacted]",
        chat: {
          instructions: "keep me"
        }
      }
    });
  });
});
