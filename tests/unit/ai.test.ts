import { describe, expect, it } from "vitest";

import {
  AiChatMessageSchema,
  AiChatStatusSchema,
  buildAiChatTranscriptItems,
  buildAiChatStatusFragments,
  createDefaultAiStatus
} from "../../extension/src/shared/ai";

describe("AI prompt caching status", () => {
  it("creates default prompt caching telemetry for fresh sessions", () => {
    const status = createDefaultAiStatus("https://example.com/path", "https://example.com/path", true);

    expect(status.promptCaching.routing).toBe("stable_session_prefix");
    expect(status.promptCaching.retention).toBe("in_memory");
    expect(status.promptCaching.lastRequest).toBeNull();
    expect(status.promptCaching.session).toEqual({
      requestCount: 0,
      chatRequestCount: 0,
      compactionRequestCount: 0,
      promptTokens: 0,
      cachedTokens: 0,
      hitRatePct: null
    });
  });

  it("parses prompt caching telemetry from ai.chat.status payloads", () => {
    const parsed = AiChatStatusSchema.parse({
      ...createDefaultAiStatus("https://example.com/path", "https://example.com/path", true),
      contextPromptTokens: 4096,
      promptCaching: {
        routing: "provider_default",
        retention: "24h",
        lastRequest: {
          source: "chat",
          promptTokens: 4096,
          cachedTokens: 3072,
          hitRatePct: 75,
          status: "partial_hit",
          retentionApplied: "24h",
          routingApplied: "provider_default",
          updatedAt: "2026-03-21T12:00:00.000Z"
        },
        session: {
          requestCount: 3,
          chatRequestCount: 2,
          compactionRequestCount: 1,
          promptTokens: 12288,
          cachedTokens: 6144,
          hitRatePct: 50
        }
      }
    });

    expect(parsed.promptCaching.lastRequest?.status).toBe("partial_hit");
    expect(parsed.promptCaching.session.compactionRequestCount).toBe(1);
    expect(parsed.contextPromptTokens).toBe(4096);
  });

  it("builds overlay status fragments with cache telemetry chips", () => {
    const status = createDefaultAiStatus("https://example.com/path", "https://example.com/path", true);
    status.model = {
      model: "gpt-5",
      tier: "standard"
    };
    status.contextPromptTokens = 6144;
    status.promptCaching.lastRequest = {
      source: "compaction",
      promptTokens: 2048,
      cachedTokens: 1024,
      hitRatePct: 50,
      status: "partial_hit",
      retentionApplied: "in_memory",
      routingApplied: "stable_session_prefix",
      updatedAt: "2026-03-21T12:00:00.000Z"
    };
    status.promptCaching.session.hitRatePct = 33.3;

    const fragments = buildAiChatStatusFragments(status);

    expect(fragments).toContainEqual(["cache", "50%"]);
    expect(fragments).toContainEqual(["cache-s", "33%"]);
    expect(fragments).toContainEqual(["tokens", "6144"]);
    expect(fragments).toContainEqual(["cache-state", "частичное попадание"]);
    expect(fragments).toContainEqual(["cache-ret", "в памяти"]);
    expect(fragments).toContainEqual(["cache-src", "сжатие"]);
  });
});

describe("AI chat transcript builder", () => {
  it("always prepends the system prompt, even when empty", () => {
    const transcript = buildAiChatTranscriptItems([], "");

    expect(transcript).toHaveLength(1);
    expect(transcript[0]).toMatchObject({
      type: "system-prompt",
      isEmpty: true,
      promptText: ""
    });
  });

  it("filters service events and groups compacted conversational messages", () => {
    const transcript = buildAiChatTranscriptItems(
      [
        {
          id: "user-1",
          pageKey: "page",
          requestId: "req-1",
          origin: "user",
          role: "user",
          kind: "user",
          text: "first user",
          ts: "2026-03-22T10:00:00.000Z",
          state: "completed",
          meta: {
            compactedBy: "cmp-1"
          }
        },
        {
          id: "assistant-1",
          pageKey: "page",
          requestId: "req-1",
          origin: "assistant",
          role: "assistant",
          kind: "assistant",
          text: "first assistant",
          ts: "2026-03-22T10:00:01.000Z",
          state: "completed",
          meta: {
            compactedBy: "cmp-1"
          }
        },
        {
          id: "queue-1",
          pageKey: "page",
          requestId: "req-1",
          origin: "system",
          role: "system",
          kind: "queue",
          text: "queued",
          ts: "2026-03-22T10:00:02.000Z",
          state: "completed"
        },
        {
          id: "compaction-request-1",
          pageKey: "page",
          requestId: "req-2",
          origin: "system",
          role: "system",
          kind: "compaction-request",
          text: "request",
          ts: "2026-03-22T10:00:03.000Z",
          state: "completed",
          meta: {
            compactionId: "cmp-1",
            affectedMessageIds: ["user-1", "assistant-1"],
            rangeStartMessageId: "user-1",
            rangeEndMessageId: "assistant-1",
            instructionsText: "compress this"
          }
        },
        {
          id: "compaction-result-1",
          pageKey: "page",
          requestId: "req-2",
          origin: "system",
          role: "system",
          kind: "compaction-result",
          text: "result",
          ts: "2026-03-22T10:00:04.000Z",
          state: "completed",
          meta: {
            compactionId: "cmp-1",
            affectedMessageIds: ["user-1", "assistant-1"],
            rangeStartMessageId: "user-1",
            rangeEndMessageId: "assistant-1",
            resultPreviewText: "summary",
            compactedItemCount: 1,
            preservedTailCount: 2
          }
        },
        {
          id: "user-2",
          pageKey: "page",
          requestId: "req-3",
          origin: "user",
          role: "user",
          kind: "user",
          text: "second user",
          ts: "2026-03-22T10:00:05.000Z",
          state: "completed"
        }
      ],
      "stay concise"
    );

    expect(transcript.map((item) => item.type)).toEqual([
      "system-prompt",
      "compacted-range",
      "compaction-request",
      "compaction-result",
      "message"
    ]);

    const compactedRange = transcript[1];
    expect(compactedRange.type).toBe("compacted-range");
    if (compactedRange.type !== "compacted-range") {
      throw new Error("Expected compacted range transcript item.");
    }

    expect(compactedRange.compactionId).toBe("cmp-1");
    expect(compactedRange.affectedMessageIds).toEqual(["user-1", "assistant-1"]);
    expect(compactedRange.messages.map((message) => message.id)).toEqual(["user-1", "assistant-1"]);

    const trailingMessage = transcript[4];
    expect(trailingMessage.type).toBe("message");
    if (trailingMessage.type !== "message") {
      throw new Error("Expected regular transcript message item.");
    }

    expect(trailingMessage.message.id).toBe("user-2");
    expect(trailingMessage.dimmed).toBe(false);
  });

  it("keeps legacy compaction events visible as regular transcript items", () => {
    const transcript = buildAiChatTranscriptItems(
      [
        {
          id: "compaction-legacy",
          pageKey: "page",
          requestId: "req-legacy",
          origin: "system",
          role: "system",
          kind: "compaction",
          text: "legacy compaction",
          ts: "2026-03-22T10:00:00.000Z",
          state: "completed"
        }
      ],
      "prompt"
    );

    expect(transcript.map((item) => item.type)).toEqual(["system-prompt", "message"]);
    const legacyMessage = transcript[1];
    expect(legacyMessage.type).toBe("message");
    if (legacyMessage.type !== "message") {
      throw new Error("Expected legacy compaction entry to stay visible.");
    }

    expect(legacyMessage.message.kind).toBe("compaction");
  });
});

describe("AI chat message schema", () => {
  it("parses new compaction request/result metadata", () => {
    const request = AiChatMessageSchema.parse({
      id: "compaction-request-1",
      pageKey: "page",
      requestId: "req-1",
      origin: "system",
      role: "system",
      kind: "compaction-request",
      text: "request",
      ts: "2026-03-22T10:00:00.000Z",
      state: "completed",
      meta: {
        compactionId: "cmp-1",
        affectedMessageIds: ["user-1"],
        rangeStartMessageId: "user-1",
        rangeEndMessageId: "user-1",
        instructionsText: "compress"
      }
    });

    const result = AiChatMessageSchema.parse({
      id: "compaction-result-1",
      pageKey: "page",
      requestId: "req-1",
      origin: "system",
      role: "system",
      kind: "compaction-result",
      text: "result",
      ts: "2026-03-22T10:00:01.000Z",
      state: "completed",
      meta: {
        compactionId: "cmp-1",
        affectedMessageIds: ["user-1"],
        rangeStartMessageId: "user-1",
        rangeEndMessageId: "user-1",
        resultPreviewText: "summary",
        compactedItemCount: 1,
        preservedTailCount: 1
      }
    });

    expect(request.kind).toBe("compaction-request");
    expect(result.kind).toBe("compaction-result");
  });

  it("keeps legacy messages without metadata valid", () => {
    const parsed = AiChatMessageSchema.parse({
      id: "assistant-legacy",
      pageKey: "page",
      requestId: "req-legacy",
      origin: "assistant",
      role: "assistant",
      kind: "assistant",
      text: "legacy",
      ts: "2026-03-22T10:00:00.000Z",
      state: "completed"
    });

    expect(parsed.meta).toBeUndefined();
  });
});
