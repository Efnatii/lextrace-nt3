import { describe, expect, it } from "vitest";

import { buildAiChatStatusFragments, createDefaultAiStatus } from "../../extension/src/shared/ai";
import {
  buildStatusChipDescriptors,
  findMissingStatusChipKeys,
  getStatusChipKeys
} from "../../extension/src/shared/status-chips";

describe("status chip catalog", () => {
  it("covers every chat status label emitted by the AI status builder", () => {
    const status = createDefaultAiStatus("page-key", "https://example.com/page", true);
    status.resolvedServiceTier = "priority";
    status.promptCaching.lastRequest = {
      source: "compaction",
      promptTokens: 120,
      cachedTokens: 72,
      hitRatePct: 60,
      status: "partial_hit",
      retentionApplied: "24h",
      routingApplied: "provider_default",
      updatedAt: "2026-03-22T12:00:00.000Z"
    };

    const missing = findMissingStatusChipKeys(
      "chat",
      buildAiChatStatusFragments(status).map(([key]) => key)
    );

    expect(missing).toEqual([]);
  });

  it("covers all six console status chips", () => {
    expect(getStatusChipKeys("console")).toEqual([
      "задача",
      "запуск",
      "пульс",
      "сессия",
      "состояние",
      "хост"
    ]);
  });

  it("preserves page full value while allowing a shortened display value", () => {
    const [descriptor] = buildStatusChipDescriptors("chat", [
      {
        key: "page",
        value: "example.com/.../tail",
        fullValue: "https://example.com/very/long/path/tail"
      }
    ]);

    expect(descriptor.tooltipLabel).toBe("Страница");
    expect(descriptor.value).toBe("example.com/.../tail");
    expect(descriptor.fullValue).toBe("https://example.com/very/long/path/tail");
    expect(descriptor.width).toBe("page");
  });

  it("preserves full bootId while keeping the launch chip compact", () => {
    const [descriptor] = buildStatusChipDescriptors("console", [
      {
        key: "запуск",
        value: "boot-123",
        fullValue: "boot-123456789"
      }
    ]);

    expect(descriptor.tooltipLabel).toBe("Запуск");
    expect(descriptor.value).toBe("boot-123");
    expect(descriptor.fullValue).toBe("boot-123456789");
    expect(descriptor.width).toBe("short");
  });
});
