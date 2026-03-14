import { describe, expect, it } from "vitest";

import {
  buildConfigPatchFromPath,
  getEditableConfigField,
  parseConfigFieldDraft
} from "../../extension/src/shared/config-fields";

describe("editable config fields", () => {
  it("maps config paths to editor metadata and scope", () => {
    expect(getEditableConfigField("ui.popupActiveTab")).toMatchObject({
      scope: "session",
      valueType: "enum",
      editorType: "select"
    });

    expect(getEditableConfigField("runtime.nativeHostName")).toMatchObject({
      scope: "local",
      valueType: "string",
      editorType: "inline"
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
    expect(parseConfigFieldDraft("protocol.testCommandsEnabled", "true")).toBe(true);
    expect(() => parseConfigFieldDraft("logging.maxEntries", "8.5")).toThrow(/integer/i);
  });
});
