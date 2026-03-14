import { beginConfigEdit, cancelConfigEdit, commitConfigEdit, updateConfigEdit, type ConfigEditState } from "../shared/config-editor";
import {
  buildConfigPatchFromPath,
  getConfigFieldDisplayValue,
  getEditableConfigField,
  readConfigValue,
  validateEffectiveConfig,
  type ConfigFieldValueType
} from "../shared/config-fields";
import { COMMANDS } from "../shared/constants";
import { defaultConfig, mergeConfig, type ExtensionConfig, type ExtensionConfigPatch, type PopupTab } from "../shared/config";
import { ProtocolCommandError, connectRuntimeStream, recordLog, sendCommand } from "../shared/client";
import { LogEntrySchema, type LogEntry } from "../shared/logging";
import { OverlayProbeResultSchema, getOverlayUserMessage, type OverlayProbeResult } from "../shared/overlay";
import { WorkerStatusSchema, type WorkerStatus } from "../shared/runtime-state";

type RuntimeSnapshot = {
  config: ExtensionConfig;
  workerStatus: WorkerStatus;
  desired: unknown;
  logs: LogEntry[];
};

function getRequiredElement<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Popup DOM is incomplete. Missing ${selector}.`);
  }
  return element;
}

const tabButtons = Array.from(document.querySelectorAll<HTMLButtonElement>(".tab-button"));
const panels = Array.from(document.querySelectorAll<HTMLElement>(".tab-panel"));
const statusBadge = getRequiredElement<HTMLElement>("#status-badge");
const openTerminalButton = getRequiredElement<HTMLButtonElement>("#open-terminal");
const terminalState = getRequiredElement<HTMLElement>("#terminal-state");
const configViewer = getRequiredElement<HTMLElement>("#config-viewer");
const workerRunning = getRequiredElement<HTMLElement>("#worker-running");
const workerBoot = getRequiredElement<HTMLElement>("#worker-boot");
const workerSession = getRequiredElement<HTMLElement>("#worker-session");
const workerTask = getRequiredElement<HTMLElement>("#worker-task");
const urlTargetTabId = parseUrlTargetTabId();
const urlTargetUrl = parseUrlTargetUrl();

let currentConfig: ExtensionConfig | null = null;
let currentStatus: WorkerStatus | null = null;
let currentLogs: LogEntry[] = [];
let overlayProbe: OverlayProbeResult | null = null;
let currentEditState: ConfigEditState | null = null;
let currentConfigFieldError: { path: string; message: string } | null = null;
let pendingEditorFocusPath: string | null = null;
let controlMessageTone: "info" | "ok" | "warn" | "error" = "info";
let controlMessageText = "";

const streamPort = connectRuntimeStream((message) => {
  const event = (message as { event?: string }).event;
  if (event === "runtime.snapshot") {
    applySnapshot(message as Partial<RuntimeSnapshot> & { config: unknown; status: unknown; logs?: unknown });
    return;
  }

  if (event === "runtime.status" && "status" in message) {
    currentStatus = WorkerStatusSchema.parse((message as { status: unknown }).status);
    renderShell();
    return;
  }

  if (event === "runtime.config" && "config" in message) {
    currentConfig = validateEffectiveConfig((message as { config: unknown }).config);
    renderShell();
    renderConfigViewer();
    return;
  }

  if (event === "runtime.log" && "logEntry" in message) {
    const logEntry = LogEntrySchema.parse((message as { logEntry: unknown }).logEntry);
    currentLogs = [...currentLogs.slice(-399), logEntry];
    renderShell();
  }
});

streamPort.onDisconnect.addListener(() => {
  void recordLog("popup", "stream.disconnect", "Popup stream disconnected.", null, "warn");
});

void bootstrap();

async function bootstrap(): Promise<void> {
  tabButtons.forEach((button) => {
    button.addEventListener("click", () => {
      void switchTab(button.dataset.tab as PopupTab);
    });
  });

  openTerminalButton.addEventListener("click", () => {
    void openTerminal();
  });

  const snapshot = await sendCommand<RuntimeSnapshot>(COMMANDS.configGet, "popup", "background");
  currentConfig = validateEffectiveConfig(snapshot.config);
  currentStatus = WorkerStatusSchema.parse(snapshot.workerStatus);
  currentLogs = snapshot.logs.map((entry) => LogEntrySchema.parse(entry));
  renderShell();
  renderConfigViewer();
  await refreshOverlayAvailability();

  await recordLog("popup", "popup.bootstrap", "Popup bootstrapped.");
}

async function switchTab(tab: PopupTab): Promise<void> {
  const previousConfig = currentConfig;
  const nextConfig = mergeConfig(currentConfig ?? defaultConfig, {
    ui: {
      popupActiveTab: tab
    }
  });
  currentConfig = nextConfig;
  renderShell();

  try {
    await applyConfigValue("ui.popupActiveTab", tab, false);
  } catch (error) {
    currentConfig = previousConfig;
    setControlMessage(getUserFacingError(error, "Failed to switch popup tab."), "error");
    renderShell();
    renderConfigViewer();
    await recordLog("popup", "popup.tab-switch.failed", "Failed to switch popup tab.", { tab, error }, "error");
    return;
  }

  await recordLog("popup", "popup.tab-switch", `Switched popup tab to ${tab}.`, { tab });
}

async function openTerminal(): Promise<void> {
  const probe = await refreshOverlayAvailability();
  if (!probe?.ready) {
    const message = getOverlayUserMessage(
      probe ?? {
        eligible: false,
        ready: false,
        reason: "overlay_open_failed"
      }
    );
    setControlMessage(message, probe?.reason === "unsupported_tab" ? "warn" : "error");
    await recordLog("popup", "popup.open-terminal.blocked", message, probe, "warn");
    renderShell();
    return;
  }

  try {
    const tabId = await resolvePreferredPageTabId();
    const result = await sendCommand<{ opened: true; tabId: number | null; url: string | null }>(
      COMMANDS.overlayOpen,
      "popup",
      "background",
      buildOverlayTargetPayload(tabId)
    );
    setControlMessage(`Terminal opened on tab ${result.tabId ?? "-"}.`, "ok");
    await recordLog("popup", "popup.open-terminal", "Requested overlay terminal open.");
    await refreshOverlayAvailability();
    renderShell();
  } catch (error) {
    const message = getUserFacingError(error, "Overlay terminal failed to open on the current page.");
    overlayProbe = OverlayProbeResultSchema.parse({
      eligible: true,
      ready: false,
      reason: "overlay_open_failed",
      tabId: null,
      url: null
    });
    setControlMessage(message, "error");
    await recordLog(
      "popup",
      "popup.open-terminal.failed",
      message,
      {
        message: error instanceof Error ? error.message : String(error),
        error
      },
      "error"
    );
    renderShell();
  }
}

async function resolvePreferredPageTabId(): Promise<number | null> {
  if (urlTargetTabId !== null) {
    return urlTargetTabId;
  }

  const tabs = await chrome.tabs.query({
    currentWindow: true
  });

  const extensionBaseUrl = chrome.runtime.getURL("");
  const candidateTabs = tabs.filter(
    (tab) => typeof tab.id === "number" && !(tab.url?.startsWith(extensionBaseUrl) ?? false)
  );

  const activeTab = candidateTabs.find((tab) => tab.active);
  if (typeof activeTab?.id === "number") {
    return activeTab.id;
  }

  const fallbackTab = candidateTabs
    .sort((left, right) => (right.lastAccessed ?? 0) - (left.lastAccessed ?? 0))[0];

  return typeof fallbackTab?.id === "number" ? fallbackTab.id : null;
}

function parseUrlTargetTabId(): number | null {
  const rawValue = new URLSearchParams(window.location.search).get("targetTabId");
  if (!rawValue) {
    return null;
  }

  const parsedValue = Number.parseInt(rawValue, 10);
  return Number.isInteger(parsedValue) && parsedValue > 0 ? parsedValue : null;
}

function parseUrlTargetUrl(): string | null {
  const rawValue = new URLSearchParams(window.location.search).get("targetUrl");
  return rawValue && rawValue.length > 0 ? rawValue : null;
}

function buildOverlayTargetPayload(tabId: number | null): { tabId?: number; expectedUrl?: string } | undefined {
  if (!tabId && !urlTargetUrl) {
    return undefined;
  }

  return {
    ...(tabId ? { tabId } : {}),
    ...(urlTargetUrl ? { expectedUrl: urlTargetUrl } : {})
  };
}

function applySnapshot(snapshot: Partial<RuntimeSnapshot> & { config: unknown; status: unknown; logs?: unknown }): void {
  currentConfig = validateEffectiveConfig(snapshot.config);
  currentStatus = WorkerStatusSchema.parse(snapshot.status);
  currentLogs = Array.isArray(snapshot.logs)
    ? snapshot.logs.map((entry) => LogEntrySchema.parse(entry))
    : currentLogs;
  renderShell();
  renderConfigViewer();
}

function applyRuntimeSnapshot(snapshot: RuntimeSnapshot): void {
  currentConfig = validateEffectiveConfig(snapshot.config);
  currentStatus = WorkerStatusSchema.parse(snapshot.workerStatus);
  currentLogs = snapshot.logs.map((entry) => LogEntrySchema.parse(entry));
  renderShell();
  renderConfigViewer();
}

function renderShell(): void {
  const popupTab = currentConfig?.ui.popupActiveTab ?? "control";
  tabButtons.forEach((button) => {
    button.classList.toggle("is-active", button.dataset.tab === popupTab);
  });

  panels.forEach((panel) => {
    panel.classList.toggle("is-active", panel.dataset.panel === popupTab);
  });

  workerRunning.textContent = currentStatus?.running ? "running" : "stopped";
  workerBoot.textContent = currentStatus?.bootId ?? "-";
  workerSession.textContent = currentStatus?.sessionId ?? "-";
  workerTask.textContent = currentStatus?.taskId ?? "-";

  statusBadge.textContent = currentStatus?.hostConnected ? "running" : currentStatus?.running ? "waiting" : "offline";
  statusBadge.dataset.state = currentStatus?.hostConnected ? "running" : currentStatus?.running ? "waiting" : "error";

  const probeMessage = overlayProbe ? getOverlayUserMessage(overlayProbe) : "Checking current page…";
  const isFeedbackVisible = controlMessageText.trim().length > 0;
  terminalState.textContent = isFeedbackVisible ? controlMessageText : probeMessage;
  terminalState.dataset.state = isFeedbackVisible
    ? controlMessageTone === "ok"
      ? "ready"
      : controlMessageTone
    : overlayProbe?.ready
      ? "ready"
      : overlayProbe?.reason === "unsupported_tab"
        ? "warn"
        : overlayProbe?.reason
          ? "error"
          : "warn";
}

function renderConfigViewer(): void {
  configViewer.replaceChildren();

  if (!currentConfig) {
    configViewer.textContent = "Loading config…";
    return;
  }

  const fragment = document.createDocumentFragment();
  fragment.append(createBraceLine(0, "{"));
  renderObjectLines(fragment, currentConfig as Record<string, unknown>, 1, "");
  fragment.append(createBraceLine(0, "}"));
  configViewer.append(fragment);

  if (pendingEditorFocusPath) {
    const editor = Array.from(configViewer.querySelectorAll<HTMLElement>("[data-editor-path]")).find(
      (element) => element.dataset.editorPath === pendingEditorFocusPath
    );

    if (editor instanceof HTMLInputElement) {
      editor.focus();
      editor.select();
    } else if (editor instanceof HTMLSelectElement) {
      editor.focus();
    }

    pendingEditorFocusPath = null;
  }
}

function renderObjectLines(
  parent: DocumentFragment | HTMLElement,
  value: Record<string, unknown>,
  indentLevel: number,
  pathPrefix: string
): void {
  const entries = Object.entries(value);
  entries.forEach(([key, childValue], index) => {
    const path = pathPrefix ? `${pathPrefix}.${key}` : key;
    const isLast = index === entries.length - 1;

    if (childValue && typeof childValue === "object" && !Array.isArray(childValue)) {
      parent.append(createObjectOpenLine(indentLevel, key));
      renderObjectLines(parent, childValue as Record<string, unknown>, indentLevel + 1, path);
      parent.append(createBraceLine(indentLevel, isLast ? "}" : "},"));
      return;
    }

    parent.append(createValueLine(indentLevel, key, path, childValue, isLast));
  });
}

function createObjectOpenLine(indentLevel: number, key: string): HTMLDivElement {
  const line = createJsonLine(indentLevel);
  appendToken(line, `"${key}"`, "json-key");
  appendToken(line, ": ", "json-punctuation");
  appendToken(line, "{", "json-punctuation");
  return line;
}

function createBraceLine(indentLevel: number, content: string): HTMLDivElement {
  const line = createJsonLine(indentLevel);
  appendToken(line, content, "json-punctuation");
  return line;
}

function createValueLine(
  indentLevel: number,
  key: string,
  path: string,
  value: unknown,
  isLast: boolean
): HTMLDivElement {
  const line = createJsonLine(indentLevel);
  const descriptor = getEditableConfigField(path);
  const isEditing = currentEditState?.path === path;
  const lineError = currentConfigFieldError?.path === path ? currentConfigFieldError.message : null;
  line.dataset.configPath = path;

  appendToken(line, `"${key}"`, "json-key");
  appendToken(line, ": ", "json-punctuation");

  if (!descriptor) {
    appendToken(line, JSON.stringify(value), "json-value");
  } else if (isEditing && currentEditState) {
    appendEditableInput(line, descriptor.path, descriptor.valueType, currentEditState.draft, descriptor.options);
  } else {
    appendEditableValue(line, descriptor.path, descriptor.valueType, value);
  }

  appendToken(line, isLast ? "" : ",", "json-punctuation");

  if (lineError) {
    const error = document.createElement("span");
    error.className = "json-error";
    error.textContent = lineError;
    line.append(error);
  }

  return line;
}

function createJsonLine(indentLevel: number): HTMLDivElement {
  const line = document.createElement("div");
  line.className = "json-line";
  line.style.setProperty("--indent-level", String(indentLevel));
  return line;
}

function appendToken(line: HTMLElement, text: string, className: string): void {
  if (!text) {
    return;
  }

  const token = document.createElement("span");
  token.className = `json-token ${className}`;
  token.textContent = text;
  line.append(token);
}

function appendEditableValue(
  line: HTMLElement,
  path: string,
  valueType: ConfigFieldValueType,
  value: unknown
): void {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `json-value is-${valueType}`;
  button.textContent = getConfigFieldDisplayValue(path, value);
  button.dataset.configPath = path;
  button.addEventListener("click", () => {
    beginEditing(path);
  });

  if (valueType === "string" || valueType === "enum") {
    appendToken(line, "\"", "json-punctuation");
    line.append(button);
    appendToken(line, "\"", "json-punctuation");
    return;
  }

  line.append(button);
}

function appendEditableInput(
  line: HTMLElement,
  path: string,
  valueType: "string" | "number" | "boolean" | "enum",
  draft: string,
  options?: readonly { label: string; value: string }[]
): void {
  const needsQuotes = valueType === "string" || valueType === "enum";
  if (needsQuotes) {
    appendToken(line, "\"", "json-punctuation");
  }

  if (valueType === "string" || valueType === "number") {
    const input = document.createElement("input");
    input.className = `json-editor is-${valueType}`;
    input.value = draft;
    input.dataset.editorPath = path;
    input.addEventListener("input", () => {
      if (currentEditState?.path === path) {
        currentEditState = updateConfigEdit(currentEditState, input.value);
      }
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void commitEditing(path);
      } else if (event.key === "Escape") {
        event.preventDefault();
        cancelEditing();
      }
    });
    input.addEventListener("blur", () => {
      void commitEditing(path);
    });
    line.append(input);
  } else {
    const select = document.createElement("select");
    select.className = `json-select is-${valueType}`;
    select.dataset.editorPath = path;
    for (const option of options ?? []) {
      const optionElement = document.createElement("option");
      optionElement.value = option.value;
      optionElement.textContent = option.label;
      optionElement.selected = option.value === draft;
      select.append(optionElement);
    }
    select.addEventListener("change", () => {
      if (currentEditState?.path === path) {
        currentEditState = updateConfigEdit(currentEditState, select.value);
        void commitEditing(path);
      }
    });
    select.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void commitEditing(path);
      } else if (event.key === "Escape") {
        event.preventDefault();
        cancelEditing();
      }
    });
    select.addEventListener("blur", () => {
      void commitEditing(path);
    });
    line.append(select);
  }

  if (needsQuotes) {
    appendToken(line, "\"", "json-punctuation");
  }
}

function beginEditing(path: string): void {
  if (!currentConfig) {
    return;
  }

  if (currentConfigFieldError?.path === path) {
    currentConfigFieldError = null;
  }
  currentEditState = beginConfigEdit(path, readConfigValue(currentConfig, path));
  pendingEditorFocusPath = path;
  renderConfigViewer();
}

function cancelEditing(): void {
  currentEditState = cancelConfigEdit();
  currentConfigFieldError = null;
  renderConfigViewer();
}

async function commitEditing(path: string): Promise<void> {
  if (!currentEditState || currentEditState.path !== path) {
    return;
  }

  const editState = currentEditState;
  const result = commitConfigEdit(editState);
  if (!result.ok) {
    currentEditState = null;
    currentConfigFieldError = {
      path,
      message: result.error
    };
    setControlMessage(result.error, "error");
    renderShell();
    renderConfigViewer();
    await recordLog("popup", "popup.config-edit.invalid", result.error, { path }, "warn");
    return;
  }

  try {
    if (result.path === "ui.overlay.visible") {
      await applyOverlayVisibility(result.value === true);
    } else {
      await applyConfigPatch(result.scope, result.patch);
    }

    currentEditState = null;
    currentConfigFieldError = null;
    if (result.path !== "ui.overlay.visible") {
      setControlMessage(`Config updated: ${result.path}`, "ok");
    }
    renderShell();
    renderConfigViewer();
    await recordLog("popup", "popup.config-edit.commit", `Updated ${result.path}.`, {
      path: result.path,
      scope: result.scope,
      value: result.value
    });
  } catch (error) {
    const failedMessage = getUserFacingError(error, "Config update failed.");
    currentEditState = null;
    currentConfigFieldError = {
      path,
      message: failedMessage
    };
    setControlMessage(failedMessage, "error");
    renderShell();
    renderConfigViewer();
    await recordLog("popup", "popup.config-edit.failed", failedMessage, {
      path,
      error
    }, "error");
  }
}

async function applyConfigValue(path: string, value: unknown, refreshViewer = true): Promise<void> {
  const descriptor = getEditableConfigField(path);
  if (!descriptor) {
    throw new Error(`Config field is not editable: ${path}`);
  }

  await applyConfigPatch(descriptor.scope, buildConfigPatchFromPath(path, value));

  if (refreshViewer) {
    renderConfigViewer();
  }
}

async function applyConfigPatch(scope: "local" | "session", patch: ExtensionConfigPatch): Promise<void> {
  const snapshot = await sendCommand<RuntimeSnapshot>(COMMANDS.configPatch, "popup", "background", {
    scope,
    patch
  });

  currentConfig = validateEffectiveConfig(snapshot.config);
  currentStatus = WorkerStatusSchema.parse(snapshot.workerStatus);
  currentLogs = snapshot.logs.map((entry) => LogEntrySchema.parse(entry));
}

async function applyOverlayVisibility(nextVisible: boolean): Promise<void> {
  const tabId = await resolvePreferredPageTabId();
  const payload = buildOverlayTargetPayload(tabId);

  if (nextVisible) {
    const result = await sendCommand<{ opened: true; tabId: number | null; url: string | null }>(
      COMMANDS.overlayOpen,
      "popup",
      "background",
      payload
    );
    setControlMessage(`Terminal opened on tab ${result.tabId ?? "-"}.`, "ok");
  } else {
    const result = await sendCommand<{ closed: true; tabId: number | null; url: string | null }>(
      COMMANDS.overlayClose,
      "popup",
      "background",
      payload
    );
    setControlMessage(`Terminal closed on tab ${result.tabId ?? "-"}.`, "ok");
  }

  const snapshot = await sendCommand<RuntimeSnapshot>(COMMANDS.configGet, "popup", "background");
  applyRuntimeSnapshot(snapshot);
  await refreshOverlayAvailability();
}

async function refreshOverlayAvailability(): Promise<OverlayProbeResult | null> {
  try {
    const tabId = await resolvePreferredPageTabId();
    const result = await sendCommand<OverlayProbeResult>(
      COMMANDS.overlayProbe,
      "popup",
      "background",
      buildOverlayTargetPayload(tabId)
    );
    overlayProbe = OverlayProbeResultSchema.parse(result);
    renderShell();
    return overlayProbe;
  } catch (error) {
    overlayProbe = OverlayProbeResultSchema.parse({
      eligible: false,
      ready: false,
      reason: "overlay_open_failed",
      tabId: null,
      url: null
    });
    setControlMessage(getUserFacingError(error, "Terminal availability check failed."), "error");
    renderShell();
    return overlayProbe;
  }
}

function setControlMessage(
  message: string,
  tone: "info" | "ok" | "warn" | "error" = "info"
): void {
  controlMessageText = message;
  controlMessageTone = tone;
}

function getUserFacingError(error: unknown, fallbackMessage: string): string {
  if (error instanceof ProtocolCommandError) {
    if (error.code === "unsupported_tab") {
      return "Terminal unavailable: switch to a regular http(s) page.";
    }
    if (error.code === "content_not_ready") {
      return "Terminal unavailable: reload the page, then try again.";
    }
    if (error.message) {
      return error.message;
    }
  }

  return error instanceof Error && error.message ? error.message : fallbackMessage;
}
