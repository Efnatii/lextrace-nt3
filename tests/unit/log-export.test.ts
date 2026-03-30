import { describe, expect, it } from "vitest";

import { createDefaultAiStatus } from "../../extension/src/shared/ai";
import { defaultConfig } from "../../extension/src/shared/config";
import {
  buildChatLogExportPayload,
  buildConsoleLogExportPayload,
  formatLogExportFileName
} from "../../extension/src/shared/log-export";
import { createInitialWorkerStatus } from "../../extension/src/shared/runtime-state";

describe("log export helpers", () => {
  it("builds a safe console export payload with visible activity feed", () => {
    const workerStatus = createInitialWorkerStatus("boot-12345678");
    const consoleEntries = [
      {
        id: "term-1",
        ts: "2026-03-22T10:00:00.000Z",
        kind: "command" as const,
        text: "help",
        sequence: 0
      },
      {
        id: "term-2",
        ts: "2026-03-22T10:00:02.000Z",
        kind: "result" as const,
        text: "ok",
        sequence: 2
      }
    ];
    const runtimeLogs = [
      {
        id: "log-1",
        ts: "2026-03-22T10:00:01.000Z",
        level: "info" as const,
        source: "content",
        event: "overlay.open",
        summary: "opened",
        details: {
          step: 1
        },
        correlationId: null,
        collapsedByDefault: false
      },
      {
        id: "log-2",
        ts: "2026-03-22T10:00:03.000Z",
        level: "warn" as const,
        source: "content",
        event: "overlay.warn",
        summary: "warning",
        details: {
          step: 2
        },
        correlationId: null,
        collapsedByDefault: false
      }
    ];

    const payload = buildConsoleLogExportPayload({
      exportedAt: "2026-03-22T10:05:00.000Z",
      pageContext: {
        pageKey: "https://example.com/path",
        pageUrl: "https://example.com/path"
      },
      workerStatus,
      currentConfig: defaultConfig,
      consoleEntries,
      runtimeLogs,
      runtimeLogSequences: new Map([
        ["log-1", 1],
        ["log-2", 3]
      ]),
      visibleActivitySequenceFloor: 1
    });

    expect(payload.scope).toBe("console");
    expect("openAiApiKey" in (payload.config?.ai ?? {})).toBe(false);
    expect(payload.visibleActivityFeed.map((item) => item.id)).toEqual(["log-1", "term-2", "log-2"]);
  });

  it("builds a chat export payload with transcript items and safe AI config", () => {
    const pageKey = "https://example.com/chat";
    const status = createDefaultAiStatus(pageKey, pageKey, true);
    const config = {
      ...defaultConfig,
      ai: {
        ...defaultConfig.ai,
        openAiApiKey: "sk-secret",
        chat: {
          ...defaultConfig.ai.chat,
          instructions: "Chat system prompt"
        }
      }
    };
    const session = {
      pageKey,
      pageUrlSample: pageKey,
      attachedViewIds: [],
      state: "idle" as const,
      activeRequestId: null,
      openaiResponseId: null,
      lastSequenceNumber: null,
      queuedCount: 0,
      recoverable: false,
      lastCheckpointAt: null,
      lastError: null,
      messages: [
        {
          id: "user-1",
          pageKey,
          requestId: "req-1",
          origin: "user" as const,
          role: "user" as const,
          kind: "user" as const,
          text: "hello",
          ts: "2026-03-22T10:00:00.000Z",
          state: "completed" as const,
          meta: null
        },
        {
          id: "assistant-1",
          pageKey,
          requestId: "req-1",
          origin: "assistant" as const,
          role: "assistant" as const,
          kind: "assistant" as const,
          text: "world",
          ts: "2026-03-22T10:00:01.000Z",
          state: "completed" as const,
          meta: null
        }
      ],
      queue: [],
      status
    };

    const payload = buildChatLogExportPayload({
      exportedAt: "2026-03-22T10:05:00.000Z",
      pageContext: {
        pageKey,
        pageUrl: pageKey
      },
      currentConfig: config,
      session
    });

    expect(payload.scope).toBe("chat");
    expect(payload.aiConfig?.chat.instructions).toBe("Chat system prompt");
    expect(payload.aiConfig?.retries).toEqual(defaultConfig.ai.retries);
    expect(payload.aiConfig?.queueRetries).toEqual(defaultConfig.ai.queueRetries);
    expect(payload.aiConfig).not.toHaveProperty("openAiApiKey");
    expect(payload.transcriptItems[0]).toMatchObject({
      type: "system-prompt",
      promptText: "Chat system prompt"
    });
    expect(payload.transcriptItems.at(-1)).toMatchObject({
      type: "message"
    });
  });

  it("formats export file names safely", () => {
    expect(
      formatLogExportFileName("chat", "2026-03-22T10:05:00.123Z", "https://example.com/very/long/path?q=1")
    ).toBe("lextrace-chat-log-example.com-very-long-path-q-1-2026-03-22T10-05-00-123Z.json");
  });
});
