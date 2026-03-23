import {
  buildAiChatTranscriptItems,
  type AiChatPageSession,
  type AiChatTranscriptItem
} from "./ai";
import type { ExtensionConfig } from "./config";
import type { LogEntry } from "./logging";
import {
  buildOverlayActivityFeed,
  type OverlayActivityItem,
  type OverlayConsoleEntry
} from "./overlay-feed";
import type { WorkerStatus } from "./runtime-state";

export type ConsoleLogExportPayload = {
  schemaVersion: 1;
  scope: "console";
  exportedAt: string;
  pageContext: {
    pageKey: string;
    pageUrl: string;
  } | null;
  workerStatus: WorkerStatus | null;
  config: SafeExtensionConfigSnapshot | null;
  visibleActivitySequenceFloor: number;
  consoleEntries: OverlayConsoleEntry[];
  runtimeLogs: LogEntry[];
  visibleActivityFeed: OverlayActivityItem[];
};

export type ChatLogExportPayload = {
  schemaVersion: 1;
  scope: "chat";
  exportedAt: string;
  pageContext: {
    pageKey: string;
    pageUrl: string;
  } | null;
  aiConfig: SafeAiConfigSnapshot | null;
  session: AiChatPageSession | null;
  transcriptItems: AiChatTranscriptItem[];
};

export type SafeAiConfigSnapshot = {
  allowedModels: ExtensionConfig["ai"]["allowedModels"];
  chat: ExtensionConfig["ai"]["chat"];
  compaction: ExtensionConfig["ai"]["compaction"];
  promptCaching: ExtensionConfig["ai"]["promptCaching"];
  rateLimits: ExtensionConfig["ai"]["rateLimits"];
};

export type SafeExtensionConfigSnapshot = Omit<ExtensionConfig, "ai"> & {
  ai: SafeAiConfigSnapshot;
};

function cloneSafeAiConfig(config: ExtensionConfig | null): SafeAiConfigSnapshot | null {
  if (!config) {
    return null;
  }

  return {
    allowedModels: [...config.ai.allowedModels],
    chat: {
      ...config.ai.chat,
      structuredOutput: {
        ...config.ai.chat.structuredOutput
      }
    },
    compaction: {
      ...config.ai.compaction
    },
    promptCaching: {
      ...config.ai.promptCaching
    },
    rateLimits: {
      ...config.ai.rateLimits
    }
  };
}

export function buildSafeExtensionConfigSnapshot(
  config: ExtensionConfig | null
): SafeExtensionConfigSnapshot | null {
  if (!config) {
    return null;
  }

  const safeAiConfig = cloneSafeAiConfig(config);
  return {
    ...config,
    ui: {
      ...config.ui,
      overlay: {
        ...config.ui.overlay
      }
    },
    logging: {
      ...config.logging
    },
    runtime: {
      ...config.runtime,
      reconnectPolicy: {
        ...config.runtime.reconnectPolicy
      }
    },
    protocol: {
      ...config.protocol
    },
    ai: safeAiConfig!,
    test: {
      ...config.test
    }
  };
}

export function buildConsoleLogExportPayload(input: {
  exportedAt: string;
  pageContext: {
    pageKey: string;
    pageUrl: string;
  } | null;
  workerStatus: WorkerStatus | null;
  currentConfig: ExtensionConfig | null;
  consoleEntries: readonly OverlayConsoleEntry[];
  runtimeLogs: readonly LogEntry[];
  runtimeLogSequences: ReadonlyMap<string, number>;
  visibleActivitySequenceFloor: number;
}): ConsoleLogExportPayload {
  const visibleActivityFeed = buildOverlayActivityFeed(
    input.consoleEntries,
    input.runtimeLogs,
    input.runtimeLogSequences
  ).filter((item) => item.sequence >= input.visibleActivitySequenceFloor);

  return {
    schemaVersion: 1,
    scope: "console",
    exportedAt: input.exportedAt,
    pageContext: input.pageContext,
    workerStatus: input.workerStatus,
    config: buildSafeExtensionConfigSnapshot(input.currentConfig),
    visibleActivitySequenceFloor: input.visibleActivitySequenceFloor,
    consoleEntries: [...input.consoleEntries],
    runtimeLogs: [...input.runtimeLogs],
    visibleActivityFeed
  };
}

export function buildChatLogExportPayload(input: {
  exportedAt: string;
  pageContext: {
    pageKey: string;
    pageUrl: string;
  } | null;
  currentConfig: ExtensionConfig | null;
  session: AiChatPageSession | null;
}): ChatLogExportPayload {
  const promptText = input.currentConfig?.ai.chat.instructions ?? "";
  return {
    schemaVersion: 1,
    scope: "chat",
    exportedAt: input.exportedAt,
    pageContext: input.pageContext,
    aiConfig: cloneSafeAiConfig(input.currentConfig),
    session: input.session,
    transcriptItems: buildAiChatTranscriptItems(input.session?.messages ?? [], promptText)
  };
}

function sanitizeFileNameSegment(value: string): string {
  const sanitized = value
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return sanitized.slice(0, 64) || "page";
}

function formatExportTimestamp(value: string): string {
  return value.replace(/[:.]/g, "-");
}

export function formatLogExportFileName(
  scope: "console" | "chat",
  exportedAt: string,
  pageKey?: string | null
): string {
  const timestamp = formatExportTimestamp(exportedAt);
  const pageSuffix = pageKey ? `-${sanitizeFileNameSegment(pageKey)}` : "";
  return `lextrace-${scope}-log${pageSuffix}-${timestamp}.json`;
}
