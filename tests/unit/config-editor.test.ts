import { describe, expect, it } from "vitest";

import {
  beginConfigEdit,
  cancelConfigEdit,
  commitConfigEdit,
  updateConfigEdit
} from "../../extension/src/shared/config-editor";

describe("config editor state", () => {
  it("commits valid edits with scope and patch metadata", () => {
    const started = beginConfigEdit("runtime.commandTimeoutMs", 10000);
    const updated = updateConfigEdit(started, "2500");
    const result = commitConfigEdit(updated);

    expect(result).toMatchObject({
      ok: true,
      path: "runtime.commandTimeoutMs",
      scope: "local",
      value: 2500
    });

    if (result.ok) {
      expect(result.patch).toEqual({
        runtime: {
          commandTimeoutMs: 2500
        }
      });
    }
  });

  it("rolls back invalid drafts and supports cancel", () => {
    const started = beginConfigEdit("logging.maxEntries", 400);
    const updated = updateConfigEdit(started, "broken");
    const result = commitConfigEdit(updated);

    expect(result).toMatchObject({
      ok: false,
      path: "logging.maxEntries",
      rollbackDisplayValue: "400"
    });
    expect(cancelConfigEdit()).toBeNull();
  });
});
