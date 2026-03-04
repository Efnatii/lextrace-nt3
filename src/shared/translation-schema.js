const REQUIRED_TRANSLATION_KEYS = ["batchId", "translations"];
const TOP_LEVEL_KEYS = new Set(["batchId", "sourceLang", "targetLang", "glossaryHints", "qualityFlags", "translations"]);
const ROW_KEYS = new Set(["blockId", "translatedText", "warnings"]);

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

  for (const key of Object.keys(payload)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      throw new Error(`Structured output contains unsupported key: ${key}`);
    }
  }

  for (const key of REQUIRED_TRANSLATION_KEYS) {
    if (!(key in payload)) {
      throw new Error(`Structured output missing key: ${key}`);
    }
  }

  if (typeof payload.batchId !== "string" || !payload.batchId) {
    throw new Error("Structured output batchId must be a non-empty string");
  }

  if (payload.sourceLang !== undefined && typeof payload.sourceLang !== "string") {
    throw new Error("Structured output sourceLang must be a string");
  }

  if (payload.targetLang !== undefined && typeof payload.targetLang !== "string") {
    throw new Error("Structured output targetLang must be a string");
  }

  if (payload.glossaryHints !== undefined) {
    if (!Array.isArray(payload.glossaryHints) || payload.glossaryHints.some((item) => typeof item !== "string")) {
      throw new Error("Structured output glossaryHints must be an array of strings");
    }
  }

  if (payload.qualityFlags !== undefined) {
    if (!Array.isArray(payload.qualityFlags) || payload.qualityFlags.some((item) => typeof item !== "string")) {
      throw new Error("Structured output qualityFlags must be an array of strings");
    }
  }

  if (!Array.isArray(payload.translations)) {
    throw new Error("Structured output translations must be an array");
  }

  for (const row of payload.translations) {
    if (!row || typeof row !== "object") {
      throw new Error("Each translation row must be an object");
    }
    for (const key of Object.keys(row)) {
      if (!ROW_KEYS.has(key)) {
        throw new Error(`Translation row contains unsupported key: ${key}`);
      }
    }
    if (typeof row.blockId !== "string" || !row.blockId) {
      throw new Error("Translation row missing blockId");
    }
    if (typeof row.translatedText !== "string") {
      throw new Error("Translation row missing translatedText");
    }
    if (row.warnings !== undefined) {
      if (!Array.isArray(row.warnings) || row.warnings.some((item) => typeof item !== "string")) {
        throw new Error("Translation row warnings must be an array of strings");
      }
    }
  }

  return payload;
}
