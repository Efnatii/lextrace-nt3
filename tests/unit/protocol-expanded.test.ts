import { describe, expect, it } from "vitest";

import { COMMANDS } from "../../extension/src/shared/constants";
import {
  createEnvelope,
  createErrorResponse,
  createOkResponse,
  parseNativeHostMessage,
  validateEnvelope,
  validateEnvelopePayload
} from "../../extension/src/shared/protocol";
import {
  createInitialDesiredRuntime,
  createInitialWorkerStatus,
  parseRuntimeWorkerStatus,
  parseWorkerStatusLike
} from "../../extension/src/shared/runtime-state";

describe("protocol payload defaults", () => {
  it.each([
    [COMMANDS.hostDisconnect, {}],
    [COMMANDS.hostRestart, {}],
    [COMMANDS.workerStart, {}],
    [COMMANDS.workerStop, {}],
    [COMMANDS.configGet, {}],
    [COMMANDS.configReset, { scope: "local" }],
    [COMMANDS.logList, {}],
    [COMMANDS.aiModelsCatalog, {}],
    [COMMANDS.aiChatCompact, { pageKey: "page", mode: "safe" }],
    [COMMANDS.aiChatResume, { pageKey: "page" }],
    [COMMANDS.aiChatReset, { pageKey: "page" }],
    [COMMANDS.aiChatList, {}],
    [COMMANDS.taskDemoStart, {}],
    [COMMANDS.taskDemoStop, {}]
  ])("applies defaults for %s", (action, payload) => {
    const envelope = createEnvelope(action, "tests", "background", payload);
    expect(validateEnvelopePayload(validateEnvelope(envelope))).toEqual(payload);
  });

  it("keeps an explicit correlation id in envelopes", () => {
    const envelope = createEnvelope(COMMANDS.ping, "tests", "background", undefined, "corr-1");
    expect(envelope.version).toBe(1);
    expect(envelope.correlationId).toBe("corr-1");
    expect(envelope.scope).toBe("command");
  });

  it("creates successful protocol responses", () => {
    expect(createOkResponse("req-1", { ok: true })).toMatchObject({
      id: "req-1",
      ok: true,
      result: { ok: true }
    });
  });

  it("creates error protocol responses", () => {
    expect(createErrorResponse("req-2", "broken", "failed", { code: 1 })).toMatchObject({
      id: "req-2",
      ok: false,
      error: {
        code: "broken",
        message: "failed",
        details: { code: 1 }
      }
    });
  });
});

describe("native-host message normalization", () => {
  it("returns null for completely unknown payloads", () => {
    expect(parseNativeHostMessage({ hello: "world" })).toBeNull();
  });

  it("parses direct runtime snapshot streams without normalization", () => {
    const parsed = parseNativeHostMessage({
      stream: "runtime",
      event: "runtime.snapshot",
      level: "info",
      summary: "snapshot",
      ts: "2026-03-22T12:00:00.000Z",
      correlationId: null,
      status: {
        running: false
      },
      workerStatus: {
        running: true,
        bootId: "boot-1",
        sessionId: null,
        hostConnected: true,
        taskId: null,
        startedAt: null,
        lastHeartbeatAt: null,
        reconnectAttempt: 0,
        nativeHostPid: 123
      },
      desired: {
        desiredRunning: false,
        desiredTaskId: null,
        sessionId: null,
        reconnectAttempt: 0,
        lastDisconnectAt: null
      },
      config: {},
      logs: []
    });

    expect(parsed).toMatchObject({
      kind: "stream",
      normalized: false
    });
  });

  it("normalizes legacy runtime logs that omit logEntry", () => {
    const parsed = parseNativeHostMessage({
      stream: "runtime",
      eventName: "runtime.log",
      level: "warn",
      summary: "legacy runtime log",
      details: {
        reason: "legacy"
      },
      timestamp: "2026-03-22T12:00:00.000Z",
      correlationId: null
    });

    expect(parsed).toMatchObject({
      kind: "stream",
      normalized: true
    });
    if (!parsed || parsed.kind !== "stream" || parsed.message.stream !== "runtime") {
      throw new Error("Expected normalized runtime stream.");
    }
    expect(parsed.message.logEntry).toMatchObject({
      level: "warn",
      event: "runtime.log",
      summary: "legacy runtime log"
    });
  });

  it("normalizes legacy AI status streams into the current shape", () => {
    const parsed = parseNativeHostMessage({
      stream: "ai",
      eventName: "ai.chat.status",
      level: "info",
      summary: "legacy ai status",
      timestamp: "2026-03-22T12:00:00.000Z",
      correlationId: null,
      pageKey: "https://example.com/path",
      pageUrl: "https://example.com/path?legacy=1",
      status: {
        provider: "openai",
        apiKeyPresent: true,
        model: "gpt-5",
        resolvedServiceTier: "standard",
        streamingEnabled: true,
        structuredOutputEnabled: false,
        structuredOutputName: null,
        structuredOutputStrict: true,
        requestState: "active",
        lastError: null,
        historyScope: "page",
        pageKey: "https://example.com/path",
        pageUrlSample: "https://example.com/path?legacy=1",
        queueCount: 1,
        activeRequestId: null,
        openaiResponseId: null,
        lastSequenceNumber: null,
        recoverable: false,
        rateLimits: {
          serverLimitRequests: null,
          serverLimitTokens: null,
          serverRemainingRequests: null,
          serverRemainingTokens: null,
          serverResetRequests: null,
          serverResetTokens: null
        },
        currentModelBudget: null,
        modelBudgets: {},
        availableActions: {
          canSend: true,
          canResume: false,
          canReset: true
        }
      }
    });

    expect(parsed).toMatchObject({
      kind: "stream",
      normalized: true
    });
    if (!parsed || parsed.kind !== "stream" || parsed.message.stream !== "ai") {
      throw new Error("Expected normalized AI stream.");
    }
    expect(parsed.message.status).toMatchObject({
      requestState: "running",
      resolvedServiceTier: "default",
      model: {
        model: "gpt-5",
        tier: "standard"
      }
    });
    expect(parsed.message.status?.promptCaching.session.requestCount).toBe(0);
  });

  it("normalizes legacy AI sessions, queue state, and tool-origin messages", () => {
    const parsed = parseNativeHostMessage({
      stream: "ai",
      event: "ai.chat.snapshot",
      level: "info",
      summary: "legacy ai snapshot",
      ts: "2026-03-22T12:00:00.000Z",
      correlationId: null,
      pageKey: "https://example.com/path",
      pageUrl: "https://example.com/path?legacy=1",
      session: {
        pageKey: "https://example.com/path",
        pageUrlSample: "https://example.com/path?legacy=1",
        state: "waiting",
        activeRequestId: null,
        openaiResponseId: null,
        lastSequenceNumber: null,
        queuedCount: 1,
        recoverable: false,
        lastCheckpointAt: null,
        lastError: null,
        attachedViewIds: [],
        messages: [
          {
            id: "tool-1",
            pageKey: "https://example.com/path",
            requestId: null,
            origin: "tool",
            role: "assistant",
            kind: "compaction_started",
            text: "tool output",
            ts: "2026-03-22T12:00:00.000Z",
            state: "failed"
          }
        ],
        queue: [
          {
            id: "queue-1",
            requestId: "req-1",
            pageKey: "https://example.com/path",
            origin: "user",
            text: "queued",
            createdAt: "2026-03-22T12:00:00.000Z",
            state: "pending"
          }
        ],
        status: {
          provider: "openai",
          apiKeyPresent: true,
          model: "gpt-5",
          resolvedServiceTier: "auto",
          streamingEnabled: true,
          structuredOutputEnabled: false,
          structuredOutputName: null,
          structuredOutputStrict: true,
          requestState: "waiting",
          lastError: null,
          historyScope: "page",
          pageKey: "https://example.com/path",
          pageUrlSample: "https://example.com/path?legacy=1",
          queueCount: 1,
          activeRequestId: null,
          openaiResponseId: null,
          lastSequenceNumber: null,
          recoverable: false,
          rateLimits: {
            serverLimitRequests: null,
            serverLimitTokens: null,
            serverRemainingRequests: null,
            serverRemainingTokens: null,
            serverResetRequests: null,
            serverResetTokens: null
          },
          currentModelBudget: null,
          modelBudgets: {},
          availableActions: {
            canSend: true,
            canResume: false,
            canReset: false
          }
        }
      }
    });

    expect(parsed).toMatchObject({
      kind: "stream",
      normalized: true
    });
    if (!parsed || parsed.kind !== "stream" || parsed.message.stream !== "ai" || !parsed.message.session) {
      throw new Error("Expected normalized AI session.");
    }
    expect(parsed.message.session.state).toBe("queued");
    expect(parsed.message.session.queue[0]?.state).toBe("queued");
    expect(parsed.message.session.messages[0]).toMatchObject({
      origin: "code",
      kind: "compaction-request",
      state: "error"
    });
  });

  it("accepts host AI status streams with null message and delta fields", () => {
    const parsed = parseNativeHostMessage({
      stream: "ai",
      event: "ai.chat.status",
      level: "info",
      summary: "AI page session reset.",
      ts: "2026-03-22T12:00:00.000Z",
      correlationId: null,
      pageKey: "https://example.com/path",
      pageUrl: "https://example.com/path",
      message: null,
      delta: null,
      status: {
        ...createInitialAiStatus()
      }
    });

    expect(parsed).toMatchObject({
      kind: "stream",
      normalized: true
    });
  });
});

describe("runtime-state helpers", () => {
  it("creates the initial worker status with the supplied boot id", () => {
    expect(createInitialWorkerStatus("boot-1")).toMatchObject({
      bootId: "boot-1",
      running: false,
      hostConnected: false
    });
  });

  it("creates the initial desired runtime state", () => {
    expect(createInitialDesiredRuntime()).toEqual({
      desiredRunning: false,
      desiredTaskId: null,
      sessionId: null,
      reconnectAttempt: 0,
      lastDisconnectAt: null
    });
  });

  it("parses full worker statuses directly", () => {
    expect(
      parseWorkerStatusLike({
        running: true,
        bootId: "boot-2",
        sessionId: "session-1",
        hostConnected: true,
        taskId: null,
        startedAt: null,
        lastHeartbeatAt: null,
        reconnectAttempt: 0,
        nativeHostPid: 100
      })
    ).toMatchObject({
      bootId: "boot-2",
      hostConnected: true
    });
  });

  it("adds the fallback boot id when parsing native-host statuses", () => {
    expect(
      parseWorkerStatusLike(
        {
          running: true,
          sessionId: "session-2",
          hostConnected: true,
          taskId: null,
          startedAt: null,
          lastHeartbeatAt: null,
          reconnectAttempt: 1,
          nativeHostPid: 101
        },
        "boot-fallback"
      )
    ).toMatchObject({
      bootId: "boot-fallback",
      hostConnected: true
    });
  });

  it("prefers workerStatus over status when both are present", () => {
    expect(
      parseRuntimeWorkerStatus({
        workerStatus: {
          running: true,
          bootId: "boot-worker",
          sessionId: null,
          hostConnected: true,
          taskId: null,
          startedAt: null,
          lastHeartbeatAt: null,
          reconnectAttempt: 0,
          nativeHostPid: 200
        },
        status: {
          running: false,
          sessionId: null,
          hostConnected: false,
          taskId: null,
          startedAt: null,
          lastHeartbeatAt: null,
          reconnectAttempt: 0,
          nativeHostPid: null
        }
      })
    ).toMatchObject({
      bootId: "boot-worker",
      hostConnected: true
    });
  });

  it("parses legacy runtime.status payloads via fallback boot id", () => {
    expect(
      parseRuntimeWorkerStatus(
        {
          status: {
            running: true,
            sessionId: null,
            hostConnected: true,
            taskId: null,
            startedAt: null,
            lastHeartbeatAt: null,
            reconnectAttempt: 2,
            nativeHostPid: 300
          }
        },
        "boot-legacy"
      )
    ).toMatchObject({
      bootId: "boot-legacy",
      reconnectAttempt: 2
    });
  });
});

function createInitialAiStatus() {
  return {
    provider: "openai",
    apiKeyPresent: true,
    model: {
      model: "gpt-5",
      tier: "standard"
    },
    resolvedServiceTier: "default",
    streamingEnabled: true,
    structuredOutputEnabled: false,
    structuredOutputName: null,
    structuredOutputStrict: true,
    requestState: "idle",
    lastError: null,
    historyScope: "page",
    pageKey: "https://example.com/path",
    pageUrlSample: "https://example.com/path",
    queueCount: 0,
    contextPromptTokens: null,
    activeRequestId: null,
    openaiResponseId: null,
    lastSequenceNumber: null,
    recoverable: false,
    rateLimits: {
      serverLimitRequests: null,
      serverLimitTokens: null,
      serverRemainingRequests: null,
      serverRemainingTokens: null,
      serverResetRequests: null,
      serverResetTokens: null
    },
    currentModelBudget: null,
    modelBudgets: {},
    promptCaching: {
      routing: "stable_session_prefix",
      retention: "in_memory",
      lastRequest: null,
      session: {
        requestCount: 0,
        chatRequestCount: 0,
        compactionRequestCount: 0,
        promptTokens: 0,
        cachedTokens: 0,
        hitRatePct: null
      }
    },
    availableActions: {
      canSend: true,
      canResume: false,
      canReset: true
    }
  };
}
