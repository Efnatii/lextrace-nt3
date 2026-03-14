import { z } from "zod";

import {
  ExtensionConfigSchema,
  type ExtensionConfig,
  type ExtensionConfigPatch,
  LogLevelSchema,
  PopupTabSchema
} from "./config";

export const ConfigFieldScopeSchema = z.enum(["local", "session"]);
export const ConfigFieldValueTypeSchema = z.enum(["string", "number", "boolean", "enum"]);
export const ConfigFieldEditorTypeSchema = z.enum(["inline", "select"]);

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
  options?: readonly ConfigFieldOption[]
): EditableConfigFieldDescriptor {
  return {
    path,
    scope,
    valueType,
    editorType: valueType === "string" || valueType === "number" ? "inline" : "select",
    schema,
    options
  };
}

export const editableConfigFields = [
  createDescriptor("ui.popupActiveTab", "session", "enum", PopupTabSchema, createSelectOptions(PopupTabSchema.options)),
  createDescriptor("ui.overlay.width", "local", "number", OverlayWidthSchema),
  createDescriptor("ui.overlay.height", "local", "number", OverlayHeightSchema),
  createDescriptor("ui.overlay.left", "local", "number", NonNegativeIntegerSchema),
  createDescriptor("ui.overlay.top", "local", "number", NonNegativeIntegerSchema),
  createDescriptor(
    "ui.overlay.visible",
    "session",
    "boolean",
    z.boolean(),
    createSelectOptions(["true", "false"])
  ),
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
