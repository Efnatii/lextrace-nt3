import { COMMANDS } from "../shared/constants";
import { connectRuntimeStream, recordLog, sendCommand } from "../shared/client";
import { ExtensionConfigSchema, type ExtensionConfig } from "../shared/config";
import { LogEntrySchema, serializeLogDetails, type LogEntry } from "../shared/logging";
import {
  buildOverlayActivityFeed,
  type OverlayConsoleEntry,
  type OverlayConsoleEntryKind
} from "../shared/overlay-feed";
import {
  createErrorResponse,
  createOkResponse,
  validateEnvelope,
  type RuntimeStreamMessage
} from "../shared/protocol";
import { WorkerStatusSchema, type WorkerStatus } from "../shared/runtime-state";
import { getTerminalHelpLines, getTerminalSuggestions, parseTerminalCommand, type TerminalCatalogOptions } from "../shared/terminal";

type RuntimeSnapshot = {
  config: ExtensionConfig;
  status: WorkerStatus;
  logs: LogEntry[];
};

class OverlayTerminalController {
  private host: HTMLDivElement | null = null;
  private shadowRoot: ShadowRoot | null = null;
  private streamPort: chrome.runtime.Port | null = null;
  private reconnectTimer: number | null = null;
  private streamKeepAliveTimer: number | null = null;
  private panelHeader: HTMLElement | null = null;

  private activityFeed: HTMLElement | null = null;
  private terminalSuggestionList: HTMLElement | null = null;
  private terminalInput: HTMLInputElement | null = null;
  private panelWindow: HTMLElement | null = null;
  private statusRow: HTMLElement | null = null;

  private currentConfig: ExtensionConfig | null = null;
  private currentStatus: WorkerStatus | null = null;
  private runtimeLogs: LogEntry[] = [];
  private consoleEntries: OverlayConsoleEntry[] = [];
  private runtimeLogSequences = new Map<string, number>();
  private activityOpenState = new Map<string, boolean>();
  private visibleActivitySequenceFloor = 0;
  private currentSuggestions: string[] = [];
  private selectedSuggestionIndex = -1;
  private nextActivitySequence = 0;
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
      `Unsupported content action: ${envelope.action}`
    );
  }

  async open(): Promise<void> {
    this.ensureDom();
    this.visible = true;
    this.host?.style.setProperty("display", "block");
    this.pushConsole("system", "Overlay terminal opened. Type help for commands.");
    await this.patchOverlaySessionConfig({
      visible: true
    });
    await this.ensureStream();
    await this.loadSnapshot();
    this.centerPanelInViewport();
    this.terminalInput?.focus();
    await recordLog("content", "overlay.open", "Overlay terminal opened.");
  }

  async close(recordClose = true): Promise<void> {
    this.visible = false;
    this.host?.style.setProperty("display", "none");
    this.disconnectStream();
    await this.patchOverlaySessionConfig({
      visible: false
    });
    if (recordClose) {
      await recordLog("content", "overlay.close", "Overlay terminal closed.");
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
            <p class="panel-kicker">Page overlay</p>
            <h1>LexTrace Terminal</h1>
          </div>
          <button type="button" class="close-button" data-close="true">Close</button>
        </header>
        <div class="status-row" data-role="status-row"></div>
        <section class="panel-body">
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
    `;

    this.shadowRoot.append(style, wrapper);
    document.documentElement.appendChild(this.host);

    this.panelWindow = wrapper.querySelector<HTMLElement>(".panel-shell");
    this.panelHeader = wrapper.querySelector<HTMLElement>(".panel-header");
    this.activityFeed = wrapper.querySelector<HTMLElement>("[data-role='activity-feed']");
    this.terminalSuggestionList = wrapper.querySelector<HTMLElement>("[data-role='terminal-suggestions']");
    this.terminalInput = wrapper.querySelector<HTMLInputElement>("[data-role='terminal-input']");
    this.statusRow = wrapper.querySelector<HTMLElement>("[data-role='status-row']");

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
  }

  private async ensureStream(): Promise<void> {
    if (this.streamPort) {
      return;
    }

    this.streamPort = connectRuntimeStream((message) => {
      void this.handleStreamMessage(message as RuntimeStreamMessage & Record<string, unknown>);
    });
    this.startStreamKeepAlive();

    this.streamPort.onDisconnect.addListener(() => {
      this.streamPort = null;
      this.stopStreamKeepAlive();
      if (!this.visible) {
        return;
      }
      this.pushConsole("error", "Runtime stream disconnected. Retrying…");
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
      status: WorkerStatusSchema.parse(snapshot.workerStatus),
      logs: snapshot.logs.map((entry) => LogEntrySchema.parse(entry))
    });
  }

  private async handleStreamMessage(message: RuntimeStreamMessage & Record<string, unknown>): Promise<void> {
    if (message.event === "runtime.snapshot") {
      this.applySnapshot({
        config: ExtensionConfigSchema.parse(message.config),
        status: WorkerStatusSchema.parse(message.status),
        logs: Array.isArray(message.logs)
          ? message.logs.map((entry) => LogEntrySchema.parse(entry))
          : this.runtimeLogs
      });
      return;
    }

    if (message.event === "runtime.status" && message.status) {
      this.currentStatus = WorkerStatusSchema.parse(message.status);
      this.renderStatus();
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

  private applySnapshot(snapshot: RuntimeSnapshot): void {
    this.currentConfig = snapshot.config;
    this.currentStatus = snapshot.status;
    this.setRuntimeLogs(snapshot.logs);
    this.applyGeometry(snapshot.config);
    this.render(true);
  }

  private render(forceActivityScroll = false): void {
    this.renderStatus();
    this.renderActivityFeed(forceActivityScroll);
  }

  private renderStatus(): void {
    if (!this.statusRow || !this.currentStatus) {
      return;
    }

    const fragments = [
      ["state", this.currentStatus.running ? "running" : "stopped"],
      ["host", this.currentStatus.hostConnected ? "connected" : "disconnected"],
      ["boot", this.currentStatus.bootId.slice(0, 8)],
      ["session", this.currentStatus.sessionId ?? "-"],
      ["task", this.currentStatus.taskId ?? "-"],
      ["heartbeat", this.currentStatus.lastHeartbeatAt ?? "-"]
    ];

    this.statusRow.replaceChildren(
      ...fragments.map(([label, value]) => {
        const item = document.createElement("span");
        item.className = "status-chip";
        item.textContent = `${label}: ${value}`;
        return item;
      })
    );
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
    level.textContent = entry.level;

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
    body.textContent = serializeLogDetails(entry.details) || "No details";

    details.append(summary, meta, body);
    return details;
  }

  private getTerminalActivityBadgeLabel(kind: OverlayConsoleEntryKind): string {
    switch (kind) {
      case "command":
        return "CMD";
      case "result":
        return "OK";
      case "error":
        return "ERR";
      case "system":
      default:
        return "SYS";
    }
  }

  private getTerminalActivityTitle(kind: OverlayConsoleEntryKind): string {
    switch (kind) {
      case "command":
        return "Terminal command";
      case "result":
        return "Terminal response";
      case "error":
        return "Terminal error";
      case "system":
      default:
        return "Overlay event";
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

      if (parsed.kind === "local") {
        if (parsed.action === "clear") {
          this.consoleEntries = [];
          this.activityOpenState.clear();
          this.visibleActivitySequenceFloor = this.nextActivitySequence;
          this.renderActivityFeed(true);
          return;
        }

        this.pushConsole("result", getTerminalHelpLines(this.getTerminalCatalogOptions()).join("\n"));
        return;
      }

      const result = await sendCommand(
        parsed.action,
        "overlay",
        "background",
        parsed.payload
      );

      this.pushConsole("result", JSON.stringify(result, null, 2));
      await recordLog("content", "overlay.command", `Executed ${parsed.action}.`, parsed.payload);
    } catch (error) {
      this.pushConsole(
        "error",
        error instanceof Error ? error.message : String(error)
      );
      await recordLog(
        "content",
        "overlay.command.failed",
        "Overlay terminal command failed.",
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

  private async patchOverlaySessionConfig(patch: Partial<ExtensionConfig["ui"]["overlay"]>): Promise<void> {
    try {
      const result = await sendCommand<{
        config: ExtensionConfig;
        workerStatus: WorkerStatus;
        logs: LogEntry[];
      }>(COMMANDS.configPatch, "content", "background", {
        scope: "session",
        patch: {
          ui: {
            overlay: patch
          }
        }
      });

      this.currentConfig = ExtensionConfigSchema.parse(result.config);
      this.currentStatus = WorkerStatusSchema.parse(result.workerStatus);
      this.setRuntimeLogs(result.logs.map((entry) => LogEntrySchema.parse(entry)));
      this.applyGeometry(this.currentConfig);
      this.render(true);
    } catch {
      // Ignore config patch failures during teardown paths.
    }
  }

  private async patchOverlayLocalConfig(patch: Partial<ExtensionConfig["ui"]["overlay"]>): Promise<void> {
    try {
      const result = await sendCommand<{
        config: ExtensionConfig;
        workerStatus: WorkerStatus;
        logs: LogEntry[];
      }>(COMMANDS.configPatch, "content", "background", {
        scope: "local",
        patch: {
          ui: {
            overlay: patch
          }
        }
      });

      this.currentConfig = ExtensionConfigSchema.parse(result.config);
      this.currentStatus = WorkerStatusSchema.parse(result.workerStatus);
      this.setRuntimeLogs(result.logs.map((entry) => LogEntrySchema.parse(entry)));
      this.applyGeometry(this.currentConfig);
      this.render(true);
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
    await recordLog("content", "overlay.drag", "Overlay terminal moved.", {
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
    this.terminalInput?.focus();
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

    const scrollContainer = candidate.closest<HTMLElement>(".activity-feed");
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
  void recordLog("content", "content.bootstrap", "Content script bootstrapped.");
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

  .status-row {
    display: flex;
    flex-wrap: wrap;
    gap: 0;
    border-bottom: 1px solid #111111;
    background: #ffffff;
  }

  .status-chip {
    display: inline-flex;
    align-items: center;
    min-height: 28px;
    border-right: 1px solid #111111;
    padding: 4px 8px;
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
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
`;
