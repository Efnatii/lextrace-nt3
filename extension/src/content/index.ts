import {
  AiChatCompactResultSchema,
  AiModelCatalogResultSchema,
  AiChatPageSessionSchema,
  buildAiChatTranscriptItems,
  buildAiChatStatusFragments,
  createDefaultAiStatus,
  formatAiEventKindLabel,
  formatAiMessageOriginLabel,
  normalizeAllowedModelRules,
  type AiAllowedModelRule,
  type AiChatMessage,
  type AiChatPageSession,
  type AiChatTranscriptItem,
  type AiModelCatalogItem,
  type AiServiceTier,
  type AiStreamMessage
} from "../shared/ai";
import { isAiModelTierAvailable } from "../shared/ai-model-catalog";
import { parseAiQueueImportJson } from "../shared/ai-queue-import";
import { COMMANDS } from "../shared/constants";
import { connectRuntimeStream, formatUserFacingCommandError, recordLog, sendCommand } from "../shared/client";
import {
  buildConfigPatchFromPath,
  getEditableConfigField,
  getEditableConfigPaths,
  omitSensitiveConfigData,
  parseConfigFieldDraft,
  readConfigValue
} from "../shared/config-fields";
import { defaultConfig, ExtensionConfigSchema, type ExtensionConfig, type ExtensionConfigPatch, type OverlayTab, type PopupTab } from "../shared/config";
import { LogEntrySchema, serializeLogDetails, type LogEntry } from "../shared/logging";
import {
  buildChatLogExportPayload,
  buildConsoleLogExportPayload,
  formatLogExportFileName
} from "../shared/log-export";
import {
  buildOverlayActivityFeed,
  type OverlayConsoleEntry,
  type OverlayConsoleEntryKind
} from "../shared/overlay-feed";
import {
  createErrorResponse,
  createOkResponse,
  validateEnvelope,
  type ExtensionStreamMessage,
  type RuntimeStreamMessage
} from "../shared/protocol";
import { normalizePageKey, shortenPageKey } from "../shared/page";
import { parseRuntimeWorkerStatus, type WorkerStatus } from "../shared/runtime-state";
import {
  buildStatusChipDescriptors,
  type StatusChipDescriptor,
  type StatusChipIcon
} from "../shared/status-chips";
import {
  getTerminalHelpLines,
  getTerminalSuggestions,
  parseTerminalCommand,
  type ParsedTerminalCommand,
  type TerminalCatalogOptions
} from "../shared/terminal";
import type { TerminalChatTarget, TerminalOverlayTarget } from "../shared/terminal-alias";

type RuntimeSnapshot = {
  config: ExtensionConfig;
  status: WorkerStatus;
  logs: LogEntry[];
};

type RuntimeSnapshotResponse = {
  config: ExtensionConfig;
  workerStatus: WorkerStatus;
  logs: LogEntry[];
};

type TerminalExecutionResult = {
  output: unknown;
  logDetails?: unknown;
  postAction?:
    | {
        type: "close-overlay";
      }
    | {
        type: "switch-overlay-tab";
        tab: OverlayTab;
      };
};

const SVG_NS = "http://www.w3.org/2000/svg";
const STATUS_DOWNLOAD_ICON: StatusChipIcon = {
  viewBox: "0 0 16 16",
  paths: [
    { d: "M8 3.25v6.5" },
    { d: "m5.5 7.75 2.5 2.5 2.5-2.5" },
    { d: "M3.5 11.75h9" }
  ]
};

function createStatusChipIcon(icon: StatusChipIcon): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", icon.viewBox);
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");

  for (const pathDefinition of icon.paths) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", pathDefinition.d);
    if (pathDefinition.fill) {
      path.setAttribute("fill", pathDefinition.fill);
    }
    if (pathDefinition.stroke) {
      path.setAttribute("stroke", pathDefinition.stroke);
    }
    svg.append(path);
  }

  return svg;
}

function createStatusChip(descriptor: StatusChipDescriptor): HTMLSpanElement {
  const chip = document.createElement("span");
  chip.className = "status-chip";
  chip.dataset.statusKey = descriptor.key;
  if (descriptor.width !== "default") {
    chip.classList.add(`status-chip--${descriptor.width}`);
  }

  const tooltip = `${descriptor.tooltipLabel}: ${descriptor.fullValue}`;
  chip.tabIndex = 0;
  chip.setAttribute("data-tooltip", tooltip);
  chip.setAttribute("aria-label", tooltip);

  const icon = document.createElement("span");
  icon.className = "status-chip-icon";
  icon.append(createStatusChipIcon(descriptor.icon));

  const value = document.createElement("span");
  value.className = "status-chip-value";
  value.textContent = descriptor.value;

  chip.append(icon, value);
  return chip;
}

function createStatusActionButton(options: {
  tooltip: string;
  icon?: StatusChipIcon;
  dataRole?: string;
  disabled?: boolean;
  onClick: () => void;
}): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "status-action";
  button.tabIndex = 0;
  button.disabled = options.disabled ?? false;
  button.setAttribute("data-tooltip", options.tooltip);
  button.setAttribute("aria-label", options.tooltip);
  if (options.dataRole) {
    button.dataset.role = options.dataRole;
  }

  button.append(createStatusChipIcon(options.icon ?? STATUS_DOWNLOAD_ICON));
  button.addEventListener("click", options.onClick);
  return button;
}

function createStatusRowShell(
  descriptors: readonly StatusChipDescriptor[],
  actions: readonly HTMLButtonElement[] = []
): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const chipList = document.createElement("div");
  chipList.className = "status-chip-list";
  chipList.append(...descriptors.map((descriptor) => createStatusChip(descriptor)));
  fragment.append(chipList);

  if (actions.length > 0) {
    const actionList = document.createElement("div");
    actionList.className = "status-row-actions";
    actionList.append(...actions);
    fragment.append(actionList);
  }

  return fragment;
}

class OverlayTerminalController {
  private host: HTMLDivElement | null = null;
  private shadowRoot: ShadowRoot | null = null;
  private streamPort: chrome.runtime.Port | null = null;
  private reconnectTimer: number | null = null;
  private streamKeepAliveTimer: number | null = null;
  private panelHeader: HTMLElement | null = null;
  private tabButtons: HTMLButtonElement[] = [];
  private consolePanel: HTMLElement | null = null;
  private chatPanel: HTMLElement | null = null;
  private consoleStatusRow: HTMLElement | null = null;
  private chatStatusRow: HTMLElement | null = null;
  private consoleToolRow: HTMLElement | null = null;
  private chatToolRow: HTMLElement | null = null;
  private chatFeed: HTMLElement | null = null;
  private chatInput: HTMLInputElement | null = null;
  private chatForm: HTMLFormElement | null = null;
  private chatQueueFileInput: HTMLInputElement | null = null;
  private chatImportQueueButton: HTMLButtonElement | null = null;
  private chatSendButton: HTMLButtonElement | null = null;
  private chatResumeButton: HTMLButtonElement | null = null;
  private chatResetButton: HTMLButtonElement | null = null;

  private activityFeed: HTMLElement | null = null;
  private terminalSuggestionList: HTMLElement | null = null;
  private terminalInput: HTMLInputElement | null = null;
  private panelWindow: HTMLElement | null = null;
  private currentConfig: ExtensionConfig | null = null;
  private currentStatus: WorkerStatus | null = null;
  private aiSession: AiChatPageSession | null = null;
  private runtimeLogs: LogEntry[] = [];
  private consoleEntries: OverlayConsoleEntry[] = [];
  private runtimeLogSequences = new Map<string, number>();
  private activityOpenState = new Map<string, boolean>();
  private visibleActivitySequenceFloor = 0;
  private currentSuggestions: string[] = [];
  private selectedSuggestionIndex = -1;
  private nextActivitySequence = 0;
  private activeTab: OverlayTab = "console";
  private chatQueueImportInProgress = false;
  private readonly pageViewId = crypto.randomUUID();
  private visible = false;
  private dragState:
    | {
        pointerId: number;
        originX: number;
        originY: number;
        startLeft: number;
        startTop: number;
        moved: boolean;
      }
    | null = null;

  constructor() {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      void this.handleMessage(message)
        .then((response) => sendResponse(response))
        .catch((error) => {
          sendResponse(
            createErrorResponse(
              crypto.randomUUID(),
              "content_error",
              error instanceof Error ? error.message : String(error)
            )
          );
        });
      return true;
    });

    window.addEventListener("keydown", this.handleCapturedKeyboardEvent, true);
    window.addEventListener("keyup", this.handleCapturedKeyboardEvent, true);
    window.addEventListener("keypress", this.handleCapturedKeyboardEvent, true);
  }

  async handleMessage(message: unknown) {
    const envelope = validateEnvelope(message);

    if (envelope.action === COMMANDS.overlayProbe) {
      return createOkResponse(envelope.id, {
        ready: true,
        visible: this.visible
      });
    }

    if (envelope.action === COMMANDS.overlayOpen) {
      await this.open();
      return createOkResponse(envelope.id, { opened: true });
    }

    if (envelope.action === COMMANDS.overlayClose) {
      await this.close(false);
      return createOkResponse(envelope.id, { closed: true });
    }

    return createErrorResponse(
      envelope.id,
      "unsupported_action",
      `Неподдерживаемое действие контент-скрипта: ${envelope.action}`
    );
  }

  async open(): Promise<void> {
    this.ensureDom();
    this.visible = true;
    this.host?.style.setProperty("display", "block");
    this.pushConsole("system", "Оверлейный терминал открыт. Введите help, чтобы увидеть команды.");
    await this.patchOverlaySessionConfig({
      visible: true
    });
    await this.ensureStream();
    await this.loadSnapshot();
    await this.loadAiSnapshot();
    this.centerPanelInViewport();
    this.focusPreferredOverlayElement();
    await recordLog("content", "overlay.open", "Оверлейный терминал открыт.");
  }

  async close(recordClose = true): Promise<void> {
    this.visible = false;
    this.host?.style.setProperty("display", "none");
    this.disconnectStream();
    await this.patchOverlaySessionConfig({
      visible: false
    });
    if (recordClose) {
      await recordLog("content", "overlay.close", "Оверлейный терминал закрыт.");
    }
  }

  private ensureDom(): void {
    if (this.host) {
      return;
    }

    this.host = document.createElement("div");
    this.host.id = "lextrace-overlay-root";
    this.host.style.position = "fixed";
    this.host.style.inset = "0";
    this.host.style.zIndex = "2147483647";
    this.host.style.pointerEvents = "none";
    this.host.style.display = "none";

    this.shadowRoot = this.host.attachShadow({
      mode: "open"
    });

    const style = document.createElement("style");
    style.textContent = overlayStyles;

    const wrapper = document.createElement("div");
    wrapper.className = "overlay-window";
    wrapper.innerHTML = `
      <div class="panel-shell">
        <header class="panel-header">
          <div>
            <p class="panel-kicker">Оверлей страницы</p>
            <h1>Терминал LexTrace</h1>
          </div>
          <button type="button" class="close-button" data-close="true">Закрыть</button>
        </header>
        <nav class="overlay-tab-strip" data-role="overlay-tabs">
          <button type="button" class="overlay-tab-button is-active" data-tab="console">Консоль</button>
          <button type="button" class="overlay-tab-button" data-tab="chat">Чат</button>
        </nav>
        <div class="tab-surface is-active" data-panel="console">
          <div class="status-row" data-role="console-status-row"></div>
          <div class="tool-row" data-role="console-tool-row"></div>
          <section class="panel-body console-body">
            <div class="activity-feed" data-role="activity-feed"></div>
            <form class="terminal-form" data-role="terminal-form">
              <span class="prompt-label">NT3&gt;</span>
              <div class="terminal-input-shell">
                <div class="terminal-suggestion-list is-hidden" data-role="terminal-suggestions"></div>
                <input class="terminal-input" data-role="terminal-input" spellcheck="false" autocomplete="off" />
              </div>
            </form>
          </section>
        </div>
        <div class="tab-surface chat-surface" data-panel="chat">
          <div class="status-row" data-role="chat-status-row"></div>
          <section class="panel-body chat-body">
            <div class="chat-feed" data-role="chat-feed"></div>
            <form class="chat-form" data-role="chat-form">
              <span class="prompt-label">AI&gt;</span>
              <div class="chat-input-shell">
                <input class="chat-input" data-role="chat-input" spellcheck="false" autocomplete="off" />
              </div>
              <input
                type="file"
                class="chat-queue-file-input"
                data-role="chat-queue-file"
                accept=".json,application/json"
              />
              <div class="tool-row chat-tool-row" data-role="chat-tool-row">
                <button
                  type="button"
                  class="tool-icon"
                  data-role="chat-import-queue"
                  data-tooltip="Загрузить очередь JSON"
                  aria-label="Загрузить очередь JSON"
                >
                  <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                    <path d="M8 3.25v6.5" />
                    <path d="m5.5 7.75 2.5 2.5 2.5-2.5" />
                    <path d="M3.5 11.75h9" />
                  </svg>
                </button>
                <button
                  type="button"
                  class="tool-icon"
                  data-role="chat-send"
                  data-tooltip="Отправить"
                  aria-label="Отправить"
                >
                  <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                    <path d="M2.5 8h9" />
                    <path d="m8.75 4.25 3.75 3.75-3.75 3.75" />
                  </svg>
                </button>
                <button
                  type="button"
                  class="tool-icon"
                  data-role="chat-resume"
                  data-tooltip="Продолжить"
                  aria-label="Продолжить"
                >
                  <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                    <path d="M5.25 3.5v9l6-4.5-6-4.5Z" fill="currentColor" stroke="none" />
                  </svg>
                </button>
                <button
                  type="button"
                  class="tool-icon"
                  data-role="chat-reset"
                  data-tooltip="Сбросить"
                  aria-label="Сбросить"
                >
                  <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                    <path d="M5 3.75H2.5v2.5" />
                    <path d="M2.75 6.25A5.25 5.25 0 1 0 4.5 3.9" />
                  </svg>
                </button>
              </div>
            </form>
          </section>
        </div>
      </div>
    `;

    this.shadowRoot.append(style, wrapper);
    document.documentElement.appendChild(this.host);

    this.panelWindow = wrapper.querySelector<HTMLElement>(".panel-shell");
    this.panelHeader = wrapper.querySelector<HTMLElement>(".panel-header");
    this.consolePanel = wrapper.querySelector<HTMLElement>("[data-panel='console']");
    this.chatPanel = wrapper.querySelector<HTMLElement>("[data-panel='chat']");
    this.consoleStatusRow = wrapper.querySelector<HTMLElement>("[data-role='console-status-row']");
    this.chatStatusRow = wrapper.querySelector<HTMLElement>("[data-role='chat-status-row']");
    this.consoleToolRow = wrapper.querySelector<HTMLElement>("[data-role='console-tool-row']");
    this.chatToolRow = wrapper.querySelector<HTMLElement>("[data-role='chat-tool-row']");
    this.activityFeed = wrapper.querySelector<HTMLElement>("[data-role='activity-feed']");
    this.chatFeed = wrapper.querySelector<HTMLElement>("[data-role='chat-feed']");
    this.terminalSuggestionList = wrapper.querySelector<HTMLElement>("[data-role='terminal-suggestions']");
    this.terminalInput = wrapper.querySelector<HTMLInputElement>("[data-role='terminal-input']");
    this.chatInput = wrapper.querySelector<HTMLInputElement>("[data-role='chat-input']");
    this.chatForm = wrapper.querySelector<HTMLFormElement>("[data-role='chat-form']");
    this.chatQueueFileInput = wrapper.querySelector<HTMLInputElement>("[data-role='chat-queue-file']");
    this.chatImportQueueButton = wrapper.querySelector<HTMLButtonElement>("[data-role='chat-import-queue']");
    this.chatSendButton = wrapper.querySelector<HTMLButtonElement>("[data-role='chat-send']");
    this.chatResumeButton = wrapper.querySelector<HTMLButtonElement>("[data-role='chat-resume']");
    this.chatResetButton = wrapper.querySelector<HTMLButtonElement>("[data-role='chat-reset']");
    this.tabButtons = Array.from(wrapper.querySelectorAll<HTMLButtonElement>(".overlay-tab-button"));

    if (this.panelWindow) {
      this.panelWindow.tabIndex = 0;
      this.panelWindow.addEventListener("pointerdown", (event) => {
        if (!this.isInteractiveElement(event.target)) {
          this.panelWindow?.focus();
        }
      });
      for (const eventName of [
        "pointerdown",
        "pointermove",
        "pointerup",
        "pointercancel",
        "mousedown",
        "mousemove",
        "mouseup",
        "click",
        "dblclick"
      ]) {
        this.panelWindow.addEventListener(eventName, this.handleOverlayPointerEvent);
      }
      this.panelWindow.addEventListener("contextmenu", this.handleOverlayPointerEvent);
      this.panelWindow.addEventListener("wheel", this.handleOverlayWheelEvent, {
        passive: false
      });
    }

    this.panelHeader?.addEventListener("pointerdown", (event) => {
      this.beginDrag(event);
    });
    this.panelHeader?.addEventListener("pointermove", (event) => {
      this.updateDrag(event);
    });
    this.panelHeader?.addEventListener("pointerup", (event) => {
      void this.endDrag(event);
    });
    this.panelHeader?.addEventListener("pointercancel", (event) => {
      void this.endDrag(event);
    });

    wrapper.querySelector<HTMLButtonElement>("[data-close='true']")?.addEventListener("click", () => {
      void this.close();
    });

    wrapper.querySelector<HTMLFormElement>("[data-role='terminal-form']")?.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.executeCommand();
    });
    this.chatForm?.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.sendChatMessage();
    });
    this.chatSendButton?.addEventListener("click", () => {
      void this.sendChatMessage();
    });
    this.chatImportQueueButton?.addEventListener("click", () => {
      this.openChatQueueImportPicker();
    });
    this.chatQueueFileInput?.addEventListener("change", () => {
      void this.handleChatQueueFileSelection();
    });
    this.chatResumeButton?.addEventListener("click", () => {
      void this.resumeChat();
    });
    this.chatResetButton?.addEventListener("click", () => {
      void this.resetChat();
    });
    this.tabButtons.forEach((button) => {
      button.addEventListener("click", () => {
        this.setActiveTab((button.dataset.tab as OverlayTab | undefined) ?? "console", true, true);
      });
    });

    this.terminalInput?.addEventListener("focus", () => {
      this.refreshTerminalSuggestions();
    });
    this.terminalInput?.addEventListener("blur", () => {
      window.setTimeout(() => {
        if (this.shadowRoot?.activeElement !== this.terminalInput) {
          this.closeTerminalSuggestions();
        }
      }, 0);
    });
    this.terminalInput?.addEventListener("input", () => {
      this.refreshTerminalSuggestions();
    });
    this.chatInput?.addEventListener("input", () => {
      this.renderChatToolRow();
    });
  }

  private async ensureStream(): Promise<void> {
    if (this.streamPort) {
      this.subscribeCurrentPageToStream();
      return;
    }

    this.streamPort = connectRuntimeStream((message) => {
      void this.handleStreamMessage(message as ExtensionStreamMessage & Record<string, unknown>).catch((error) => {
        void recordLog("content", "overlay.stream.invalid", "Некорректное stream-сообщение проигнорировано.", {
          error
        }, "warn");
      });
    });
    this.subscribeCurrentPageToStream();
    this.startStreamKeepAlive();

    this.streamPort.onDisconnect.addListener(() => {
      this.streamPort = null;
      this.stopStreamKeepAlive();
      if (!this.visible) {
        return;
      }
      this.pushConsole("error", "Поток среды выполнения отключён. Повторное подключение…");
      if (this.reconnectTimer) {
        window.clearTimeout(this.reconnectTimer);
      }
      this.reconnectTimer = window.setTimeout(() => {
        void this.ensureStream();
      }, 1000);
    });
  }

  private disconnectStream(): void {
    if (this.reconnectTimer) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopStreamKeepAlive();
    this.streamPort?.disconnect();
    this.streamPort = null;
  }

  private startStreamKeepAlive(): void {
    if (this.streamKeepAliveTimer !== null) {
      return;
    }

    this.streamKeepAliveTimer = window.setInterval(() => {
      try {
        this.streamPort?.postMessage({
          type: "keepalive"
        });
      } catch {
        // Reconnect logic is driven by port.onDisconnect.
      }
    }, 15000);
  }

  private stopStreamKeepAlive(): void {
    if (this.streamKeepAliveTimer === null) {
      return;
    }

    window.clearInterval(this.streamKeepAliveTimer);
    this.streamKeepAliveTimer = null;
  }

  private async loadSnapshot(): Promise<void> {
    const snapshot = await sendCommand<{
      config: ExtensionConfig;
      workerStatus: WorkerStatus;
      logs: LogEntry[];
    }>(COMMANDS.configGet, "overlay", "background");

    this.applySnapshot({
      config: ExtensionConfigSchema.parse(snapshot.config),
      status: parseRuntimeWorkerStatus(snapshot),
      logs: snapshot.logs.map((entry) => LogEntrySchema.parse(entry))
    });
  }

  private async loadAiSnapshot(): Promise<void> {
    const pageContext = this.getCurrentPageContext();
    if (!pageContext) {
      this.aiSession = null;
      this.render();
      return;
    }

    try {
      const snapshot = await sendCommand<{ session: AiChatPageSession }>(
        COMMANDS.aiChatStatus,
        "overlay",
        "background",
        {
          pageKey: pageContext.pageKey,
          pageUrl: pageContext.pageUrl
        }
      );
      this.aiSession = AiChatPageSessionSchema.parse(snapshot.session);
      this.render();
    } catch (error) {
      const message = formatUserFacingCommandError(error, "Не удалось загрузить состояние AI-чата.");
      this.aiSession = {
        pageKey: pageContext.pageKey,
        pageUrlSample: pageContext.pageUrl,
        attachedViewIds: [],
        state: "error",
        activeRequestId: null,
        openaiResponseId: null,
        lastSequenceNumber: null,
        queuedCount: 0,
        recoverable: false,
        lastCheckpointAt: null,
        lastError: message,
        messages: [],
        queue: [],
        status: {
          ...createDefaultAiStatus(pageContext.pageKey, pageContext.pageUrl, false),
          requestState: "error",
          lastError: message
        }
      };
      this.render();
    }
  }

  private async handleStreamMessage(message: ExtensionStreamMessage & Record<string, unknown>): Promise<void> {
    if (message.stream === "ai") {
      await this.handleAiStreamMessage(message as AiStreamMessage);
      return;
    }

    if (message.event === "runtime.snapshot") {
      this.applySnapshot({
        config: ExtensionConfigSchema.parse(message.config),
        status: parseRuntimeWorkerStatus(message),
        logs: Array.isArray(message.logs)
          ? message.logs.map((entry) => LogEntrySchema.parse(entry))
          : this.runtimeLogs
      });
      return;
    }

    if (message.event === "runtime.status") {
      this.currentStatus = parseRuntimeWorkerStatus(message);
      this.renderConsoleStatus();
      return;
    }

    if (message.event === "runtime.config" && message.config) {
      this.currentConfig = ExtensionConfigSchema.parse(message.config);
      this.applyGeometry(this.currentConfig);
      this.render();
      return;
    }

    if (message.event === "runtime.log" && message.logEntry) {
      const entry = LogEntrySchema.parse(message.logEntry);
      this.setRuntimeLogs([...this.runtimeLogs.slice(-399), entry]);
      this.renderActivityFeed();
    }
  }

  private async handleAiStreamMessage(message: AiStreamMessage): Promise<void> {
    const currentPageContext = this.getCurrentPageContext();
    if (!currentPageContext || message.pageKey !== currentPageContext.pageKey) {
      return;
    }

    if (message.session) {
      this.aiSession = AiChatPageSessionSchema.parse(message.session);
      this.renderChat();
      return;
    }

    if (this.aiSession && message.status) {
      this.aiSession = {
        ...this.aiSession,
        status: message.status,
        state: message.status.requestState,
        activeRequestId: message.status.activeRequestId,
        openaiResponseId: message.status.openaiResponseId,
        lastSequenceNumber: message.status.lastSequenceNumber,
        queuedCount: message.status.queueCount,
        recoverable: message.status.recoverable,
        lastError: message.status.lastError
      };
      this.renderChat();
      return;
    }

    await this.loadAiSnapshot();
  }

  private applySnapshot(snapshot: RuntimeSnapshot): void {
    this.currentConfig = snapshot.config;
    this.currentStatus = snapshot.status;
    this.setRuntimeLogs(snapshot.logs);
    this.applyGeometry(snapshot.config);
    this.render(true);
  }

  private render(forceActivityScroll = false): void {
    if (this.currentConfig) {
      this.activeTab = this.currentConfig.ui.overlay.activeTab;
    }
    this.renderConsoleStatus();
    this.renderConsoleToolRow();
    this.renderActivityFeed(forceActivityScroll);
    this.renderChat();
    this.setActiveTab(this.activeTab, false);
  }

  private renderConsoleStatus(): void {
    if (!this.consoleStatusRow || !this.currentStatus) {
      return;
    }

    const descriptors = buildStatusChipDescriptors("console", [
      {
        key: "состояние",
        value: this.currentStatus.running ? "в работе" : "остановлен"
      },
      {
        key: "хост",
        value: this.currentStatus.hostConnected ? "подключён" : "отключён"
      },
      {
        key: "запуск",
        value: this.currentStatus.bootId.slice(0, 8),
        fullValue: this.currentStatus.bootId
      },
      {
        key: "сессия",
        value: this.currentStatus.sessionId ?? "-"
      },
      {
        key: "задача",
        value: this.currentStatus.taskId ?? "-"
      },
      {
        key: "пульс",
        value: this.currentStatus.lastHeartbeatAt ?? "-"
      }
    ]);

    this.consoleStatusRow.replaceChildren(
      createStatusRowShell(descriptors, [
        createStatusActionButton({
          tooltip: "Скачать лог консоли",
          dataRole: "console-export-log",
          onClick: () => {
            void this.downloadConsoleLog();
          }
        })
      ])
    );
  }

  private renderConsoleToolRow(): void {
    if (!this.consoleToolRow) {
      return;
    }

    this.consoleToolRow.replaceChildren();
    this.consoleToolRow.classList.add("is-collapsed");
  }

  private renderChat(): void {
    this.renderChatStatus();
    this.renderChatToolRow();
    this.renderChatFeed();
  }

  private renderChatStatus(): void {
    if (!this.chatStatusRow) {
      return;
    }

    const pageContext = this.getCurrentPageContext();
    const session = this.aiSession;
    const status = session?.status ?? (pageContext ? createDefaultAiStatus(pageContext.pageKey, pageContext.pageUrl, false) : null);
    if (!status) {
      this.chatStatusRow.replaceChildren();
      return;
    }

    const descriptors = buildStatusChipDescriptors(
      "chat",
      buildAiChatStatusFragments(status).map(([key, value]) => ({
        key,
        value: key === "page" ? shortenPageKey(value) : value,
        fullValue: value
      }))
    );

    this.chatStatusRow.replaceChildren(
      createStatusRowShell(descriptors, [
        createStatusActionButton({
          tooltip: "Скачать лог чата",
          dataRole: "chat-export-log",
          onClick: () => {
            void this.downloadChatLog();
          }
        })
      ])
    );
  }

  private async downloadConsoleLog(): Promise<void> {
    try {
      const exportedAt = new Date().toISOString();
      const pageContext = this.getCurrentPageContext();
      const payload = buildConsoleLogExportPayload({
        exportedAt,
        pageContext,
        workerStatus: this.currentStatus,
        currentConfig: this.currentConfig,
        consoleEntries: this.consoleEntries,
        runtimeLogs: this.runtimeLogs,
        runtimeLogSequences: this.runtimeLogSequences,
        visibleActivitySequenceFloor: this.visibleActivitySequenceFloor
      });
      const fileName = formatLogExportFileName("console", exportedAt, pageContext?.pageKey ?? null);
      this.downloadJsonFile(fileName, payload);
      await recordLog("content", "console.log.export", "Лог консоли выгружен.", {
        fileName,
        consoleEntryCount: payload.consoleEntries.length,
        runtimeLogCount: payload.runtimeLogs.length,
        visibleActivityCount: payload.visibleActivityFeed.length
      });
    } catch (error) {
      this.pushConsole("error", formatUserFacingCommandError(error, "Не удалось выгрузить лог консоли."));
      await recordLog("content", "console.log.export.failed", "Не удалось выгрузить лог консоли.", serializeLogDetails(error), "error");
    }
  }

  private async downloadChatLog(): Promise<void> {
    try {
      const exportedAt = new Date().toISOString();
      const pageContext = this.getCurrentPageContext();
      const payload = buildChatLogExportPayload({
        exportedAt,
        pageContext,
        currentConfig: this.currentConfig,
        session: this.aiSession
      });
      const fileName = formatLogExportFileName(
        "chat",
        exportedAt,
        this.aiSession?.pageKey ?? pageContext?.pageKey ?? null
      );
      this.downloadJsonFile(fileName, payload);
      await recordLog("content", "chat.log.export", "Лог чата выгружен.", {
        fileName,
        pageKey: this.aiSession?.pageKey ?? pageContext?.pageKey ?? null,
        messageCount: this.aiSession?.messages.length ?? 0,
        transcriptItemCount: payload.transcriptItems.length
      });
    } catch (error) {
      this.pushConsole("error", formatUserFacingCommandError(error, "Не удалось выгрузить лог чата."));
      await recordLog("content", "chat.log.export.failed", "Не удалось выгрузить лог чата.", serializeLogDetails(error), "error");
    }
  }

  private downloadJsonFile(fileName: string, payload: unknown): void {
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json;charset=utf-8"
    });
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = fileName;
    link.rel = "noopener";
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => {
      URL.revokeObjectURL(objectUrl);
    }, 0);
  }

  private renderChatToolRow(): void {
    const status = this.aiSession?.status;
    const chatInputValue = this.chatInput?.value.trim() ?? "";
    const configuredModel = status?.model?.model ?? this.currentConfig?.ai.chat.model?.model ?? "";
    const canSendFromInput = configuredModel.trim().length > 0 && chatInputValue.length > 0;
    const canImportQueue = Boolean(this.getCurrentPageContext());

    if (this.chatImportQueueButton) {
      this.chatImportQueueButton.hidden = !canImportQueue;
      this.chatImportQueueButton.disabled = this.chatQueueImportInProgress;
      const tooltip = this.chatQueueImportInProgress ? "Импорт очереди JSON…" : "Загрузить очередь JSON";
      this.chatImportQueueButton.dataset.tooltip = tooltip;
      this.chatImportQueueButton.setAttribute("aria-label", tooltip);
    }

    if (this.chatSendButton) {
      this.chatSendButton.hidden = !canSendFromInput;
    }
    if (this.chatResumeButton) {
      this.chatResumeButton.hidden = !(status?.availableActions.canResume ?? false);
    }
    if (this.chatResetButton) {
      this.chatResetButton.hidden = !(status?.availableActions.canReset ?? false);
    }

    if (this.chatToolRow) {
      const hasVisibleActions = [
        this.chatImportQueueButton,
        this.chatSendButton,
        this.chatResumeButton,
        this.chatResetButton
      ].some((button) => button && !button.hidden);
      this.chatToolRow.classList.toggle("is-collapsed", !hasVisibleActions);
    }
  }

  private renderChatFeed(): void {
    if (!this.chatFeed) {
      return;
    }

    const transcriptItems = buildAiChatTranscriptItems(
      this.aiSession?.messages ?? [],
      this.currentConfig?.ai.chat.instructions ?? ""
    );
    this.chatFeed.replaceChildren(
      ...transcriptItems.map((item) => this.createChatTranscriptElement(item))
    );
    this.chatFeed.scrollTop = this.chatFeed.scrollHeight;
  }

  private createChatTranscriptElement(item: AiChatTranscriptItem): HTMLElement {
    switch (item.type) {
      case "system-prompt":
        return this.createChatSystemPromptElement(item);
      case "compacted-range":
        return this.createChatCompactedRangeElement(item);
      case "compaction-request":
        return this.createChatCompactionEventElement(
          item.message,
          "Запрос сжатия",
          `Сжимаются ${item.meta?.affectedMessageIds.length ?? 0} сообщений`,
          item.meta?.instructionsText ?? ""
        );
      case "compaction-result":
        return this.createChatCompactionEventElement(
          item.message,
          "Результат сжатия",
          `Сжато в ${item.meta?.compactedItemCount ?? 0} элементов, сохранён хвост ${item.meta?.preservedTailCount ?? 0}`,
          item.meta?.resultPreviewText ?? ""
        );
      case "message":
      default:
        return this.createChatMessageElement(item.message, item.dimmed);
    }
  }

  private createChatSystemPromptElement(item: Extract<AiChatTranscriptItem, { type: "system-prompt" }>): HTMLElement {
    const card = this.createChatEntryShell("system-prompt", "промпт", "Системный промпт");
    const note = document.createElement("div");
    note.className = "chat-entry-note";
    note.textContent = "Текущие инструкции";

    const bodyText = document.createElement("div");
    bodyText.className = `chat-entry-content${item.isEmpty ? " is-placeholder" : ""}`;
    bodyText.textContent = item.isEmpty ? "Пусто" : item.promptText;

    card.querySelector(".chat-entry-body")?.append(note, bodyText);
    return card;
  }

  private createChatCompactedRangeElement(
    item: Extract<AiChatTranscriptItem, { type: "compacted-range" }>
  ): HTMLElement {
    const details = document.createElement("details");
    details.className = "chat-range";

    const summary = document.createElement("summary");
    summary.className = "chat-range-summary";

    const badge = document.createElement("span");
    badge.className = "chat-range-badge";
    badge.textContent = "архив";

    const title = document.createElement("span");
    title.className = "chat-range-title";
    title.textContent = `Сжатый фрагмент · ${item.messages.length} сообщений`;

    summary.append(badge, title);

    const body = document.createElement("div");
    body.className = "chat-range-body";
    body.append(...item.messages.map((message) => this.createChatMessageElement(message, true)));

    details.append(summary, body);
    return details;
  }

  private createChatCompactionEventElement(
    message: AiChatMessage,
    titleText: string,
    summaryText: string,
    bodyTextValue: string
  ): HTMLElement {
    const card = this.createChatEntryShell("compaction", "сжатие", `${titleText} • ${new Date(message.ts).toLocaleTimeString()}`);
    card.classList.add(`state-${message.state}`);

    const note = document.createElement("div");
    note.className = "chat-entry-note";
    note.textContent = summaryText;

    const bodyText = document.createElement("div");
    const text = bodyTextValue.trim();
    bodyText.className = `chat-entry-content${text ? "" : " is-placeholder"}`;
    bodyText.textContent = text || "Пусто";

    card.querySelector(".chat-entry-body")?.append(note, bodyText);
    return card;
  }

  private createChatMessageElement(message: AiChatMessage, dimmed = false): HTMLElement {
    const baseCard = this.createChatEntryShell(
      message.kind,
      formatAiEventKindLabel(message.kind),
      `${formatAiMessageOriginLabel(message.origin)} • ${new Date(message.ts).toLocaleTimeString()}`
    );
    baseCard.classList.add(`state-${message.state}`);
    if (dimmed) {
      baseCard.classList.add("is-dimmed");
    }

    const bodyText = document.createElement("div");
    bodyText.className = "chat-entry-content";
    bodyText.textContent = message.text || (message.state === "streaming" ? "…" : "");
    baseCard.querySelector(".chat-entry-body")?.append(bodyText);
    return baseCard;
  }

  private createChatEntryShell(kindClass: string, badgeText: string, metaText: string): HTMLElement {
    const card = document.createElement("article");
    card.className = `chat-entry kind-${kindClass}`;

    const header = document.createElement("div");
    header.className = "chat-entry-header";

    const badge = document.createElement("span");
    badge.className = "chat-entry-badge";
    badge.textContent = badgeText;

    const meta = document.createElement("span");
    meta.className = "chat-entry-meta";
    meta.textContent = metaText;

    const body = document.createElement("div");
    body.className = "chat-entry-body";

    header.append(badge, meta);
    card.append(header, body);
    return card;
  }

  private setActiveTab(tab: OverlayTab, focusInput = true, persist = false): void {
    this.activeTab = tab;
    if (this.currentConfig) {
      this.currentConfig = {
        ...this.currentConfig,
        ui: {
          ...this.currentConfig.ui,
          overlay: {
            ...this.currentConfig.ui.overlay,
            activeTab: tab
          }
        }
      };
    }
    this.tabButtons.forEach((button) => {
      button.classList.toggle("is-active", button.dataset.tab === tab);
    });
    this.consolePanel?.classList.toggle("is-active", tab === "console");
    this.chatPanel?.classList.toggle("is-active", tab === "chat");
    this.consoleToolRow?.classList.toggle("is-collapsed", tab === "console" && this.consoleToolRow.childElementCount === 0);

    if (persist) {
      void this.patchOverlaySessionConfig({
        activeTab: tab
      });
    }

    if (focusInput) {
      if (tab === "chat") {
        this.chatInput?.focus();
      } else {
        this.terminalInput?.focus();
      }
    }
  }

  private getCurrentPageContext(): { pageKey: string; pageUrl: string } | null {
    const pageUrl = window.location.href;
    const pageKey = normalizePageKey(pageUrl);
    if (!pageKey) {
      return null;
    }

    return {
      pageKey,
      pageUrl
    };
  }

  private requireCurrentPageContext(commandLabel: string): { pageKey: string; pageUrl: string } {
    const pageContext = this.getCurrentPageContext();
    if (!pageContext) {
      throw new Error(`${commandLabel} доступна только на обычной вкладке страницы.`);
    }

    return pageContext;
  }

  private async ensureRuntimeSnapshotLoaded(): Promise<void> {
    if (this.currentConfig && this.currentStatus) {
      return;
    }

    await this.loadSnapshot();
  }

  private cloneDefaultConfigValue(path: string): unknown {
    const defaultValue = readConfigValue(defaultConfig, path);
    return defaultValue && typeof defaultValue === "object"
      ? structuredClone(defaultValue)
      : defaultValue;
  }

  private requireEditableTerminalConfigField(path: string) {
    const descriptor = getEditableConfigField(path);
    if (!descriptor) {
      throw new Error(`Поле конфига недоступно для терминала: ${path}`);
    }
    if (descriptor.sensitive) {
      throw new Error(`Поле ${path} недоступно в консоли.`);
    }

    return descriptor;
  }

  private parseTerminalConfigValue(path: string, valueText: string): unknown {
    const descriptor = this.requireEditableTerminalConfigField(path);
    const trimmedValue = valueText.trim();

    if (
      (descriptor.valueType === "string" || descriptor.valueType === "enum") &&
      trimmedValue.startsWith("\"") &&
      trimmedValue.endsWith("\"")
    ) {
      const parsedString = JSON.parse(trimmedValue);
      if (typeof parsedString !== "string") {
        throw new Error("Строковое значение должно быть JSON-строкой.");
      }
      return descriptor.schema.parse(parsedString);
    }

    if (descriptor.valueType === "string" && trimmedValue === "\"\"") {
      return descriptor.schema.parse("");
    }

    return parseConfigFieldDraft(path, valueText);
  }

  private getAllowedModelRules(): AiAllowedModelRule[] {
    const config = this.currentConfig ?? defaultConfig;
    const value = readConfigValue(config, "ai.allowedModels");
    return normalizeAllowedModelRules(Array.isArray(value) ? value : []);
  }

  private async fetchModelCatalog(): Promise<{
    fetchedAt: string;
    models: AiModelCatalogItem[];
    warning?: string | null;
  }> {
    return AiModelCatalogResultSchema.parse(
      await sendCommand(COMMANDS.aiModelsCatalog, "overlay", "background")
    );
  }

  private findCatalogModel(
    models: readonly AiModelCatalogItem[],
    modelId: string
  ): AiModelCatalogItem | null {
    const exactMatch = models.find((item) => item.id === modelId);
    if (exactMatch) {
      return exactMatch;
    }

    const normalizedModelId = modelId.toLowerCase();
    return models.find((item) => item.id.toLowerCase() === normalizedModelId) ?? null;
  }

  private buildTerminalStatusSnapshot(): Record<string, unknown> {
    const pageContext = this.getCurrentPageContext();
    const apiKeyPresent =
      typeof this.currentConfig?.ai.openAiApiKey === "string" &&
      this.currentConfig.ai.openAiApiKey.trim().length > 0;
    const chatStatus =
      this.aiSession?.status ??
      (pageContext ? createDefaultAiStatus(pageContext.pageKey, pageContext.pageUrl, apiKeyPresent) : null);

    return {
      worker: this.currentStatus
        ? {
            running: this.currentStatus.running,
            hostConnected: this.currentStatus.hostConnected,
            bootId: this.currentStatus.bootId,
            sessionId: this.currentStatus.sessionId,
            taskId: this.currentStatus.taskId,
            startedAt: this.currentStatus.startedAt,
            lastHeartbeatAt: this.currentStatus.lastHeartbeatAt,
            reconnectAttempt: this.currentStatus.reconnectAttempt,
            nativeHostPid: this.currentStatus.nativeHostPid
          }
        : null,
      page: pageContext
        ? {
            supported: true,
            pageKey: pageContext.pageKey,
            pageUrl: pageContext.pageUrl
          }
        : {
            supported: false,
            pageUrl: window.location.href
          },
      overlay: {
        visible: this.visible,
        activeTab: this.activeTab
      },
      chat: chatStatus
        ? {
            requestState: chatStatus.requestState,
            pageKey: chatStatus.pageKey,
            pageUrlSample: chatStatus.pageUrlSample,
            activeRequestId: chatStatus.activeRequestId,
            queueCount: chatStatus.queueCount,
            lastError: chatStatus.lastError,
            availableActions: chatStatus.availableActions
          }
        : null
    };
  }

  private buildOverlayTargetPayload(target: TerminalOverlayTarget): { tabId?: number; expectedUrl?: string } {
    switch (target.type) {
      case "tab":
        return {
          tabId: target.tabId
        };
      case "url":
        return {
          expectedUrl: target.url
        };
      case "current":
      default:
        return {};
    }
  }

  private resolveChatTarget(
    target: TerminalChatTarget,
    commandLabel: string
  ): { pageKey: string; pageUrl?: string; isCurrentPage: boolean } {
    if (target.type === "current") {
      const pageContext = this.requireCurrentPageContext(commandLabel);
      return {
        pageKey: pageContext.pageKey,
        pageUrl: pageContext.pageUrl,
        isCurrentPage: true
      };
    }

    const currentPageContext = this.getCurrentPageContext();
    if (target.type === "url") {
      const pageKey = normalizePageKey(target.url);
      if (!pageKey) {
        throw new Error(`${commandLabel} требует обычный http(s) URL страницы.`);
      }
      return {
        pageKey,
        pageUrl: target.url,
        isCurrentPage: currentPageContext?.pageKey === pageKey
      };
    }

    return {
      pageKey: target.pageKey,
      pageUrl: target.pageUrl ?? undefined,
      isCurrentPage: currentPageContext?.pageKey === target.pageKey
    };
  }

  private applyAiSessionResult(session: AiChatPageSession, isCurrentPage: boolean): AiChatPageSession {
    if (isCurrentPage) {
      this.aiSession = session;
      this.renderChat();
    }
    return session;
  }

  private parseTerminalSecretValue(valueText: string, commandLabel: string): string {
    const trimmed = valueText.trim();
    if (!trimmed.length) {
      throw new Error(`${commandLabel} требует значение.`);
    }

    if (trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
      const parsedValue = JSON.parse(trimmed);
      if (typeof parsedValue !== "string") {
        throw new Error(`${commandLabel} принимает строку.`);
      }
      return parsedValue;
    }

    return valueText;
  }

  private async getAiKeyStatusResult(): Promise<Record<string, unknown>> {
    const managedKey =
      typeof this.currentConfig?.ai.openAiApiKey === "string" ? this.currentConfig.ai.openAiApiKey.trim() : "";
    const currentPageStatus = this.aiSession?.status?.apiKeyPresent ?? null;
    let sessionApiKeyPresent = currentPageStatus;

    if (sessionApiKeyPresent === null) {
      const pageContext = this.getCurrentPageContext();
      if (pageContext) {
        const response = await sendCommand<{ session: AiChatPageSession }>(
          COMMANDS.aiChatStatus,
          "overlay",
          "background",
          {
            pageKey: pageContext.pageKey,
            pageUrl: pageContext.pageUrl
          }
        );
        const session = AiChatPageSessionSchema.parse(response.session);
        sessionApiKeyPresent = session.status.apiKeyPresent;
        this.applyAiSessionResult(session, true);
      }
    }

    if (sessionApiKeyPresent === null) {
      const listResult = await sendCommand<{ sessions: AiChatPageSession[] }>(COMMANDS.aiChatList, "overlay", "background");
      sessionApiKeyPresent = listResult.sessions.some((session) => session.status.apiKeyPresent);
    }

    const mode = managedKey.length > 0 ? "managed" : sessionApiKeyPresent ? "environment" : "missing";
    return {
      mode,
      apiKeyPresent: managedKey.length > 0 || sessionApiKeyPresent === true,
      managed: managedKey.length > 0
    };
  }

  private async sendAiChatToTarget(
    target: TerminalChatTarget,
    origin: "user" | "code",
    text: string
  ): Promise<AiChatPageSession> {
    const resolvedTarget = this.resolveChatTarget(target, origin === "code" ? "chat.code" : "chat.send");
    const response = await sendCommand<{ session: AiChatPageSession }>(
      COMMANDS.aiChatSend,
      "overlay",
      "background",
      {
        pageKey: resolvedTarget.pageKey,
        pageUrl: resolvedTarget.pageUrl ?? resolvedTarget.pageKey,
        origin,
        text
      }
    );
    const session = AiChatPageSessionSchema.parse(response.session);
    return this.applyAiSessionResult(session, resolvedTarget.isCurrentPage);
  }

  private async sendAiChat(origin: "user" | "code", text: string): Promise<AiChatPageSession> {
    return this.sendAiChatToTarget({ type: "current" }, origin, text);
  }

  private async resumeAiChatSessionForTarget(target: TerminalChatTarget): Promise<AiChatPageSession> {
    const resolvedTarget = this.resolveChatTarget(target, "chat.resume");
    const response = await sendCommand<{ session: AiChatPageSession }>(
      COMMANDS.aiChatResume,
      "overlay",
      "background",
      {
        pageKey: resolvedTarget.pageKey
      }
    );
    const session = AiChatPageSessionSchema.parse(response.session);
    return this.applyAiSessionResult(session, resolvedTarget.isCurrentPage);
  }

  private async resumeAiChatSession(): Promise<AiChatPageSession> {
    return this.resumeAiChatSessionForTarget({ type: "current" });
  }

  private async resetAiChatSessionForTarget(target: TerminalChatTarget): Promise<AiChatPageSession> {
    const resolvedTarget = this.resolveChatTarget(target, "chat.reset");
    const response = await sendCommand<{ session: AiChatPageSession }>(
      COMMANDS.aiChatReset,
      "overlay",
      "background",
      {
        pageKey: resolvedTarget.pageKey
      }
    );
    const session = AiChatPageSessionSchema.parse(response.session);
    return this.applyAiSessionResult(session, resolvedTarget.isCurrentPage);
  }

  private async resetAiChatSession(): Promise<AiChatPageSession> {
    return this.resetAiChatSessionForTarget({ type: "current" });
  }

  private async refreshAiChatStatusSessionForTarget(target: TerminalChatTarget): Promise<AiChatPageSession> {
    const resolvedTarget = this.resolveChatTarget(target, "chat.status");
    const response = await sendCommand<{ session: AiChatPageSession }>(
      COMMANDS.aiChatStatus,
      "overlay",
      "background",
      {
        pageKey: resolvedTarget.pageKey,
        pageUrl: resolvedTarget.pageUrl
      }
    );
    const session = AiChatPageSessionSchema.parse(response.session);
    return this.applyAiSessionResult(session, resolvedTarget.isCurrentPage);
  }

  private async refreshAiChatStatusSession(): Promise<AiChatPageSession> {
    return this.refreshAiChatStatusSessionForTarget({ type: "current" });
  }

  private async compactAiChatSessionForTarget(
    target: TerminalChatTarget,
    mode: "safe" | "force"
  ): Promise<{
    session: AiChatPageSession;
    triggered: boolean;
    mode: "safe" | "force";
    compactionId?: string | null;
    reason?: string | null;
    affectedMessageCount?: number;
    compactedItemCount?: number;
    preservedTailCount?: number;
  }> {
    const resolvedTarget = this.resolveChatTarget(target, mode === "force" ? "chat.compact.force" : "chat.compact");
    const response = AiChatCompactResultSchema.parse(
      await sendCommand(
        COMMANDS.aiChatCompact,
        "overlay",
        "background",
        {
          pageKey: resolvedTarget.pageKey,
          pageUrl: resolvedTarget.pageUrl,
          mode
        }
      )
    );
    this.applyAiSessionResult(response.session, resolvedTarget.isCurrentPage);
    return response;
  }

  private subscribeCurrentPageToStream(): void {
    const pageContext = this.getCurrentPageContext();
    if (!pageContext) {
      return;
    }

    try {
      this.streamPort?.postMessage({
        type: "page.subscribe",
        pageKey: pageContext.pageKey,
        pageUrl: pageContext.pageUrl,
        viewId: this.pageViewId
      });
    } catch {
      // Reconnect path owns recovery.
    }
  }

  private async sendChatMessage(): Promise<void> {
    const text = this.chatInput?.value.trim() ?? "";
    if (!text) {
      this.renderChatToolRow();
      return;
    }

    try {
      this.chatInput!.value = "";
      this.renderChatToolRow();
      await this.sendAiChat("user", text);
    } catch (error) {
      this.pushConsole("error", formatUserFacingCommandError(error, "Не удалось отправить сообщение в AI-чат."));
      await recordLog("content", "chat.send.failed", "Не удалось отправить сообщение в AI-чат.", serializeLogDetails(error), "error");
    }
  }

  private openChatQueueImportPicker(): void {
    if (this.chatQueueImportInProgress || !this.chatQueueFileInput) {
      return;
    }

    this.chatQueueFileInput.value = "";
    this.chatQueueFileInput.click();
  }

  private async handleChatQueueFileSelection(): Promise<void> {
    const input = this.chatQueueFileInput;
    const file = input?.files?.[0] ?? null;
    if (!file) {
      return;
    }

    try {
      await this.importChatQueueFromFile(file);
    } catch (error) {
      const details = serializeLogDetails(error);
      this.pushConsole(
        "error",
        formatUserFacingCommandError(error, `Не удалось загрузить очередь AI-запросов из ${file.name}.`)
      );
      await recordLog(
        "content",
        "chat.queue-import.failed",
        "Не удалось загрузить очередь AI-запросов из JSON.",
        {
          fileName: file.name,
          ...((details && typeof details === "object" && !Array.isArray(details)) ? details : { error: details })
        },
        "error"
      );
    } finally {
      if (input) {
        input.value = "";
      }
    }
  }

  private async importChatQueueFromFile(file: File): Promise<void> {
    this.chatQueueImportInProgress = true;
    this.renderChatToolRow();

    let importedCount = 0;
    try {
      const pageContext = this.requireCurrentPageContext("Импорт очереди AI");
      const target: TerminalChatTarget = {
        type: "key",
        pageKey: pageContext.pageKey,
        pageUrl: pageContext.pageUrl
      };
      const parsedRequests = parseAiQueueImportJson(await file.text());
      this.pushConsole(
        "system",
        `Импорт очереди AI из ${file.name} начат: ${parsedRequests.length} ${parsedRequests.length === 1 ? "запрос" : parsedRequests.length < 5 ? "запроса" : "запросов"}.`
      );
      await recordLog(
        "content",
        "chat.queue-import.started",
        "Импорт очереди AI из JSON начат.",
        {
          fileName: file.name,
          requestCount: parsedRequests.length
        }
      );

      for (const [index, request] of parsedRequests.entries()) {
        try {
          await this.sendAiChatToTarget(target, request.origin, request.text);
          importedCount += 1;
        } catch (error) {
          throw new Error(
            `Импорт очереди остановлен на элементе ${index + 1}/${parsedRequests.length}: ${formatUserFacingCommandError(
              error,
              "Не удалось поставить AI-запрос в очередь."
            )}`
          );
        }
      }

      this.pushConsole(
        "result",
        `Очередь AI из ${file.name} загружена: ${importedCount}/${parsedRequests.length} ${parsedRequests.length === 1 ? "запрос" : parsedRequests.length < 5 ? "запроса" : "запросов"}.`
      );
      await recordLog(
        "content",
        "chat.queue-import.completed",
        "Импорт очереди AI из JSON завершён.",
        {
          fileName: file.name,
          requestCount: parsedRequests.length,
          importedCount
        }
      );
    } finally {
      this.chatQueueImportInProgress = false;
      this.renderChatToolRow();
    }
  }

  private async resumeChat(): Promise<void> {
    try {
      await this.resumeAiChatSession();
    } catch (error) {
      this.pushConsole("error", formatUserFacingCommandError(error, "Не удалось возобновить AI-чат."));
      await recordLog("content", "chat.resume.failed", "Не удалось возобновить AI-чат.", serializeLogDetails(error), "error");
    }
  }

  private async resetChat(): Promise<void> {
    try {
      await this.resetAiChatSession();
    } catch (error) {
      this.pushConsole("error", formatUserFacingCommandError(error, "Не удалось сбросить AI-чат."));
      await recordLog("content", "chat.reset.failed", "Не удалось сбросить AI-чат.", serializeLogDetails(error), "error");
    }
  }

  private renderActivityFeed(forceScrollToEnd = false): void {
    if (!this.activityFeed) {
      return;
    }

    const shouldStickToBottom = forceScrollToEnd || this.isActivityFeedPinnedToBottom();
    const feedItems = buildOverlayActivityFeed(
      this.consoleEntries,
      this.runtimeLogs,
      this.runtimeLogSequences
    ).filter((item) => item.sequence >= this.visibleActivitySequenceFloor);

    this.activityFeed.replaceChildren(
      ...feedItems.map((item) =>
        item.type === "terminal"
          ? this.createTerminalActivityElement(item.id, item.terminalKind, item.ts, item.text)
          : this.createLogActivityElement(item.logEntry)
      )
    );

    if (shouldStickToBottom) {
      this.scrollActivityFeedToEnd();
    }
  }

  private setRuntimeLogs(logs: LogEntry[]): void {
    this.runtimeLogs = logs;

    const liveIds = new Set<string>();
    for (const entry of logs) {
      liveIds.add(entry.id);
      if (!this.runtimeLogSequences.has(entry.id)) {
        this.runtimeLogSequences.set(entry.id, this.nextActivitySequence++);
      }
    }

    for (const knownId of Array.from(this.runtimeLogSequences.keys())) {
      if (!liveIds.has(knownId)) {
        this.runtimeLogSequences.delete(knownId);
      }
    }

    for (const knownId of Array.from(this.activityOpenState.keys())) {
      if (!liveIds.has(knownId)) {
        this.activityOpenState.delete(knownId);
      }
    }
  }

  private isActivityFeedPinnedToBottom(): boolean {
    if (!this.activityFeed) {
      return true;
    }

    return this.activityFeed.scrollHeight - this.activityFeed.scrollTop - this.activityFeed.clientHeight <= 24;
  }

  private scrollActivityFeedToEnd(): void {
    if (!this.activityFeed) {
      return;
    }

    this.activityFeed.scrollTop = this.activityFeed.scrollHeight;
  }

  private createTerminalActivityElement(
    entryId: string,
    kind: OverlayConsoleEntryKind,
    ts: string,
    text: string
  ): HTMLElement {
    const details = document.createElement("details");
    details.className = `activity-entry activity-terminal terminal-${kind}`;
    details.open = this.activityOpenState.get(entryId) ?? false;
    details.addEventListener("toggle", () => {
      this.activityOpenState.set(entryId, details.open);
    });

    const summaryRow = document.createElement("summary");
    summaryRow.className = "activity-terminal-summary";

    const badge = document.createElement("span");
    badge.className = "activity-kind";
    badge.textContent = this.getTerminalActivityBadgeLabel(kind);

    const title = document.createElement("span");
    title.className = "activity-title";
    title.textContent = this.getTerminalActivityTitle(kind);

    const summary = document.createElement("span");
    summary.className = "activity-summary";
    summary.textContent = text.split("\n")[0] ?? "";

    const time = document.createElement("time");
    time.className = "activity-ts";
    time.textContent = new Date(ts).toLocaleTimeString();

    const body = document.createElement("pre");
    body.className = "activity-body";
    body.textContent = text;

    summaryRow.append(badge, title, summary, time);
    details.append(summaryRow, body);
    return details;
  }

  private createLogActivityElement(entry: LogEntry): HTMLElement {
    const details = document.createElement("details");
    details.className = `activity-entry activity-log level-${entry.level}`;
    details.open = this.activityOpenState.get(entry.id) ?? false;
    details.addEventListener("toggle", () => {
      this.activityOpenState.set(entry.id, details.open);
    });

    const summary = document.createElement("summary");
    summary.className = "log-summary";

    const level = document.createElement("span");
    level.className = `log-level level-${entry.level}`;
    level.textContent = formatOverlayLogLevel(entry.level);

    const headingBlock = document.createElement("span");
    headingBlock.className = "log-heading-block";

    const heading = document.createElement("span");
    heading.className = "log-heading";
    heading.textContent = `${entry.source} :: ${entry.summary}`;
    headingBlock.append(heading);

    const ts = document.createElement("time");
    ts.className = "log-ts";
    ts.textContent = new Date(entry.ts).toLocaleTimeString();

    summary.append(level, headingBlock, ts);

    const meta = document.createElement("div");
    meta.className = "log-meta";
    meta.textContent = `${entry.event}${entry.correlationId ? ` • ${entry.correlationId}` : ""}`;

    const body = document.createElement("pre");
    body.className = "log-body";
    body.textContent = serializeLogDetails(entry.details) || "Подробности отсутствуют";

    details.append(summary, meta, body);
    return details;
  }

  private getTerminalActivityBadgeLabel(kind: OverlayConsoleEntryKind): string {
    switch (kind) {
      case "command":
        return "КОМ";
      case "result":
        return "ОК";
      case "error":
        return "ОШ";
      case "system":
      default:
        return "СИС";
    }
  }

  private getTerminalActivityTitle(kind: OverlayConsoleEntryKind): string {
    switch (kind) {
      case "command":
        return "Команда терминала";
      case "result":
        return "Ответ терминала";
      case "error":
        return "Ошибка терминала";
      case "system":
      default:
        return "Событие оверлея";
    }
  }

  private refreshTerminalSuggestions(): void {
    const rawInput = this.terminalInput?.value ?? "";
    if (!rawInput.trim()) {
      this.closeTerminalSuggestions();
      return;
    }

    this.currentSuggestions = getTerminalSuggestions(rawInput, 6, this.getTerminalCatalogOptions());
    this.selectedSuggestionIndex = this.currentSuggestions.length > 0 ? 0 : -1;
    this.renderTerminalSuggestions();
  }

  private renderTerminalSuggestions(): void {
    if (!this.terminalSuggestionList) {
      return;
    }

    this.terminalSuggestionList.replaceChildren(
      ...this.currentSuggestions.map((suggestion, index) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "terminal-suggestion-item";
        button.dataset.suggestionIndex = String(index);
        button.classList.toggle("is-selected", index === this.selectedSuggestionIndex);
        button.textContent = suggestion;
        button.addEventListener("pointerdown", (event) => {
          event.preventDefault();
        });
        button.addEventListener("click", () => {
          this.applyTerminalSuggestion(index);
        });
        return button;
      })
    );

    this.terminalSuggestionList.classList.toggle("is-hidden", this.currentSuggestions.length === 0);
  }

  private closeTerminalSuggestions(): void {
    this.currentSuggestions = [];
    this.selectedSuggestionIndex = -1;
    this.renderTerminalSuggestions();
  }

  private handleTerminalInputKeydown(event: KeyboardEvent): boolean {
    if (event.key === "ArrowDown") {
      if (this.currentSuggestions.length === 0) {
        this.refreshTerminalSuggestions();
      }
      if (this.currentSuggestions.length > 0) {
        event.preventDefault();
        event.stopImmediatePropagation();
        event.stopPropagation();
        this.selectedSuggestionIndex =
          (this.selectedSuggestionIndex + 1 + this.currentSuggestions.length) % this.currentSuggestions.length;
        this.renderTerminalSuggestions();
      }
      return true;
    }

    if (event.key === "ArrowUp") {
      if (this.currentSuggestions.length > 0) {
        event.preventDefault();
        event.stopImmediatePropagation();
        event.stopPropagation();
        this.selectedSuggestionIndex =
          (this.selectedSuggestionIndex - 1 + this.currentSuggestions.length) % this.currentSuggestions.length;
        this.renderTerminalSuggestions();
      }
      return true;
    }

    if (event.key === "Escape" && this.currentSuggestions.length > 0) {
      event.preventDefault();
      event.stopImmediatePropagation();
      event.stopPropagation();
      this.closeTerminalSuggestions();
      return true;
    }

    if ((event.key === "Tab" || event.key === "Enter") && this.shouldApplySelectedSuggestion()) {
      event.preventDefault();
      event.stopImmediatePropagation();
      event.stopPropagation();
      this.applyTerminalSuggestion(this.selectedSuggestionIndex);
      return true;
    }

    return false;
  }

  private shouldApplySelectedSuggestion(): boolean {
    if (this.selectedSuggestionIndex < 0 || this.selectedSuggestionIndex >= this.currentSuggestions.length) {
      return false;
    }

    const currentValue = this.terminalInput?.value.trim() ?? "";
    if (!currentValue) {
      return false;
    }

    const selectedSuggestion = this.currentSuggestions[this.selectedSuggestionIndex];
    return currentValue !== selectedSuggestion;
  }

  private applyTerminalSuggestion(index: number): void {
    const suggestion = this.currentSuggestions[index];
    if (!suggestion || !this.terminalInput) {
      return;
    }

    this.terminalInput.value = suggestion;
    this.terminalInput.focus();
    this.terminalInput.setSelectionRange(suggestion.length, suggestion.length);
    this.closeTerminalSuggestions();
  }

  private formatTerminalOutput(output: unknown): string {
    if (typeof output === "string") {
      return output;
    }

    const serialized = JSON.stringify(output, null, 2);
    if (typeof serialized === "string") {
      return serialized;
    }

    return String(output);
  }

  private async applyTerminalPostAction(
    postAction: TerminalExecutionResult["postAction"] | undefined
  ): Promise<void> {
    if (!postAction) {
      return;
    }

    if (postAction.type === "close-overlay") {
      await this.close();
      return;
    }

    this.setActiveTab(postAction.tab, true, false);
  }

  private async applyConfigValueCommand(path: string, value: unknown): Promise<TerminalExecutionResult> {
    const descriptor = this.requireEditableTerminalConfigField(path);

    if (path === "ui.overlay.visible" && value === false) {
      return {
        output: {
          path,
          scope: descriptor.scope,
          value,
          hidden: true
        },
        logDetails: {
          path,
          scope: descriptor.scope,
          value
        },
        postAction: {
          type: "close-overlay"
        }
      };
    }

    await this.sendConfigPatch(descriptor.scope, buildConfigPatchFromPath(path, value));
    return {
      output: {
        path,
        scope: descriptor.scope,
        value
      },
      logDetails: {
        path,
        scope: descriptor.scope,
        value
      },
      postAction:
        path === "ui.overlay.activeTab"
          ? {
              type: "switch-overlay-tab",
              tab: value as OverlayTab
            }
          : undefined
    };
  }

  private async resetConfigFieldCommand(path: string): Promise<TerminalExecutionResult> {
    const defaultValue = this.cloneDefaultConfigValue(path);
    return this.applyConfigValueCommand(path, defaultValue);
  }

  private async executeLocalTerminalCommand(
    parsed: Extract<ParsedTerminalCommand, { kind: "local" }>
  ): Promise<TerminalExecutionResult | null> {
    if (parsed.action === "clear") {
      this.consoleEntries = [];
      this.activityOpenState.clear();
      this.visibleActivitySequenceFloor = this.nextActivitySequence;
      this.renderActivityFeed(true);
      return null;
    }

    if (parsed.action === "help") {
      return {
        output: getTerminalHelpLines(this.getTerminalCatalogOptions(), parsed.topic).join("\n")
      };
    }

    await this.ensureRuntimeSnapshotLoaded();
    return {
      output: this.buildTerminalStatusSnapshot()
    };
  }

  private async executeAliasCommand(
    parsed: Extract<ParsedTerminalCommand, { kind: "alias" }>
  ): Promise<TerminalExecutionResult> {
    await this.ensureRuntimeSnapshotLoaded();

    switch (parsed.namespace) {
      case "config":
        switch (parsed.action) {
          case "paths":
            return {
              output: {
                prefix: parsed.prefix,
                paths: getEditableConfigPaths({
                  prefix: parsed.prefix ?? undefined,
                  includeSensitive: false
                })
              },
              logDetails: {
                prefix: parsed.prefix
              }
            };
          case "get":
            if (!parsed.path) {
              return {
                output: omitSensitiveConfigData(structuredClone(this.currentConfig ?? defaultConfig))
              };
            }

            return {
              output: {
                path: parsed.path,
                scope: this.requireEditableTerminalConfigField(parsed.path).scope,
                value: readConfigValue(this.currentConfig ?? defaultConfig, parsed.path)
              },
              logDetails: {
                path: parsed.path
              }
            };
          case "set":
            return this.applyConfigValueCommand(parsed.path, this.parseTerminalConfigValue(parsed.path, parsed.valueText));
          case "reset-field":
            return this.resetConfigFieldCommand(parsed.path);
          case "reset": {
            const snapshot = await this.sendConfigReset(parsed.scope);
            const sanitizedConfig = omitSensitiveConfigData(structuredClone(snapshot.config));
            return {
              output: {
                scope: parsed.scope,
                config: sanitizedConfig,
                workerStatus: snapshot.workerStatus,
                logCount: snapshot.logs.length
              },
              logDetails: {
                scope: parsed.scope
              },
              postAction:
                parsed.scope === "session" && snapshot.config.ui.overlay.visible === false
                  ? {
                      type: "close-overlay"
                    }
                  : undefined
            };
          }
        }
        break;
      case "ai-key":
        switch (parsed.action) {
          case "status":
            return {
              output: await this.getAiKeyStatusResult()
            };
          case "set": {
            const nextValue = this.parseTerminalSecretValue(parsed.valueText, "ai.key.set");
            await this.sendConfigPatch("local", buildConfigPatchFromPath("ai.openAiApiKey", nextValue));
            return {
              output: {
                mode: "managed",
                apiKeyPresent: nextValue.trim().length > 0
              },
              logDetails: {
                path: "ai.openAiApiKey",
                action: "set",
                redacted: true
              }
            };
          }
          case "clear":
            await this.sendConfigPatch("local", buildConfigPatchFromPath("ai.openAiApiKey", ""));
            return {
              output: {
                mode: "missing",
                apiKeyPresent: false
              },
              logDetails: {
                path: "ai.openAiApiKey",
                action: "clear",
                redacted: true
              }
            };
          case "unmanage":
            await this.sendConfigPatch("local", buildConfigPatchFromPath("ai.openAiApiKey", null));
            return {
              output: {
                mode: "environment",
                managed: false
              },
              logDetails: {
                path: "ai.openAiApiKey",
                action: "unmanage",
                redacted: true
              }
            };
        }
        break;
      case "chat":
        switch (parsed.action) {
          case "status":
            return {
              output: {
                session: await this.refreshAiChatStatusSessionForTarget(parsed.target)
              }
            };
          case "send":
            return {
              output: {
                session: await this.sendAiChatToTarget(parsed.target, "user", parsed.text)
              },
              logDetails: {
                target: parsed.target,
                origin: "user",
                text: parsed.text
              }
            };
          case "code":
            return {
              output: {
                session: await this.sendAiChatToTarget(parsed.target, "code", parsed.text)
              },
              logDetails: {
                target: parsed.target,
                origin: "code",
                text: parsed.text
              }
            };
          case "resume":
            return {
              output: {
                session: await this.resumeAiChatSessionForTarget(parsed.target)
              }
            };
          case "reset":
            return {
              output: {
                session: await this.resetAiChatSessionForTarget(parsed.target)
              }
            };
          case "list":
            return {
              output: await sendCommand(COMMANDS.aiChatList, "overlay", "background")
            };
          case "compact":
            return {
              output: await this.compactAiChatSessionForTarget(parsed.target, parsed.mode),
              logDetails: {
                target: parsed.target,
                mode: parsed.mode
              }
            };
        }
        break;
      case "models":
        switch (parsed.action) {
          case "list":
            return {
              output: await this.fetchModelCatalog()
            };
          case "allow-list":
            return {
              output: {
                allowedModels: this.getAllowedModelRules()
              }
            };
          case "allow-clear": {
            const nextRules: AiAllowedModelRule[] = [];
            await this.sendConfigPatch("local", buildConfigPatchFromPath("ai.allowedModels", nextRules));
            return {
              output: {
                allowedModels: nextRules
              },
              logDetails: {
                path: "ai.allowedModels",
                value: nextRules
              }
            };
          }
          case "allow-add": {
            const catalog = await this.fetchModelCatalog();
            const catalogModel = this.findCatalogModel(catalog.models, parsed.model);
            if (!catalogModel) {
              throw new Error(`Модель ${parsed.model} не найдена в каталоге.`);
            }
            if (!isAiModelTierAvailable(catalogModel, parsed.tier)) {
              throw new Error(`Модель ${catalogModel.id} недоступна в тарифе ${parsed.tier}.`);
            }

            const nextRules = normalizeAllowedModelRules([
              ...this.getAllowedModelRules(),
              {
                model: catalogModel.id,
                tier: parsed.tier
              }
            ]);
            await this.sendConfigPatch("local", buildConfigPatchFromPath("ai.allowedModels", nextRules));
            return {
              output: {
                allowedModels: nextRules
              },
              logDetails: {
                path: "ai.allowedModels",
                value: nextRules
              }
            };
          }
          case "allow-remove": {
            const targetModel = parsed.model.toLowerCase();
            const nextRules = this.getAllowedModelRules().filter(
              (rule) => !(rule.model.toLowerCase() === targetModel && rule.tier === parsed.tier)
            );
            await this.sendConfigPatch("local", buildConfigPatchFromPath("ai.allowedModels", nextRules));
            return {
              output: {
                allowedModels: nextRules
              },
              logDetails: {
                path: "ai.allowedModels",
                value: nextRules
              }
            };
          }
          case "select": {
            const catalog = await this.fetchModelCatalog();
            const catalogModel = this.findCatalogModel(catalog.models, parsed.model);
            if (!catalogModel) {
              throw new Error(`Модель ${parsed.model} не найдена в каталоге.`);
            }
            if (!isAiModelTierAvailable(catalogModel, parsed.tier)) {
              throw new Error(`Модель ${catalogModel.id} недоступна в тарифе ${parsed.tier}.`);
            }

            const nextSelection = {
              model: catalogModel.id,
              tier: parsed.tier as AiServiceTier
            };
            const isAllowed = this.getAllowedModelRules().some(
              (rule) => rule.model === nextSelection.model && rule.tier === nextSelection.tier
            );
            if (!isAllowed) {
              throw new Error("Сначала добавьте модель через models.allow add.");
            }

            const path = parsed.target === "chat" ? "ai.chat.model" : "ai.compaction.modelOverride";
            return this.applyConfigValueCommand(path, nextSelection);
          }
        }
        break;
      case "logs":
        switch (parsed.action) {
          case "tail":
            return {
              output: await sendCommand(COMMANDS.logList, "overlay", "background", {
                limit: parsed.limit
              }),
              logDetails: {
                limit: parsed.limit
              }
            };
          case "subscribe":
            return {
              output: await sendCommand(COMMANDS.logSubscribe, "overlay", "background", {
                since: parsed.since
              }),
              logDetails: {
                since: parsed.since
              }
            };
          case "note":
            return {
              output: await sendCommand(COMMANDS.logRecord, "overlay", "background", {
                level: "info",
                source: "overlay",
                event: "manual.note",
                summary: parsed.summary
              }),
              logDetails: {
                summary: parsed.summary
              }
            };
        }
        break;
      case "overlay":
        switch (parsed.action) {
          case "probe":
            return {
              output: await sendCommand(COMMANDS.overlayProbe, "overlay", "background", this.buildOverlayTargetPayload(parsed.target)),
              logDetails: this.buildOverlayTargetPayload(parsed.target)
            };
          case "open":
            return {
              output: await sendCommand(COMMANDS.overlayOpen, "overlay", "background", this.buildOverlayTargetPayload(parsed.target)),
              logDetails: this.buildOverlayTargetPayload(parsed.target)
            };
          case "close":
            if (parsed.target.type === "current") {
              return {
                output: {
                  closed: true,
                  current: true
                },
                postAction: {
                  type: "close-overlay"
                }
              };
            }
            return {
              output: await sendCommand(COMMANDS.overlayClose, "overlay", "background", this.buildOverlayTargetPayload(parsed.target)),
              logDetails: this.buildOverlayTargetPayload(parsed.target)
            };
          case "tab":
            return this.applyConfigValueCommand("ui.overlay.activeTab", parsed.tab);
          case "hide":
            return {
              output: {
                hidden: true
              },
              postAction: {
                type: "close-overlay"
              }
            };
        }
        break;
      case "popup":
        switch (parsed.action) {
          case "tab":
            return this.applyConfigValueCommand("ui.popupActiveTab", parsed.tab as PopupTab);
        }
        break;
      case "host":
        switch (parsed.action) {
          case "connect":
            return { output: await sendCommand(COMMANDS.hostConnect, "overlay", "background") };
          case "disconnect":
            return { output: await sendCommand(COMMANDS.hostDisconnect, "overlay", "background") };
          case "status":
            return { output: await sendCommand(COMMANDS.hostStatus, "overlay", "background") };
          case "restart":
            return { output: await sendCommand(COMMANDS.hostRestart, "overlay", "background") };
          case "crash":
            return { output: await sendCommand(COMMANDS.testHostCrash, "overlay", "background") };
        }
        break;
      case "worker":
        switch (parsed.action) {
          case "start":
            return { output: await sendCommand(COMMANDS.workerStart, "overlay", "background") };
          case "stop":
            return { output: await sendCommand(COMMANDS.workerStop, "overlay", "background") };
          case "status":
            return { output: await sendCommand(COMMANDS.workerStatus, "overlay", "background") };
        }
        break;
      case "demo":
        switch (parsed.action) {
          case "start":
            return {
              output: await sendCommand(
                COMMANDS.taskDemoStart,
                "overlay",
                "background",
                parsed.taskId ? { taskId: parsed.taskId } : undefined
              ),
              logDetails: {
                taskId: parsed.taskId
              }
            };
          case "stop":
            return {
              output: await sendCommand(COMMANDS.taskDemoStop, "overlay", "background")
            };
        }
        break;
    }

    throw new Error("Неподдерживаемая alias-команда.");
  }

  private async executeCommand(): Promise<void> {
    const rawInput = this.terminalInput?.value ?? "";
    this.terminalInput?.focus();
    this.terminalInput!.value = "";
    this.closeTerminalSuggestions();

    try {
      const parsed = parseTerminalCommand(rawInput);
      if (!parsed) {
        return;
      }

      this.pushConsole("command", `NT3> ${parsed.raw}`);

      let result: TerminalExecutionResult | null;
      if (parsed.kind === "local") {
        result = await this.executeLocalTerminalCommand(parsed);
      } else if (parsed.kind === "alias") {
        result = await this.executeAliasCommand(parsed);
      } else {
        result = {
          output: await sendCommand(parsed.action, "overlay", "background", parsed.payload),
          logDetails: parsed.payload
        };
      }

      if (!result) {
        return;
      }

      this.pushConsole("result", this.formatTerminalOutput(result.output));
      await recordLog(
        "content",
        "overlay.command",
        `Выполнена команда ${parsed.raw}.`,
        result.logDetails ?? (parsed.kind === "protocol" ? parsed.payload : { raw: parsed.raw })
      );
      await this.applyTerminalPostAction(result.postAction);
    } catch (error) {
      this.pushConsole(
        "error",
        formatUserFacingCommandError(error, "Не удалось выполнить команду терминала.")
      );
      await recordLog(
        "content",
        "overlay.command.failed",
        "Не удалось выполнить команду оверлейного терминала.",
        { message: error instanceof Error ? error.message : String(error) },
        "error"
      );
    }
  }

  private pushConsole(kind: OverlayConsoleEntryKind, text: string): void {
    this.consoleEntries = [
      ...this.consoleEntries.slice(-199),
      {
        id: crypto.randomUUID(),
        ts: new Date().toISOString(),
        kind,
        text,
        sequence: this.nextActivitySequence++
      }
    ];
    this.renderActivityFeed(true);
  }

  private applyRuntimeCommandResult(result: RuntimeSnapshotResponse): RuntimeSnapshotResponse {
    const parsedConfig = ExtensionConfigSchema.parse(result.config);
    const parsedLogs = result.logs.map((entry) => LogEntrySchema.parse(entry));
    this.currentConfig = parsedConfig;
    this.currentStatus = parseRuntimeWorkerStatus(result);
    this.setRuntimeLogs(parsedLogs);
    this.applyGeometry(parsedConfig);
    this.render(true);
    return {
      config: parsedConfig,
      workerStatus: this.currentStatus,
      logs: parsedLogs
    };
  }

  private async sendConfigPatch(scope: "local" | "session", patch: ExtensionConfigPatch): Promise<RuntimeSnapshotResponse> {
    const result = await sendCommand<RuntimeSnapshotResponse>(COMMANDS.configPatch, "content", "background", {
      scope,
      patch
    });
    return this.applyRuntimeCommandResult(result);
  }

  private async sendConfigReset(scope: "local" | "session"): Promise<RuntimeSnapshotResponse> {
    const result = await sendCommand<RuntimeSnapshotResponse>(COMMANDS.configReset, "content", "background", {
      scope
    });
    return this.applyRuntimeCommandResult(result);
  }

  private async patchOverlaySessionConfig(patch: Partial<ExtensionConfig["ui"]["overlay"]>): Promise<void> {
    try {
      await this.sendConfigPatch("session", {
        ui: {
          overlay: patch
        }
      });
    } catch {
      // Ignore config patch failures during teardown paths.
    }
  }

  private async patchOverlayLocalConfig(patch: Partial<ExtensionConfig["ui"]["overlay"]>): Promise<void> {
    try {
      await this.sendConfigPatch("local", {
        ui: {
          overlay: patch
        }
      });
    } catch {
      // Ignore drag persistence failures. The window already moved locally.
    }
  }

  private applyGeometry(config: ExtensionConfig): void {
    if (!this.panelWindow) {
      return;
    }

    this.panelWindow.style.width = `${config.ui.overlay.width}px`;
    this.panelWindow.style.height = `${config.ui.overlay.height}px`;
    this.panelWindow.style.left = `${config.ui.overlay.left}px`;
    this.panelWindow.style.top = `${config.ui.overlay.top}px`;
  }

  private getTerminalCatalogOptions(): TerminalCatalogOptions {
    return {
      testCommandsEnabled: this.currentConfig?.protocol.testCommandsEnabled ?? true,
      allowHostCrashCommand: this.currentConfig?.test.allowHostCrashCommand ?? true
    };
  }

  private centerPanelInViewport(): void {
    if (!this.panelWindow) {
      return;
    }

    const panelWidth = this.panelWindow.offsetWidth || this.currentConfig?.ui.overlay.width || 0;
    const panelHeight = this.panelWindow.offsetHeight || this.currentConfig?.ui.overlay.height || 0;
    const centeredLeft = this.clampLeft(Math.round((window.innerWidth - panelWidth) / 2));
    const centeredTop = this.clampTop(Math.round((window.innerHeight - panelHeight) / 2));

    this.applyLocalPosition(centeredLeft, centeredTop);
  }

  private beginDrag(event: PointerEvent): void {
    if (!this.visible || !this.panelWindow || !this.panelHeader) {
      return;
    }

    if (event.button !== 0 || this.isInteractiveElement(event.target)) {
      return;
    }

    const { left, top } = this.readCurrentPosition();
    this.dragState = {
      pointerId: event.pointerId,
      originX: event.clientX,
      originY: event.clientY,
      startLeft: left,
      startTop: top,
      moved: false
    };

    this.panelHeader.setPointerCapture(event.pointerId);
    this.panelWindow.focus();
    event.preventDefault();
    event.stopPropagation();
  }

  private updateDrag(event: PointerEvent): void {
    if (!this.dragState || !this.panelWindow || event.pointerId !== this.dragState.pointerId) {
      return;
    }

    const deltaX = event.clientX - this.dragState.originX;
    const deltaY = event.clientY - this.dragState.originY;
    const nextLeft = this.clampLeft(this.dragState.startLeft + deltaX);
    const nextTop = this.clampTop(this.dragState.startTop + deltaY);

    this.dragState.moved = this.dragState.moved || deltaX !== 0 || deltaY !== 0;
    this.applyLocalPosition(nextLeft, nextTop);
    event.preventDefault();
    event.stopPropagation();
  }

  private async endDrag(event: PointerEvent): Promise<void> {
    if (!this.dragState || event.pointerId !== this.dragState.pointerId || !this.panelHeader) {
      return;
    }

    const finishedState = this.dragState;
    this.dragState = null;

    if (this.panelHeader.hasPointerCapture(event.pointerId)) {
      this.panelHeader.releasePointerCapture(event.pointerId);
    }

    event.preventDefault();
    event.stopPropagation();

    if (!finishedState.moved) {
      return;
    }

    const { left, top } = this.readCurrentPosition();
    await this.patchOverlayLocalConfig({
      left,
      top
    });
    await recordLog("content", "overlay.drag", "Оверлейный терминал перемещён.", {
      left,
      top
    });
  }

  private applyLocalPosition(left: number, top: number): void {
    if (!this.panelWindow) {
      return;
    }

    this.panelWindow.style.left = `${left}px`;
    this.panelWindow.style.top = `${top}px`;

    if (this.currentConfig) {
      this.currentConfig = {
        ...this.currentConfig,
        ui: {
          ...this.currentConfig.ui,
          overlay: {
            ...this.currentConfig.ui.overlay,
            left,
            top
          }
        }
      };
    }
  }

  private readCurrentPosition(): { left: number; top: number } {
    const fallbackLeft = this.currentConfig?.ui.overlay.left ?? 32;
    const fallbackTop = this.currentConfig?.ui.overlay.top ?? 32;

    if (!this.panelWindow) {
      return {
        left: fallbackLeft,
        top: fallbackTop
      };
    }

    const parsedLeft = Number.parseInt(this.panelWindow.style.left || "", 10);
    const parsedTop = Number.parseInt(this.panelWindow.style.top || "", 10);

    return {
      left: Number.isFinite(parsedLeft) ? parsedLeft : fallbackLeft,
      top: Number.isFinite(parsedTop) ? parsedTop : fallbackTop
    };
  }

  private clampLeft(candidateLeft: number): number {
    const panelWidth = this.panelWindow?.offsetWidth ?? this.currentConfig?.ui.overlay.width ?? 0;
    return Math.min(Math.max(0, candidateLeft), Math.max(0, window.innerWidth - panelWidth));
  }

  private clampTop(candidateTop: number): number {
    const panelHeight = this.panelWindow?.offsetHeight ?? this.currentConfig?.ui.overlay.height ?? 0;
    return Math.min(Math.max(0, candidateTop), Math.max(0, window.innerHeight - panelHeight));
  }

  private readonly handleCapturedKeyboardEvent = (event: KeyboardEvent): void => {
    if (!this.shouldCaptureKeyboardEvent(event)) {
      return;
    }

    if (event.composedPath()[0] === this.terminalInput && this.handleTerminalInputKeydown(event)) {
      return;
    }

    if (event.type === "keydown" && event.key === "Tab") {
      event.preventDefault();
      event.stopImmediatePropagation();
      event.stopPropagation();
      this.moveOverlayFocus(event.shiftKey ? -1 : 1);
      return;
    }

    event.stopImmediatePropagation();
    event.stopPropagation();

    if (!this.isTypingElement(event.composedPath()[0])) {
      event.preventDefault();
    }
  };

  private shouldCaptureKeyboardEvent(event: KeyboardEvent): boolean {
    if (!this.visible) {
      return false;
    }

    return this.isEventInsideOverlay(event) || this.isOverlayFocusActive();
  }

  private readonly handleOverlayPointerEvent = (event: Event): void => {
    if (!this.visible || !this.isEventInsideOverlay(event)) {
      return;
    }

    event.stopPropagation();
  };

  private readonly handleOverlayWheelEvent = (event: WheelEvent): void => {
    if (!this.visible || !this.isEventInsideOverlay(event)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const scrollContainer = this.findScrollableOverlayAncestor(event.composedPath()[0]);
    if (!scrollContainer) {
      return;
    }

    scrollContainer.scrollTop += event.deltaY;
  };

  private isEventInsideOverlay(event: Event): boolean {
    if (!this.visible) {
      return false;
    }

    return event.composedPath().some((candidate) => this.isOverlayCandidate(candidate));
  }

  private isOverlayFocusActive(): boolean {
    if (!this.visible) {
      return false;
    }

    if (this.shadowRoot?.activeElement) {
      return true;
    }

    if (this.panelWindow?.matches(":focus-within")) {
      return true;
    }

    return document.activeElement === this.panelWindow;
  }

  private focusPreferredOverlayElement(): void {
    if (this.activeTab === "chat") {
      this.chatInput?.focus();
    } else {
      this.terminalInput?.focus();
    }
    if (this.shadowRoot?.activeElement || this.panelWindow?.matches(":focus-within")) {
      return;
    }

    this.panelWindow?.focus();
  }

  private moveOverlayFocus(direction: -1 | 1): void {
    const focusableElements = this.getOverlayFocusableElements();
    if (focusableElements.length === 0) {
      this.focusPreferredOverlayElement();
      return;
    }

    const activeElement = this.shadowRoot?.activeElement;
    const currentIndex = activeElement ? focusableElements.indexOf(activeElement as HTMLElement) : -1;
    const nextIndex =
      currentIndex === -1
        ? direction > 0
          ? 0
          : focusableElements.length - 1
        : (currentIndex + direction + focusableElements.length) % focusableElements.length;

    focusableElements[nextIndex]?.focus();
  }

  private getOverlayFocusableElements(): HTMLElement[] {
    if (!this.shadowRoot) {
      return [];
    }

    return Array.from(
      this.shadowRoot.querySelectorAll<HTMLElement>(
        'button, input, select, textarea, summary, [tabindex]:not([tabindex="-1"])'
      )
    ).filter((element) => {
      if (element.hasAttribute("disabled")) {
        return false;
      }

      if (element.tabIndex < 0) {
        return false;
      }

      return element.offsetParent !== null || element === this.panelWindow;
    });
  }

  private isOverlayCandidate(candidate: EventTarget | null | undefined): boolean {
    if (!candidate) {
      return false;
    }

    if (candidate === this.host) {
      return true;
    }

    return candidate instanceof Node && !!this.shadowRoot?.contains(candidate);
  }

  private isElementInsideOverlay(candidate: EventTarget | null | undefined): boolean {
    return this.isOverlayCandidate(candidate);
  }

  private findScrollableOverlayAncestor(candidate: EventTarget | null | undefined): HTMLElement | null {
    if (!(candidate instanceof Element)) {
      return null;
    }

    const scrollContainer = candidate.closest<HTMLElement>(".activity-feed, .chat-feed");
    if (scrollContainer) {
      return scrollContainer;
    }

    const nestedScrollable = candidate.closest<HTMLElement>(".log-body, .activity-body");
    if (nestedScrollable) {
      return nestedScrollable;
    }

    return this.activityFeed;
  }

  private isTypingElement(candidate: EventTarget | null | undefined): boolean {
    if (!(candidate instanceof HTMLElement)) {
      return false;
    }

    return (
      candidate instanceof HTMLInputElement ||
      candidate instanceof HTMLTextAreaElement ||
      candidate instanceof HTMLSelectElement ||
      candidate.isContentEditable
    );
  }

  private isInteractiveElement(candidate: EventTarget | null | undefined): boolean {
    if (!(candidate instanceof Element)) {
      return false;
    }

    return !!candidate.closest("button, input, select, textarea, a, summary");
  }
}

const contentGlobals = globalThis as typeof globalThis & {
  __lextraceNt3ContentBootstrapped?: boolean;
  __lextraceNt3OverlayController?: OverlayTerminalController;
};

if (!contentGlobals.__lextraceNt3ContentBootstrapped) {
  contentGlobals.__lextraceNt3OverlayController = new OverlayTerminalController();
  contentGlobals.__lextraceNt3ContentBootstrapped = true;
  void recordLog("content", "content.bootstrap", "Контент-скрипт инициализирован.");
}

function formatOverlayLogLevel(level: LogEntry["level"]): string {
  switch (level) {
    case "debug":
      return "отладка";
    case "info":
      return "инфо";
    case "warn":
      return "предупр.";
    case "error":
    default:
      return "ошибка";
  }
}

const overlayStyles = `
  :host {
    all: initial;
    --scroll-track: #dadada;
    --scroll-thumb: #111111;
    --scroll-thumb-hover: #303030;
    --scroll-thumb-active: #000000;
    --scroll-size: 12px;
  }

  * {
    box-sizing: border-box;
    scrollbar-width: thin;
    scrollbar-color: var(--scroll-thumb) var(--scroll-track);
  }

  *::-webkit-scrollbar {
    width: var(--scroll-size);
    height: var(--scroll-size);
  }

  *::-webkit-scrollbar-track {
    background: var(--scroll-track);
    border-left: 1px solid #111111;
  }

  *::-webkit-scrollbar-thumb {
    background: var(--scroll-thumb);
    border: 1px solid #ffffff;
    border-radius: 0;
  }

  *::-webkit-scrollbar-thumb:hover {
    background: var(--scroll-thumb-hover);
  }

  *::-webkit-scrollbar-thumb:active {
    background: var(--scroll-thumb-active);
  }

  *::-webkit-scrollbar-button {
    display: none;
  }

  *::-webkit-scrollbar-corner {
    background: var(--scroll-track);
  }

  .overlay-window {
    position: fixed;
    inset: 0;
    pointer-events: none;
    font-family: "Bahnschrift", "Segoe UI Variable Text", "Segoe UI", sans-serif;
    color: #111111;
  }

  .panel-shell {
    position: fixed;
    pointer-events: auto;
    border: 1px solid #111111;
    background: rgba(238, 238, 238, 0.98);
    display: grid;
    grid-template-rows: auto auto 1fr;
    gap: 0;
    overflow: hidden;
    overscroll-behavior: contain;
  }

  .panel-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 0;
    padding: 10px 12px;
    border-bottom: 1px solid #111111;
    background: #f3f3f3;
    cursor: move;
    user-select: none;
    touch-action: none;
  }

  .panel-header h1,
  .panel-kicker {
    margin: 0;
  }

  .panel-kicker {
    font-size: 11px;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: #5b5b5b;
  }

  .panel-header h1 {
    font-size: 28px;
    line-height: 1;
    font-weight: 600;
    letter-spacing: 0.04em;
  }

  .close-button {
    appearance: none;
    border: 0;
    color: #111111;
    font: inherit;
    cursor: pointer;
  }

  .close-button {
    min-height: 34px;
    padding: 0 12px;
    border-left: 1px solid #111111;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    font-size: 12px;
    background: transparent;
    cursor: pointer;
  }

  .overlay-tab-strip {
    display: flex;
    gap: 0;
    border-bottom: 1px solid #111111;
    background: #ffffff;
  }

  .overlay-tab-button {
    appearance: none;
    border: 0;
    border-right: 1px solid #111111;
    background: #ffffff;
    color: #111111;
    min-height: 36px;
    padding: 0 14px;
    font: inherit;
    font-size: 12px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    cursor: pointer;
  }

  .overlay-tab-button.is-active {
    background: #111111;
    color: #ffffff;
  }

  .tab-surface {
    display: none;
    min-height: 0;
    grid-template-rows: auto auto 1fr;
  }

  .tab-surface.is-active {
    display: grid;
  }

  .tab-surface.chat-surface {
    grid-template-rows: auto 1fr;
  }

  .status-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 0;
    border-bottom: 1px solid #111111;
    background: #ffffff;
  }

  .status-chip-list {
    display: grid;
    min-width: 0;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 108px), 1fr));
    gap: 0;
  }

  .status-row-actions {
    display: flex;
    align-items: stretch;
    min-height: 100%;
    border-left: 1px solid #111111;
    background: #fafafa;
  }

  .tool-row {
    display: flex;
    align-items: center;
    gap: 0;
    min-height: 32px;
    border-bottom: 1px solid #111111;
    background: #fafafa;
  }

  .tool-row.is-collapsed {
    min-height: 0;
    height: 0;
    border-bottom: 0;
    overflow: hidden;
    pointer-events: none;
  }

  .status-chip {
    position: relative;
    display: inline-flex;
    width: 100%;
    box-sizing: border-box;
    align-items: center;
    gap: 5px;
    min-width: 0;
    max-width: 100%;
    min-height: 24px;
    border-right: 1px solid #111111;
    padding: 3px 5px;
    background: #ffffff;
    color: #111111;
    font-size: 10px;
    letter-spacing: 0.03em;
    line-height: 1;
    cursor: default;
    transition: background 120ms ease, color 120ms ease;
  }

  .status-chip-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 12px;
    height: 12px;
    flex: 0 0 auto;
  }

  .status-chip-icon svg {
    width: 11px;
    height: 11px;
    stroke: currentColor;
    stroke-width: 1.35;
    stroke-linecap: round;
    stroke-linejoin: round;
    fill: none;
  }

  .status-chip-value {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .status-chip--short .status-chip-value {
    max-width: 56px;
  }

  .status-chip--wide .status-chip-value {
    max-width: 100%;
  }

  .status-chip--page .status-chip-value {
    max-width: 100%;
  }

  .status-chip:hover,
  .status-chip:focus-visible {
    background: #f3f3f3;
    outline: none;
  }

  .status-chip:focus-visible {
    box-shadow: inset 0 0 0 2px #111111;
    z-index: 2;
  }

  .status-action {
    appearance: none;
    border: 0;
    border-left: 1px solid #111111;
    background: transparent;
    color: #111111;
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 28px;
    min-height: 24px;
    padding: 0 6px;
    cursor: pointer;
    transition: background 120ms ease, color 120ms ease;
  }

  .status-row-actions .status-action:first-child {
    border-left: 0;
  }

  .status-action svg {
    width: 12px;
    height: 12px;
    stroke: currentColor;
    stroke-width: 1.35;
    stroke-linecap: round;
    stroke-linejoin: round;
    fill: none;
  }

  .status-action:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .tool-icon {
    appearance: none;
    border: 0;
    border-left: 1px solid #111111;
    background: transparent;
    color: #111111;
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 34px;
    min-height: 34px;
    padding: 0;
    cursor: pointer;
    transition: background 120ms ease, color 120ms ease;
  }

  .tool-icon svg {
    width: 14px;
    height: 14px;
    stroke: currentColor;
    stroke-width: 1.45;
    stroke-linecap: round;
    stroke-linejoin: round;
    fill: none;
  }

  .tool-icon:disabled {
    opacity: 0.5;
    cursor: progress;
  }

  .tool-icon::before,
  .tool-icon::after,
  .status-chip::before,
  .status-chip::after,
  .status-action::before,
  .status-action::after {
    position: absolute;
    left: 50%;
    opacity: 0;
    visibility: hidden;
    pointer-events: none;
    transition:
      opacity 120ms ease,
      visibility 120ms ease,
      transform 120ms ease;
  }

  .tool-icon::before,
  .status-chip::before,
  .status-action::before {
    content: "";
    bottom: calc(100% + 3px);
    width: 8px;
    height: 8px;
    border-left: 1px solid #111111;
    border-top: 1px solid #111111;
    background: #f3f3f3;
    transform: translateX(-50%) rotate(45deg);
  }

  .tool-icon::after,
  .status-chip::after,
  .status-action::after {
    content: attr(data-tooltip);
    display: block;
    bottom: calc(100% + 8px);
    padding: 3px 6px;
    border: 1px solid #111111;
    background: #f3f3f3;
    color: #111111;
    font-family: "Bahnschrift", "Segoe UI Variable Text", "Segoe UI", sans-serif;
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    box-shadow: 2px 2px 0 rgba(17, 17, 17, 0.08);
    transform: translate(-50%, 4px);
    z-index: 1;
  }

  .tool-icon::after,
  .status-action::after {
    white-space: nowrap;
  }

  .status-chip::after {
    width: max-content;
    max-width: min(320px, calc(100vw - 32px));
    white-space: normal;
    overflow-wrap: break-word;
    word-break: normal;
    line-height: 1.35;
    text-align: left;
    text-transform: none;
  }

  .tool-icon:hover,
  .tool-icon:focus-visible {
    background: #111111;
    color: #ffffff;
    outline: none;
  }

  .tool-icon:focus-visible {
    box-shadow: inset 0 0 0 2px #ffffff;
  }

  .status-action:hover,
  .status-action:focus-visible {
    background: #111111;
    color: #ffffff;
    outline: none;
  }

  .status-action:focus-visible {
    box-shadow: inset 0 0 0 2px #ffffff;
  }

  .tool-icon:hover::before,
  .tool-icon:hover::after,
  .tool-icon:focus-visible::before,
  .tool-icon:focus-visible::after,
  .status-action:hover::before,
  .status-action:hover::after,
  .status-action:focus-visible::before,
  .status-action:focus-visible::after,
  .status-chip:hover::before,
  .status-chip:hover::after,
  .status-chip:focus-visible::before,
  .status-chip:focus-visible::after {
    opacity: 1;
    visibility: visible;
  }

  .tool-icon:hover::after,
  .tool-icon:focus-visible::after,
  .status-action:hover::after,
  .status-action:focus-visible::after,
  .status-chip:hover::after,
  .status-chip:focus-visible::after {
    transform: translate(-50%, 0);
  }

  .tool-icon:active {
    background: #2f2f2f;
    color: #ffffff;
  }

  .panel-body {
    min-height: 0;
    display: grid;
    grid-template-rows: 1fr auto;
    background: rgba(255, 255, 255, 0.96);
  }

  .activity-feed {
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    border: 0;
    padding: 0;
    overscroll-behavior: contain;
  }

  .chat-feed {
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    background: #ffffff;
    overscroll-behavior: contain;
  }

  .activity-entry {
    border-bottom: 1px solid rgba(17, 17, 17, 0.14);
    background: #ffffff;
  }

  .activity-terminal-summary {
    display: grid;
    grid-template-columns: auto auto 1fr auto;
    gap: 6px;
    align-items: center;
    min-height: 24px;
    padding: 4px 8px;
    cursor: pointer;
    list-style: none;
  }

  .activity-kind,
  .log-level {
    display: inline-flex;
    min-width: 56px;
    justify-content: center;
    border: 1px solid currentColor;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    font-size: 11px;
    padding: 4px 8px;
  }

  .activity-terminal .activity-kind {
    min-width: 44px;
    padding: 2px 6px;
    font-size: 10px;
  }

  .activity-title,
  .activity-ts,
  .log-ts,
  .log-meta {
    font-size: 11px;
    color: #5b5b5b;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .activity-title {
    white-space: nowrap;
  }

  .activity-summary,
  .log-heading {
    font-size: 12px;
    line-height: 1.5;
    overflow-wrap: anywhere;
  }

  .activity-summary {
    color: #3b3b3b;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .activity-terminal-summary::-webkit-details-marker {
    display: none;
  }

  .activity-body,
  .log-body {
    margin: 0;
    padding: 0 10px 10px;
    font-family: "Cascadia Code", "Consolas", monospace;
    font-size: 12px;
    line-height: 1.5;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    overflow-x: hidden;
  }

  .terminal-command .activity-kind,
  .terminal-command .activity-title {
    color: #1d4ed8;
  }

  .terminal-result .activity-kind,
  .terminal-result .activity-title {
    color: #166534;
  }

  .terminal-error .activity-kind,
  .terminal-error .activity-title {
    color: #b91c1c;
  }

  .terminal-system .activity-kind,
  .terminal-system .activity-title {
    color: #4b5563;
  }

  .terminal-form {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 8px;
    align-items: center;
    border-top: 1px solid #111111;
    background: #ffffff;
    padding: 0 10px;
    min-height: 40px;
  }

  .chat-form {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    gap: 0;
    align-items: stretch;
    border-top: 1px solid #111111;
    background: #ffffff;
    padding: 0 0 0 10px;
    min-height: 40px;
  }

  .chat-form .prompt-label {
    display: inline-flex;
    align-items: center;
    margin-right: 8px;
  }

  .prompt-label {
    font-family: "Cascadia Code", "Consolas", monospace;
    font-size: 12px;
    letter-spacing: 0.1em;
  }

  .terminal-input-shell {
    position: relative;
    min-width: 0;
  }

  .terminal-input {
    width: 100%;
    border: 0;
    background: transparent;
    font: inherit;
    font-family: "Cascadia Code", "Consolas", monospace;
    font-size: 13px;
    color: #111111;
    outline: none;
  }

  .chat-input {
    width: 100%;
    border: 0;
    background: transparent;
    font: inherit;
    font-family: "Cascadia Code", "Consolas", monospace;
    font-size: 13px;
    color: #111111;
    outline: none;
  }

  .chat-input-shell {
    min-width: 0;
    display: flex;
    align-items: center;
  }

  .chat-queue-file-input {
    display: none;
  }

  .chat-tool-row {
    align-self: stretch;
    flex-shrink: 0;
    align-items: stretch;
    min-height: 100%;
    border-bottom: 0;
    border-left: 1px solid #111111;
    background: #f6f6f6;
  }

  .chat-tool-row .tool-icon:first-child {
    border-left: 0;
  }

  .chat-tool-row.is-collapsed {
    display: none;
  }

  .terminal-suggestion-list {
    position: absolute;
    left: 0;
    right: 0;
    bottom: calc(100% + 1px);
    display: grid;
    max-height: 108px;
    overflow-y: auto;
    overflow-x: hidden;
    border: 1px solid #111111;
    background: #ffffff;
    box-shadow: 0 -1px 0 rgba(17, 17, 17, 0.05);
    z-index: 2;
  }

  .terminal-suggestion-list.is-hidden {
    display: none;
  }

  .terminal-suggestion-item {
    appearance: none;
    border: 0;
    border-bottom: 1px solid rgba(17, 17, 17, 0.12);
    background: #ffffff;
    color: #111111;
    min-height: 20px;
    padding: 2px 6px;
    text-align: left;
    font-family: "Cascadia Code", "Consolas", monospace;
    font-size: 10px;
    line-height: 1.2;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    cursor: pointer;
  }

  .terminal-suggestion-item.is-selected {
    background: #111111;
    color: #ffffff;
  }

  .activity-log {
    overflow: hidden;
  }

  .activity-log .log-summary {
    min-height: 24px;
    padding: 3px 8px;
  }

  .activity-log .log-level {
    min-width: 44px;
    padding: 2px 6px;
    font-size: 10px;
  }

  .log-summary {
    display: grid;
    grid-template-columns: auto 1fr auto;
    gap: 6px;
    align-items: center;
    min-height: 28px;
    padding: 4px 8px;
    cursor: pointer;
    list-style: none;
  }

  .log-summary::-webkit-details-marker {
    display: none;
  }

  .log-heading-block {
    display: block;
    min-width: 0;
  }

  .log-heading {
    color: #111111;
    font-size: 11px;
    line-height: 1.35;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .log-meta,
  .log-body {
    padding: 0 10px 10px;
  }

  .log-meta {
    color: #5b5b5b;
  }

  .level-debug {
    color: #4b5563;
  }

  .level-info {
    color: #1d4ed8;
  }

  .level-warn {
    color: #b45309;
  }

  .level-error {
    color: #b91c1c;
  }

  .chat-entry {
    display: grid;
    gap: 0;
    border-bottom: 1px solid rgba(17, 17, 17, 0.14);
    background: #ffffff;
  }

  .chat-entry-header {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 8px;
    align-items: center;
    min-height: 26px;
    padding: 4px 8px;
  }

  .chat-entry-badge {
    display: inline-flex;
    justify-content: center;
    min-width: 52px;
    border: 1px solid currentColor;
    padding: 2px 6px;
    font-size: 10px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }

  .chat-entry-meta {
    min-width: 0;
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #5b5b5b;
  }

  .chat-entry-body {
    padding: 0 10px 10px;
    display: grid;
    gap: 6px;
    font-size: 12px;
    line-height: 1.55;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    overflow-x: hidden;
  }

  .chat-entry-note {
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #5b5b5b;
  }

  .chat-entry-content {
    min-width: 0;
  }

  .chat-entry-content.is-placeholder {
    color: #7a7a7a;
  }

  .chat-entry.is-dimmed {
    background: #f6f6f6;
    opacity: 0.56;
  }

  .chat-entry.kind-system-prompt {
    background: #f7f7f7;
  }

  .chat-entry.kind-system-prompt .chat-entry-badge,
  .chat-entry.kind-compaction .chat-entry-badge {
    color: #4b5563;
  }

  .chat-range {
    border-bottom: 1px solid rgba(17, 17, 17, 0.14);
    background: #fafafa;
  }

  .chat-range-summary {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 8px;
    align-items: center;
    min-height: 30px;
    padding: 5px 8px;
    cursor: pointer;
    list-style: none;
  }

  .chat-range-summary::-webkit-details-marker {
    display: none;
  }

  .chat-range-badge {
    display: inline-flex;
    justify-content: center;
    min-width: 52px;
    border: 1px solid #4b5563;
    color: #4b5563;
    padding: 2px 6px;
    font-size: 10px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }

  .chat-range-title {
    min-width: 0;
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #5b5b5b;
  }

  .chat-range-body {
    display: grid;
  }

  .chat-entry.kind-assistant .chat-entry-badge {
    color: #166534;
  }

  .chat-entry.kind-user .chat-entry-badge,
  .chat-entry.kind-code .chat-entry-badge {
    color: #1d4ed8;
  }

  .chat-entry.kind-error .chat-entry-badge {
    color: #b91c1c;
  }
`;


