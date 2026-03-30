import {
  AiChatCompactResultSchema,
  AiChatListResultSchema,
  AiModelCatalogResultSchema,
  AiChatPageSessionSchema,
  AiChatStatusResultSchema,
  AiStreamMessageSchema,
  createDefaultAiStatus,
  type AiChatPageSession,
  type AiModelCatalogResult,
  type AiStreamMessage
} from "../shared/ai";
import { COMMANDS, RECONNECT_ALARM_NAME, RUNTIME_STREAM_PORT, STORAGE_KEYS, STREAM_EVENTS } from "../shared/constants";
import { buildEffectiveConfig, defaultConfig, mergeConfigPatch, normalizeConfigPatch, normalizePersistedConfigPatch, type ExtensionConfig, type ExtensionConfigPatch } from "../shared/config";
import { createLogEntry, isLogLevelEnabled, LogEntryInputSchema, LogEntrySchema, serializeError, type LogEntry } from "../shared/logging";
import {
  OverlayProbeResultSchema,
  createOverlayProbeResult,
  getOverlaySupportReason,
  isContentScriptUnavailableError,
  type OverlayErrorCode,
  type OverlayProbeResult
} from "../shared/overlay";
import { redactSensitiveConfigData } from "../shared/config-fields";
import {
  createEnvelope,
  createErrorResponse,
  createOkResponse,
  parseNativeHostMessage,
  ProtocolResponseSchema,
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
  parseRuntimeWorkerStatus,
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

type UiPortState = {
  port: chrome.runtime.Port;
  viewId: string;
  pageKey: string | null;
  pageUrl: string | null;
};

const NATIVE_CONFIG_SYNC_ACTION = "config.sync";
const AI_MODEL_CATALOG_CACHE_TTL_MS = 5 * 60 * 1000;
const AI_SESSION_PERSISTENCE_PROFILES = [
  { maxSessions: 48, maxMessages: 12, maxQueueItems: 6 },
  { maxSessions: 16, maxMessages: 4, maxQueueItems: 2 },
  { maxSessions: 0, maxMessages: 0, maxQueueItems: 0 }
] as const;
const LOG_PERSISTENCE_MAX_ENTRIES = [250, 100, 25, 0] as const;
const PERSISTED_MESSAGE_TEXT_MAX_LENGTH = 512;
const PERSISTED_SUMMARY_MAX_LENGTH = 256;
const PERSISTED_LAST_ERROR_MAX_LENGTH = 512;
const PERSISTED_PAGE_URL_MAX_LENGTH = 512;
const PERSISTED_QUEUE_TEXT_MAX_LENGTH = 256;

const bootId = crypto.randomUUID();
let bootstrapPromise: Promise<void> | null = null;
let localConfigPatch: ExtensionConfigPatch = {};
let sessionConfigPatch: ExtensionConfigPatch = {};
let configCache: ExtensionConfig = defaultConfig;
let logs: LogEntry[] = [];
let workerStatus: WorkerStatus = createInitialWorkerStatus(bootId);
let desiredRuntime: DesiredRuntimeState = createInitialDesiredRuntime();
const uiPorts = new Map<string, UiPortState>();
const aiSessions = new Map<string, AiChatPageSession>();
let aiModelCatalogCache: { expiresAt: number; result: AiModelCatalogResult } | null = null;

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

  async connect(hostName = configCache.runtime.nativeHostName): Promise<void> {
    if (this.port) {
      return;
    }

    this.port = chrome.runtime.connectNative(hostName);
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
    this.clearPending("нативный хост отключён");
  }

  async sendRequest(action: string, payload?: unknown): Promise<unknown> {
    if (!this.port) {
      throw new Error("Нативный хост не подключён.");
    }

    const envelope = createEnvelope(action, "background", "native-host", payload);

    return new Promise((resolve, reject) => {
      const timeoutId = globalThis.setTimeout(() => {
        this.pending.delete(envelope.id);
        reject(new Error(`Истекло время ожидания ответа нативного хоста для ${action}.`));
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
    const parsedMessage = parseNativeHostMessage(message);
    if (parsedMessage?.kind === "response") {
      const responseResult = { data: parsedMessage.message };
      const pending = this.pending.get(parsedMessage.message.id);
      if (pending) {
        this.pending.delete(parsedMessage.message.id);
        globalThis.clearTimeout(pending.timeoutId);
        if (parsedMessage.message.ok) {
          pending.resolve(parsedMessage.message.result);
        } else {
          const nativeError = new Error(responseResult.data.error?.message ?? "Не удалось выполнить команду нативного хоста.");
          Object.assign(nativeError, {
            code: parsedMessage.message.error?.code ?? null,
            details: parsedMessage.message.error?.details ?? null
          });
          pending.reject(nativeError);
        }
      }
      return;
    }

    if (parsedMessage?.kind === "stream") {
      if (parsedMessage.message.stream === "runtime") {
        await handleRuntimeStream(parsedMessage.message);
      } else {
        await handleAiStream(parsedMessage.message);
      }
      return;
    }

    await appendLog({
      level: "warn",
      source: "protocol-router",
      event: "native-host.unknown-message",
      summary: "Неизвестное сообщение от нативного хоста проигнорировано.",
      details: message
    });
  }

  private async handleDisconnect(): Promise<void> {
    const lastErrorMessage = chrome.runtime.lastError?.message ?? null;
    const wasManual = this.manualDisconnect;
    this.port = null;
    this.manualDisconnect = false;
    aiModelCatalogCache = null;
    this.clearPending(lastErrorMessage ?? "Нативный хост отключён.");

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
        ? "Нативный хост отключён по запросу."
        : "Нативный хост отключился неожиданно.",
      details: {
        manual: wasManual,
        lastErrorMessage
      }
    });

    if (!wasManual && shouldKeepNativeConnection()) {
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
        summary: "Не удалось обработать сообщение.",
        details: {
          error: serializeError(error),
          message: sanitizeRuntimeMessageForLogs(message)
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
  uiPorts.set(portId, {
    port,
    viewId: portId,
    pageKey: null,
    pageUrl: null
  });

  port.onDisconnect.addListener(() => {
    void detachViewFromPort(portId);
  });

  port.onMessage.addListener((message) => {
    void (async () => {
      await bootstrap("onConnect.message");

      if (message && typeof message === "object" && (message as { type?: string }).type === "snapshot.request") {
        await sendSnapshot(port);
        return;
      }

      if (message && typeof message === "object" && (message as { type?: string }).type === "page.subscribe") {
        await handlePortPageSubscribe(portId, message as { pageKey?: unknown; pageUrl?: unknown });
      }
    })();
  });

  void (async () => {
    await bootstrap("onConnect");
    await sendSnapshot(port);
  })();
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
        STORAGE_KEYS.logs,
        STORAGE_KEYS.aiSessions
      ]);

      localConfigPatch = normalizePersistedConfigPatch(localValues[STORAGE_KEYS.localConfig] ?? {});
      sessionConfigPatch = normalizePersistedConfigPatch(sessionValues[STORAGE_KEYS.sessionConfig] ?? {});
      configCache = buildEffectiveConfig(localConfigPatch, sessionConfigPatch);

      const storedLogs = sessionValues[STORAGE_KEYS.logs];
      logs = Array.isArray(storedLogs)
        ? storedLogs
            .map((item: unknown) => createLogEntryFromPersisted(item))
            .filter((item): item is LogEntry => item !== null)
        : [];

      const storedAiSessions = sessionValues[STORAGE_KEYS.aiSessions];
      aiSessions.clear();
      if (Array.isArray(storedAiSessions)) {
        for (const item of storedAiSessions) {
          const parsedSession = AiChatPageSessionSchema.safeParse(item);
          if (parsedSession.success) {
            aiSessions.set(parsedSession.data.pageKey, parsedSession.data);
          }
        }
      }

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
        summary: "Service worker инициализирован.",
        details: {
          reason,
          bootId
        }
      });

      if (shouldKeepNativeConnection()) {
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
          "Демо-команды отключены в настройках."
        ) as ReturnType<typeof createOkResponse>;
      }
      await runNativeCommand(COMMANDS.taskDemoStart, payload);
      return createOkResponse(envelope.id, { workerStatus });

    case COMMANDS.taskDemoStop:
      if (!configCache.protocol.testCommandsEnabled) {
        return createErrorResponse(
          envelope.id,
          "forbidden",
          "Демо-команды отключены в настройках."
        ) as ReturnType<typeof createOkResponse>;
      }
      await runNativeCommand(COMMANDS.taskDemoStop, payload);
      return createOkResponse(envelope.id, { workerStatus });

    case COMMANDS.testHostCrash:
      if (!configCache.protocol.testCommandsEnabled || !configCache.test.allowHostCrashCommand) {
        return createErrorResponse(
          envelope.id,
          "forbidden",
          "Команда аварийного завершения хоста отключена в настройках."
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

    case COMMANDS.hostConnect:
      await connectNativeHost(payload as { reason?: string });
      return createOkResponse(envelope.id, {
        workerStatus,
        desired: desiredRuntime
      });

    case COMMANDS.hostDisconnect:
      await disconnectNativeHost(payload as { reason?: string });
      return createOkResponse(envelope.id, {
        workerStatus,
        desired: desiredRuntime
      });

    case COMMANDS.hostStatus:
      return createOkResponse(envelope.id, {
        workerStatus,
        desired: desiredRuntime,
        host: {
          connected: nativeBridge.connected,
          configuredHostName: configCache.runtime.nativeHostName,
          keepAlive: shouldKeepNativeConnection()
        }
      });

    case COMMANDS.hostRestart:
      await restartNativeHost(payload as { reason?: string });
      return createOkResponse(envelope.id, {
        workerStatus,
        desired: desiredRuntime
      });

    case COMMANDS.configGet:
      return createOkResponse(envelope.id, getRuntimeSnapshot());

    case COMMANDS.configPatch:
      await patchConfig(payload as { scope: "local" | "session"; patch: ExtensionConfigPatch });
      return createOkResponse(envelope.id, getRuntimeSnapshot());

    case COMMANDS.configReset:
      await resetConfigScope(payload as { scope: "local" | "session" });
      return createOkResponse(envelope.id, getRuntimeSnapshot());

    case COMMANDS.logList:
      return createOkResponse(envelope.id, {
        logs: (payload as { limit?: number }).limit
          ? logs.slice(-(payload as { limit: number }).limit)
          : logs
      });

    case COMMANDS.logSubscribe:
      return createOkResponse(envelope.id, getRuntimeSnapshot());

    case COMMANDS.aiModelsCatalog:
      return handleAiModelsCatalogCommand(envelope.id);

    case COMMANDS.aiChatStatus:
      return handleAiStatusCommand(
        envelope.id,
        payload as { pageKey: string; pageUrl?: string }
      );

    case COMMANDS.aiChatSend:
      return handleAiSendCommand(
        envelope.id,
        payload as { pageKey: string; pageUrl: string; origin: "user" | "code"; text: string; requestId?: string }
      );

    case COMMANDS.aiChatCompact:
      return handleAiCompactCommand(
        envelope.id,
        payload as { pageKey: string; pageUrl?: string; mode?: "safe" | "force" }
      );

    case COMMANDS.aiChatResume:
      return handleAiResumeCommand(envelope.id, payload as { pageKey: string });

    case COMMANDS.aiChatReset:
      return handleAiResetCommand(envelope.id, payload as { pageKey: string });

    case COMMANDS.aiChatList:
      return handleAiListCommand(envelope.id);

    default:
      return createErrorResponse(
        envelope.id,
        "unsupported_action",
        `Действие ${envelope.action} не реализовано.`
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
    summary: "Команда запуска воркера выполнена.",
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
      if (!shouldKeepNativeConnection()) {
        await nativeBridge.disconnect();
      }
    }
  }

  workerStatus = {
    ...workerStatus,
    running: false,
    hostConnected: nativeBridge.connected,
    taskId: null,
    sessionId: null,
    nativeHostPid: nativeBridge.connected ? workerStatus.nativeHostPid : null
  };
  await persistRuntimeState();
  await broadcastStatus();
  await appendLog({
    level: "info",
    source: "background",
    event: "worker.stop",
    summary: "Команда остановки воркера выполнена.",
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
    summary: "Подключение к нативному хосту.",
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

  await syncNativeConfig();

  const statusResult = await nativeBridge.sendRequest(COMMANDS.workerStatus, {});
  applyNativeStatus(statusResult);
  await syncAiSessionsFromNative();
  await persistRuntimeState();
  await broadcastStatus();
}

async function connectNativeHost(payload: { reason?: string }): Promise<void> {
  await ensureNativeConnection(payload.reason ?? COMMANDS.hostConnect);
  await appendLog({
    level: "info",
    source: "background",
    event: COMMANDS.hostConnect,
    summary: "Команда подключения к нативному хосту выполнена.",
    details: payload
  });
}

async function disconnectNativeHost(payload: { reason?: string }): Promise<void> {
  if (nativeBridge.connected) {
    await nativeBridge.disconnect();
  }

  desiredRuntime = {
    ...desiredRuntime,
    reconnectAttempt: 0,
    lastDisconnectAt: new Date().toISOString()
  };
  workerStatus = {
    ...workerStatus,
    running: false,
    hostConnected: false,
    nativeHostPid: null
  };
  await persistRuntimeState();
  await broadcastStatus();
  await appendLog({
    level: "info",
    source: "background",
    event: COMMANDS.hostDisconnect,
    summary: "Команда отключения нативного хоста выполнена.",
    details: payload
  });
}

async function restartNativeHost(payload: { reason?: string }): Promise<void> {
  await disconnectNativeHost({
    reason: payload.reason ?? COMMANDS.hostRestart
  });
  await ensureNativeConnection(payload.reason ?? COMMANDS.hostRestart);
  await appendLog({
    level: "info",
    source: "background",
    event: COMMANDS.hostRestart,
    summary: "Команда перезапуска нативного хоста выполнена.",
    details: payload
  });
}

async function reconnectNative(reason: string): Promise<void> {
  if (!shouldKeepNativeConnection()) {
    return;
  }

  try {
    await ensureNativeConnection(reason);
    await appendLog({
      level: "info",
      source: "background",
      event: "native-host.reconnected",
      summary: "Соединение с нативным хостом работает штатно.",
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
      summary: "Не удалось переподключиться к нативному хосту.",
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
      summary: "Попытки переподключения исчерпаны.",
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
    summary: "Запланировано переподключение.",
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
    summary: `Выполнена команда ${action}.`,
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
    workerStatus = parseRuntimeWorkerStatus(message, bootId);
    await persistRuntimeState();
    await broadcastStatus();
  }

  if (message.logEntry) {
    if (isLogLevelEnabled(message.logEntry.level, configCache.logging.level)) {
      logs = [...logs.slice(-(configCache.logging.maxEntries - 1)), message.logEntry];
      await persistLogs();
    }
  }

  if (message.event === STREAM_EVENTS.log && message.logEntry && isLogLevelEnabled(message.logEntry.level, configCache.logging.level)) {
    broadcastStream(message);
  }
}

async function handleAiStream(message: AiStreamMessage): Promise<void> {
  if (message.session) {
    updateAiSessionCache(message.session);
  } else if (message.status) {
    const currentSession = aiSessions.get(message.pageKey);
    if (currentSession) {
      updateAiSessionCache({
        ...currentSession,
        status: message.status,
        state: deriveSessionState(message.status.requestState, currentSession.attachedViewIds.length > 0),
        activeRequestId: message.status.activeRequestId,
        openaiResponseId: message.status.openaiResponseId,
        lastSequenceNumber: message.status.lastSequenceNumber,
        queuedCount: message.status.queueCount,
        recoverable: message.status.recoverable,
        lastError: message.status.lastError
      });
    }
  }

  await persistAiSessions();
  broadcastAiStream(message);
  await syncNativeConnectionLifecycle();
}

async function handleAiStatusCommand(
  requestId: string,
  payload: { pageKey: string; pageUrl?: string }
): Promise<ProtocolResponse> {
  try {
    await ensureNativeConnection(COMMANDS.aiChatStatus);
    const result = AiChatStatusResultSchema.parse(
      await nativeBridge.sendRequest(COMMANDS.aiChatStatus, payload)
    );
    updateAiSessionCache(result.session);
    await persistAiSessions();
    return createOkResponse(requestId, result);
  } catch (error) {
    return createErrorResponse(
      requestId,
      "ai_status_failed",
      error instanceof Error ? error.message : String(error),
      serializeError(error)
    );
  }
}

async function handleAiModelsCatalogCommand(requestId: string): Promise<ProtocolResponse> {
  try {
    if (aiModelCatalogCache && Date.now() < aiModelCatalogCache.expiresAt) {
      return createOkResponse(requestId, aiModelCatalogCache.result);
    }

    await ensureNativeConnection(COMMANDS.aiModelsCatalog);
    const result = AiModelCatalogResultSchema.parse(
      await nativeBridge.sendRequest(COMMANDS.aiModelsCatalog, {})
    );

    aiModelCatalogCache = {
      expiresAt: Date.now() + AI_MODEL_CATALOG_CACHE_TTL_MS,
      result
    };

    return createOkResponse(requestId, result);
  } catch (error) {
    return createErrorResponse(
      requestId,
      "ai_models_catalog_failed",
      error instanceof Error ? error.message : String(error),
      serializeError(error)
    );
  }
}

async function handleAiSendCommand(
  requestId: string,
  payload: { pageKey: string; pageUrl: string; origin: "user" | "code"; text: string; requestId?: string }
): Promise<ProtocolResponse> {
  try {
    await ensureNativeConnection(COMMANDS.aiChatSend);
    const result = AiChatStatusResultSchema.parse(
      await nativeBridge.sendRequest(COMMANDS.aiChatSend, payload)
    );
    updateAiSessionCache(result.session);
    await persistAiSessions();
    broadcastAiSessionSnapshot(result.session, "AI-запрос поставлен в очередь.");
    return createOkResponse(requestId, result);
  } catch (error) {
    return createErrorResponse(
      requestId,
      "ai_send_failed",
      error instanceof Error ? error.message : String(error),
      serializeError(error)
    );
  }
}

async function handleAiCompactCommand(
  requestId: string,
  payload: { pageKey: string; pageUrl?: string; mode?: "safe" | "force" }
): Promise<ProtocolResponse> {
  try {
    await ensureNativeConnection(COMMANDS.aiChatCompact);
    const result = AiChatCompactResultSchema.parse(
      await nativeBridge.sendRequest(COMMANDS.aiChatCompact, payload)
    );
    updateAiSessionCache(result.session);
    await persistAiSessions();
    broadcastAiSessionSnapshot(
      result.session,
      result.triggered ? "Контекст AI-сессии сжат." : "Сжатие контекста AI-сессии завершилось без изменений."
    );
    return createOkResponse(requestId, result);
  } catch (error) {
    return createErrorResponse(
      requestId,
      "ai_compact_failed",
      error instanceof Error ? error.message : String(error),
      serializeError(error)
    );
  }
}

async function handleAiResumeCommand(
  requestId: string,
  payload: { pageKey: string }
): Promise<ProtocolResponse> {
  try {
    await ensureNativeConnection(COMMANDS.aiChatResume);
    const result = AiChatStatusResultSchema.parse(
      await nativeBridge.sendRequest(COMMANDS.aiChatResume, payload)
    );
    updateAiSessionCache(result.session);
    await persistAiSessions();
    broadcastAiSessionSnapshot(result.session, "Сессия AI для страницы возобновлена.");
    return createOkResponse(requestId, result);
  } catch (error) {
    return createErrorResponse(
      requestId,
      "ai_resume_failed",
      error instanceof Error ? error.message : String(error),
      serializeError(error)
    );
  }
}

async function handleAiResetCommand(
  requestId: string,
  payload: { pageKey: string }
): Promise<ProtocolResponse> {
  try {
    await ensureNativeConnection(COMMANDS.aiChatReset);
    const result = AiChatStatusResultSchema.parse(
      await nativeBridge.sendRequest(COMMANDS.aiChatReset, payload)
    );
    updateAiSessionCache(result.session);
    await persistAiSessions();
    broadcastAiSessionSnapshot(result.session, "Сессия AI для страницы сброшена.");
    await syncNativeConnectionLifecycle();
    return createOkResponse(requestId, result);
  } catch (error) {
    return createErrorResponse(
      requestId,
      "ai_reset_failed",
      error instanceof Error ? error.message : String(error),
      serializeError(error)
    );
  }
}

async function handleAiListCommand(requestId: string): Promise<ProtocolResponse> {
  try {
    await ensureNativeConnection(COMMANDS.aiChatList);
    const result = AiChatListResultSchema.parse(
      await nativeBridge.sendRequest(COMMANDS.aiChatList, {})
    );

    for (const session of result.sessions) {
      updateAiSessionCache(session);
    }
    await persistAiSessions();

    return createOkResponse(requestId, {
      sessions: [...aiSessions.values()].sort((left, right) => left.pageKey.localeCompare(right.pageKey))
    });
  } catch (error) {
    return createErrorResponse(
      requestId,
      "ai_list_failed",
      error instanceof Error ? error.message : String(error),
      serializeError(error)
    );
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
      summary: "Открытие оверлея отклонено для неподдерживаемой вкладки.",
      details: probeResult
    });
    return createOverlayErrorResponse(
      requestId,
      "unsupported_tab",
      "Оверлейный терминал доступен только на обычных страницах http(s).",
      probeResult
    );
  }

  if (!probeResult.ready) {
    const code = probeResult.reason ?? "content_not_ready";
    const message =
      code === "content_not_ready"
        ? "Оверлейный терминал будет доступен после перезагрузки страницы."
        : "Не удалось открыть оверлейный терминал на текущей странице.";
    await appendLog({
      level: code === "content_not_ready" ? "warn" : "error",
      source: "background",
      event: COMMANDS.overlayOpen,
      summary: "Открытие оверлея отклонено: страница ещё не готова.",
      details: probeResult
    });
    return createOverlayErrorResponse(requestId, code, message, probeResult);
  }

  const targetTab = await requireOverlayTargetTab(payload, sender);
  if (!targetTab?.id) {
    return createOverlayErrorResponse(
      requestId,
      "unsupported_tab",
      "Не удалось определить вкладку для оверлейного терминала."
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
      summary: "Не удалось открыть оверлейный терминал.",
      details: {
        tabId: targetTab.id,
        url: getResolvedTabUrl(targetTab),
        error: serializeError(error)
      }
    });
    return createOverlayErrorResponse(
      requestId,
      "overlay_open_failed",
      "Не удалось открыть оверлейный терминал на текущей странице.",
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
      "Не удалось определить вкладку для оверлейного терминала."
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
  const targetTab = await resolveOverlayTargetTab(payload, sender);
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
    throw new Error("Не найдена подходящая вкладка для команды оверлея.");
  }

  const contentEnvelope = createEnvelope(action, "background", "content", payload);
  const rawResponse = await chrome.tabs.sendMessage(resolvedTab.id, contentEnvelope);
  const response = ProtocolResponseSchema.parse(rawResponse);
  if (!response.ok) {
    throw new Error(response.error?.message ?? `Не удалось выполнить content-команду ${action}.`);
  }

  await appendLog({
    level: "info",
    source: "background",
    event: action,
    summary: `Команда ${action} отправлена на вкладку ${resolvedTab.id}.`,
    details: {
      payload,
      url: getResolvedTabUrl(resolvedTab)
    }
  });

  return response.result;
}

async function resolveTargetTab(explicitTabId?: number, expectedUrl?: string): Promise<chrome.tabs.Tab | undefined> {
  if (explicitTabId) {
    try {
      return await chrome.tabs.get(explicitTabId);
    } catch {
      return undefined;
    }
  }

  if (typeof expectedUrl === "string" && expectedUrl.length > 0) {
    const matchingTabs = (await chrome.tabs.query({})).filter(
      (tab) => tab.url === expectedUrl || tab.pendingUrl === expectedUrl
    );
    if (matchingTabs.length > 0) {
      return matchingTabs.sort((left, right) => (right.lastAccessed ?? 0) - (left.lastAccessed ?? 0))[0];
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
  const targetTab = await resolveOverlayTargetTab(payload, sender);
  if (!targetTab?.id) {
    return undefined;
  }

  const supportReason = getOverlaySupportReason(getOverlaySupportUrl(targetTab, payload));
  if (supportReason) {
    return undefined;
  }

  return targetTab;
}

async function resolveOverlayTargetTab(
  payload: OverlayTargetPayload,
  sender: chrome.runtime.MessageSender
): Promise<chrome.tabs.Tab | undefined> {
  const explicitTabId = typeof payload.tabId === "number" ? payload.tabId : undefined;
  const senderTabId = explicitTabId === undefined && !payload.expectedUrl ? sender.tab?.id : undefined;
  return resolveTargetTab(explicitTabId ?? senderTabId, payload.expectedUrl);
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
    summary: "Попытка внедрить content-скрипт в текущую страницу.",
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
      summary: "Content-скрипт внедрён в текущую страницу.",
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
      summary: "Не удалось внедрить content-скрипт.",
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

async function handlePortPageSubscribe(
  portId: string,
  message: { pageKey?: unknown; pageUrl?: unknown }
): Promise<void> {
  const portState = uiPorts.get(portId);
  if (!portState) {
    return;
  }

  const nextPageKey = typeof message.pageKey === "string" && message.pageKey.length > 0 ? message.pageKey : null;
  const nextPageUrl = typeof message.pageUrl === "string" && message.pageUrl.length > 0 ? message.pageUrl : null;

  if (portState.pageKey && portState.pageKey !== nextPageKey) {
    const previousSession = aiSessions.get(portState.pageKey);
    if (previousSession) {
      updateAiSessionCache({
        ...previousSession,
        attachedViewIds: previousSession.attachedViewIds.filter((viewId) => viewId !== portState.viewId)
      });
    }
  }

  portState.pageKey = nextPageKey;
  portState.pageUrl = nextPageUrl;
  uiPorts.set(portId, portState);

  if (!nextPageKey) {
    await persistAiSessions();
    return;
  }

  const existingSession = aiSessions.get(nextPageKey);
  if (existingSession) {
    updateAiSessionCache({
      ...existingSession,
      pageUrlSample: nextPageUrl ?? existingSession.pageUrlSample,
      attachedViewIds: mergeAttachedViewIds(existingSession.attachedViewIds, portState.viewId)
    });
  } else {
    const status = createDefaultAiStatus(nextPageKey, nextPageUrl, false);
    updateAiSessionCache({
      pageKey: nextPageKey,
      pageUrlSample: nextPageUrl,
      attachedViewIds: [portState.viewId],
      state: deriveSessionState(status.requestState, true),
      activeRequestId: null,
      openaiResponseId: null,
      lastSequenceNumber: null,
      queuedCount: 0,
      recoverable: false,
      lastCheckpointAt: null,
      lastError: null,
      messages: [],
      queue: [],
      status
    });
  }

  await persistAiSessions();
}

async function detachViewFromPort(portId: string): Promise<void> {
  const portState = uiPorts.get(portId);
  uiPorts.delete(portId);
  if (!portState?.pageKey) {
    await syncNativeConnectionLifecycle();
    return;
  }

  const session = aiSessions.get(portState.pageKey);
  if (!session) {
    return;
  }

  updateAiSessionCache({
    ...session,
    attachedViewIds: session.attachedViewIds.filter((viewId) => viewId !== portState.viewId)
  });
  await persistAiSessions();
  await syncNativeConnectionLifecycle();
}

function mergeAttachedViewIds(currentIds: readonly string[], nextId: string): string[] {
  return Array.from(new Set([...currentIds, nextId]));
}

function deriveSessionState(
  requestState: AiChatPageSession["status"]["requestState"],
  hasAttachedViews: boolean
): AiChatPageSession["state"] {
  if (!hasAttachedViews && requestState !== "idle") {
    return "detached";
  }

  return requestState;
}

function updateAiSessionCache(session: AiChatPageSession): void {
  const currentSession = aiSessions.get(session.pageKey);
  const attachedViewIds = session.attachedViewIds.length > 0
    ? session.attachedViewIds
    : currentSession?.attachedViewIds ?? [];
  const normalizedSession: AiChatPageSession = {
    ...session,
    pageUrlSample: session.pageUrlSample ?? currentSession?.pageUrlSample ?? null,
    attachedViewIds,
    state: deriveSessionState(session.status.requestState, attachedViewIds.length > 0),
    activeRequestId: session.activeRequestId ?? session.status.activeRequestId,
    openaiResponseId: session.openaiResponseId ?? session.status.openaiResponseId,
    lastSequenceNumber: session.lastSequenceNumber ?? session.status.lastSequenceNumber,
    queuedCount: session.queuedCount ?? session.status.queueCount,
    recoverable: session.recoverable ?? session.status.recoverable,
    lastError: session.lastError ?? session.status.lastError
  };
  aiSessions.set(normalizedSession.pageKey, normalizedSession);
}

async function persistAiSessions(): Promise<void> {
  let lastError: unknown = null;
  for (const profile of AI_SESSION_PERSISTENCE_PROFILES) {
    try {
      await chrome.storage.session.set({
        [STORAGE_KEYS.aiSessions]: buildPersistedAiSessions(profile)
      });
      return;
    } catch (error) {
      lastError = error;
    }
  }

  console.warn("Не удалось сохранить AI-сессии в chrome.storage.session.", lastError);
}

async function persistLogs(): Promise<void> {
  let lastError: unknown = null;
  const entryLimits = Array.from(
    new Set([
      Math.max(0, Math.min(logs.length, configCache.logging.maxEntries)),
      ...LOG_PERSISTENCE_MAX_ENTRIES
    ])
  );

  for (const maxEntries of entryLimits) {
    try {
      await chrome.storage.session.set({
        [STORAGE_KEYS.logs]: maxEntries > 0 ? logs.slice(-maxEntries) : []
      });
      return;
    } catch (error) {
      lastError = error;
    }
  }

  console.warn("Не удалось сохранить runtime-логи в chrome.storage.session.", lastError);
}

function buildPersistedAiSessions(profile: {
  maxSessions: number;
  maxMessages: number;
  maxQueueItems: number;
}): AiChatPageSession[] {
  if (profile.maxSessions <= 0) {
    return [];
  }

  return [...aiSessions.values()]
    .sort((left, right) => compareAiSessionPersistencePriority(left, right))
    .slice(0, profile.maxSessions)
    .map((session) => buildPersistedAiSession(session, profile));
}

function buildPersistedAiSession(
  session: AiChatPageSession,
  profile: {
    maxMessages: number;
    maxQueueItems: number;
  }
): AiChatPageSession {
  return {
    ...session,
    pageUrlSample: trimPersistedNullableText(session.pageUrlSample, PERSISTED_PAGE_URL_MAX_LENGTH),
    lastError: trimPersistedNullableText(session.lastError, PERSISTED_LAST_ERROR_MAX_LENGTH),
    messages: profile.maxMessages > 0
      ? session.messages.slice(-profile.maxMessages).map((message) => ({
        ...message,
        text: trimPersistedRequiredText(message.text, PERSISTED_MESSAGE_TEXT_MAX_LENGTH),
        summary: trimPersistedOptionalText(message.summary, PERSISTED_SUMMARY_MAX_LENGTH),
        meta: undefined
      }))
      : [],
    queue: profile.maxQueueItems > 0
      ? session.queue.slice(-profile.maxQueueItems).map((item) => ({
        ...item,
        text: trimPersistedRequiredText(item.text, PERSISTED_QUEUE_TEXT_MAX_LENGTH)
      }))
      : [],
    status: {
      ...session.status,
      pageUrlSample: trimPersistedNullableText(session.status.pageUrlSample, PERSISTED_PAGE_URL_MAX_LENGTH),
      lastError: trimPersistedNullableText(session.status.lastError, PERSISTED_LAST_ERROR_MAX_LENGTH),
      rateLimits: undefined,
      currentModelBudget: null,
      modelBudgets: {}
    }
  };
}

function trimPersistedRequiredText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function trimPersistedNullableText(value: string | null, maxLength: number): string | null {
  if (value === null) {
    return value;
  }

  return trimPersistedRequiredText(value, maxLength);
}

function trimPersistedOptionalText(value: string | null | undefined, maxLength: number): string | null | undefined {
  if (typeof value !== "string") {
    return value;
  }

  return trimPersistedRequiredText(value, maxLength);
}

function compareAiSessionPersistencePriority(left: AiChatPageSession, right: AiChatPageSession): number {
  const leftPriority = getAiSessionPersistencePriority(left);
  const rightPriority = getAiSessionPersistencePriority(right);
  if (leftPriority !== rightPriority) {
    return rightPriority - leftPriority;
  }

  return getAiSessionRecency(right) - getAiSessionRecency(left);
}

function getAiSessionPersistencePriority(session: AiChatPageSession): number {
  if (
    session.status.requestState !== "idle" ||
    session.recoverable ||
    session.queue.length > 0 ||
    session.activeRequestId !== null ||
    session.openaiResponseId !== null
  ) {
    return 2;
  }

  if (session.attachedViewIds.length > 0) {
    return 1;
  }

  return 0;
}

function getAiSessionRecency(session: AiChatPageSession): number {
  const candidates = [
    session.lastCheckpointAt,
    session.messages.at(-1)?.ts ?? null
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  for (const value of candidates) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return 0;
}

function shouldKeepNativeConnection(): boolean {
  return desiredRuntime.desiredRunning || hasActiveAiSessions() || uiPorts.size > 0;
}

function hasActiveAiSessions(): boolean {
  for (const session of aiSessions.values()) {
    if (
      session.queuedCount > 0 ||
      session.recoverable ||
      session.activeRequestId !== null ||
      session.openaiResponseId !== null ||
      (session.status.requestState !== "idle" && session.status.requestState !== "error")
    ) {
      return true;
    }
  }

  return false;
}

async function syncNativeConfig(): Promise<void> {
  if (!nativeBridge.connected) {
    return;
  }

  await nativeBridge.sendRequest(NATIVE_CONFIG_SYNC_ACTION, {
    config: configCache
  });
}

async function syncAiSessionsFromNative(): Promise<void> {
  if (!nativeBridge.connected) {
    return;
  }

  try {
    const result = AiChatListResultSchema.parse(
      await nativeBridge.sendRequest(COMMANDS.aiChatList, {})
    );

    const attachedByPage = new Map<string, string[]>();
    for (const existingSession of aiSessions.values()) {
      attachedByPage.set(existingSession.pageKey, [...existingSession.attachedViewIds]);
    }

    aiSessions.clear();
    for (const session of result.sessions) {
      updateAiSessionCache({
        ...session,
        attachedViewIds: attachedByPage.get(session.pageKey) ?? session.attachedViewIds
      });
    }

    await persistAiSessions();
  } catch (error) {
    await appendLog({
      level: "warn",
      source: "background",
      event: "ai.chat.list.sync.failed",
      summary: "Не удалось восстановить AI-сессии из нативного хоста.",
      details: serializeError(error)
    });
  }
}

async function syncNativeConnectionLifecycle(): Promise<void> {
  if (shouldKeepNativeConnection() || !nativeBridge.connected) {
    return;
  }

  await nativeBridge.disconnect();
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
    summary: `Обновлён конфиг области ${input.scope}.`,
    details: {
      scope: input.scope,
      patch: redactSensitiveConfigData(input.patch)
    }
  });
}

async function resetConfigScope(input: {
  scope: "local" | "session";
}): Promise<void> {
  if (input.scope === "local") {
    localConfigPatch = {};
    await chrome.storage.local.remove(STORAGE_KEYS.localConfig);
  } else {
    sessionConfigPatch = {};
    await chrome.storage.session.remove(STORAGE_KEYS.sessionConfig);
  }

  configCache = buildEffectiveConfig(localConfigPatch, sessionConfigPatch);
  await syncConfigSideEffects({ ai: {}, logging: {}, protocol: {}, runtime: {}, test: {}, ui: {} });
  await broadcastConfig();
  await appendLog({
    level: "info",
    source: "config-store",
    event: "config.reset",
    summary: `Сброшен конфиг области ${input.scope}.`,
    details: {
      scope: input.scope
    }
  });
}

function sanitizeRuntimeMessageForLogs(message: unknown): unknown {
  if (!message || typeof message !== "object") {
    return message;
  }

  const envelope = structuredClone(message as Record<string, unknown>);
  if (envelope.action !== COMMANDS.configPatch) {
    return envelope;
  }

  const payload = envelope.payload;
  if (!payload || typeof payload !== "object") {
    return envelope;
  }

  const patchPayload = payload as Record<string, unknown>;
  if ("patch" in patchPayload) {
    patchPayload.patch = redactSensitiveConfigData(patchPayload.patch);
  }

  return envelope;
}
async function appendLog(input: unknown): Promise<void> {
  const entry = createLogEntry(LogEntryInputSchema.parse(input), configCache.logging.collapseThreshold);
  if (!isLogLevelEnabled(entry.level, configCache.logging.level)) {
    return;
  }

  logs = [...logs.slice(-(configCache.logging.maxEntries - 1)), entry];
  await persistLogs();
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
    await persistLogs();
  }

  if (!nativeBridge.connected) {
    return;
  }

  if (patch.ai || patch.runtime?.nativeHostName !== undefined) {
    await syncNativeConfig();
  }

  if (!workerStatus.running) {
    await syncNativeConnectionLifecycle();
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

  await syncNativeConnectionLifecycle();
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
  const snapshot = getRuntimeSnapshot();
  port.postMessage({
    stream: "runtime",
    event: STREAM_EVENTS.snapshot,
    level: "info",
    summary: "Снимок runtime",
    details: null,
    ts: new Date().toISOString(),
    correlationId: null,
    status: snapshot.workerStatus,
    workerStatus: snapshot.workerStatus,
    desired: snapshot.desired,
    config: snapshot.config,
    logs: snapshot.logs
  });
}

async function broadcastStatus(): Promise<void> {
  broadcastStream({
    stream: "runtime",
    event: STREAM_EVENTS.status,
    level: "info",
    summary: "Статус воркера обновлён.",
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
    summary: "Конфиг обновлён.",
    details: null,
    ts: new Date().toISOString(),
    correlationId: null,
    config: configCache
  });
}

function broadcastStream(message: unknown): void {
  for (const [portId, portState] of uiPorts.entries()) {
    try {
      portState.port.postMessage(message);
    } catch {
      uiPorts.delete(portId);
    }
  }
}

function broadcastAiStream(message: AiStreamMessage): void {
  const session = aiSessions.get(message.pageKey);
  const enrichedMessage: AiStreamMessage =
    session && message.session
      ? {
          ...message,
          session
        }
      : message;

  for (const [portId, portState] of uiPorts.entries()) {
    if (portState.pageKey !== message.pageKey) {
      continue;
    }

    try {
      portState.port.postMessage(enrichedMessage);
    } catch {
      uiPorts.delete(portId);
    }
  }
}

function broadcastAiSessionSnapshot(session: AiChatPageSession, summary: string): void {
  const normalizedSession = aiSessions.get(session.pageKey) ?? session;
  broadcastAiStream(AiStreamMessageSchema.parse({
    stream: "ai",
    event: "ai.chat.snapshot",
    level: "info",
    summary,
    details: null,
    ts: new Date().toISOString(),
    correlationId: null,
    pageKey: normalizedSession.pageKey,
    pageUrl: normalizedSession.pageUrlSample,
    requestId: normalizedSession.activeRequestId,
    sequenceNumber: normalizedSession.lastSequenceNumber,
    status: normalizedSession.status,
    session: normalizedSession,
    queue: normalizedSession.queue,
    delta: undefined
  }));
}
