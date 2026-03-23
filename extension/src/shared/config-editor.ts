import {
  buildConfigPatchFromPath,
  getConfigFieldDisplayValue,
  getEditableConfigField,
  parseConfigFieldDraft,
  type ConfigFieldScope
} from "./config-fields";
import type { ExtensionConfigPatch } from "./config";

export type ConfigEditState = {
  path: string;
  draft: string;
  initialDisplayValue: string;
  error: string | null;
};

export type ConfigEditCommitResult =
  | {
      ok: true;
      path: string;
      scope: ConfigFieldScope;
      value: unknown;
      patch: ExtensionConfigPatch;
    }
  | {
      ok: false;
      path: string;
      error: string;
      rollbackDisplayValue: string;
    };

export function beginConfigEdit(path: string, currentValue: unknown): ConfigEditState {
  return {
    path,
    draft: getConfigFieldDisplayValue(path, currentValue),
    initialDisplayValue: getConfigFieldDisplayValue(path, currentValue),
    error: null
  };
}

export function updateConfigEdit(state: ConfigEditState, draft: string): ConfigEditState {
  return {
    ...state,
    draft,
    error: null
  };
}

export function cancelConfigEdit(): null {
  return null;
}

export function commitConfigEdit(state: ConfigEditState): ConfigEditCommitResult {
  const descriptor = getEditableConfigField(state.path);
  if (!descriptor) {
    return {
      ok: false,
      path: state.path,
      error: `Неизвестный путь поля конфига: ${state.path}`,
      rollbackDisplayValue: state.initialDisplayValue
    };
  }

  try {
    const parsedValue = parseConfigFieldDraft(state.path, state.draft);
    return {
      ok: true,
      path: state.path,
      scope: descriptor.scope,
      value: parsedValue,
      patch: buildConfigPatchFromPath(state.path, parsedValue)
    };
  } catch (error) {
    return {
      ok: false,
      path: state.path,
      error: error instanceof Error ? error.message : String(error),
      rollbackDisplayValue: state.initialDisplayValue
    };
  }
}
