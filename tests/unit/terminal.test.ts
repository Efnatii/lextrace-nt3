import { describe, expect, it } from "vitest";

import { COMMANDS } from "../../extension/src/shared/constants";
import {
  getTerminalCommandTemplates,
  getTerminalCoveredProtocolActions,
  getTerminalHelpLines,
  getTerminalSuggestions,
  parseTerminalCommand
} from "../../extension/src/shared/terminal";

describe("terminal helpers", () => {
  it("shows one detailed help manual by default", () => {
    const helpLines = getTerminalHelpLines();

    expect(helpLines[0]).toBe("Справка по консоли LexTrace");
    expect(helpLines).toContain("[основное]");
    expect(helpLines).toContain("[config]");
    expect(helpLines).toContain("[ai]");
    expect(helpLines).toContain("[raw fallback]");
    expect(helpLines).toContain("chat.compact.force [current|url <url>|key <pageKey> [pageUrl <url>]] [DANGER]");
    expect(helpLines).toContain("ai.key.set <value> [SECRET]");
    expect(helpLines.some((line) => line.includes("Что делает:"))).toBe(true);
    expect(helpLines.some((line) => line.includes("Примеры:"))).toBe(true);
  });

  it("shows gated test commands in help with explicit warnings", () => {
    const helpLines = getTerminalHelpLines({
      testCommandsEnabled: false,
      allowHostCrashCommand: false
    });

    expect(helpLines).toContain("demo.start [taskId] [TEST] [GATED]");
    expect(helpLines).toContain("host.crash [TEST] [DANGER] [GATED]");
    expect(helpLines.some((line) => line.includes("protocol.testCommandsEnabled=false"))).toBe(true);
  });

  it("exposes every protocol action in raw help", () => {
    const protocolActions = new Set(
      getTerminalHelpLines(undefined, "raw")
        .filter((line) => line && !line.startsWith("[") && !line.startsWith("  "))
        .map((line) => line.split(" ", 1)[0])
    );

    expect(protocolActions).toEqual(new Set(Object.values(COMMANDS)));
  });

  it("tracks protocol coverage across first-class and raw surfaces", () => {
    expect(new Set(getTerminalCoveredProtocolActions())).toEqual(new Set(Object.values(COMMANDS)));
  });

  it("shows topic-specific help", () => {
    const configHelp = getTerminalHelpLines(undefined, "config");
    expect(configHelp).toContain("[config]");
    expect(configHelp).toContain("config.paths [prefix]");

    const runtimeHelp = getTerminalHelpLines(undefined, "runtime");
    expect(runtimeHelp).toContain("[runtime]");
    expect(runtimeHelp).toContain("ping");
    expect(runtimeHelp).toContain("host.restart");

    const aiHelp = getTerminalHelpLines(undefined, "ai");
    expect(aiHelp).toContain("[ai]");
    expect(aiHelp).toContain("ai.key.status [SECRET]");
  });

  it("prioritizes alias suggestions before raw protocol templates", () => {
    expect(getTerminalSuggestions("config.get")).toEqual([
      "config.get",
      "config.get ai.chat.streamingEnabled",
      "config.get {}"
    ]);
  });

  it("surfaces local, alias, and raw suggestions by substring", () => {
    expect(getTerminalSuggestions("help")).toEqual(["help"]);
    expect(getTerminalSuggestions("models.allow")).toEqual([
      "models.allow list",
      "models.allow add gpt-5",
      "models.allow add gpt-5 priority",
      "models.allow remove gpt-5",
      "models.allow remove gpt-5 flex",
      "models.allow clear"
    ]);
    expect(getTerminalSuggestions("host")).toEqual([
      "host.connect",
      "host.disconnect",
      "host.status",
      "host.restart",
      "host.crash",
      "test.host.crash"
    ]);
  });

  it("filters test-only commands from templates when disabled", () => {
    expect(getTerminalCommandTemplates({ testCommandsEnabled: false })).not.toContain("demo.start");
    expect(getTerminalCommandTemplates({ testCommandsEnabled: false })).not.toContain(
      "task.demo.start {\"taskId\":\"demo-task\"}"
    );
  });

  it("filters host crash templates when explicitly forbidden", () => {
    expect(
      getTerminalCommandTemplates({
        testCommandsEnabled: true,
        allowHostCrashCommand: false
      })
    ).not.toContain("host.crash");
  });

  it("returns no suggestions for blank input", () => {
    expect(getTerminalSuggestions("")).toEqual([]);
    expect(getTerminalSuggestions("   ")).toEqual([]);
  });

  it("parses local help and status commands", () => {
    expect(parseTerminalCommand("help")).toEqual({
      kind: "local",
      action: "help",
      topic: null,
      raw: "help"
    });
    expect(parseTerminalCommand("help config")).toEqual({
      kind: "local",
      action: "help",
      topic: "config",
      raw: "help config"
    });
    expect(parseTerminalCommand("status")).toEqual({
      kind: "local",
      action: "status",
      raw: "status"
    });
    expect(parseTerminalCommand("clear")).toEqual({
      kind: "local",
      action: "clear",
      raw: "clear"
    });
  });

  it("parses first-class alias commands across all namespaces", () => {
    expect(parseTerminalCommand("host.connect")).toEqual({
      kind: "alias",
      namespace: "host",
      action: "connect",
      raw: "host.connect"
    });
    expect(parseTerminalCommand("worker.status")).toEqual({
      kind: "alias",
      namespace: "worker",
      action: "status",
      raw: "worker.status"
    });
    expect(parseTerminalCommand("popup.tab config")).toEqual({
      kind: "alias",
      namespace: "popup",
      action: "tab",
      tab: "config",
      raw: "popup.tab config"
    });
    expect(parseTerminalCommand("overlay.open url https://example.com/path")).toEqual({
      kind: "alias",
      namespace: "overlay",
      action: "open",
      target: {
        type: "url",
        url: "https://example.com/path"
      },
      raw: "overlay.open url https://example.com/path"
    });
    expect(parseTerminalCommand("ai.key.set sk-secret")).toEqual({
      kind: "alias",
      namespace: "ai-key",
      action: "set",
      valueText: "sk-secret",
      raw: "ai.key.set sk-secret"
    });
    expect(parseTerminalCommand("chat.status url https://example.com/path")).toEqual({
      kind: "alias",
      namespace: "chat",
      action: "status",
      target: {
        type: "url",
        url: "https://example.com/path"
      },
      raw: "chat.status url https://example.com/path"
    });
    expect(parseTerminalCommand("chat.send url https://example.com/path -- hello")).toEqual({
      kind: "alias",
      namespace: "chat",
      action: "send",
      target: {
        type: "url",
        url: "https://example.com/path"
      },
      text: "hello",
      raw: "chat.send url https://example.com/path -- hello"
    });
    expect(parseTerminalCommand("chat.send hello")).toEqual({
      kind: "alias",
      namespace: "chat",
      action: "send",
      target: {
        type: "current"
      },
      text: "hello",
      raw: "chat.send hello"
    });
    expect(parseTerminalCommand("chat.compact.force key https://example.com/path")).toEqual({
      kind: "alias",
      namespace: "chat",
      action: "compact",
      mode: "force",
      target: {
        type: "key",
        pageKey: "https://example.com/path",
        pageUrl: null
      },
      raw: "chat.compact.force key https://example.com/path"
    });
    expect(parseTerminalCommand("logs.subscribe since 2026-03-22T12:00:00.000Z")).toEqual({
      kind: "alias",
      namespace: "logs",
      action: "subscribe",
      since: "2026-03-22T12:00:00.000Z",
      raw: "logs.subscribe since 2026-03-22T12:00:00.000Z"
    });
    expect(parseTerminalCommand("demo.start demo-task")).toEqual({
      kind: "alias",
      namespace: "demo",
      action: "start",
      taskId: "demo-task",
      raw: "demo.start demo-task"
    });
  });

  it("keeps raw protocol fallback working", () => {
    expect(parseTerminalCommand("config.get {}")).toEqual({
      kind: "protocol",
      action: "config.get",
      payload: {},
      raw: "config.get {}"
    });
    expect(parseTerminalCommand("host.connect {\"reason\":\"manual\"}")).toEqual({
      kind: "protocol",
      action: "host.connect",
      payload: {
        reason: "manual"
      },
      raw: "host.connect {\"reason\":\"manual\"}"
    });
    expect(parseTerminalCommand("ping")).toEqual({
      kind: "protocol",
      action: "ping",
      raw: "ping"
    });
  });

  it("rejects unknown help topics and unknown commands", () => {
    expect(() => parseTerminalCommand("help nope")).toThrow(/help/i);
    expect(() => parseTerminalCommand("unknown.command")).toThrow(/unknown\.command/i);
  });
});
