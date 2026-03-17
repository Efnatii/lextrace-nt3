export const EXTENSION_DISPLAY_NAME = "LexTrace NT3";
export const PROTOCOL_VERSION = 1;
export const NATIVE_HOST_NAME = "com.lextrace.nt3.host";
export const OPENAI_API_KEY_ENV_VAR_NAME = "OPENAI_API_KEY";
export const RUNTIME_STREAM_PORT = "lextrace-runtime-stream";
export const RECONNECT_ALARM_NAME = "lextrace-native-reconnect";
export const STORAGE_KEYS = {
  localConfig: "lextrace.config.local",
  sessionConfig: "lextrace.config.session",
  runtimeState: "lextrace.runtime.state",
  logs: "lextrace.runtime.logs",
  aiSessions: "lextrace.ai.sessions"
} as const;

export const MAX_LOG_DETAILS_PREVIEW = 240;

export const COMMANDS = {
  ping: "ping",
  overlayProbe: "overlay.probe",
  overlayOpen: "overlay.open",
  overlayClose: "overlay.close",
  workerStart: "worker.start",
  workerStop: "worker.stop",
  workerStatus: "worker.status",
  configGet: "config.get",
  configPatch: "config.patch",
  configReset: "config.reset",
  logList: "log.list",
  logSubscribe: "log.subscribe",
  logRecord: "log.record",
  aiModelsCatalog: "ai.models.catalog",
  aiChatStatus: "ai.chat.status",
  aiChatSend: "ai.chat.send",
  aiChatResume: "ai.chat.resume",
  aiChatReset: "ai.chat.reset",
  aiChatList: "ai.chat.list",
  taskDemoStart: "task.demo.start",
  taskDemoStop: "task.demo.stop",
  testHostCrash: "test.host.crash"
} as const;

export const STREAM_EVENTS = {
  snapshot: "runtime.snapshot",
  log: "runtime.log",
  status: "runtime.status",
  config: "runtime.config"
} as const;

export const AI_STREAM_EVENTS = {
  snapshot: "ai.chat.snapshot",
  status: "ai.chat.status",
  delta: "ai.chat.delta",
  completed: "ai.chat.completed",
  error: "ai.chat.error",
  compactionStarted: "ai.chat.compaction.started",
  compactionCompleted: "ai.chat.compaction.completed",
  rateLimitWaiting: "ai.chat.rate_limit.waiting"
} as const;
