import { describe, expect, it } from "vitest";

import {
  getTerminalAliasCommandTemplates,
  getTerminalAliasCoverageActions,
  getTerminalAliasHelpEntries,
  getTerminalAliasHelpLines,
  parseTerminalAliasCommand
} from "../../extension/src/shared/terminal-alias";

describe("terminal alias helpers", () => {
  it("returns grouped alias help", () => {
    expect(getTerminalAliasHelpLines()).toEqual([
      "[config]",
      "config.paths [prefix]",
      "config.get [path]",
      "config.set <path> <value>",
      "config.reset-field <path>",
      "config.reset <local|session>",
      "",
      "[chat]",
      "chat.status [current|url <url>|key <pageKey> [pageUrl <url>]]",
      "chat.send [target] -- <text>",
      "chat.code [target] -- <text>",
      "chat.resume [current|url <url>|key <pageKey> [pageUrl <url>]]",
      "chat.reset [current|url <url>|key <pageKey> [pageUrl <url>]]",
      "chat.list",
      "chat.compact [current|url <url>|key <pageKey> [pageUrl <url>]]",
      "chat.compact.force [current|url <url>|key <pageKey> [pageUrl <url>]]",
      "",
      "[models]",
      "models.list",
      "models.allow list",
      "models.allow add <model> [tier]",
      "models.allow remove <model> [tier]",
      "models.allow clear",
      "models.select <chat|compaction> <model> [tier]",
      "",
      "[logs]",
      "logs.tail [limit]",
      "logs.subscribe [all|since <iso-ts>]",
      "logs.note <summary>",
      "",
      "[overlay]",
      "overlay.probe [current|tab <id>|url <url>]",
      "overlay.open [current|tab <id>|url <url>]",
      "overlay.close [current|tab <id>|url <url>]",
      "overlay.hide",
      "overlay.tab <console|chat>",
      "",
      "[popup]",
      "popup.tab <control|config>",
      "",
      "[ai]",
      "ai.key.status",
      "ai.key.set <value>",
      "ai.key.clear",
      "ai.key.unmanage",
      "",
      "[runtime]",
      "host.connect",
      "host.disconnect",
      "host.status",
      "host.restart",
      "worker.start",
      "worker.stop",
      "worker.status",
      "",
      "[tests]",
      "demo.start [taskId]",
      "demo.stop",
      "host.crash"
    ]);
  });

  it("exposes alias command templates", () => {
    expect(getTerminalAliasCommandTemplates()).toContain("chat.compact");
    expect(getTerminalAliasCommandTemplates()).toContain("overlay.open url https://example.com/path");
    expect(getTerminalAliasCommandTemplates()).toContain("popup.tab config");
    expect(getTerminalAliasCommandTemplates()).toContain("ai.key.set sk-example-secret");
  });

  it("marks gated help entries when test commands are disabled", () => {
    const disabledEntries = getTerminalAliasHelpEntries("tests", {
      testCommandsEnabled: false,
      allowHostCrashCommand: false
    });

    expect(disabledEntries.every((entry) => entry.labels?.includes("GATED"))).toBe(true);
  });

  it("tracks explicit first-class protocol coverage", () => {
    expect(getTerminalAliasCoverageActions()).toContain("ai.chat.compact");
    expect(getTerminalAliasCoverageActions()).toContain("overlay.open");
    expect(getTerminalAliasCoverageActions()).toContain("test.host.crash");
  });

  it("parses namespace-specific alias commands", () => {
    expect(parseTerminalAliasCommand("config.get")).toEqual({
      kind: "alias",
      namespace: "config",
      action: "get",
      path: null,
      raw: "config.get"
    });
    expect(parseTerminalAliasCommand("chat.compact")).toEqual({
      kind: "alias",
      namespace: "chat",
      action: "compact",
      mode: "safe",
      target: {
        type: "current"
      },
      raw: "chat.compact"
    });
    expect(parseTerminalAliasCommand("models.allow list")).toEqual({
      kind: "alias",
      namespace: "models",
      action: "allow-list",
      raw: "models.allow list"
    });
    expect(parseTerminalAliasCommand("logs.subscribe")).toEqual({
      kind: "alias",
      namespace: "logs",
      action: "subscribe",
      since: null,
      raw: "logs.subscribe"
    });
    expect(parseTerminalAliasCommand("overlay.tab console")).toEqual({
      kind: "alias",
      namespace: "overlay",
      action: "tab",
      tab: "console",
      raw: "overlay.tab console"
    });
    expect(parseTerminalAliasCommand("popup.tab control")).toEqual({
      kind: "alias",
      namespace: "popup",
      action: "tab",
      tab: "control",
      raw: "popup.tab control"
    });
  });

  it("returns null for raw protocol-looking payloads", () => {
    expect(parseTerminalAliasCommand("config.get {}")).toBeNull();
    expect(parseTerminalAliasCommand("overlay.open {\"expectedUrl\":\"https://example.com\"}")).toBeNull();
  });

  it("rejects malformed alias commands", () => {
    expect(() => parseTerminalAliasCommand("config.set ai.chat.instructions")).toThrow(/config\.set/i);
    expect(() => parseTerminalAliasCommand("chat.compact no-such-target")).toThrow(/chat\.compact/i);
    expect(() => parseTerminalAliasCommand("models.select unknown gpt-5")).toThrow(/models\.select/i);
    expect(() => parseTerminalAliasCommand("models.allow add gpt-5 ultra")).toThrow(/tier/i);
    expect(() => parseTerminalAliasCommand("logs.tail 0")).toThrow(/limit/i);
    expect(() => parseTerminalAliasCommand("logs.subscribe since")).toThrow(/logs\.subscribe since/i);
    expect(() => parseTerminalAliasCommand("chat.send --   ")).toThrow(/chat\.send/i);
    expect(parseTerminalAliasCommand("logs.note")).toBeNull();
  });
});
