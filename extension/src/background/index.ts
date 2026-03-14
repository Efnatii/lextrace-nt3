import { COMMANDS, RECONNECT_ALARM_NAME, RUNTIME_STREAM_PORT, STORAGE_KEYS, STREAM_EVENTS } from "../shared/constants";
import { buildEffectiveConfig, defaultConfig, mergeConfigPatch, normalizeConfigPatch, type ExtensionConfig, type ExtensionConfigPatch } from "../shared/config";
import { createLogEntry, isLogLevelEnabled, LogEntryInputSchema, LogEntrySchema, serializeError, type LogEntry } from "../shared/logging";
import {
  OverlayProbeResultSchema,
  createOverlayProbeResult,
  getOverlaySupportReason,
  isContentScriptUnavailableError,
  type OverlayErrorCode,
  type OverlayProbeResult
} from "../shared/overlay";
import {
  createEnvelope,
  createErrorResponse,
  createOkResponse,
  ProtocolResponseSchema,
  RuntimeStreamMessageSchema,
  type ProtocolResponse,
  type RuntimeStreamMessage,
  validateEnvelope,
  validateEnvelopePayload
} from "../shared/protocol";
import { canReconnect, getReconnectDelayMs } from "../shared/retry";
import {
  createInitialDesiredRuntime,
  createInitialWorkerStatus,
  NativeHostStatusSchema,
  PersistedRuntimeStateSchema,
  type DesiredRuntimeState,
  type NativeHostStatus,
  type PersistedRuntimeState,
  type WorkerStatus
} from "../shared/runtime-state";

type RuntimeSnapshot = {
  config: ExtensionConfig;
  workerStatus: WorkerStatus;
  desired: DesiredRuntimeState;
  logs: LogEntry[];
};

type OverlayTargetPayload = {
  tabId?: number;
  expectedUrl?: string;
};

const bootId = crypto.randomUUID();
let bootstrapPromise: Promise<void> | null = null;
let localConfigPatch: ExtensionConfigPatch = {};
let sessionConfigPatch: ExtensionConfigPatch = {};
let configCache: ExtensionConfig = defaultConfig;
let logs: LogEntry[] = [];
let workerStatus: WorkerStatus = createInitialWorkerStatus(bootId);
let desiredRuntime: DesiredRuntimeState = createInitialDesiredRuntime();
const uiPorts = new Map<string, chrome.runtime.Port>();

class NativeHostBridge {
  private port: chrome.runtime.Port | null = null;
  private pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timeoutId: ReturnType<typeof globalThis.setTimeout>;
    }
  >();

  private manualDisconnect = false;

  get connected(): boolean {
    return this.port !== null;
  }

  async connect(): Promise<void> {
    if (this.port) {
      return;
    }

    this.port = chrome.runtime.connectNative(configCache.runtime.nativeHostName);
    this.manualDisconnect = false;
    this.port.onMessage.addListener((message) => {
      void this.handleMessage(message);
    });
    this.port.onDisconnect.addListener(() => {
      void this.handleDisconnect();
    });
  }

  async disconnect(): Promise<void> {
    if (!this.port) {
      return;
    }

    this.manualDisconnect = true;
    this.port.disconnect();
    this.port = null;
    this.clearPending("native host disconnected");
  }

  async sendRequest(action: string, payload?: unknown): Promise<unknown> {
    if (!this.port) {
      throw new Error("Native host is not connected.");
    }

    const envelope = createEnvelope(action, "background", "native-host", payload);

    return new Promise((resolve, reject) => {
      const timeoutId = globalThis.setTimeout(() => {
        this.pending.delete(envelope.id);
        reject(new Error(`Native host request timed out for ${action}.`));
      }, configCache.runtime.commandTimeoutMs);

      this.pending.set(envelope.id, {
        resolve,
        reject,
        timeoutId
      });

      try {
        this.port?.postMessage(envelope);
      } catch (error) {
        this.pending.delete(envelope.id);
        globalThis.clearTimeout(timeoutId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private async handleMessage(message: unknown): Promise<void> {
    const responseResult = ProtocolResponseSchema.safeParse(message);
    if (responseResult.success) {
      const pending = this.pending.get(responseResult.data.id);
      if (pending) {
        this.pending.delete(responseResult.data.id);
        globalThis.clearTimeout(pending.timeoutId);
        if (responseResult.data.ok) {
          pending.resolve(responseResult.data.result);
        } else {
          pending.reject(
            new Error(responseResult.data.error?.message ?? "Native host command failed.")
          );
        }
      }
      return;
    }

    const streamResult = RuntimeStreamMessageSchema.safeParse(message);
    if (streamResult.success) {
      await handleRuntimeStream(streamResult.data);
      return;
    }

    await appendLog({
      level: "warn",
      source: "protocol-router",
      event: "native-host.unknown-message",
      summary: "Ignored unknown native host message.",
      details: message
    });
  }

  private async handleDisconnect(): Promise<void> {
    const lastErrorMessage = chrome.runtime.lastError?.message ?? null;
    const wasManual = this.manualDisconnect;
    this.port = null;
    this.manualDisconnect = false;
    this.clearPending(lastErrorMessage ?? "Native host disconnected.");

    workerStatus = {
      ...workerStatus,
      running: false,
      hostConnected: false,
      nativeHostPid: null,
      reconnectAttempt: desiredRuntime.reconnectAttempt
    };
    await persistRuntimeState();
    await broadcastStatus();

    await appendLog({
      level: wasManual ? "info" : "warn",
      source: "background",
      event: "native-host.disconnected",
      summary: wasManual
        ? "Native host disconnected by request."
        : "Native host disconnected unexpectedly.",
      details: {
        manual: wasManual,
        lastErrorMessage
      }
    });

    if (!wasManual && desiredRuntime.desiredRunning) {
      await scheduleReconnect("native-host-disconnect");
    }
  }

  private clearPending(message: string): void {
    for (const [requestId, pending] of this.pending.entries()) {
      this.pending.delete(requestId);
      globalThis.clearTimeout(pending.timeoutId);
      pending.reject(new Error(message));
    }
  }
}

const nativeBridge = new NativeHostBridge();

void bootstrap("module-load");

chrome.runtime.onInstalled.addListener(() => {
  void bootstrap("onInstalled");
});

chrome.runtime.onStartup.addListener(() => {
  void bootstrap("onStartup");
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  void (async () => {
    await bootstrap("onMessage");
    try {
      const response = await handleRuntimeMessage(message, sender);
      sendResponse(response);
    } catch (error) {
      const fallbackEnvelope =
        typeof message === "object" && message && "id" in (message as Record<string, unknown>)
          ? String((message as Record<string, unknown>).id)
          : crypto.randomUUID();

      await appendLog({
        level: "error",
        source: "background",
        event: "runtime.message-error",
        summary: "Message handling failed.",
        details: {
          error: serializeError(error),
          message
        }
      });
      sendResponse(
        createErrorResponse(
          fallbackEnvelope,
          "internal_error",
          error instanceof Error ? error.message : String(error),
          serializeError(error)
        )
      );
    }
  })();

  return true;
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== RUNTIME_STREAM_PORT) {
    return;
  }

  const portId = port.sender?.documentId ?? crypto.randomUUID();
  uiPorts.set(portId, port);

  port.onDisconnect.addListener(() => {
    uiPorts.delete(portId);
  });

  port.onMessage.addListener((message) => {
    if (message && typeof message === "object" && (message as { type?: string }).type === "snapshot.request") {
      void sendSnapshot(port);
    }
  });

  void sendSnapshot(port);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM_NAME) {
    void reconnectNative("alarm");
  }
});

async function bootstrap(reason: string): Promise<void> {
  if (!bootstrapPromise) {
    bootstrapPromise = (async () => {
      const localValues = await chrome.storage.local.get([STORAGE_KEYS.localConfig]);
      const sessionValues = await chrome.storage.session.get([
        STORAGE_KEYS.sessionConfig,
        STORAGE_KEYS.runtimeState,
        STORAGE_KEYS.logs
      ]);

      localConfigPatch = normalizeConfigPatch(localValues[STORAGE_KEYS.localConfig] ?? {});
      sessionConfigPatch = normalizeConfigPatch(sessionValues[STORAGE_KEYS.sessionConfig] ?? {});
      configCache = buildEffectiveConfig(localConfigPatch, sessionConfigPatch);

      const storedLogs = sessionValues[STORAGE_KEYS.logs];
      logs = Array.isArray(storedLogs)
        ? storedLogs
            .map((item: unknown) => createLogEntryFromPersisted(item))
            .filter((item): item is LogEntry => item !== null)
        : [];

      const persistedRuntimeRaw = sessionValues[STORAGE_KEYS.runtimeState];
      if (persistedRuntimeRaw) {
        const persistedRuntime = PersistedRuntimeStateSchema.safeParse(persistedRuntimeRaw);
        if (persistedRuntime.success) {
          desiredRuntime = persistedRuntime.data.desired;
          workerStatus = {
            ...persistedRuntime.data.workerStatus,
            bootId,
            hostConnected: false,
            nativeHostPid: null
          };
        }
      }

      await appendLog({
        level: "info",
        source: "background",
        event: "service-worker.boot",
        summary: "Service worker bootstrapped.",
        details: {
          reason,
          bootId
        }
      });

      if (desiredRuntime.desiredRunning) {
        await reconnectNative("bootstrap-resume");
      } else {
        await persistRuntimeState();
      }
    })();
  }

  await bootstrapPromise;
}

function createLogEntryFromPersisted(value: unknown): LogEntry | null {
  const parsed = LogEntrySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

async function handleRuntimeMessage(
  message: unknown,
  sender: chrome.runtime.MessageSender
): Promise<ProtocolResponse> {
  const envelope = validateEnvelope(message);
  const payload = validateEnvelopePayload(envelope);

  switch (envelope.action) {
    case COMMANDS.ping:
      return createOkResponse(envelope.id, {
        pong: true,
        bootId,
        ts: new Date().toISOString()
      });

    case COMMANDS.logRecord:
      await appendLog(LogEntryInputSchema.parse(payload));
      return createOkResponse(envelope.id, { recorded: true });

    case COMMANDS.workerStart:
      await startWorker(payload as { reason?: string });
      return createOkResponse(envelope.id, { workerStatus });

    case COMMANDS.workerStop:
      await stopWorker(payload as { reason?: string });
      return createOkResponse(envelope.id, { workerStatus });

    case COMMANDS.workerStatus:
      return createOkResponse(envelope.id, {
        workerStatus,
        desired: desiredRuntime
      });

    case COMMANDS.taskDemoStart:
      if (!configCache.protocol.testCommandsEnabled) {
        return createErrorResponse(
          envelope.id,
          "forbidden",
          "Demo commands are disabled in config."
        ) as ReturnType<typeof createOkResponse>;
      }
      await runNativeCommand(COMMANDS.taskDemoStart, payload);
      return createOkResponse(envelope.id, { workerStatus });

    case COMMANDS.taskDemoStop:
      if (!configCache.protocol.testCommandsEnabled) {
        return createErrorResponse(
          envelope.id,
          "forbidden",
          "Demo commands are disabled in config."
        ) as ReturnType<typeof createOkResponse>;
      }
      await runNativeCommand(COMMANDS.taskDemoStop, payload);
      return createOkResponse(envelope.id, { workerStatus });

    case COMMANDS.testHostCrash:
      if (!configCache.protocol.testCommandsEnabled || !configCache.test.allowHostCrashCommand) {
        return createErrorResponse(
          envelope.id,
          "forbidden",
          "Host crash command is disabled in config."
        ) as ReturnType<typeof createOkResponse>;
      }
      await runNativeCommand(COMMANDS.testHostCrash, payload);
      return createOkResponse(envelope.id, { requested: true });

    case COMMANDS.overlayProbe:
      return createOkResponse(
        envelope.id,
        await probeOverlayTarget(payload as OverlayTargetPayload, sender)
      );

    case COMMANDS.overlayOpen:
      return openOverlay(envelope.id, payload as OverlayTargetPayload, sender);

    case COMMANDS.overlayClose:
      return closeOverlay(envelope.id, payload as OverlayTargetPayload, sender);

    case COMMANDS.configGet:
      return createOkResponse(envelope.id, getRuntimeSnapshot());

    case COMMANDS.configPatch:
      await patchConfig(payload as { scope: "local" | "session"; patch: ExtensionConfigPatch });
      return createOkResponse(envelope.id, getRuntimeSnapshot());

    case COMMANDS.logList:
      return createOkResponse(envelope.id, {
        logs: (payload as { limit?: number }).limit
          ? logs.slice(-(payload as { limit: number }).limit)
          : logs
      });

    case COMMANDS.logSubscribe:
      return createOkResponse(envelope.id, getRuntimeSnapshot());

    default:
      return createErrorResponse(
        envelope.id,
        "unsupported_action",
        `Action ${envelope.action} is not implemented.`
      ) as ReturnType<typeof createOkResponse>;
  }
}

async function startWorker(payload: { reason?: string }): Promise<void> {
  desiredRuntime = {
    ...desiredRuntime,
    desiredRunning: true
  };
  await ensureNativeConnection("worker.start");
  const result = await nativeBridge.sendRequest(COMMANDS.workerStart, {
    ...(payload ?? {}),
    heartbeatMs: configCache.runtime.heartbeatMs
  });
  applyNativeStatus(result);
  await appendLog({
    level: "info",
    source: "background",
    event: "worker.start",
    summary: "Worker start command executed.",
    details: payload
  });
}

async function stopWorker(payload: { reason?: string }): Promise<void> {
  desiredRuntime = {
    ...desiredRuntime,
    desiredRunning: false,
    desiredTaskId: null,
    reconnectAttempt: 0,
    lastDisconnectAt: null
  };

  if (nativeBridge.connected) {
    try {
      const result = await nativeBridge.sendRequest(COMMANDS.workerStop, payload);
      applyNativeStatus(result);
    } finally {
      await nativeBridge.disconnect();
    }
  }

  workerStatus = {
    ...workerStatus,
    running: false,
    hostConnected: false,
    taskId: null,
    sessionId: null,
    nativeHostPid: null
  };
  await persistRuntimeState();
  await broadcastStatus();
  await appendLog({
    level: "info",
    source: "background",
    event: "worker.stop",
    summary: "Worker stop command executed.",
    details: payload
  });
}

async function ensureNativeConnection(reason: string): Promise<void> {
  if (nativeBridge.connected) {
    return;
  }

  await appendLog({
    level: "info",
    source: "background",
    event: "native-host.connect",
    summary: "Connecting to native host.",
    details: {
      reason,
      host: configCache.runtime.nativeHostName
    }
  });

  await nativeBridge.connect();
  desiredRuntime = {
    ...desiredRuntime,
    reconnectAttempt: 0
  };

  const statusResult = await nativeBridge.sendRequest(COMMANDS.workerStatus, {});
  applyNativeStatus(statusResult);
  await persistRuntimeState();
  await broadcastStatus();
}

async function reconnectNative(reason: string): Promise<void> {
  if (!desiredRuntime.desiredRunning) {
    return;
  }

  try {
    await ensureNativeConnection(reason);
    await appendLog({
      level: "info",
      source: "background",
      event: "native-host.reconnected",
      summary: "Native host connection is healthy.",
      details: {
        reason,
        reconnectAttempt: desiredRuntime.reconnectAttempt
      }
    });
  } catch (error) {
    await appendLog({
      level: "error",
      source: "background",
      event: "native-host.reconnect-failed",
      summary: "Native host reconnect attempt failed.",
      details: {
        reason,
        error: serializeError(error)
      }
    });
    await scheduleReconnect("reconnect-failed");
  }
}

async function scheduleReconnect(reason: string): Promise<void> {
  const nextAttempt = desiredRuntime.reconnectAttempt + 1;
  if (!canReconnect(nextAttempt, configCache.runtime.reconnectPolicy)) {
    desiredRuntime = {
      ...desiredRuntime,
      desiredRunning: false,
      reconnectAttempt: nextAttempt,
      lastDisconnectAt: new Date().toISOString()
    };
    await persistRuntimeState();
    await broadcastStatus();
    await appendLog({
      level: "error",
      source: "background",
      event: "native-host.reconnect-exhausted",
      summary: "Reconnect attempts exhausted.",
      details: {
        reason,
        attempts: nextAttempt
      }
    });
    return;
  }

  const delayMs = getReconnectDelayMs(nextAttempt, configCache.runtime.reconnectPolicy);
  desiredRuntime = {
    ...desiredRuntime,
    reconnectAttempt: nextAttempt,
    lastDisconnectAt: new Date().toISOString()
  };
  chrome.alarms.create(RECONNECT_ALARM_NAME, {
    when: Date.now() + delayMs
  });
  await persistRuntimeState();
  await broadcastStatus();
  await appendLog({
    level: "warn",
    source: "background",
    event: "native-host.reconnect-scheduled",
    summary: "Reconnect scheduled.",
    details: {
      reason,
      delayMs,
      attempt: nextAttempt
    }
  });
}

async function runNativeCommand(action: string, payload: unknown): Promise<void> {
  desiredRuntime = {
    ...desiredRuntime,
    desiredRunning: true
  };
  const safePayload =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? { ...(payload as Record<string, unknown>) }
      : {};

  if (action === COMMANDS.taskDemoStart) {
    desiredRuntime = {
      ...desiredRuntime,
      desiredTaskId:
        typeof safePayload.taskId === "string"
          ? safePayload.taskId
          : desiredRuntime.desiredTaskId
    };
    safePayload.heartbeatMs = configCache.test.demoHeartbeatMs;
  }
  if (action === COMMANDS.taskDemoStop) {
    desiredRuntime = {
      ...desiredRuntime,
      desiredTaskId: null
    };
    safePayload.heartbeatMs = configCache.runtime.heartbeatMs;
  }

  await ensureNativeConnection(action);
  const result = await nativeBridge.sendRequest(action, safePayload);
  applyNativeStatus(result);
  await persistRuntimeState();
  await broadcastStatus();
  await appendLog({
    level: "info",
    source: "background",
    event: action,
    summary: `Executed ${action}.`,
    details: safePayload
  });
}

function applyNativeStatus(result: unknown): void {
  const parsed = NativeHostStatusSchema.safeParse(result);
  if (!parsed.success) {
    return;
  }

  const nativeStatus = parsed.data;
  workerStatus = {
    ...nativeStatus,
    bootId
  };
}

async function handleRuntimeStream(message: RuntimeStreamMessage): Promise<void> {
  if (message.status) {
    const statusResult = NativeHostStatusSchema.safeParse(message.status);
    if (statusResult.success) {
      applyNativeStatus(statusResult.data);
      await persistRuntimeState();
      await broadcastStatus();
    }
  }

  if (message.logEntry) {
    if (isLogLevelEnabled(message.logEntry.level, configCache.logging.level)) {
      logs = [...logs.slice(-(configCache.logging.maxEntries - 1)), message.logEntry];
      await chrome.storage.session.set({
        [STORAGE_KEYS.logs]: logs
      });
    }
  }

  if (message.event === STREAM_EVENTS.log && message.logEntry && isLogLevelEnabled(message.logEntry.level, configCache.logging.level)) {
    broadcastStream(message);
  } else if (message.event === STREAM_EVENTS.status) {
    broadcastStream(message);
  }
}

async function openOverlay(
  requestId: string,
  payload: OverlayTargetPayload,
  sender: chrome.runtime.MessageSender
): Promise<ProtocolResponse> {
  const probeResult = await probeOverlayTarget(payload, sender);
  if (!probeResult.eligible) {
    await appendLog({
      level: "warn",
      source: "background",
      event: COMMANDS.overlayOpen,
      summary: "Overlay open rejected for unsupported tab.",
      details: probeResult
    });
    return createOverlayErrorResponse(
      requestId,
      "unsupported_tab",
      "Overlay terminal is only available on regular http(s) pages.",
      probeResult
    );
  }

  if (!probeResult.ready) {
    const code = probeResult.reason ?? "content_not_ready";
    const message =
      code === "content_not_ready"
        ? "Overlay terminal is unavailable until this page is reloaded."
        : "Overlay terminal failed to open on the current page.";
    await appendLog({
      level: code === "content_not_ready" ? "warn" : "error",
      source: "background",
      event: COMMANDS.overlayOpen,
      summary: "Overlay open rejected because the page is not ready.",
      details: probeResult
    });
    return createOverlayErrorResponse(requestId, code, message, probeResult);
  }

  const targetTab = await requireOverlayTargetTab(payload, sender);
  if (!targetTab?.id) {
    return createOverlayErrorResponse(
      requestId,
      "unsupported_tab",
      "Overlay terminal target tab could not be resolved."
    );
  }

  try {
    await sendContentCommand(COMMANDS.overlayOpen, payload, targetTab);
    return createOkResponse(requestId, {
      opened: true,
      tabId: targetTab.id,
      url: getResolvedTabUrl(targetTab)
    });
  } catch (error) {
    await appendLog({
      level: "error",
      source: "background",
      event: COMMANDS.overlayOpen,
      summary: "Overlay terminal failed to open.",
      details: {
        tabId: targetTab.id,
        url: getResolvedTabUrl(targetTab),
        error: serializeError(error)
      }
    });
    return createOverlayErrorResponse(
      requestId,
      "overlay_open_failed",
      "Overlay terminal failed to open on the current page.",
      {
        tabId: targetTab.id,
        url: getResolvedTabUrl(targetTab),
        error: serializeError(error)
      }
    );
  }
}

async function closeOverlay(
  requestId: string,
  payload: OverlayTargetPayload,
  sender: chrome.runtime.MessageSender
): Promise<ProtocolResponse> {
  const targetTab = await requireOverlayTargetTab(payload, sender);
  if (!targetTab?.id) {
    return createOverlayErrorResponse(
      requestId,
      "unsupported_tab",
      "Overlay terminal target tab could not be resolved."
    );
  }

  try {
    await sendContentCommand(COMMANDS.overlayClose, payload, targetTab);
    return createOkResponse(requestId, {
      closed: true,
      tabId: targetTab.id,
      url: getResolvedTabUrl(targetTab)
    });
  } catch (error) {
    return createOverlayErrorResponse(
      requestId,
      isContentScriptUnavailableError(error) ? "content_not_ready" : "overlay_open_failed",
      error instanceof Error ? error.message : String(error),
      {
        tabId: targetTab.id,
        url: getResolvedTabUrl(targetTab),
        error: serializeError(error)
      }
    );
  }
}

async function probeOverlayTarget(
  payload: OverlayTargetPayload,
  sender: chrome.runtime.MessageSender
): Promise<OverlayProbeResult> {
  const targetTab = await resolveTargetTab(payload.tabId ?? sender.tab?.id);
  const tabId = typeof targetTab?.id === "number" ? targetTab.id : null;
  const url = getOverlaySupportUrl(targetTab, payload);
  const supportReason = getOverlaySupportReason(url);

  if (!tabId || supportReason) {
    return createOverlayProbeResult(tabId, url, false, "unsupported_tab");
  }

  if (!targetTab) {
    return createOverlayProbeResult(tabId, url, false, "overlay_open_failed");
  }

  try {
    await sendContentCommand(COMMANDS.overlayProbe, payload, targetTab);
    return createOverlayProbeResult(tabId, url, true, null);
  } catch (error) {
    const injected = await injectContentScriptIfNeeded(targetTab, error);
    if (injected) {
      try {
        await sendContentCommand(COMMANDS.overlayProbe, payload, targetTab);
        return createOverlayProbeResult(tabId, url, true, null);
      } catch (retryError) {
        return createOverlayProbeResult(
          tabId,
          url,
          false,
          isContentScriptUnavailableError(retryError) ? "content_not_ready" : "overlay_open_failed"
        );
      }
    }

    return createOverlayProbeResult(
      tabId,
      url,
      false,
      isContentScriptUnavailableError(error) ? "content_not_ready" : "overlay_open_failed"
    );
  }
}

async function sendContentCommand(
  action: string,
  payload: unknown,
  resolvedTab: chrome.tabs.Tab
): Promise<unknown> {
  if (!resolvedTab.id) {
    throw new Error("No eligible tab found for overlay command.");
  }

  const contentEnvelope = createEnvelope(action, "background", "content", payload);
  const rawResponse = await chrome.tabs.sendMessage(resolvedTab.id, contentEnvelope);
  const response = ProtocolResponseSchema.parse(rawResponse);
  if (!response.ok) {
    throw new Error(response.error?.message ?? `Content command ${action} failed.`);
  }

  await appendLog({
    level: "info",
    source: "background",
    event: action,
    summary: `Sent ${action} to tab ${resolvedTab.id}.`,
    details: {
      payload,
      url: getResolvedTabUrl(resolvedTab)
    }
  });

  return response.result;
}

async function resolveTargetTab(explicitTabId?: number): Promise<chrome.tabs.Tab | undefined> {
  if (explicitTabId) {
    try {
      return await chrome.tabs.get(explicitTabId);
    } catch {
      return undefined;
    }
  }

  const [activeTab] = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });

  if (activeTab?.id) {
    return activeTab;
  }

  const currentTabs = await chrome.tabs.query({
    currentWindow: true
  });

  return currentTabs
    .sort((left, right) => (right.lastAccessed ?? 0) - (left.lastAccessed ?? 0))[0];
}

async function requireOverlayTargetTab(
  payload: OverlayTargetPayload,
  sender: chrome.runtime.MessageSender
): Promise<chrome.tabs.Tab | undefined> {
  const targetTab = await resolveTargetTab(payload.tabId ?? sender.tab?.id);
  if (!targetTab?.id) {
    return undefined;
  }

  const supportReason = getOverlaySupportReason(getOverlaySupportUrl(targetTab, payload));
  if (supportReason) {
    return undefined;
  }

  return targetTab;
}

function getResolvedTabUrl(tab: chrome.tabs.Tab | undefined): string | null {
  return tab?.url ?? tab?.pendingUrl ?? null;
}

async function injectContentScriptIfNeeded(
  targetTab: chrome.tabs.Tab,
  error: unknown
): Promise<boolean> {
  if (!targetTab.id || !isContentScriptUnavailableError(error)) {
    return false;
  }

  await appendLog({
    level: "info",
    source: "background",
    event: "content-script.inject.attempt",
    summary: "Attempting to inject content script into current page.",
    details: {
      tabId: targetTab.id,
      url: getResolvedTabUrl(targetTab),
      error: serializeError(error)
    }
  });

  try {
    await chrome.scripting.executeScript({
      target: {
        tabId: targetTab.id
      },
      files: ["content.js"]
    });

    await appendLog({
      level: "info",
      source: "background",
      event: "content-script.inject.success",
      summary: "Injected content script into current page.",
      details: {
        tabId: targetTab.id,
        url: getResolvedTabUrl(targetTab)
      }
    });

    return true;
  } catch (injectionError) {
    await appendLog({
      level: "warn",
      source: "background",
      event: "content-script.inject.failed",
      summary: "Content script injection failed.",
      details: {
        tabId: targetTab.id,
        url: getResolvedTabUrl(targetTab),
        error: serializeError(injectionError)
      }
    });

    return false;
  }
}

function getOverlaySupportUrl(
  tab: chrome.tabs.Tab | undefined,
  payload?: OverlayTargetPayload
): string | null {
  const resolvedUrl = getResolvedTabUrl(tab);
  if (!getOverlaySupportReason(resolvedUrl)) {
    return resolvedUrl;
  }

  if (payload?.expectedUrl && !getOverlaySupportReason(payload.expectedUrl)) {
    return payload.expectedUrl;
  }

  return resolvedUrl;
}

function createOverlayErrorResponse(
  requestId: string,
  code: OverlayErrorCode,
  message: string,
  details?: unknown
): ProtocolResponse {
  return createErrorResponse(requestId, code, message, details);
}

async function patchConfig(input: {
  scope: "local" | "session";
  patch: ExtensionConfigPatch;
}): Promise<void> {
  if (input.scope === "local") {
    localConfigPatch = mergeConfigPatch(localConfigPatch, input.patch);
    await chrome.storage.local.set({
      [STORAGE_KEYS.localConfig]: localConfigPatch
    });
  } else {
    sessionConfigPatch = mergeConfigPatch(sessionConfigPatch, input.patch);
    await chrome.storage.session.set({
      [STORAGE_KEYS.sessionConfig]: sessionConfigPatch
    });
  }

  configCache = buildEffectiveConfig(localConfigPatch, sessionConfigPatch);
  await syncConfigSideEffects(input.patch);
  await broadcastConfig();
  await appendLog({
    level: "info",
    source: "config-store",
    event: "config.patch",
    summary: `Patched ${input.scope} config.`,
    details: input.patch
  });
}

async function appendLog(input: unknown): Promise<void> {
  const entry = createLogEntry(LogEntryInputSchema.parse(input), configCache.logging.collapseThreshold);
  if (!isLogLevelEnabled(entry.level, configCache.logging.level)) {
    return;
  }

  logs = [...logs.slice(-(configCache.logging.maxEntries - 1)), entry];
  await chrome.storage.session.set({
    [STORAGE_KEYS.logs]: logs
  });
  broadcastStream({
    stream: "runtime",
    event: STREAM_EVENTS.log,
    level: entry.level,
    summary: entry.summary,
    details: entry.details,
    ts: entry.ts,
    correlationId: entry.correlationId ?? null,
    logEntry: entry
  });
}

async function syncConfigSideEffects(patch: ExtensionConfigPatch): Promise<void> {
  if (logs.length > configCache.logging.maxEntries) {
    logs = logs.slice(-configCache.logging.maxEntries);
    await chrome.storage.session.set({
      [STORAGE_KEYS.logs]: logs
    });
  }

  if (!nativeBridge.connected || !workerStatus.running) {
    return;
  }

  if (patch.test?.demoHeartbeatMs !== undefined && workerStatus.taskId) {
    const result = await nativeBridge.sendRequest(COMMANDS.taskDemoStart, {
      taskId: workerStatus.taskId,
      heartbeatMs: configCache.test.demoHeartbeatMs
    });
    applyNativeStatus(result);
    await persistRuntimeState();
    await broadcastStatus();
    return;
  }

  if (patch.runtime?.heartbeatMs !== undefined && !workerStatus.taskId) {
    const result = await nativeBridge.sendRequest(COMMANDS.workerStart, {
      reason: "config.runtime.heartbeatMs.sync",
      heartbeatMs: configCache.runtime.heartbeatMs
    });
    applyNativeStatus(result);
    await persistRuntimeState();
    await broadcastStatus();
  }
}

async function persistRuntimeState(): Promise<void> {
  const persisted: PersistedRuntimeState = {
    workerStatus,
    desired: desiredRuntime
  };

  await chrome.storage.session.set({
    [STORAGE_KEYS.runtimeState]: persisted
  });
}

function getRuntimeSnapshot(): RuntimeSnapshot {
  return {
    config: configCache,
    workerStatus,
    desired: desiredRuntime,
    logs
  };
}

async function sendSnapshot(port: chrome.runtime.Port): Promise<void> {
  port.postMessage({
    stream: "runtime",
    event: STREAM_EVENTS.snapshot,
    level: "info",
    summary: "Runtime snapshot",
    details: null,
    ts: new Date().toISOString(),
    correlationId: null,
    status: workerStatus,
    config: configCache,
    logs
  });
}

async function broadcastStatus(): Promise<void> {
  broadcastStream({
    stream: "runtime",
    event: STREAM_EVENTS.status,
    level: "info",
    summary: "Worker status updated.",
    details: desiredRuntime,
    ts: new Date().toISOString(),
    correlationId: null,
    status: workerStatus
  });
}

async function broadcastConfig(): Promise<void> {
  broadcastStream({
    stream: "runtime",
    event: STREAM_EVENTS.config,
    level: "info",
    summary: "Config updated.",
    details: null,
    ts: new Date().toISOString(),
    correlationId: null,
    config: configCache
  });
}

function broadcastStream(message: unknown): void {
  for (const [portId, port] of uiPorts.entries()) {
    try {
      port.postMessage(message);
    } catch {
      uiPorts.delete(portId);
    }
  }
}
