import { describe, expect, it } from "vitest";

import {
  AiChatMessageSchema,
  buildAiChatStatusFragments,
  buildAiChatTranscriptItems,
  createDefaultAiStatus,
  createEmptyAiModelBudgetState,
  formatAiPromptCachePercent,
  getAiCompactedBy,
  getAiCompactionRequestMeta,
  getAiCompactionResultMeta,
  isAiConversationalKind,
  isAiTranscriptKind,
  normalizeAiModelSelection,
  normalizeAllowedModelRules,
  type AiChatMessage,
  type AiEventKind
} from "../../extension/src/shared/ai";

const ALL_KINDS: readonly AiEventKind[] = [
  "user",
  "assistant",
  "code",
  "system",
  "queue",
  "compaction",
  "compaction-request",
  "compaction-result",
  "rate-limit",
  "resume",
  "reset",
  "error"
] as const;

function createMessage(
  overrides: Partial<AiChatMessage> & Pick<AiChatMessage, "id" | "kind" | "origin" | "role" | "text">
): AiChatMessage {
  return AiChatMessageSchema.parse({
    id: overrides.id,
    pageKey: overrides.pageKey ?? "https://example.com/page",
    requestId: overrides.requestId ?? "req-1",
    openaiResponseId: overrides.openaiResponseId ?? null,
    origin: overrides.origin,
    role: overrides.role,
    kind: overrides.kind,
    text: overrides.text,
    summary: overrides.summary,
    ts: overrides.ts ?? "2026-03-22T12:00:00.000Z",
    state: overrides.state ?? "completed",
    meta: overrides.meta
  });
}

describe("AI helper classification", () => {
  it.each(
    ALL_KINDS.map((kind) => [
      kind,
      kind === "user" || kind === "assistant" || kind === "code"
    ] as const)
  )("marks conversational kind %s correctly", (kind, expected) => {
    expect(isAiConversationalKind(kind)).toBe(expected);
  });

  it.each(
    ALL_KINDS.map((kind) => [
      kind,
      kind === "user" ||
        kind === "assistant" ||
        kind === "code" ||
        kind === "compaction" ||
        kind === "compaction-request" ||
        kind === "compaction-result"
    ] as const)
  )("marks transcript kind %s correctly", (kind, expected) => {
    expect(isAiTranscriptKind(kind)).toBe(expected);
  });
});

describe("AI compaction metadata helpers", () => {
  it("extracts compactedBy when the metadata is valid", () => {
    expect(
      getAiCompactedBy(
        createMessage({
          id: "user-1",
          kind: "user",
          origin: "user",
          role: "user",
          text: "hello",
          meta: {
            compactedBy: "cmp-1"
          }
        })
      )
    ).toBe("cmp-1");
  });

  it("returns null when compactedBy is blank", () => {
    expect(
      getAiCompactedBy(
        createMessage({
          id: "user-2",
          kind: "user",
          origin: "user",
          role: "user",
          text: "hello",
          meta: {
            compactedBy: "   "
          }
        })
      )
    ).toBeNull();
  });

  it("returns null when the metadata shape is unrelated", () => {
    expect(
      getAiCompactedBy(
        createMessage({
          id: "user-3",
          kind: "user",
          origin: "user",
          role: "user",
          text: "hello",
          meta: {
            note: "other"
          }
        })
      )
    ).toBeNull();
  });

  it("parses compaction request metadata", () => {
    const message = createMessage({
      id: "cmp-req",
      kind: "compaction-request",
      origin: "system",
      role: "system",
      text: "compress",
      meta: {
        compactionId: "cmp-1",
        affectedMessageIds: ["m1", "m2"],
        rangeStartMessageId: "m1",
        rangeEndMessageId: "m2",
        instructionsText: "trim the context"
      }
    });

    expect(getAiCompactionRequestMeta(message)).toMatchObject({
      compactionId: "cmp-1",
      affectedMessageIds: ["m1", "m2"],
      instructionsText: "trim the context"
    });
  });

  it("rejects malformed compaction request metadata", () => {
    const message = createMessage({
      id: "cmp-req-bad",
      kind: "compaction-request",
      origin: "system",
      role: "system",
      text: "compress",
      meta: {
        compactionId: "",
        affectedMessageIds: []
      }
    });

    expect(getAiCompactionRequestMeta(message)).toBeNull();
  });

  it("parses compaction result metadata", () => {
    const message = createMessage({
      id: "cmp-res",
      kind: "compaction-result",
      origin: "system",
      role: "system",
      text: "result",
      meta: {
        compactionId: "cmp-2",
        affectedMessageIds: ["m1"],
        rangeStartMessageId: "m1",
        rangeEndMessageId: "m1",
        resultPreviewText: "summary",
        compactedItemCount: 1,
        preservedTailCount: 3
      }
    });

    expect(getAiCompactionResultMeta(message)).toMatchObject({
      compactionId: "cmp-2",
      resultPreviewText: "summary",
      compactedItemCount: 1,
      preservedTailCount: 3
    });
  });

  it("rejects malformed compaction result metadata", () => {
    const message = createMessage({
      id: "cmp-res-bad",
      kind: "compaction-result",
      origin: "system",
      role: "system",
      text: "result",
      meta: {
        compactionId: "cmp-3",
        affectedMessageIds: ["m1"],
        rangeStartMessageId: "m1"
      }
    });

    expect(getAiCompactionResultMeta(message)).toBeNull();
  });
});

describe("AI transcript builder", () => {
  it("prepends a system prompt item when instructions are undefined", () => {
    const items = buildAiChatTranscriptItems([], undefined);
    expect(items).toMatchObject([
      {
        type: "system-prompt",
        isEmpty: true,
        promptText: ""
      }
    ]);
  });

  it("marks the system prompt as empty for whitespace instructions", () => {
    const items = buildAiChatTranscriptItems([], "   ");
    expect(items[0]).toMatchObject({
      type: "system-prompt",
      isEmpty: true,
      promptText: "   "
    });
  });

  it("keeps regular conversational messages in order", () => {
    const items = buildAiChatTranscriptItems(
      [
        createMessage({
          id: "user-1",
          kind: "user",
          origin: "user",
          role: "user",
          text: "question"
        }),
        createMessage({
          id: "assistant-1",
          kind: "assistant",
          origin: "assistant",
          role: "assistant",
          text: "answer"
        })
      ],
      "be concise"
    );

    expect(items.map((item) => item.type)).toEqual(["system-prompt", "message", "message"]);
  });

  it("drops non-transcript service events", () => {
    const items = buildAiChatTranscriptItems(
      [
        createMessage({
          id: "queue-1",
          kind: "queue",
          origin: "system",
          role: "system",
          text: "queued"
        }),
        createMessage({
          id: "resume-1",
          kind: "resume",
          origin: "system",
          role: "system",
          text: "resumed"
        })
      ],
      "prompt"
    );

    expect(items).toHaveLength(1);
    expect(items[0]?.type).toBe("system-prompt");
  });

  it("groups consecutive compacted conversational messages into a single range", () => {
    const items = buildAiChatTranscriptItems(
      [
        createMessage({
          id: "user-1",
          kind: "user",
          origin: "user",
          role: "user",
          text: "question",
          meta: { compactedBy: "cmp-1" }
        }),
        createMessage({
          id: "assistant-1",
          kind: "assistant",
          origin: "assistant",
          role: "assistant",
          text: "answer",
          meta: { compactedBy: "cmp-1" }
        })
      ],
      "prompt"
    );

    expect(items.map((item) => item.type)).toEqual(["system-prompt", "compacted-range"]);
    const range = items[1];
    expect(range?.type).toBe("compacted-range");
    if (range?.type !== "compacted-range") {
      throw new Error("Expected compacted range.");
    }
    expect(range.messages.map((message) => message.id)).toEqual(["user-1", "assistant-1"]);
  });

  it("starts a new compacted range when compaction id changes", () => {
    const items = buildAiChatTranscriptItems(
      [
        createMessage({
          id: "user-1",
          kind: "user",
          origin: "user",
          role: "user",
          text: "one",
          meta: { compactedBy: "cmp-1" }
        }),
        createMessage({
          id: "assistant-1",
          kind: "assistant",
          origin: "assistant",
          role: "assistant",
          text: "two",
          meta: { compactedBy: "cmp-2" }
        })
      ],
      "prompt"
    );

    expect(items.map((item) => item.type)).toEqual([
      "system-prompt",
      "compacted-range",
      "compacted-range"
    ]);
  });

  it("ends the active compacted range when a non-compacted conversational message appears", () => {
    const items = buildAiChatTranscriptItems(
      [
        createMessage({
          id: "user-1",
          kind: "user",
          origin: "user",
          role: "user",
          text: "one",
          meta: { compactedBy: "cmp-1" }
        }),
        createMessage({
          id: "assistant-2",
          kind: "assistant",
          origin: "assistant",
          role: "assistant",
          text: "fresh"
        })
      ],
      "prompt"
    );

    expect(items.map((item) => item.type)).toEqual(["system-prompt", "compacted-range", "message"]);
  });

  it("keeps compaction request and result entries after compacted ranges", () => {
    const items = buildAiChatTranscriptItems(
      [
        createMessage({
          id: "user-1",
          kind: "user",
          origin: "user",
          role: "user",
          text: "one",
          meta: { compactedBy: "cmp-1" }
        }),
        createMessage({
          id: "cmp-req",
          kind: "compaction-request",
          origin: "system",
          role: "system",
          text: "compress",
          meta: {
            compactionId: "cmp-1",
            affectedMessageIds: ["user-1"],
            rangeStartMessageId: "user-1",
            rangeEndMessageId: "user-1",
            instructionsText: "shrink"
          }
        }),
        createMessage({
          id: "cmp-res",
          kind: "compaction-result",
          origin: "system",
          role: "system",
          text: "done",
          meta: {
            compactionId: "cmp-1",
            affectedMessageIds: ["user-1"],
            rangeStartMessageId: "user-1",
            rangeEndMessageId: "user-1",
            resultPreviewText: "summary"
          }
        })
      ],
      "prompt"
    );

    expect(items.map((item) => item.type)).toEqual([
      "system-prompt",
      "compacted-range",
      "compaction-request",
      "compaction-result"
    ]);
  });

  it("keeps legacy compaction messages visible as plain messages", () => {
    const items = buildAiChatTranscriptItems(
      [
        createMessage({
          id: "legacy-cmp",
          kind: "compaction",
          origin: "system",
          role: "system",
          text: "legacy"
        })
      ],
      "prompt"
    );

    expect(items.map((item) => item.type)).toEqual(["system-prompt", "message"]);
  });
});

describe("AI model normalization", () => {
  it("normalizes a plain model id into a standard-tier selection", () => {
    expect(normalizeAiModelSelection("gpt-5")).toEqual({
      model: "gpt-5",
      tier: "standard"
    });
  });

  it("respects a fallback tier for plain model ids", () => {
    expect(normalizeAiModelSelection("gpt-5", "priority")).toEqual({
      model: "gpt-5",
      tier: "priority"
    });
  });

  it("keeps a valid structured model selection", () => {
    expect(
      normalizeAiModelSelection({
        model: "gpt-5-mini",
        tier: "flex"
      })
    ).toEqual({
      model: "gpt-5-mini",
      tier: "flex"
    });
  });

  it("returns null for blank model strings", () => {
    expect(normalizeAiModelSelection("   ")).toBeNull();
  });

  it("returns null for invalid tier objects", () => {
    expect(
      normalizeAiModelSelection({
        model: "gpt-5",
        tier: "broken"
      } as never)
    ).toBeNull();
  });

  it("returns null for null input", () => {
    expect(normalizeAiModelSelection(null)).toBeNull();
  });

  it("deduplicates and sorts allowed model rules", () => {
    expect(
      normalizeAllowedModelRules([
        "gpt-5",
        { model: "gpt-5", tier: "standard" },
        { model: "gpt-4.1", tier: "priority" },
        { model: "gpt-5-mini", tier: "flex" }
      ])
    ).toEqual([
      { model: "gpt-5", tier: "standard" },
      { model: "gpt-5-mini", tier: "flex" },
      { model: "gpt-4.1", tier: "priority" }
    ]);
  });

  it("drops malformed allowed model rules", () => {
    expect(
      normalizeAllowedModelRules([
        "gpt-5",
        { model: "", tier: "standard" } as never,
        { model: "gpt-4.1", tier: "broken" } as never
      ])
    ).toEqual([{ model: "gpt-5", tier: "standard" }]);
  });
});

describe("AI prompt cache and status formatting", () => {
  it.each([
    [null, "-"],
    [0, "0%"],
    [49.4, "49%"],
    [49.6, "50%"]
  ])("formats cache percentage %s", (value, expected) => {
    expect(formatAiPromptCachePercent(value)).toBe(expected);
  });

  it("creates an empty model budget shell", () => {
    expect(createEmptyAiModelBudgetState("gpt-5")).toMatchObject({
      model: "gpt-5",
      observedAt: null,
      lastResolvedServiceTier: null,
      serverLimitRequests: null,
      serverLimitTokens: null
    });
  });

  it("creates a default idle AI status", () => {
    expect(createDefaultAiStatus("page-key", "https://example.com", true)).toMatchObject({
      provider: "openai",
      apiKeyPresent: true,
      pageKey: "page-key",
      queueCount: 0,
      requestState: "idle"
    });
  });

  it("builds core status fragments for a fresh session", () => {
    const fragments = new Map(
      buildAiChatStatusFragments(createDefaultAiStatus("page-key", "https://example.com", true))
    );

    expect(fragments.get("provider")).toBe("OpenAI");
    expect(fragments.get("key")).toBeTruthy();
    expect(fragments.get("page")).toBe("page-key");
    expect(fragments.get("queue")).toBe("0");
  });

  it("includes the served tier when it is resolved", () => {
    const status = createDefaultAiStatus("page-key", "https://example.com", true);
    status.resolvedServiceTier = "priority";

    const fragments = buildAiChatStatusFragments(status);
    expect(fragments.some(([label]) => label === "served")).toBe(true);
  });

  it("includes cache source when the last request contains one", () => {
    const status = createDefaultAiStatus("page-key", "https://example.com", true);
    status.promptCaching.lastRequest = {
      source: "compaction",
      promptTokens: 100,
      cachedTokens: 80,
      hitRatePct: 80,
      status: "partial_hit",
      retentionApplied: "24h",
      routingApplied: "provider_default",
      updatedAt: "2026-03-22T12:00:00.000Z"
    };

    const fragments = buildAiChatStatusFragments(status);
    expect(fragments.some(([label]) => label === "cache-src")).toBe(true);
  });

  it("uses the current model budget over the coarse rate limit snapshot", () => {
    const status = createDefaultAiStatus("page-key", "https://example.com", true);
    status.rateLimits = {
      serverLimitRequests: 500,
      serverLimitTokens: 1000,
      serverRemainingRequests: 20,
      serverRemainingTokens: 200,
      serverResetRequests: "10s",
      serverResetTokens: "15s"
    };
    status.currentModelBudget = {
      model: "gpt-5",
      observedAt: "2026-03-22T12:00:00.000Z",
      lastResolvedServiceTier: "flex",
      serverLimitRequests: 100,
      serverLimitTokens: 200,
      serverRemainingRequests: 7,
      serverRemainingTokens: 8,
      serverResetRequests: "1s",
      serverResetTokens: "2s"
    };

    const fragments = new Map(buildAiChatStatusFragments(status));
    expect(fragments.get("rpm")).toBe("7/100");
    expect(fragments.get("tpm")).toBe("8/200");
    expect(fragments.get("reset")).toBe("1s");
  });
});
