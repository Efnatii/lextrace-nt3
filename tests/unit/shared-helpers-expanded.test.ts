import { describe, expect, it, vi } from "vitest";

import {
  buildAllowedModelSections,
  buildModelSelectOptions,
  formatAllowedModelsDisplay,
  sortAiModelCatalog,
  type AllowedModelSectionItem
} from "../../extension/src/shared/ai-model-catalog";
import {
  createLogEntry,
  getLogPreview,
  isLogLevelEnabled,
  serializeError,
  serializeLogDetails,
  shouldCollapseLog,
  type LogEntry,
  type LogLevel
} from "../../extension/src/shared/logging";
import { buildOverlayActivityFeed } from "../../extension/src/shared/overlay-feed";
import {
  createOverlayProbeResult,
  getOverlaySupportReason,
  getOverlayUserMessage,
  isContentScriptUnavailableError
} from "../../extension/src/shared/overlay";
import { normalizePageKey, shortenPageKey } from "../../extension/src/shared/page";
import { canReconnect, getReconnectDelayMs } from "../../extension/src/shared/retry";
import {
  getTerminalCommandTemplates,
  getTerminalSuggestions,
  parseTerminalCommand
} from "../../extension/src/shared/terminal";
import type { AiModelCatalogItem } from "../../extension/src/shared/ai";

const MODEL_CATALOG: AiModelCatalogItem[] = [
  {
    id: "gpt-5",
    created: 200,
    ownedBy: "system",
    family: "gpt-5",
    matchedBy: {
      standard: "exact",
      flex: "exact",
      priority: "exact"
    },
    pricing: {
      sourceUrl: "https://example.com/pricing",
      standard: {
        tier: "standard",
        pricingModelId: "gpt-5",
        inputUsdPer1M: 1,
        cachedInputUsdPer1M: 0.1,
        outputUsdPer1M: 8,
        trainingUsdPer1M: null,
        trainingUsdPerHour: null,
        summaryUsdPer1M: 9
      },
      flex: {
        tier: "flex",
        pricingModelId: "gpt-5",
        inputUsdPer1M: 0.5,
        cachedInputUsdPer1M: 0.05,
        outputUsdPer1M: 4,
        trainingUsdPer1M: null,
        trainingUsdPerHour: null,
        summaryUsdPer1M: 4.5
      },
      priority: {
        tier: "priority",
        pricingModelId: "gpt-5",
        inputUsdPer1M: 2,
        cachedInputUsdPer1M: 0.2,
        outputUsdPer1M: 16,
        trainingUsdPer1M: null,
        trainingUsdPerHour: null,
        summaryUsdPer1M: 18
      }
    }
  },
  {
    id: "gpt-5-mini",
    created: 300,
    ownedBy: "system",
    family: "gpt-5-mini",
    matchedBy: {
      standard: "exact",
      flex: "exact",
      priority: "unavailable"
    },
    pricing: {
      sourceUrl: "https://example.com/pricing",
      standard: {
        tier: "standard",
        pricingModelId: "gpt-5-mini",
        inputUsdPer1M: 0.25,
        cachedInputUsdPer1M: 0.025,
        outputUsdPer1M: 2,
        trainingUsdPer1M: null,
        trainingUsdPerHour: null,
        summaryUsdPer1M: 2.25
      },
      flex: {
        tier: "flex",
        pricingModelId: "gpt-5-mini",
        inputUsdPer1M: 0.125,
        cachedInputUsdPer1M: 0.0125,
        outputUsdPer1M: 1,
        trainingUsdPer1M: null,
        trainingUsdPerHour: null,
        summaryUsdPer1M: 1.125
      },
      priority: {
        tier: "priority",
        pricingModelId: "gpt-5-mini",
        inputUsdPer1M: null,
        cachedInputUsdPer1M: null,
        outputUsdPer1M: null,
        trainingUsdPer1M: null,
        trainingUsdPerHour: null,
        summaryUsdPer1M: null
      }
    }
  }
];

describe("logging helpers", () => {
  it("serializes string details directly", () => {
    expect(serializeLogDetails("plain text")).toBe("plain text");
  });

  it("serializes object details as pretty JSON", () => {
    expect(serializeLogDetails({ answer: 42 })).toContain('"answer": 42');
  });

  it("collapses long summaries", () => {
    expect(shouldCollapseLog("x".repeat(300), undefined, 100)).toBe(true);
  });

  it("collapses long details", () => {
    expect(shouldCollapseLog("short", { message: "x".repeat(300) }, 100)).toBe(true);
  });

  it.each([
    ["debug", "debug", true],
    ["info", "debug", true],
    ["warn", "info", true],
    ["debug", "warn", false]
  ] as const)("checks log level %s against %s", (entryLevel, thresholdLevel, expected) => {
    expect(isLogLevelEnabled(entryLevel as LogLevel, thresholdLevel as LogLevel)).toBe(expected);
  });

  it("serializes extended Error fields", () => {
    const error = new Error("boom") as Error & { code?: string; details?: unknown };
    error.code = "E_BOOM";
    error.details = { phase: "test" };

    expect(serializeError(error)).toMatchObject({
      message: "boom",
      code: "E_BOOM",
      details: { phase: "test" }
    });
  });

  it("builds previews from details when they are present", () => {
    const entry: LogEntry = {
      id: "log-1",
      ts: "2026-03-22T12:00:00.000Z",
      level: "info",
      source: "tests",
      event: "demo",
      summary: "summary",
      details: {
        payload: "hello"
      },
      correlationId: null,
      collapsedByDefault: false
    };

    expect(getLogPreview(entry)).toContain('"payload": "hello"');
  });

  it("creates log entries with collapse metadata", () => {
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue("00000000-0000-0000-0000-000000000001");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-22T12:00:00.000Z"));

    const entry = createLogEntry(
      {
        level: "warn",
        source: "tests",
        event: "demo",
        summary: "x".repeat(300)
      },
      100
    );

    expect(entry).toMatchObject({
        id: "00000000-0000-0000-0000-000000000001",
      level: "warn",
      collapsedByDefault: true
    });

    vi.useRealTimers();
    vi.restoreAllMocks();
  });
});

describe("overlay activity feed", () => {
  it("sorts terminal and runtime activities by timestamp then sequence", () => {
    const items = buildOverlayActivityFeed(
      [
        {
          id: "terminal-1",
          ts: "2026-03-22T12:00:01.000Z",
          kind: "command",
          text: "help",
          sequence: 3
        }
      ],
      [
        {
          id: "log-1",
          ts: "2026-03-22T12:00:00.000Z",
          level: "info",
          source: "tests",
          event: "boot",
          summary: "ready",
          correlationId: null,
          collapsedByDefault: false
        }
      ]
    );

    expect(items.map((item) => item.id)).toEqual(["log-1", "terminal-1"]);
  });

  it("uses runtime log sequences when provided", () => {
    const items = buildOverlayActivityFeed(
      [],
      [
        {
          id: "log-a",
          ts: "2026-03-22T12:00:00.000Z",
          level: "info",
          source: "tests",
          event: "a",
          summary: "a",
          correlationId: null,
          collapsedByDefault: false
        }
      ],
      new Map([["log-a", 99]])
    );

    expect(items[0]).toMatchObject({
      id: "log-a",
      sequence: 99
    });
  });
});

describe("overlay support helpers", () => {
  it.each([
    ["https://example.com", null],
    ["http://example.com/path", null],
    ["https://example.com/file.pdf", "unsupported_tab"],
    ["chrome://extensions", "unsupported_tab"],
    [null, "unsupported_tab"]
  ])("detects overlay support for %s", (url, expected) => {
    expect(getOverlaySupportReason(url)).toBe(expected);
  });

  it("creates a ready overlay probe result for supported tabs", () => {
    expect(createOverlayProbeResult(7, "https://example.com", true, null)).toMatchObject({
      eligible: true,
      ready: true,
      tabId: 7
    });
  });

  it("marks unsupported tabs as ineligible", () => {
    expect(createOverlayProbeResult(8, "about:blank", false, "unsupported_tab")).toMatchObject({
      eligible: false,
      ready: false
    });
  });

  it("recognizes content script unavailable errors", () => {
    expect(isContentScriptUnavailableError(new Error("Could not establish connection. Receiving end does not exist."))).toBe(true);
    expect(isContentScriptUnavailableError(new Error("message port closed before a response was received"))).toBe(true);
    expect(isContentScriptUnavailableError(new Error("different error"))).toBe(false);
  });

  it("returns a positive user message for ready overlays", () => {
    expect(getOverlayUserMessage({ eligible: true, ready: true, reason: null })).toContain("Терминал");
  });
});

describe("page and retry helpers", () => {
  it.each([
    ["https://EXAMPLE.com/path/?q=1", "https://example.com/path"],
    ["http://example.com:80//a//b/", "http://example.com/a/b"],
    ["https://example.com:443", "https://example.com/"],
    ["chrome://extensions", null]
  ])("normalizes page key for %s", (rawUrl, expected) => {
    expect(normalizePageKey(rawUrl)).toBe(expected);
  });

  it("shortens long page keys and preserves short ones", () => {
    expect(shortenPageKey("https://example.com/short", 40)).toBe("https://example.com/short");
    expect(shortenPageKey("https://example.com/very/long/path", 12)).toHaveLength(12);
  });

  it.each([
    [0, 1000],
    [1, 1000],
    [2, 2000],
    [3, 4000],
    [10, 8000]
  ])("calculates reconnect delay for attempt %s", (attempt, expected) => {
    expect(
      getReconnectDelayMs(attempt, {
        baseDelayMs: 1000,
        maxDelayMs: 8000,
        maxAttempts: 5
      })
    ).toBe(expected);
  });

  it.each([
    [1, true],
    [5, true],
    [6, false]
  ])("checks reconnect eligibility for attempt %s", (attempt, expected) => {
    expect(
      canReconnect(attempt, {
        baseDelayMs: 1000,
        maxDelayMs: 8000,
        maxAttempts: 5
      })
    ).toBe(expected);
  });
});

describe("terminal helpers", () => {
  it("filters test-only commands from the template catalog when disabled", () => {
    expect(getTerminalCommandTemplates({ testCommandsEnabled: false })).not.toContain("task.demo.start {\"taskId\":\"demo-task\"}");
    expect(getTerminalCommandTemplates({ testCommandsEnabled: false })).not.toContain("demo.start");
  });

  it("filters host crash from the template catalog when explicitly forbidden", () => {
    expect(
      getTerminalCommandTemplates({
        testCommandsEnabled: true,
        allowHostCrashCommand: false
      })
    ).not.toContain("test.host.crash");
  });

  it("returns no suggestions for blank input", () => {
    expect(getTerminalSuggestions("   ")).toEqual([]);
  });

  it("limits terminal suggestions", () => {
    expect(getTerminalSuggestions("a", 2).length).toBeLessThanOrEqual(2);
  });

  it("finds terminal suggestions by substring", () => {
    expect(getTerminalSuggestions("host.")).toContain("host.connect");
  });

  it("parses local terminal commands", () => {
    expect(parseTerminalCommand("help")).toEqual({
      kind: "local",
      action: "help",
      topic: null,
      raw: "help"
    });
  });

  it("parses protocol terminal commands without payload", () => {
    expect(parseTerminalCommand("worker.status")).toEqual({
      kind: "alias",
      namespace: "worker",
      action: "status",
      raw: "worker.status"
    });
  });

  it("parses protocol terminal commands with JSON payload", () => {
    expect(parseTerminalCommand("log.list {\"limit\":5}")).toEqual({
      kind: "protocol",
      action: "log.list",
      payload: {
        limit: 5
      },
      raw: "log.list {\"limit\":5}"
    });
  });

  it("rejects unknown terminal commands", () => {
    expect(() => parseTerminalCommand("unknown.command")).toThrow(/unknown\.command/i);
  });
});

describe("AI model catalog helpers", () => {
  it("sorts by availability before price when requested", () => {
    expect(sortAiModelCatalog(MODEL_CATALOG, "availability", "priority").map((item) => item.id)).toEqual([
      "gpt-5",
      "gpt-5-mini"
    ]);
  });

  it("adds an empty option and preserves unknown current values", () => {
    const options = buildModelSelectOptions(
      MODEL_CATALOG,
      [],
      "legacy-model",
      "standard",
      true
    );

    expect(options[0]?.value).toBe("legacy-model");
    expect(options.some((option) => option.value === "")).toBe(true);
  });

  it("builds allowed model sections for missing catalog entries", () => {
    const sections = buildAllowedModelSections(MODEL_CATALOG, [
      { model: "missing-model", tier: "priority" }
    ]);

    expect((sections.priority[0] as AllowedModelSectionItem).model).toBeNull();
    expect((sections.priority[0] as AllowedModelSectionItem).tooltip).toContain("missing-model");
  });

  it("formats the allowed-model preview for multiple rules", () => {
    expect(
      formatAllowedModelsDisplay([
        { model: "gpt-5", tier: "standard" },
        { model: "gpt-5-mini", tier: "flex" },
        { model: "gpt-4.1", tier: "priority" }
      ])
    ).toContain("+1");
  });
});
