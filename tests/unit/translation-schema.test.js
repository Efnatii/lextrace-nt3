import { describe, expect, it } from "vitest";
import { validateStructuredTranslation } from "../../src/shared/translation-schema.js";

describe("validateStructuredTranslation", () => {
  it("accepts a strict valid payload", () => {
    const payload = {
      batchId: "b1",
      sourceLang: "en",
      targetLang: "ru",
      glossaryHints: ["API", "SDK"],
      qualityFlags: ["ok"],
      translations: [
        {
          blockId: "blk_1",
          translatedText: "Привет",
          warnings: []
        }
      ]
    };

    expect(validateStructuredTranslation(payload)).toEqual(payload);
  });

  it("rejects unknown top-level keys", () => {
    expect(() =>
      validateStructuredTranslation({
        batchId: "b1",
        translations: [],
        unknown: true
      })
    ).toThrow("unsupported key");
  });

  it("rejects unknown translation row keys", () => {
    expect(() =>
      validateStructuredTranslation({
        batchId: "b1",
        translations: [
          {
            blockId: "blk_1",
            translatedText: "ok",
            extra: "nope"
          }
        ]
      })
    ).toThrow("unsupported key");
  });
});
