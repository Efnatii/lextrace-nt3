import { z } from "zod";

import {
  AiAllowedModelRuleSchema,
  formatAiPromptCacheRetentionLabel,
  formatAiPromptCacheRoutingLabel,
  type AiModelSelection,
  AiModelSelectionSchema,
  normalizeAiModelSelection,
  normalizeAllowedModelRules,
  type AiAllowedModelRule
} from "./ai";
import {
  ExtensionConfigSchema,
  type ExtensionConfig,
  type ExtensionConfigPatch,
  LogLevelSchema,
  OverlayTabSchema,
  PopupTabSchema
} from "./config";
import { OPENAI_API_KEY_ENV_VAR_NAME } from "./constants";

export const ConfigFieldScopeSchema = z.enum(["local", "session"]);
export const ConfigFieldValueTypeSchema = z.enum(["string", "number", "boolean", "enum", "string-array", "model-rule", "model-rule-array"]);
export const ConfigFieldEditorTypeSchema = z.enum([
  "inline",
  "select",
  "model-select-panel",
  "model-multiselect",
  "modal-text"
]);

export type ConfigFieldScope = z.infer<typeof ConfigFieldScopeSchema>;
export type ConfigFieldValueType = z.infer<typeof ConfigFieldValueTypeSchema>;
export type ConfigFieldEditorType = z.infer<typeof ConfigFieldEditorTypeSchema>;

export type ConfigFieldOption = {
  label: string;
  value: string;
};

export type EditableConfigFieldDescriptor = {
  path: string;
  scope: ConfigFieldScope;
  valueType: ConfigFieldValueType;
  editorType: ConfigFieldEditorType;
  schema: z.ZodTypeAny;
  sensitive?: boolean;
  options?: readonly ConfigFieldOption[];
};

const NonEmptyStringSchema = z.string().min(1);
const OverlayWidthSchema = z.number().int().min(480);
const OverlayHeightSchema = z.number().int().min(320);
const NonNegativeIntegerSchema = z.number().int().min(0);
const MaxEntriesSchema = z.number().int().min(100);
const CollapseThresholdSchema = z.number().int().min(80);
const RuntimeDelaySchema = z.number().int().min(250);
const RuntimeMaxDelaySchema = z.number().int().min(500);
const RuntimeMaxAttemptsSchema = z.number().int().min(1);
const RuntimeCommandTimeoutSchema = z.number().int().min(1000);
const AiTokenThresholdSchema = z.number().int().min(32);
const AiPositiveIntegerSchema = z.number().int().min(1);

function createSelectOptions(values: readonly string[]): ConfigFieldOption[] {
  return values.map((value) => ({
    label: value,
    value
  }));
}

function createBooleanOptions(): ConfigFieldOption[] {
  return [
    { label: "включено", value: "true" },
    { label: "выключено", value: "false" }
  ];
}

function createNamedOptions(labelByValue: Record<string, string>): ConfigFieldOption[] {
  return Object.entries(labelByValue).map(([value, label]) => ({
    label,
    value
  }));
}

function createDescriptor(
  path: string,
  scope: ConfigFieldScope,
  valueType: ConfigFieldValueType,
  schema: z.ZodTypeAny,
  options?: readonly ConfigFieldOption[],
  editorType?: ConfigFieldEditorType,
  sensitive = false
): EditableConfigFieldDescriptor {
  return {
    path,
    scope,
    valueType,
    editorType:
      editorType ?? (valueType === "string" || valueType === "number" ? "inline" : "select"),
    schema,
    sensitive,
    options
  };
}

export const editableConfigFields = [
  createDescriptor(
    "ui.popupActiveTab",
    "session",
    "enum",
    PopupTabSchema,
    createNamedOptions({
      control: "управление",
      config: "настройки"
    })
  ),
  createDescriptor(
    "ui.overlay.activeTab",
    "session",
    "enum",
    OverlayTabSchema,
    createNamedOptions({
      console: "консоль",
      chat: "чат"
    })
  ),
  createDescriptor(
    "ui.overlay.visible",
    "session",
    "boolean",
    z.boolean(),
    createBooleanOptions()
  ),
  createDescriptor("ui.overlay.width", "local", "number", OverlayWidthSchema),
  createDescriptor("ui.overlay.height", "local", "number", OverlayHeightSchema),
  createDescriptor("ui.overlay.left", "local", "number", NonNegativeIntegerSchema),
  createDescriptor("ui.overlay.top", "local", "number", NonNegativeIntegerSchema),
  createDescriptor(
    "logging.level",
    "local",
    "enum",
    LogLevelSchema,
    createNamedOptions({
      debug: "отладка",
      info: "инфо",
      warn: "предупреждение",
      error: "ошибка"
    })
  ),
  createDescriptor("logging.maxEntries", "local", "number", MaxEntriesSchema),
  createDescriptor("logging.collapseThreshold", "local", "number", CollapseThresholdSchema),
  createDescriptor("runtime.nativeHostName", "local", "string", NonEmptyStringSchema),
  createDescriptor("runtime.reconnectPolicy.baseDelayMs", "local", "number", RuntimeDelaySchema),
  createDescriptor("runtime.reconnectPolicy.maxDelayMs", "local", "number", RuntimeMaxDelaySchema),
  createDescriptor("runtime.reconnectPolicy.maxAttempts", "local", "number", RuntimeMaxAttemptsSchema),
  createDescriptor("runtime.heartbeatMs", "local", "number", RuntimeDelaySchema),
  createDescriptor("runtime.commandTimeoutMs", "local", "number", RuntimeCommandTimeoutSchema),
  createDescriptor(
    "protocol.testCommandsEnabled",
    "local",
    "boolean",
    z.boolean(),
    createBooleanOptions()
  ),
  createDescriptor(
    "ai.openAiApiKey",
    "local",
    "string",
    z.string().nullable(),
    undefined,
    "modal-text",
    true
  ),
  createDescriptor(
    "ai.allowedModels",
    "local",
    "model-rule-array",
    z.array(AiAllowedModelRuleSchema),
    undefined,
    "model-multiselect"
  ),
  createDescriptor("ai.chat.model", "local", "model-rule", AiModelSelectionSchema.nullable(), undefined, "model-select-panel"),
  createDescriptor(
    "ai.chat.streamingEnabled",
    "local",
    "boolean",
    z.boolean(),
    createBooleanOptions()
  ),
  createDescriptor("ai.chat.instructions", "local", "string", z.string(), undefined, "modal-text"),
  createDescriptor("ai.chat.structuredOutput.name", "local", "string", z.string()),
  createDescriptor("ai.chat.structuredOutput.description", "local", "string", z.string(), undefined, "modal-text"),
  createDescriptor("ai.chat.structuredOutput.schema", "local", "string", ExtensionConfigSchema.shape.ai.shape.chat.shape.structuredOutput.shape.schema, undefined, "modal-text"),
  createDescriptor(
    "ai.chat.structuredOutput.strict",
    "local",
    "boolean",
    z.boolean(),
    createBooleanOptions()
  ),
  createDescriptor(
    "ai.compaction.enabled",
    "local",
    "boolean",
    z.boolean(),
    createBooleanOptions()
  ),
  createDescriptor(
    "ai.compaction.streamingEnabled",
    "local",
    "boolean",
    z.boolean(),
    createBooleanOptions()
  ),
  createDescriptor(
    "ai.compaction.modelOverride",
    "local",
    "model-rule",
    AiModelSelectionSchema.nullable(),
    undefined,
    "model-select-panel"
  ),
  createDescriptor("ai.compaction.instructions", "local", "string", z.string(), undefined, "modal-text"),
  createDescriptor("ai.compaction.triggerPromptTokens", "local", "number", AiTokenThresholdSchema),
  createDescriptor("ai.compaction.preserveRecentTurns", "local", "number", NonNegativeIntegerSchema),
  createDescriptor("ai.compaction.maxPassesPerPage", "local", "number", AiPositiveIntegerSchema),
  createDescriptor(
    "ai.promptCaching.routing",
    "local",
    "enum",
    z.enum(["stable_session_prefix", "provider_default"]),
    createNamedOptions({
      stable_session_prefix: formatAiPromptCacheRoutingLabel("stable_session_prefix"),
      provider_default: formatAiPromptCacheRoutingLabel("provider_default")
    })
  ),
  createDescriptor(
    "ai.promptCaching.retention",
    "local",
    "enum",
    z.enum(["in_memory", "24h"]),
    createNamedOptions({
      in_memory: formatAiPromptCacheRetentionLabel("in_memory"),
      "24h": formatAiPromptCacheRetentionLabel("24h")
    })
  ),
  createDescriptor("ai.retries.maxRetries", "local", "number", NonNegativeIntegerSchema),
  createDescriptor("ai.retries.baseDelayMs", "local", "number", AiPositiveIntegerSchema),
  createDescriptor("ai.retries.maxDelayMs", "local", "number", AiPositiveIntegerSchema),
  createDescriptor("ai.queueRetries.maxRetries", "local", "number", NonNegativeIntegerSchema),
  createDescriptor("ai.queueRetries.baseDelayMs", "local", "number", AiPositiveIntegerSchema),
  createDescriptor("ai.queueRetries.maxDelayMs", "local", "number", AiPositiveIntegerSchema),
  createDescriptor("ai.rateLimits.reserveOutputTokens", "local", "number", AiPositiveIntegerSchema),
  createDescriptor("ai.rateLimits.maxQueuedPerPage", "local", "number", AiPositiveIntegerSchema),
  createDescriptor("ai.rateLimits.maxQueuedGlobal", "local", "number", AiPositiveIntegerSchema),
  createDescriptor(
    "debug.textElements.highlightEnabled",
    "local",
    "boolean",
    z.boolean(),
    createBooleanOptions()
  ),
  createDescriptor(
    "debug.textElements.inlineEditingEnabled",
    "local",
    "boolean",
    z.boolean(),
    createBooleanOptions()
  ),
  createDescriptor(
    "debug.textElements.displayMode",
    "local",
    "enum",
    z.enum(["effective", "original"]),
    createNamedOptions({
      effective: "effective/current",
      original: "original"
    })
  ),
  createDescriptor(
    "debug.textElements.autoScanMode",
    "local",
    "enum",
    z.enum(["off", "incremental"]),
    createNamedOptions({
      off: "off/manual",
      incremental: "incremental"
    })
  ),
  createDescriptor(
    "debug.textElements.incrementalRefreshDebounceMs",
    "local",
    "number",
    NonNegativeIntegerSchema
  ),
  createDescriptor(
    "debug.textElements.autoBlankOnScan",
    "local",
    "boolean",
    z.boolean(),
    createBooleanOptions()
  ),
  createDescriptor(
    "debug.textElements.deferredMutationRetryEnabled",
    "local",
    "boolean",
    z.boolean(),
    createBooleanOptions()
  ),
  createDescriptor(
    "debug.textElements.deferredMutationRetryDelayMs",
    "local",
    "number",
    NonNegativeIntegerSchema
  ),
  createDescriptor("test.demoHeartbeatMs", "local", "number", RuntimeDelaySchema),
  createDescriptor(
    "test.allowHostCrashCommand",
    "local",
    "boolean",
    z.boolean(),
    createBooleanOptions()
  )
] as const satisfies readonly EditableConfigFieldDescriptor[];

const overlayActiveTabFieldDescriptor = editableConfigFields.find(
  (descriptor) => descriptor.path === "ui.overlay.activeTab"
);
if (overlayActiveTabFieldDescriptor) {
  const nextOptions = [...(overlayActiveTabFieldDescriptor.options ?? [])];
  if (!nextOptions.some((option) => option.value === "texts")) {
    nextOptions.push({
      label: "texts",
      value: "texts"
    });
    overlayActiveTabFieldDescriptor.options = nextOptions;
  }
}

const editableConfigFieldMap = new Map<string, EditableConfigFieldDescriptor>(
  editableConfigFields.map((descriptor) => [descriptor.path, descriptor])
);

export function getEditableConfigPaths(options?: {
  prefix?: string;
  includeSensitive?: boolean;
}): string[] {
  const prefix = options?.prefix?.trim() ?? "";
  const includeSensitive = options?.includeSensitive ?? true;

  return editableConfigFields
    .filter((descriptor) => {
      if (!includeSensitive && descriptor.sensitive) {
        return false;
      }

      return !prefix || descriptor.path.startsWith(prefix);
    })
    .map((descriptor) => descriptor.path);
}

export function getEditableConfigField(path: string): EditableConfigFieldDescriptor | undefined {
  return editableConfigFieldMap.get(path);
}

export function isSensitiveConfigPath(path: string): boolean {
  return getEditableConfigField(path)?.sensitive === true;
}

const configKeyOrderRegistry = new Map<string, readonly string[]>([
  ["", ["ui", "debug", "ai", "logging", "runtime", "protocol", "test"]],
  ["ui", ["popupActiveTab", "overlay"]],
  ["ui.overlay", ["activeTab", "visible", "width", "height", "left", "top"]],
  ["debug", ["textElements"]],
  [
    "debug.textElements",
    [
      "highlightEnabled",
      "inlineEditingEnabled",
      "displayMode",
      "autoScanMode",
      "incrementalRefreshDebounceMs",
      "autoBlankOnScan",
      "deferredMutationRetryEnabled",
      "deferredMutationRetryDelayMs"
    ]
  ],
  ["ai", ["openAiApiKey", "allowedModels", "chat", "compaction", "promptCaching", "retries", "queueRetries", "rateLimits"]],
  ["ai.chat", ["model", "streamingEnabled", "instructions", "structuredOutput"]],
  ["ai.chat.structuredOutput", ["name", "description", "schema", "strict"]],
  ["ai.compaction", ["enabled", "streamingEnabled", "modelOverride", "instructions", "triggerPromptTokens", "preserveRecentTurns", "maxPassesPerPage"]],
  ["ai.promptCaching", ["routing", "retention"]],
  ["ai.retries", ["maxRetries", "baseDelayMs", "maxDelayMs"]],
  ["ai.queueRetries", ["maxRetries", "baseDelayMs", "maxDelayMs"]],
  ["ai.rateLimits", ["reserveOutputTokens", "maxQueuedPerPage", "maxQueuedGlobal"]],
  ["logging", ["level", "maxEntries", "collapseThreshold"]],
  ["runtime", ["nativeHostName", "reconnectPolicy", "heartbeatMs", "commandTimeoutMs"]],
  ["runtime.reconnectPolicy", ["baseDelayMs", "maxDelayMs", "maxAttempts"]],
  ["protocol", ["testCommandsEnabled"]],
  ["test", ["demoHeartbeatMs", "allowHostCrashCommand"]]
]);

export function getOrderedConfigEntries(
  value: Record<string, unknown>,
  pathPrefix = ""
): Array<[string, unknown]> {
  const order = configKeyOrderRegistry.get(pathPrefix) ?? [];
  const rank = new Map(order.map((key, index) => [key, index]));
  return Object.entries(value).sort(([leftKey], [rightKey]) => {
    const leftRank = rank.get(leftKey);
    const rightRank = rank.get(rightKey);
    if (leftRank !== undefined && rightRank !== undefined) {
      return leftRank - rightRank;
    }

    if (leftRank !== undefined) {
      return -1;
    }

    if (rightRank !== undefined) {
      return 1;
    }

    return leftKey.localeCompare(rightKey, "en", {
      sensitivity: "base",
      numeric: true
    });
  });
}

export function isEditableConfigPath(path: string): boolean {
  return editableConfigFieldMap.has(path);
}

export function readConfigValue(config: ExtensionConfig, path: string): unknown {
  const value = path.split(".").reduce<unknown>((currentValue, segment) => {
    if (currentValue && typeof currentValue === "object" && segment in (currentValue as Record<string, unknown>)) {
      return (currentValue as Record<string, unknown>)[segment];
    }

    return undefined;
  }, config);

  return value;
}

export function buildConfigPatchFromPath(path: string, value: unknown): ExtensionConfigPatch {
  const descriptor = getEditableConfigField(path);
  if (!descriptor) {
    throw new Error(`Неизвестный путь поля конфига: ${path}`);
  }

  const segments = path.split(".");
  const patch: Record<string, unknown> = {};
  let cursor = patch;

  segments.forEach((segment, index) => {
    if (index === segments.length - 1) {
      cursor[segment] = value;
      return;
    }

    const nextCursor: Record<string, unknown> = {};
    cursor[segment] = nextCursor;
    cursor = nextCursor;
  });

  return patch as ExtensionConfigPatch;
}

export function parseConfigFieldDraft(path: string, rawValue: string): unknown {
  const descriptor = getEditableConfigField(path);
  if (!descriptor) {
    throw new Error(`Неизвестный путь поля конфига: ${path}`);
  }

  const parsedValue = (() => {
    switch (descriptor.valueType) {
      case "boolean":
        if (rawValue !== "true" && rawValue !== "false") {
          throw new Error("Значение должно быть true или false.");
        }
        return rawValue === "true";
      case "number": {
        const trimmed = rawValue.trim();
        if (!/^-?\d+$/.test(trimmed)) {
          throw new Error("Значение должно быть целым числом.");
        }
        return Number(trimmed);
      }
      case "enum":
      case "string":
        return rawValue;
      case "string-array": {
        const parsedArray = JSON.parse(rawValue);
        if (!Array.isArray(parsedArray) || parsedArray.some((item) => typeof item !== "string")) {
          throw new Error("Значение должно быть JSON-массивом строк.");
        }
        return parsedArray;
      }
      case "model-rule": {
        const parsedValue = rawValue.trim() === "null" ? null : JSON.parse(rawValue);
        return normalizeAiModelSelection(parsedValue as AiModelSelection | string | null);
      }
      case "model-rule-array": {
        const parsedArray = JSON.parse(rawValue);
        if (!Array.isArray(parsedArray)) {
          throw new Error("Значение должно быть JSON-массивом правил моделей.");
        }
        return normalizeAllowedModelRules(parsedArray as Array<AiAllowedModelRule | string>);
      }
      default:
        return rawValue;
    }
  })();

  return descriptor.schema.parse(parsedValue);
}

export function getConfigFieldDisplayValue(path: string, value: unknown): string {
  const descriptor = getEditableConfigField(path);
  if (!descriptor) {
    return JSON.stringify(value);
  }

  if (descriptor.sensitive) {
    return formatSensitiveConfigDisplayValue(path, value);
  }

  if (descriptor.valueType === "boolean") {
    return value ? "true" : "false";
  }

  if (descriptor.valueType === "number") {
    return typeof value === "number" ? String(value) : "";
  }

  if (descriptor.valueType === "string-array") {
    return Array.isArray(value) ? JSON.stringify(value) : "[]";
  }

  if (descriptor.valueType === "model-rule") {
    return value ? JSON.stringify(value) : "null";
  }

  if (descriptor.valueType === "model-rule-array") {
    return Array.isArray(value) ? JSON.stringify(value) : "[]";
  }

  if (descriptor.editorType === "modal-text" && (value === null || value === "")) {
    return "null";
  }

  return typeof value === "string" ? value.replace(/\r?\n/g, "\\n") : "";
}

export function getConfigFieldTooltipValue(path: string, value: unknown): string {
  const descriptor = getEditableConfigField(path);
  if (!descriptor) {
    return JSON.stringify(value, null, 2);
  }

  if (descriptor.sensitive) {
    return formatSensitiveConfigTooltipValue(path, value);
  }

  if (descriptor.valueType === "model-rule-array" || descriptor.valueType === "string-array") {
    return JSON.stringify(value ?? [], null, 2);
  }

  if (descriptor.valueType === "model-rule") {
    return JSON.stringify(value ?? null, null, 2);
  }

  if (descriptor.valueType === "boolean") {
    return value ? "true" : "false";
  }

  if (descriptor.valueType === "number") {
    return typeof value === "number" ? String(value) : "";
  }

  if (descriptor.editorType === "modal-text" && (value === null || value === "")) {
    return "null";
  }

  return typeof value === "string" ? value : "";
}

export function validateEffectiveConfig(config: unknown): ExtensionConfig {
  return ExtensionConfigSchema.parse(config);
}

export function omitSensitiveConfigData<T>(value: T, pathPrefix = ""): T {
  if (isSensitiveConfigPath(pathPrefix)) {
    return undefined as T;
  }

  if (Array.isArray(value) || value === null || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).flatMap(([key, childValue]) => {
      const nextPath = pathPrefix ? `${pathPrefix}.${key}` : key;
      if (isSensitiveConfigPath(nextPath)) {
        return [];
      }

      return [[key, omitSensitiveConfigData(childValue, nextPath)]];
    })
  ) as T;
}

export function redactSensitiveConfigData<T>(value: T, pathPrefix = ""): T {
  if (isSensitiveConfigPath(pathPrefix)) {
    return redactSensitiveLeafValue(value) as T;
  }

  if (Array.isArray(value) || value === null || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, childValue]) => [
      key,
      redactSensitiveConfigData(childValue, pathPrefix ? `${pathPrefix}.${key}` : key)
    ])
  ) as T;
}

function redactSensitiveLeafValue(value: unknown): unknown {
  if (typeof value === "string") {
    return value.trim().length > 0 ? "[скрыто]" : value;
  }

  return value === null || value === undefined ? value : "[скрыто]";
}

function formatSensitiveConfigDisplayValue(path: string, value: unknown): string {
  if (path === "ai.openAiApiKey") {
    return typeof value === "string" && value.trim().length > 0 ? "[скрыто]" : "null";
  }

  return typeof value === "string" ? value : "";
}

function formatSensitiveConfigTooltipValue(path: string, value: unknown): string {
  if (path !== "ai.openAiApiKey") {
    return "[скрыто]";
  }

  if (typeof value === "string" && value.trim().length > 0) {
    return `Сохранённое значение скрыто. Откройте редактор, чтобы заменить его. Сохраните пустой текст, чтобы удалить ${OPENAI_API_KEY_ENV_VAR_NAME}.`;
  }

  if (value === "") {
    return `Сохраните непустое значение, чтобы создать или обновить ${OPENAI_API_KEY_ENV_VAR_NAME}. Сохраните пустой текст, чтобы удалить переменную.`;
  }

  return `Это поле сейчас не управляет ${OPENAI_API_KEY_ENV_VAR_NAME}. Сохраните значение, чтобы создать или обновить переменную. Сохраните пустой текст, чтобы удалить её.`;
}
