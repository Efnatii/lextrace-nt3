import { z } from "zod";

import {
  AiAllowedModelRuleSchema,
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
  createDescriptor("ui.popupActiveTab", "session", "enum", PopupTabSchema, createSelectOptions(PopupTabSchema.options)),
  createDescriptor("ui.overlay.activeTab", "session", "enum", OverlayTabSchema, createSelectOptions(OverlayTabSchema.options)),
  createDescriptor(
    "ui.overlay.visible",
    "session",
    "boolean",
    z.boolean(),
    createSelectOptions(["true", "false"])
  ),
  createDescriptor("ui.overlay.width", "local", "number", OverlayWidthSchema),
  createDescriptor("ui.overlay.height", "local", "number", OverlayHeightSchema),
  createDescriptor("ui.overlay.left", "local", "number", NonNegativeIntegerSchema),
  createDescriptor("ui.overlay.top", "local", "number", NonNegativeIntegerSchema),
  createDescriptor("logging.level", "local", "enum", LogLevelSchema, createSelectOptions(LogLevelSchema.options)),
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
    createSelectOptions(["true", "false"])
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
      createSelectOptions(["true", "false"])
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
    createSelectOptions(["true", "false"])
  ),
  createDescriptor(
    "ai.compaction.enabled",
    "local",
    "boolean",
      z.boolean(),
      createSelectOptions(["true", "false"])
  ),
  createDescriptor(
    "ai.compaction.streamingEnabled",
    "local",
    "boolean",
      z.boolean(),
      createSelectOptions(["true", "false"])
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
  createDescriptor("ai.rateLimits.reserveOutputTokens", "local", "number", AiPositiveIntegerSchema),
  createDescriptor("ai.rateLimits.maxQueuedPerPage", "local", "number", AiPositiveIntegerSchema),
  createDescriptor("ai.rateLimits.maxQueuedGlobal", "local", "number", AiPositiveIntegerSchema),
  createDescriptor("test.demoHeartbeatMs", "local", "number", RuntimeDelaySchema),
  createDescriptor(
    "test.allowHostCrashCommand",
    "local",
    "boolean",
    z.boolean(),
    createSelectOptions(["true", "false"])
  )
] as const satisfies readonly EditableConfigFieldDescriptor[];

const editableConfigFieldMap = new Map<string, EditableConfigFieldDescriptor>(
  editableConfigFields.map((descriptor) => [descriptor.path, descriptor])
);

export function getEditableConfigField(path: string): EditableConfigFieldDescriptor | undefined {
  return editableConfigFieldMap.get(path);
}

export function isSensitiveConfigPath(path: string): boolean {
  return getEditableConfigField(path)?.sensitive === true;
}

const configKeyOrderRegistry = new Map<string, readonly string[]>([
  ["", ["ui", "ai", "logging", "runtime", "protocol", "test"]],
  ["ui", ["popupActiveTab", "overlay"]],
  ["ui.overlay", ["activeTab", "visible", "width", "height", "left", "top"]],
  ["ai", ["openAiApiKey", "allowedModels", "chat", "compaction", "rateLimits"]],
  ["ai.chat", ["model", "streamingEnabled", "instructions", "structuredOutput"]],
  ["ai.chat.structuredOutput", ["name", "description", "schema", "strict"]],
  ["ai.compaction", ["enabled", "streamingEnabled", "modelOverride", "instructions", "triggerPromptTokens", "preserveRecentTurns", "maxPassesPerPage"]],
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
    throw new Error(`Unknown config field path: ${path}`);
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
    throw new Error(`Unknown config field path: ${path}`);
  }

  const parsedValue = (() => {
    switch (descriptor.valueType) {
      case "boolean":
        if (rawValue !== "true" && rawValue !== "false") {
          throw new Error("Value must be true or false.");
        }
        return rawValue === "true";
      case "number": {
        const trimmed = rawValue.trim();
        if (!/^-?\d+$/.test(trimmed)) {
          throw new Error("Value must be an integer.");
        }
        return Number(trimmed);
      }
      case "enum":
      case "string":
        return rawValue;
      case "string-array": {
        const parsedArray = JSON.parse(rawValue);
        if (!Array.isArray(parsedArray) || parsedArray.some((item) => typeof item !== "string")) {
          throw new Error("Value must be a JSON array of strings.");
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
          throw new Error("Value must be a JSON array of model rules.");
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

  return typeof value === "string" ? value : "";
}

export function validateEffectiveConfig(config: unknown): ExtensionConfig {
  return ExtensionConfigSchema.parse(config);
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
    return value.trim().length > 0 ? "[redacted]" : value;
  }

  return value === null || value === undefined ? value : "[redacted]";
}

function formatSensitiveConfigDisplayValue(path: string, value: unknown): string {
  if (path === "ai.openAiApiKey") {
    return typeof value === "string" && value.trim().length > 0 ? "[redacted]" : "";
  }

  return typeof value === "string" ? value : "";
}

function formatSensitiveConfigTooltipValue(path: string, value: unknown): string {
  if (path !== "ai.openAiApiKey") {
    return "[redacted]";
  }

  if (typeof value === "string" && value.trim().length > 0) {
    return `Stored value is hidden. Open the editor to replace it. Save empty text to remove ${OPENAI_API_KEY_ENV_VAR_NAME}.`;
  }

  if (value === "") {
    return `Save a non-empty value to create or update ${OPENAI_API_KEY_ENV_VAR_NAME}. Save empty text to remove it.`;
  }

  return `This field does not currently manage ${OPENAI_API_KEY_ENV_VAR_NAME}. Save a value to create or update it. Save empty text to remove it.`;
}
