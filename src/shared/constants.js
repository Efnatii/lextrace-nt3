export const APP_NAME = "Neuro Translate";

export const MESSAGE = Object.freeze({
  UI_START: "ui.start",
  UI_CANCEL: "ui.cancel",
  UI_CLEAR: "ui.clear",
  UI_SWITCH_VIEW: "ui.switch_view",
  UI_STATE: "ui.state",
  UI_PING: "ui.ping",
  UI_LOAD_SETTINGS: "ui.load_settings",
  UI_SAVE_SETTINGS: "ui.save_settings",
  UI_SAVE_PROFILE: "ui.save_profile",
  UI_LIST_MODELS: "ui.list_models",
  UI_LIST_PROFILES: "ui.list_profiles",
  LOG_QUERY: "log.query",
  LOG_EXPORT: "log.export",
  LOG_CLEAR: "log.clear",
  CONTENT_SCAN: "content.scan",
  CONTENT_APPLY_BATCH: "content.apply_batch",
  CONTENT_SWITCH_VIEW: "content.switch_view",
  CONTENT_CLEAR: "content.clear",
  OFFSCREEN_EXECUTE: "offscreen.execute",
  OFFSCREEN_CANCEL: "offscreen.cancel",
  PIPELINE_RESUME: "pipeline.resume"
});

export const VIEW_MODE = Object.freeze({
  TRANSLATION: "translation",
  ORIGINAL: "original",
  DIFF: "diff"
});

export const PIPELINE_STAGE = Object.freeze({
  IDLE: "idle",
  SCANNING: "scanning",
  CONTEXT: "context",
  BATCHING: "batching",
  TRANSLATING: "translating",
  APPLYING: "applying",
  DONE: "done",
  CANCELLED: "cancelled",
  FAILED: "failed"
});

export const LOG_LEVEL = Object.freeze({
  DEBUG: "debug",
  INFO: "info",
  WARN: "warn",
  ERROR: "error"
});

export const EVENT_CATEGORY = Object.freeze({
  UI_ACTION: "ui.action",
  PIPELINE_STAGE: "pipeline.stage",
  DOM_SCAN: "dom.scan",
  DOM_CLASSIFY: "dom.classify",
  DOM_APPLY: "dom.apply",
  CONTEXT_GENERATE: "context.generate",
  CONTEXT_COMPACT: "context.compact",
  BATCH_CREATE: "batch.create",
  BATCH_TRANSLATE: "batch.translate",
  OPENAI_REQUEST: "openai.request",
  OPENAI_RESPONSE: "openai.response",
  OPENAI_RATE_LIMIT: "openai.rate_limit",
  CANCELLATION: "cancellation",
  STORAGE_GC: "storage.gc",
  ERROR: "error"
});

export const STORAGE_KEYS = Object.freeze({
  SETTINGS: "settings",
  PROFILES: "profiles",
  TAB_STATES: "tabStates",
  ACTIVE_SESSION_BY_TAB: "activeSessionByTab"
});

export const DEFAULT_SETTINGS = Object.freeze({
  activeProfileName: "default",
  selectedViewMode: VIEW_MODE.ORIGINAL,
  accessMode: "BYOK",
  byokApiKey: "",
  byokBaseUrl: "https://api.openai.com/v1",
  proxyToken: "",
  proxyBaseUrl: "",
  promptCaching: {
    enabled: true,
    scope: "profile"
  },
  globalContext: {
    targetTokens: 15000,
    maxOutputTokens: 4096,
    model: "gpt-4.1-mini"
  },
  batching: {
    blockLimits: {
      minChars: 1,
      maxChars: 2800
    },
    batchTokenTarget: 1200,
    maxBlocksPerBatch: 24
  },
  batchWindow: {
    prevBatchesCount: 3,
    compactAfter: 8,
    compactPolicy: "rolling"
  },
  compaction: {
    model: "gpt-4.1-mini",
    prompt: "Compact translated history preserving terms and entities.",
    thresholds: {
      tokenTarget: 450,
      startAfterBatch: 8
    }
  },
  storagePolicy: {
    whatToKeep: "full",
    maxBytes: 3_000_000,
    maxRecords: 8_000,
    maxAgeMs: 1000 * 60 * 60 * 24 * 7,
    gcPolicy: "lru"
  },
  models: {
    selected: ["gpt-4.1-mini", "gpt-4.1-nano"],
    sortablePricing: true
  },
  modelPriority: {
    context: ["gpt-4.1-mini", "gpt-4.1-nano"],
    translation: ["gpt-4.1-mini", "gpt-4.1-nano"]
  },
  rateLimits: {
    safetyBufferTokens: 500,
    perModel: {
      "gpt-4.1-mini": { tpm: 180000, rpm: 500, concurrency: 3 },
      "gpt-4.1-nano": { tpm: 300000, rpm: 600, concurrency: 4 }
    }
  },
  mockMode: {
    enabled: false,
    artificialDelayMs: 120,
    forceError: false
  }
});

export const DEFAULT_PROFILE_TEMPLATE = Object.freeze({
  promptCaching: { ...DEFAULT_SETTINGS.promptCaching },
  globalContext: { ...DEFAULT_SETTINGS.globalContext },
  batching: { ...DEFAULT_SETTINGS.batching },
  batchWindow: { ...DEFAULT_SETTINGS.batchWindow },
  compaction: { ...DEFAULT_SETTINGS.compaction },
  storagePolicy: { ...DEFAULT_SETTINGS.storagePolicy },
  models: { ...DEFAULT_SETTINGS.models },
  modelPriority: { ...DEFAULT_SETTINGS.modelPriority },
  rateLimits: { ...DEFAULT_SETTINGS.rateLimits }
});

export const MODEL_PRICE_CATALOG = Object.freeze({
  "gpt-4.1": { input: 10, output: 30, cachedInput: 2.5 },
  "gpt-4.1-mini": { input: 0.8, output: 3.2, cachedInput: 0.2 },
  "gpt-4.1-nano": { input: 0.2, output: 0.8, cachedInput: 0.05 },
  "gpt-5": { input: 15, output: 45, cachedInput: 3.75 },
  "gpt-5-mini": { input: 1.2, output: 4.8, cachedInput: 0.3 },
  "gpt-5-nano": { input: 0.4, output: 1.6, cachedInput: 0.1 }
});

export const OFFSCREEN_DOCUMENT_PATH = "offscreen/offscreen.html";

export const ALARM_RESUME_PIPELINE = "pipeline_resume";

export const EVENT_STREAM_PORT = "event_stream_port";
