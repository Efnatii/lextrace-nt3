import { describe, expect, it } from "vitest";

import { COMMANDS } from "../../extension/src/shared/constants";
import {
  ExtensionStreamMessageSchema,
  ProtocolResponseSchema,
  createEnvelope,
  createErrorResponse,
  parseNativeHostMessage,
  validateEnvelope,
  validateEnvelopePayload
} from "../../extension/src/shared/protocol";

describe("protocol validation", () => {
  it("accepts valid protocol envelope and payload", () => {
    const envelope = createEnvelope(
      COMMANDS.configPatch,
      "popup",
      "background",
      {
        scope: "session",
        patch: {
          ui: {
            popupActiveTab: "config"
          }
        }
      }
    );

    const parsedEnvelope = validateEnvelope(envelope);
    const parsedPayload = validateEnvelopePayload(parsedEnvelope);

    expect(parsedEnvelope.action).toBe(COMMANDS.configPatch);
    expect(parsedPayload).toMatchObject({
      scope: "session"
    });
  });

  it("normalizes legacy config patch payloads before validation", () => {
    const envelope = createEnvelope(COMMANDS.configPatch, "tests", "background", {
      scope: "local",
      patch: {
        ai: {
          model: "gpt-4.1",
          serviceTier: "priority"
        }
      }
    });

    expect(validateEnvelopePayload(validateEnvelope(envelope))).toMatchObject({
      scope: "local",
      patch: {
        ai: {
          chat: {
            model: {
              model: "gpt-4.1",
              tier: "priority"
            }
          }
        }
      }
    });
  });

  it("rejects unsupported actions", () => {
    expect(() =>
      validateEnvelope({
        ...createEnvelope(COMMANDS.ping, "tests", "background"),
        action: "unknown.command"
      })
    ).toThrow(/Unsupported action/);
  });

  it("accepts overlay probe payloads and structured overlay errors", () => {
    const envelope = createEnvelope(COMMANDS.overlayProbe, "tests", "background", {
      tabId: 77,
      expectedUrl: "https://example.com/slow"
    });

    expect(validateEnvelopePayload(validateEnvelope(envelope))).toMatchObject({
      tabId: 77,
      expectedUrl: "https://example.com/slow"
    });

    const response = ProtocolResponseSchema.parse(
      createErrorResponse("req-1", "content_not_ready", "Reload the page first.")
    );

    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe("content_not_ready");
  });

  it("accepts AI chat payloads", () => {
    const envelope = createEnvelope(COMMANDS.aiChatSend, "tests", "background", {
      pageKey: "https://example.com/path",
      pageUrl: "https://example.com/path?query=1#hash",
      origin: "user",
      text: "Hello from AI test"
    });

    expect(validateEnvelopePayload(validateEnvelope(envelope))).toMatchObject({
      pageKey: "https://example.com/path",
      origin: "user"
    });
  });

  it("accepts AI compaction payloads", () => {
    const envelope = createEnvelope(COMMANDS.aiChatCompact, "tests", "background", {
      pageKey: "https://example.com/path",
      pageUrl: "https://example.com/path?query=1#hash",
      mode: "force"
    });

    expect(validateEnvelopePayload(validateEnvelope(envelope))).toMatchObject({
      pageKey: "https://example.com/path",
      mode: "force"
    });
  });

  it("accepts AI model catalog payloads", () => {
    const envelope = createEnvelope(COMMANDS.aiModelsCatalog, "tests", "background", {});

    expect(validateEnvelopePayload(validateEnvelope(envelope))).toEqual({});
  });

  it("accepts native host management payloads", () => {
    const connectEnvelope = createEnvelope(COMMANDS.hostConnect, "tests", "background", {
      reason: "unit-test"
    });
    const statusEnvelope = createEnvelope(COMMANDS.hostStatus, "tests", "background");

    expect(validateEnvelopePayload(validateEnvelope(connectEnvelope))).toMatchObject({
      reason: "unit-test"
    });
    expect(validateEnvelopePayload(validateEnvelope(statusEnvelope))).toEqual({});
  });

  it("parses representative current native-host runtime streams without normalization", () => {
    const startupLog = {
      stream: "runtime",
      event: "runtime.log",
      level: "info",
      summary: "Native host is ready.",
      details: {
        pid: 6812,
        apiKeyPresent: true
      },
      ts: "2026-03-21T23:50:29.6751695+00:00",
      correlationId: null,
      logEntry: {
        id: "d0b4e61b-9f7d-4d9a-9333-851aae0a083e",
        ts: "2026-03-21T23:50:29.6751695+00:00",
        level: "info",
        source: "native-host",
        event: "native-host.startup",
        summary: "Native host is ready.",
        details: {
          pid: 6812,
          apiKeyPresent: true
        },
        correlationId: null,
        collapsedByDefault: true
      }
    };

    const parsed = parseNativeHostMessage(startupLog);
    expect(parsed).toMatchObject({
      kind: "stream",
      normalized: false
    });

    if (!parsed || parsed.kind !== "stream") {
      throw new Error("Expected runtime stream payload.");
    }

    expect(parsed.message.stream).toBe("runtime");
    expect(parsed.message.event).toBe("runtime.log");
  });

  it("normalizes legacy AI stream payloads from older native-host builds", () => {
    const legacyAiStatusStream = {
      stream: "ai",
      eventName: "ai.chat.status",
      level: "info",
      summary: "AI request queued.",
      details: {
        legacyBuild: true
      },
      timestamp: "2026-03-22T00:37:29.000Z",
      correlationId: null,
      pageKey: "https://example.com/path",
      pageUrl: "https://example.com/path?legacy=1",
      requestId: null,
      sequenceNumber: null,
      status: {
        provider: "openai",
        apiKeyPresent: true,
        model: {
          model: "gpt-5",
          tier: "standard"
        },
        resolvedServiceTier: "standard",
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
      },
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
        messages: [
          {
            id: "legacy-msg-1",
            pageKey: "https://example.com/path",
            requestId: null,
            openaiResponseId: null,
            origin: "system",
            role: "system",
            kind: "queue",
            text: "AI request accepted.",
            summary: null,
            ts: "2026-03-22T00:37:29.000Z",
            state: "queued",
            meta: "legacy-meta-string"
          }
        ],
        queue: [
          {
            id: "legacy-queue-1",
            requestId: "legacy-request-1",
            pageKey: "https://example.com/path",
            origin: "user",
            text: "Legacy queued request",
            createdAt: "2026-03-22T00:37:29.000Z",
            state: "pending"
          }
        ],
        status: {
          provider: "openai",
          apiKeyPresent: true,
          model: "gpt-5",
          resolvedServiceTier: "standard",
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
    };

    expect(ExtensionStreamMessageSchema.safeParse(legacyAiStatusStream).success).toBe(false);

    const parsed = parseNativeHostMessage(legacyAiStatusStream);
    expect(parsed).toMatchObject({
      kind: "stream",
      normalized: true
    });

    if (!parsed || parsed.kind !== "stream" || parsed.message.stream !== "ai") {
      throw new Error("Expected normalized AI stream payload.");
    }

    expect(parsed.message.event).toBe("ai.chat.status");
    expect(parsed.message.status?.promptCaching).toMatchObject({
      routing: "stable_session_prefix",
      retention: "in_memory"
    });
    expect(parsed.message.status?.resolvedServiceTier).toBe("default");
    expect(parsed.message.status?.requestState).toBe("queued");
    expect(parsed.message.session?.attachedViewIds).toEqual([]);
    expect(parsed.message.session?.status.promptCaching.lastRequest).toBeNull();
    expect(parsed.message.session?.messages[0]?.state).toBe("pending");
    expect(parsed.message.session?.messages[0]?.meta).toBeNull();
    expect(parsed.message.session?.queue[0]?.state).toBe("queued");
    expect(parsed.message.session?.queue[0]?.attemptCount).toBe(0);
    expect(parsed.message.session?.queue[0]?.nextRetryAt).toBeNull();
  });

  it("accepts host AI status streams that encode optional fields as null", () => {
    const resetStatusStream = {
      stream: "ai",
      event: "ai.chat.status",
      level: "info",
      summary: "AI page session reset.",
      details: null,
      ts: "2026-03-22T00:14:24.7004699+00:00",
      correlationId: null,
      pageKey: "http://127.0.0.1/overlay-user",
      pageUrl: "http://127.0.0.1/overlay-user",
      requestId: null,
      sequenceNumber: null,
      status: {
        provider: "openai",
        apiKeyPresent: true,
        model: {
          model: "gpt-5",
          tier: "standard"
        },
        resolvedServiceTier: null,
        streamingEnabled: true,
        structuredOutputEnabled: false,
        structuredOutputName: "edge_structured_reply",
        structuredOutputStrict: true,
        requestState: "idle",
        lastError: null,
        historyScope: "page",
        pageKey: "http://127.0.0.1/overlay-user",
        pageUrlSample: "http://127.0.0.1/overlay-user",
        queueCount: 0,
        contextPromptTokens: 4096,
        activeRequestId: null,
        openaiResponseId: null,
        lastSequenceNumber: null,
        recoverable: false,
        rateLimits: {
          serverLimitRequests: 5000,
          serverLimitTokens: 2000000,
          serverRemainingRequests: 4999,
          serverRemainingTokens: 2000000,
          serverResetRequests: "12ms",
          serverResetTokens: "0s"
        },
        currentModelBudget: {
          model: "gpt-5",
          observedAt: "2026-03-22T00:13:25.0811278+00:00",
          lastResolvedServiceTier: "default",
          serverLimitRequests: 5000,
          serverLimitTokens: 2000000,
          serverRemainingRequests: 4999,
          serverRemainingTokens: 2000000,
          serverResetRequests: "12ms",
          serverResetTokens: "0s"
        },
        modelBudgets: {
          "gpt-5": {
            model: "gpt-5",
            observedAt: "2026-03-22T00:13:25.0811278+00:00",
            lastResolvedServiceTier: "default",
            serverLimitRequests: 5000,
            serverLimitTokens: 2000000,
            serverRemainingRequests: 4999,
            serverRemainingTokens: 2000000,
            serverResetRequests: "12ms",
            serverResetTokens: "0s"
          }
        },
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
          canReset: false
        }
      },
      session: {
        pageKey: "http://127.0.0.1/overlay-user",
        pageUrlSample: "http://127.0.0.1/overlay-user",
        attachedViewIds: [],
        state: "idle",
        activeRequestId: null,
        openaiResponseId: null,
        lastSequenceNumber: null,
        queuedCount: 0,
        recoverable: false,
        lastCheckpointAt: "2026-03-22T00:14:24.6979654+00:00",
        lastError: null,
        messages: [],
        queue: [],
        status: {
          provider: "openai",
          apiKeyPresent: true,
          model: {
            model: "gpt-5",
            tier: "standard"
          },
          resolvedServiceTier: null,
          streamingEnabled: true,
          structuredOutputEnabled: false,
          structuredOutputName: "edge_structured_reply",
          structuredOutputStrict: true,
          requestState: "idle",
          lastError: null,
          historyScope: "page",
          pageKey: "http://127.0.0.1/overlay-user",
          pageUrlSample: "http://127.0.0.1/overlay-user",
          queueCount: 0,
          contextPromptTokens: 4096,
          activeRequestId: null,
          openaiResponseId: null,
          lastSequenceNumber: null,
          recoverable: false,
          rateLimits: {
            serverLimitRequests: 5000,
            serverLimitTokens: 2000000,
            serverRemainingRequests: 4999,
            serverRemainingTokens: 2000000,
            serverResetRequests: "12ms",
            serverResetTokens: "0s"
          },
          currentModelBudget: {
            model: "gpt-5",
            observedAt: "2026-03-22T00:13:25.0811278+00:00",
            lastResolvedServiceTier: "default",
            serverLimitRequests: 5000,
            serverLimitTokens: 2000000,
            serverRemainingRequests: 4999,
            serverRemainingTokens: 2000000,
            serverResetRequests: "12ms",
            serverResetTokens: "0s"
          },
          modelBudgets: {
            "gpt-5": {
              model: "gpt-5",
              observedAt: "2026-03-22T00:13:25.0811278+00:00",
              lastResolvedServiceTier: "default",
              serverLimitRequests: 5000,
              serverLimitTokens: 2000000,
              serverRemainingRequests: 4999,
              serverRemainingTokens: 2000000,
              serverResetRequests: "12ms",
              serverResetTokens: "0s"
            }
          },
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
            canReset: false
          }
        }
      },
      message: null,
      queue: [],
      delta: null
    };

    expect(ExtensionStreamMessageSchema.safeParse(resetStatusStream).success).toBe(false);

    const parsed = parseNativeHostMessage(resetStatusStream);
    expect(parsed).toMatchObject({
      kind: "stream",
      normalized: true
    });

    if (!parsed || parsed.kind !== "stream" || parsed.message.stream !== "ai") {
      throw new Error("Expected normalized reset AI stream payload.");
    }

    expect("message" in parsed.message).toBe(false);
    expect("delta" in parsed.message).toBe(false);
    expect(parsed.message.session?.messages).toEqual([]);
    expect(parsed.message.status?.requestState).toBe("idle");
    expect(parsed.message.status?.contextPromptTokens).toBe(4096);
    expect(parsed.message.session?.status.contextPromptTokens).toBe(4096);
  });

  it("accepts retry visibility fields in AI queue and session payloads", () => {
    const stream = {
      stream: "ai",
      event: "ai.chat.status",
      level: "warn",
      summary: "AI request scheduled for automatic retry.",
      details: null,
      ts: "2026-03-24T10:00:00.000Z",
      correlationId: null,
      pageKey: "https://example.com/retry",
      pageUrl: "https://example.com/retry",
      requestId: "req-retry",
      sequenceNumber: null,
      status: {
        provider: "openai",
        apiKeyPresent: true,
        model: {
          model: "gpt-5",
          tier: "standard"
        },
        resolvedServiceTier: null,
        streamingEnabled: true,
        structuredOutputEnabled: false,
        structuredOutputName: null,
        structuredOutputStrict: true,
        requestState: "queued",
        lastError: "temporary network failure",
        historyScope: "page",
        pageKey: "https://example.com/retry",
        pageUrlSample: "https://example.com/retry",
        queueCount: 1,
        contextPromptTokens: 1024,
        activeRequestId: null,
        openaiResponseId: null,
        lastSequenceNumber: null,
        nextRetryAt: "2026-03-24T10:00:05.000Z",
        recoverable: true,
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
      },
      session: {
        pageKey: "https://example.com/retry",
        pageUrlSample: "https://example.com/retry",
        attachedViewIds: [],
        state: "queued",
        activeRequestId: null,
        openaiResponseId: null,
        lastSequenceNumber: null,
        nextRetryAt: "2026-03-24T10:00:05.000Z",
        queuedCount: 1,
        recoverable: true,
        lastCheckpointAt: "2026-03-24T10:00:00.000Z",
        lastError: "temporary network failure",
        messages: [],
        queue: [
          {
            id: "queue-1",
            requestId: "req-retry",
            pageKey: "https://example.com/retry",
            origin: "user",
            text: "retry me",
            createdAt: "2026-03-24T09:59:59.000Z",
            state: "queued",
            attemptCount: 2,
            nextRetryAt: "2026-03-24T10:00:05.000Z"
          }
        ],
        status: {
          provider: "openai",
          apiKeyPresent: true,
          model: {
            model: "gpt-5",
            tier: "standard"
          },
          resolvedServiceTier: null,
          streamingEnabled: true,
          structuredOutputEnabled: false,
          structuredOutputName: null,
          structuredOutputStrict: true,
          requestState: "queued",
          lastError: "temporary network failure",
          historyScope: "page",
          pageKey: "https://example.com/retry",
          pageUrlSample: "https://example.com/retry",
          queueCount: 1,
          contextPromptTokens: 1024,
          activeRequestId: null,
          openaiResponseId: null,
          lastSequenceNumber: null,
          nextRetryAt: "2026-03-24T10:00:05.000Z",
          recoverable: true,
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
        }
      }
    };

    const parsed = parseNativeHostMessage(stream);
    expect(parsed).toMatchObject({
      kind: "stream",
      normalized: false
    });

    if (!parsed || parsed.kind !== "stream" || parsed.message.stream !== "ai") {
      throw new Error("Expected AI retry stream payload.");
    }

    expect(parsed.message.status?.nextRetryAt).toBe("2026-03-24T10:00:05.000Z");
    expect(parsed.message.session?.nextRetryAt).toBe("2026-03-24T10:00:05.000Z");
    expect(parsed.message.session?.queue[0]?.attemptCount).toBe(2);
    expect(parsed.message.session?.queue[0]?.nextRetryAt).toBe("2026-03-24T10:00:05.000Z");
  });
});
