const REQUIRED_TRANSLATION_KEYS = ["batchId", "translations"];

export const TRANSLATION_JSON_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: REQUIRED_TRANSLATION_KEYS,
  properties: {
    batchId: { type: "string" },
    sourceLang: { type: "string" },
    targetLang: { type: "string" },
    glossaryHints: { type: "array", items: { type: "string" } },
    qualityFlags: { type: "array", items: { type: "string" } },
    translations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["blockId", "translatedText"],
        properties: {
          blockId: { type: "string" },
          translatedText: { type: "string" },
          warnings: { type: "array", items: { type: "string" } }
        }
      }
    }
  }
});

export function validateStructuredTranslation(payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error("Structured output must be an object");
  }

  for (const key of REQUIRED_TRANSLATION_KEYS) {
    if (!(key in payload)) {
      throw new Error(`Structured output missing key: ${key}`);
    }
  }

  if (!Array.isArray(payload.translations)) {
    throw new Error("Structured output translations must be an array");
  }

  for (const row of payload.translations) {
    if (!row || typeof row !== "object") {
      throw new Error("Each translation row must be an object");
    }
    if (typeof row.blockId !== "string" || !row.blockId) {
      throw new Error("Translation row missing blockId");
    }
    if (typeof row.translatedText !== "string") {
      throw new Error("Translation row missing translatedText");
    }
  }

  return payload;
}