import { beginConfigEdit, cancelConfigEdit, commitConfigEdit, updateConfigEdit, type ConfigEditState } from "../shared/config-editor";
import {
  formatAiModelCompactTooltip,
  buildAllowedModelSections,
  formatAiModelSummaryPrice,
  formatAiModelTooltip,
  isAiModelTierAvailable,
  formatAllowedModelsDisplay,
  sortAiModelCatalog,
  type ModelCatalogSort
} from "../shared/ai-model-catalog";
import {
  AiChatListResultSchema,
  AiChatPageSessionSchema,
  AiModelCatalogResultSchema,
  type AiModelCatalogItem,
  type AiAllowedModelRule,
  type AiModelSelection,
  type AiModelBudgetMap,
  type AiServiceTier,
  normalizeAiModelSelection,
  normalizeAllowedModelRules
} from "../shared/ai";
import {
  buildConfigPatchFromPath,
  getConfigFieldTooltipValue,
  getConfigFieldDisplayValue,
  getEditableConfigField,
  getOrderedConfigEntries,
  readConfigValue,
  validateEffectiveConfig,
  type EditableConfigFieldDescriptor
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

type AllowedModelsPanelState = {
  kind: "allowed-models";
  path: "ai.allowedModels";
  sort: ModelCatalogSort;
};

type ModelSelectPanelPath = "ai.chat.model" | "ai.compaction.modelOverride";
type ModelSelectPanelState = {
  kind: "model-select";
  path: ModelSelectPanelPath;
};

type ConfigPanelState = AllowedModelsPanelState | ModelSelectPanelState;

type ModalTextPath =
  | "ai.chat.instructions"
  | "ai.chat.structuredOutput.description"
  | "ai.chat.structuredOutput.schema"
  | "ai.compaction.instructions";
type ModalTextState = {
  path: ModalTextPath;
  draft: string;
  initialValue: string;
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
const configViewport = getRequiredElement<HTMLElement>("#config-viewport");
const configViewer = getRequiredElement<HTMLElement>("#config-viewer");
const workerRunning = getRequiredElement<HTMLElement>("#worker-running");
const workerBoot = getRequiredElement<HTMLElement>("#worker-boot");
const workerSession = getRequiredElement<HTMLElement>("#worker-session");
const workerTask = getRequiredElement<HTMLElement>("#worker-task");
const popupBody = getRequiredElement<HTMLElement>("body");
const urlTargetTabId = parseUrlTargetTabId();
const urlTargetUrl = parseUrlTargetUrl();

let currentConfig: ExtensionConfig | null = null;
let currentStatus: WorkerStatus | null = null;
let currentLogs: LogEntry[] = [];
let overlayProbe: OverlayProbeResult | null = null;
let currentEditState: ConfigEditState | null = null;
let currentConfigFieldError: { path: string; message: string } | null = null;
let currentModelCatalog: AiModelCatalogItem[] = [];
let currentModelBudgets: AiModelBudgetMap = {};
let currentModelCatalogFetchedAt: string | null = null;
let currentModelCatalogError: string | null = null;
let currentConfigPanelState: ConfigPanelState | null = null;
let currentModalTextState: ModalTextState | null = null;
let pendingEditorFocusPath: string | null = null;
let controlMessageTone: "info" | "ok" | "warn" | "error" = "info";
let controlMessageText = "";

const MODEL_LIST_SELECTOR = ".json-model-list";
const POPUP_TOOLTIP_ID = "popup-config-tooltip";
const MODAL_ROOT_ID = "popup-modal-root";

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
    return;
  }

  if (typeof event === "string" && event.startsWith("ai.chat.") && "session" in message) {
    hydrateModelBudgetsFromSessions([message]);
    renderConfigViewer();
  }
});

streamPort.onDisconnect.addListener(() => {
  void recordLog("popup", "stream.disconnect", "Popup stream disconnected.", null, "warn");
});

void bootstrap();

async function bootstrap(): Promise<void> {
  ensureTooltipRoot();
  ensureModalRoot();

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
  await refreshAiSessionBudgets();
  await refreshModelCatalog();
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
    setControlMessage(`Терминал открыт на вкладке ${result.tabId ?? "-"}.`, "ok");
    await recordLog("popup", "popup.open-terminal", "Requested overlay terminal open.");
    await refreshOverlayAvailability();
    renderShell();
  } catch (error) {
    const message = getUserFacingError(error, "Не удалось открыть терминал поверх текущей страницы.");
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

  const probeMessage = overlayProbe ? getOverlayUserMessage(overlayProbe) : "Проверка текущей страницы…";
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
  const previousScrollTop = configViewport.scrollTop;
  hidePopupTooltip();
  configViewer.replaceChildren();

  if (!currentConfig) {
    configViewer.textContent = "Загрузка конфига…";
    configViewport.scrollTop = previousScrollTop;
    return;
  }

  const fragment = document.createDocumentFragment();
  fragment.append(createBraceLine(0, "{"));
  renderObjectLines(fragment, currentConfig as Record<string, unknown>, 1, "");
  fragment.append(createBraceLine(0, "}"));
  configViewer.append(fragment);
  renderPopupModal();

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

  configViewport.scrollTop = previousScrollTop;
}

function renderObjectLines(
  parent: DocumentFragment | HTMLElement,
  value: Record<string, unknown>,
  indentLevel: number,
  pathPrefix: string
): void {
  const entries = getOrderedConfigEntries(value, pathPrefix);
  entries.forEach(([key, childValue], index) => {
    const path = pathPrefix ? `${pathPrefix}.${key}` : key;
    const isLast = index === entries.length - 1;
    const descriptor = getEditableConfigField(path);

    if (!descriptor && childValue && typeof childValue === "object" && !Array.isArray(childValue)) {
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

  appendConfigKeyToken(line, key, descriptor?.path ?? null);
  appendToken(line, ": ", "json-punctuation");

  if (!descriptor) {
    appendToken(line, JSON.stringify(value), "json-value");
  } else if (descriptor.editorType === "model-multiselect") {
    appendAllowedModelsValue(line, descriptor.path, value);
  } else if (descriptor.editorType === "modal-text") {
    appendEditableValue(line, descriptor, value, {
      forceTooltip: true
    });
  } else if (isEditing && currentEditState) {
    appendEditableInput(line, descriptor, currentEditState.draft);
  } else {
    appendEditableValue(line, descriptor, value);
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

function appendConfigKeyToken(
  line: HTMLElement,
  key: string,
  resetPath: string | null
): void {
  const token = document.createElement("span");
  token.className = "json-token json-key";
  token.textContent = `"${key}"`;

  if (resetPath) {
    token.classList.add("is-resettable");
    token.addEventListener("dblclick", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void resetConfigFieldToDefault(resetPath);
    });
  }

  line.append(token);
}

function appendEditableValue(
  line: HTMLElement,
  descriptor: EditableConfigFieldDescriptor,
  value: unknown,
  options: {
    forceTooltip?: boolean;
  } = {}
): void {
  const { path, valueType } = descriptor;
  const button = document.createElement("button");
  button.type = "button";
  button.className = `json-value is-${valueType}`;
  const displayText = getConfigButtonLabel(descriptor, value);
  button.textContent = displayText;
  button.dataset.configPath = path;
  button.classList.toggle("is-empty", displayText.length === 0);
  button.addEventListener("click", () => {
    beginEditing(path);
  });
  bindPopupTooltip(
    button,
    getConfigFieldTooltipValue(path, value),
    options.forceTooltip && getConfigFieldTooltipValue(path, value).trim().length > 0 ? "always" : "overflow"
  );

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
  descriptor: EditableConfigFieldDescriptor,
  draft: string
): void {
  const { path, valueType } = descriptor;
  const options = getEditorOptions(descriptor, draft);
  const needsQuotes = valueType === "string" || valueType === "enum";
  if (needsQuotes) {
    appendToken(line, "\"", "json-punctuation");
  }

  if (
    descriptor.editorType === "inline" ||
    descriptor.editorType === "modal-text" ||
    (descriptor.editorType === "model-select-panel" && options.length === 0)
  ) {
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
      optionElement.title = option.title ?? option.label;
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

function appendAllowedModelsValue(line: HTMLElement, path: string, value: unknown): void {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "json-value is-model-rule-array";
  button.dataset.configPath = path;
  button.textContent = formatAllowedModelsDisplay(readAllowedModelRulesFromUnknown(value));
  button.addEventListener("click", () => {
    toggleAllowedModelsEditor(path);
  });
  bindPopupTooltip(
    button,
    getConfigFieldTooltipValue(path, value),
    "overflow"
  );
  line.append(button);
}

function getConfigButtonLabel(
  descriptor: EditableConfigFieldDescriptor,
  value: unknown
): string {
  return getConfigFieldDisplayValue(descriptor.path, value);
}

function createAllowedModelsPanel(currentValue: unknown[]): HTMLDivElement {
  const panel = document.createElement("div");
  panel.className = "json-model-panel is-modal";

  const toolbar = document.createElement("div");
  toolbar.className = "json-model-toolbar";

  const count = document.createElement("span");
  count.className = "json-model-count";
  const selectedRules = readAllowedModelRulesFromUnknown(currentValue);
  count.textContent = `Разрешено правил: ${selectedRules.length}`;
  if (currentModelCatalogFetchedAt) {
    count.title = `Каталог получен: ${currentModelCatalogFetchedAt}`;
  }

  const sortSelect = document.createElement("select");
  sortSelect.className = "json-model-sort";
  sortSelect.setAttribute("aria-label", "Порядок сортировки моделей");

  const sortOptions: Array<{ label: string; value: ModelCatalogSort }> = [
    { label: "Имя А-Я", value: "name-asc" },
    { label: "Имя Я-А", value: "name-desc" },
    { label: "Сначала с ценой", value: "availability" },
    { label: "Σ дешевле", value: "price-asc" },
    { label: "Σ дороже", value: "price-desc" },
    { label: "Вход дешевле", value: "input-asc" },
    { label: "Вход дороже", value: "input-desc" },
    { label: "Выход дешевле", value: "output-asc" },
    { label: "Выход дороже", value: "output-desc" },
    { label: "Новые сначала", value: "newest" },
    { label: "Старые сначала", value: "oldest" }
  ];

  const activeSort =
    currentConfigPanelState?.kind === "allowed-models"
      ? currentConfigPanelState.sort
      : "name-asc";
  for (const option of sortOptions) {
    const element = document.createElement("option");
    element.value = option.value;
    element.textContent = option.label;
    element.selected = option.value === activeSort;
    sortSelect.append(element);
  }
  sortSelect.addEventListener("change", () => {
    currentConfigPanelState = {
      kind: "allowed-models",
      path: "ai.allowedModels",
      sort: sortSelect.value as ModelCatalogSort
    };
    renderConfigViewer();
  });

  toolbar.append(count, sortSelect);
  panel.append(toolbar);

  if (currentModelCatalogError) {
    const error = document.createElement("div");
    error.className = "json-model-empty is-error";
    error.textContent = currentModelCatalogError;
    panel.append(error);
  } else if (currentModelCatalog.length === 0) {
    const placeholder = document.createElement("div");
    placeholder.className = "json-model-empty";
    placeholder.textContent = "Загружается каталог моделей OpenAI…";
    panel.append(placeholder);
  } else {
    const list = document.createElement("div");
    list.className = "json-model-list";
    const selectedRuleKeys = new Set(selectedRules.map((rule) => createAllowedModelRuleKey(rule.model, rule.tier)));

    for (const tier of ["standard", "flex", "priority"] as const satisfies readonly AiServiceTier[]) {
      const section = document.createElement("section");
      section.className = "json-model-section";

      const heading = document.createElement("div");
      heading.className = "json-model-section-title";
      heading.textContent = tier;
      section.append(heading);

      const sectionList = document.createElement("div");
      sectionList.className = "json-model-section-list";
      const sortedModels = sortAiModelCatalog(currentModelCatalog, activeSort, tier).filter((model) =>
        isAiModelTierAvailable(model, tier)
      );

      if (sortedModels.length === 0) {
        const empty = document.createElement("div");
        empty.className = "json-model-empty";
        empty.textContent = "Нет моделей для этого tier.";
        sectionList.append(empty);
      }

      for (const model of sortedModels) {
        const option = document.createElement("label");
        option.className = "json-model-option";
        bindPopupTooltip(
          option,
          formatAiModelCompactTooltip(model, tier, resolveModelBudget(model.id)),
          "always"
        );

        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.className = "json-model-checkbox";
        checkbox.checked = selectedRuleKeys.has(createAllowedModelRuleKey(model.id, tier));
        checkbox.addEventListener("change", () => {
          void toggleAllowedModel(model.id, tier);
        });

        const name = document.createElement("span");
        name.className = "json-model-name";
        name.textContent = model.id;

        const summary = document.createElement("span");
        summary.className = "json-model-summary";
        summary.textContent = formatAiModelSummaryPrice(model, tier);

        option.append(checkbox, name, summary);
        sectionList.append(option);
      }

      section.append(sectionList);
      list.append(section);
    }

    panel.append(list);
  }

  return panel;
}

function createModelSelectPanel(path: ModelSelectPanelPath): HTMLDivElement {
  const panel = document.createElement("div");
  panel.className = "json-model-panel is-single-select is-modal";

  const currentValue = readModelSelectionValue(path);
  const allowedRules = getAllowedModelRules();
  const sections = buildAllowedModelSections(currentModelCatalog, allowedRules, currentModelBudgets);
  const selectedKey = currentValue ? createAllowedModelRuleKey(currentValue.model, currentValue.tier) : null;

  const toolbar = document.createElement("div");
  toolbar.className = "json-model-toolbar";

  const count = document.createElement("span");
  count.className = "json-model-count";
  count.textContent = currentValue ? `Текущее значение: ${JSON.stringify(currentValue)}` : "Текущее значение: null";
  bindPopupTooltip(
    count,
    currentValue
      ? JSON.stringify(currentValue, null, 2)
      : "null\nСначала заполните ai.allowedModels, затем выберите одну модель.",
    "always"
  );

  const meta = document.createElement("span");
  meta.className = "json-model-count";
  meta.textContent = "Один выбор";

  toolbar.append(count, meta);
  panel.append(toolbar);

  if (currentModelCatalogError) {
    const error = document.createElement("div");
    error.className = "json-model-empty is-error";
    error.textContent = currentModelCatalogError;
    panel.append(error);
  } else if (allowedRules.length === 0) {
    const placeholder = document.createElement("div");
    placeholder.className = "json-model-empty";
    placeholder.textContent = "Сначала заполните ai.allowedModels.";
    panel.append(placeholder);
  } else {
    if (
      currentValue &&
      !allowedRules.some((rule) => rule.model === currentValue.model && rule.tier === currentValue.tier)
    ) {
      const warning = document.createElement("div");
      warning.className = "json-model-empty is-error";
      warning.textContent = `Текущее значение вне ai.allowedModels: ${JSON.stringify(currentValue)}`;
      panel.append(warning);
    }

    const list = document.createElement("div");
    list.className = "json-model-list";

    for (const tier of ["standard", "flex", "priority"] as const satisfies readonly AiServiceTier[]) {
      const section = document.createElement("section");
      section.className = "json-model-section";

      const heading = document.createElement("div");
      heading.className = "json-model-section-title";
      heading.textContent = tier;
      section.append(heading);

      const sectionList = document.createElement("div");
      sectionList.className = "json-model-section-list";
      const items = sections[tier];

      if (items.length === 0) {
        const empty = document.createElement("div");
        empty.className = "json-model-empty";
        empty.textContent = "Пусто";
        sectionList.append(empty);
      } else {
        for (const item of items) {
          const option = document.createElement("button");
          option.type = "button";
          option.className = "json-model-option is-single-select";
          option.classList.toggle(
            "is-selected",
            createAllowedModelRuleKey(item.rule.model, item.rule.tier) === selectedKey
          );
          bindPopupTooltip(
            option,
            item.model
              ? formatAiModelCompactTooltip(item.model, item.rule.tier, resolveModelBudget(item.rule.model))
              : item.tooltip,
            "always"
          );
          option.addEventListener("click", () => {
            void applySingleModelValue(path, item.rule);
          });

          const name = document.createElement("span");
          name.className = "json-model-name";
          name.textContent = item.rule.model;

          const summary = document.createElement("span");
          summary.className = "json-model-summary";
          summary.textContent = item.summaryPrice;

          option.append(name, summary);
          sectionList.append(option);
        }
      }

      section.append(sectionList);
      list.append(section);
    }

    panel.append(list);
  }

  return panel;
}

function readAllowedModelRulesFromUnknown(value: unknown): AiAllowedModelRule[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return normalizeAllowedModelRules(value as Array<AiAllowedModelRule | string>);
}

function createAllowedModelRuleKey(modelId: string, tier: AiServiceTier): string {
  return `${tier}::${modelId.toLowerCase()}`;
}

function getEditorOptions(
  descriptor: EditableConfigFieldDescriptor,
  _currentValue: string
): Array<{ label: string; title?: string; value: string }> {
  return (descriptor.options ?? []).map((option) => ({
    ...option,
    title: option.label
  }));
}

function getAllowedModelRules(): AiAllowedModelRule[] {
  if (!currentConfig) {
    return [];
  }

  const value = readConfigValue(currentConfig, "ai.allowedModels");
  return readAllowedModelRulesFromUnknown(value);
}

function readModelSelectionValue(path: ModelSelectPanelPath): AiModelSelection | null {
  return normalizeAiModelSelection(readConfigValue(currentConfig ?? defaultConfig, path) as AiModelSelection | string | null);
}

function beginEditing(path: string): void {
  if (!currentConfig) {
    return;
  }

  const descriptor = getEditableConfigField(path);
  if (descriptor?.editorType === "model-multiselect") {
    toggleAllowedModelsEditor(path);
    return;
  }
  if (descriptor?.editorType === "model-select-panel") {
    toggleModelSelectEditor(path as ModelSelectPanelPath);
    return;
  }
  if (descriptor?.editorType === "modal-text") {
    openModalTextEditor(path as ModalTextPath);
    return;
  }

  if (currentConfigFieldError?.path === path) {
    currentConfigFieldError = null;
  }
  currentConfigPanelState = null;
  currentEditState = beginConfigEdit(path, readConfigValue(currentConfig, path));
  pendingEditorFocusPath = path;
  renderConfigViewer();
}

function cancelEditing(): void {
  currentEditState = cancelConfigEdit();
  currentConfigFieldError = null;
  renderConfigViewer();
}

function toggleAllowedModelsEditor(path: string): void {
  if (path !== "ai.allowedModels") {
    return;
  }

  const previousSort =
    currentConfigPanelState?.kind === "allowed-models"
      ? currentConfigPanelState.sort
      : "name-asc";
  currentEditState = null;
  currentModalTextState = null;
  currentConfigFieldError = null;
  currentConfigPanelState =
    currentConfigPanelState?.kind === "allowed-models" && currentConfigPanelState.path === path
      ? null
      : {
          kind: "allowed-models",
          path,
          sort: previousSort
        };
  renderConfigViewer();
}

function toggleModelSelectEditor(path: ModelSelectPanelPath): void {
  currentEditState = null;
  currentModalTextState = null;
  currentConfigFieldError = null;
  currentConfigPanelState =
    currentConfigPanelState?.kind === "model-select" && currentConfigPanelState.path === path
      ? null
      : {
          kind: "model-select",
          path
        };
  renderConfigViewer();
}

async function toggleAllowedModel(modelId: string, tier: AiServiceTier): Promise<void> {
  if (!currentConfig) {
    return;
  }

  const selectedRules = getAllowedModelRules();
  const targetKey = createAllowedModelRuleKey(modelId, tier);
  const nextSelectedRules = normalizeAllowedModelRules(
    selectedRules.some((rule) => createAllowedModelRuleKey(rule.model, rule.tier) === targetKey)
      ? selectedRules.filter((rule) => createAllowedModelRuleKey(rule.model, rule.tier) !== targetKey)
      : [...selectedRules, { model: modelId, tier }]
  );

  try {
    await applyConfigValue("ai.allowedModels", nextSelectedRules, false);
    currentConfigFieldError = null;
    setControlMessage("Конфиг обновлён: ai.allowedModels", "ok");
    renderShell();
    renderConfigViewer();
    await recordLog("popup", "popup.config-edit.commit", "Updated ai.allowedModels.", {
      path: "ai.allowedModels",
      scope: "local",
      value: nextSelectedRules
    });
  } catch (error) {
    const failedMessage = getUserFacingError(error, "Не удалось обновить список разрешённых моделей.");
    currentConfigFieldError = {
      path: "ai.allowedModels",
      message: failedMessage
    };
    setControlMessage(failedMessage, "error");
    renderShell();
    renderConfigViewer();
    await recordLog("popup", "popup.config-edit.failed", failedMessage, {
      path: "ai.allowedModels",
      error
    }, "error");
  }
}

async function applySingleModelValue(path: ModelSelectPanelPath, selection: AiModelSelection): Promise<void> {
  try {
    await applyConfigValue(path, selection, false);
    currentConfigFieldError = null;
    currentConfigPanelState = null;
    setControlMessage(`Конфиг обновлён: ${path}`, "ok");
    renderShell();
    renderConfigViewer();
    await recordLog("popup", "popup.config-edit.commit", `Updated ${path}.`, {
      path,
      scope: "local",
      value: selection
    });
  } catch (error) {
    const failedMessage = getUserFacingError(error, `Не удалось обновить ${path}.`);
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

async function resetConfigFieldToDefault(path: string): Promise<void> {
  const descriptor = getEditableConfigField(path);
  if (!descriptor) {
    return;
  }

  const defaultValue = cloneDefaultConfigValue(path);
  currentEditState = null;
  currentConfigFieldError = null;
  currentConfigPanelState = null;
  currentModalTextState = null;

  try {
    if (path === "ui.overlay.visible") {
      await applyOverlayVisibility(defaultValue === true);
    } else {
      await applyConfigValue(path, defaultValue, false);
    }

    setControlMessage(`Сброшено к значению по умолчанию: ${path}`, "ok");
    renderShell();
    renderConfigViewer();
    await recordLog("popup", "popup.config-reset.commit", `Reset ${path} to default value.`, {
      path,
      scope: descriptor.scope,
      value: defaultValue
    });
  } catch (error) {
    const failedMessage = getUserFacingError(error, `Не удалось сбросить ${path} к значению по умолчанию.`);
    currentConfigFieldError = {
      path,
      message: failedMessage
    };
    setControlMessage(failedMessage, "error");
    renderShell();
    renderConfigViewer();
    await recordLog("popup", "popup.config-reset.failed", failedMessage, {
      path,
      error
    }, "error");
  }
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
      setControlMessage(`Конфиг обновлён: ${result.path}`, "ok");
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
  await refreshAiSessionBudgets();
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
    setControlMessage(`Терминал открыт на вкладке ${result.tabId ?? "-"}.`, "ok");
  } else {
    const result = await sendCommand<{ closed: true; tabId: number | null; url: string | null }>(
      COMMANDS.overlayClose,
      "popup",
      "background",
      payload
    );
    setControlMessage(`Терминал закрыт на вкладке ${result.tabId ?? "-"}.`, "ok");
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
    setControlMessage(getUserFacingError(error, "Не удалось проверить доступность терминала."), "error");
    renderShell();
    return overlayProbe;
  }
}

async function refreshModelCatalog(): Promise<void> {
  try {
    const result = AiModelCatalogResultSchema.parse(
      await sendCommand(COMMANDS.aiModelsCatalog, "popup", "background")
    );
    currentModelCatalog = result.models;
    currentModelCatalogFetchedAt = result.fetchedAt;
    currentModelCatalogError = null;
    renderConfigViewer();
  } catch (error) {
    currentModelCatalog = [];
    currentModelCatalogFetchedAt = null;
    currentModelCatalogError = getUserFacingError(error, "Каталог моделей OpenAI недоступен.");
    renderConfigViewer();
    await recordLog("popup", "popup.model-catalog.failed", currentModelCatalogError, {
      error
    }, "warn");
  }
}

async function refreshAiSessionBudgets(): Promise<void> {
  try {
    const result = AiChatListResultSchema.parse(
      await sendCommand(COMMANDS.aiChatList, "popup", "background")
    );
    hydrateModelBudgetsFromSessions(result.sessions);
  } catch (error) {
    currentModelBudgets = {};
    await recordLog("popup", "popup.ai-budgets.failed", "Не удалось загрузить AI budget telemetry.", {
      error
    }, "warn");
  }
}

function hydrateModelBudgetsFromSessions(sessions: readonly unknown[]): void {
  const nextBudgets: AiModelBudgetMap = {};

  for (const item of sessions) {
    const parsed = AiChatPageSessionSchema.safeParse(item);
    if (!parsed.success) {
      continue;
    }

    const status = parsed.data.status;
    for (const [model, budget] of Object.entries(status.modelBudgets)) {
      const current = nextBudgets[model];
      if (!current || (budget.observedAt ?? "") >= (current.observedAt ?? "")) {
        nextBudgets[model] = budget;
      }
    }

    if (status.currentModelBudget) {
      const current = nextBudgets[status.currentModelBudget.model];
      if (!current || (status.currentModelBudget.observedAt ?? "") >= (current.observedAt ?? "")) {
        nextBudgets[status.currentModelBudget.model] = status.currentModelBudget;
      }
    }
  }

  currentModelBudgets = nextBudgets;
}

function resolveModelBudget(modelId: string) {
  const exact = currentModelBudgets[modelId];
  if (exact) {
    return exact;
  }

  const normalizedModelId = modelId.toLowerCase();
  for (const [key, value] of Object.entries(currentModelBudgets)) {
    if (key.toLowerCase() === normalizedModelId || value.model.toLowerCase() === normalizedModelId) {
      return value;
    }
  }

  return null;
}

function cloneDefaultConfigValue(path: string): unknown {
  const defaultValue = readConfigValue(defaultConfig, path);
  return defaultValue && typeof defaultValue === "object"
    ? structuredClone(defaultValue)
    : defaultValue;
}

function ensureTooltipRoot(): HTMLElement {
  let root = document.getElementById(POPUP_TOOLTIP_ID);
  if (root) {
    return root;
  }

  root = document.createElement("div");
  root.id = POPUP_TOOLTIP_ID;
  root.className = "popup-tooltip";
  root.hidden = true;
  popupBody.append(root);
  return root;
}

function bindPopupTooltip(
  element: HTMLElement,
  text: string,
  mode: "always" | "overflow"
): void {
  if (!text.trim()) {
    return;
  }

  const show = () => {
    if (mode === "overflow" && !shouldShowOverflowTooltip(element)) {
      hidePopupTooltip();
      return;
    }

    const tooltip = ensureTooltipRoot();
    tooltip.textContent = text;
    tooltip.hidden = false;
    positionPopupTooltip(element, tooltip);
  };

  element.addEventListener("mouseenter", show);
  element.addEventListener("focus", show);
  element.addEventListener("mousemove", () => {
    const tooltip = document.getElementById(POPUP_TOOLTIP_ID);
    if (tooltip && !tooltip.hidden) {
      positionPopupTooltip(element, tooltip);
    }
  });
  element.addEventListener("mouseleave", hidePopupTooltip);
  element.addEventListener("blur", hidePopupTooltip);
}

function positionPopupTooltip(anchor: HTMLElement, tooltip: HTMLElement): void {
  const anchorRect = anchor.getBoundingClientRect();
  const tooltipRect = tooltip.getBoundingClientRect();
  const offset = 10;
  const maxLeft = window.innerWidth - tooltipRect.width - 8;
  const preferredLeft = Math.min(Math.max(8, anchorRect.left), Math.max(8, maxLeft));
  const placeAbove = anchorRect.bottom + offset + tooltipRect.height > window.innerHeight;
  const top = placeAbove
    ? Math.max(8, anchorRect.top - tooltipRect.height - offset)
    : Math.min(window.innerHeight - tooltipRect.height - 8, anchorRect.bottom + offset);

  tooltip.style.left = `${preferredLeft}px`;
  tooltip.style.top = `${top}px`;
}

function hidePopupTooltip(): void {
  const tooltip = document.getElementById(POPUP_TOOLTIP_ID);
  if (tooltip) {
    tooltip.hidden = true;
  }
}

function shouldShowOverflowTooltip(element: HTMLElement): boolean {
  return element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1;
}

function ensureModalRoot(): HTMLElement {
  let root = document.getElementById(MODAL_ROOT_ID);
  if (root) {
    return root;
  }

  root = document.createElement("div");
  root.id = MODAL_ROOT_ID;
  root.className = "popup-modal-root";
  root.hidden = true;
  popupBody.append(root);
  return root;
}

function openModalTextEditor(path: ModalTextPath): void {
  if (!currentConfig) {
    return;
  }

  currentEditState = null;
  currentConfigPanelState = null;
  currentConfigFieldError = null;
  const currentValue = typeof readConfigValue(currentConfig, path) === "string"
    ? String(readConfigValue(currentConfig, path) ?? "")
    : "";
  currentModalTextState = {
    path,
    draft: currentValue,
    initialValue: currentValue
  };
  renderPopupModal();
}

function closePopupModal(): void {
  currentModalTextState = null;
  currentConfigPanelState = null;
  renderPopupModal();
}

function renderPopupModal(): void {
  const root = ensureModalRoot();
  const previousModelListScrollTop = root.querySelector<HTMLElement>(MODEL_LIST_SELECTOR)?.scrollTop ?? null;
  hidePopupTooltip();
  root.replaceChildren();

  if (!currentModalTextState && !currentConfigPanelState) {
    root.hidden = true;
    return;
  }

  root.hidden = false;
  const backdrop = document.createElement("div");
  backdrop.className = "popup-modal-backdrop";
  backdrop.addEventListener("click", closePopupModal);

  const dialog = document.createElement("div");
  dialog.className = "popup-modal-shell";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.addEventListener("click", (event) => {
    event.stopPropagation();
  });
  dialog.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closePopupModal();
    }
  });

  let autoFocusElement: HTMLElement | null = null;

  if (currentModalTextState) {
    dialog.append(createModalTextEditorContent());
    autoFocusElement = dialog.querySelector<HTMLElement>(".popup-modal-textarea");
  } else if (currentConfigPanelState?.kind === "allowed-models" && currentConfig) {
    dialog.classList.add("is-picker", "is-wide");
    dialog.append(
      createModalFrame(
        "ai.allowedModels",
        createAllowedModelsPanel(readConfigValue(currentConfig, "ai.allowedModels") as unknown[])
      )
    );
    autoFocusElement =
      dialog.querySelector<HTMLElement>(".json-model-sort") ??
      dialog.querySelector<HTMLElement>(".json-model-checkbox");
  } else if (currentConfigPanelState?.kind === "model-select") {
    dialog.classList.add("is-picker", "is-wide");
    dialog.append(createModalFrame(currentConfigPanelState.path, createModelSelectPanel(currentConfigPanelState.path)));
    autoFocusElement = dialog.querySelector<HTMLElement>(".json-model-option.is-selected") ??
      dialog.querySelector<HTMLElement>(".json-model-option");
  }

  backdrop.append(dialog);
  root.append(backdrop);

  if (previousModelListScrollTop !== null) {
    const nextModelList = root.querySelector<HTMLElement>(MODEL_LIST_SELECTOR);
    if (nextModelList) {
      nextModelList.scrollTop = previousModelListScrollTop;
    }
  }

  queueMicrotask(() => {
    if (autoFocusElement instanceof HTMLTextAreaElement) {
      autoFocusElement.focus();
      autoFocusElement.setSelectionRange(autoFocusElement.value.length, autoFocusElement.value.length);
      return;
    }

    autoFocusElement?.focus();
  });
}

function createModalFrame(titleText: string, bodyContent: HTMLElement): HTMLDivElement {
  const fragment = document.createElement("div");
  fragment.className = "popup-modal-frame";

  const header = document.createElement("div");
  header.className = "popup-modal-header";

  const title = document.createElement("span");
  title.className = "popup-modal-title";
  title.textContent = titleText;

  const actions = document.createElement("div");
  actions.className = "popup-modal-actions";

  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "popup-modal-button";
  closeButton.textContent = "Close";
  closeButton.addEventListener("click", closePopupModal);

  actions.append(closeButton);
  header.append(title, actions);

  const body = document.createElement("div");
  body.className = "popup-modal-body";
  body.append(bodyContent);

  fragment.append(header, body);
  return fragment;
}

function createModalTextEditorContent(): HTMLDivElement {
  const fragment = document.createElement("div");
  fragment.className = "popup-modal-frame";

  const header = document.createElement("div");
  header.className = "popup-modal-header";

  const title = document.createElement("span");
  title.className = "popup-modal-title";
  title.textContent = currentModalTextState?.path ?? "";

  const actions = document.createElement("div");
  actions.className = "popup-modal-actions";

  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.className = "popup-modal-button";
  cancelButton.textContent = "Cancel";
  cancelButton.addEventListener("click", closePopupModal);

  const saveButton = document.createElement("button");
  saveButton.type = "button";
  saveButton.className = "popup-modal-button is-primary";
  saveButton.textContent = "Save";
  saveButton.addEventListener("click", () => {
    void commitModalTextEditor();
  });

  actions.append(cancelButton, saveButton);
  header.append(title, actions);

  const textarea = document.createElement("textarea");
  textarea.className = "popup-modal-textarea";
  textarea.value = currentModalTextState?.draft ?? "";
  textarea.addEventListener("input", () => {
    if (currentModalTextState) {
      currentModalTextState = {
        ...currentModalTextState,
        draft: textarea.value
      };
    }
  });
  textarea.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closePopupModal();
      return;
    }

    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      void commitModalTextEditor();
    }
  });

  fragment.append(header, textarea);
  return fragment;
}

async function commitModalTextEditor(): Promise<void> {
  if (!currentModalTextState) {
    return;
  }

  const modalState = currentModalTextState;
  try {
    await applyConfigValue(modalState.path, modalState.draft, false);
    currentConfigFieldError = null;
    currentModalTextState = null;
    setControlMessage(`Конфиг обновлён: ${modalState.path}`, "ok");
    renderShell();
    renderConfigViewer();
    await recordLog("popup", "popup.config-edit.commit", `Updated ${modalState.path}.`, {
      path: modalState.path,
      scope: "local",
      valueLength: modalState.draft.length
    });
  } catch (error) {
    const failedMessage = getUserFacingError(error, `Не удалось обновить ${modalState.path}.`);
    currentConfigFieldError = {
      path: modalState.path,
      message: failedMessage
    };
    setControlMessage(failedMessage, "error");
    renderShell();
    renderConfigViewer();
    await recordLog("popup", "popup.config-edit.failed", failedMessage, {
      path: modalState.path,
      error
    }, "error");
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
      return "Терминал недоступен: переключитесь на обычную http(s)-страницу.";
    }
    if (error.code === "content_not_ready") {
      return "Терминал недоступен: перезагрузите страницу и повторите попытку.";
    }
    if (error.message) {
      return error.message;
    }
  }

  return error instanceof Error && error.message ? error.message : fallbackMessage;
}
