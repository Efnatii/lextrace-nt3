import { describe, expect, it } from "vitest";

import { getTerminalHelpLines, getTerminalSuggestions, parseTerminalCommand } from "../../extension/src/shared/terminal";

describe("terminal helpers", () => {
  it("returns substring-matching suggestions with templates", () => {
    expect(getTerminalSuggestions("work")).toEqual([
      "worker.start",
      "worker.stop",
      "worker.status"
    ]);
  });

  it("returns matches for non-prefix substrings", () => {
    expect(getTerminalSuggestions("demo")).toEqual([
      "task.demo.start {\"taskId\":\"demo-task\"}",
      "task.demo.stop"
    ]);
  });

  it("returns no suggestions when input is empty", () => {
    expect(getTerminalSuggestions("")).toEqual([]);
  });

  it("returns no suggestions when input contains only whitespace", () => {
    expect(getTerminalSuggestions("   ")).toEqual([]);
  });

  it("hides demo and crash commands when test commands are disabled", () => {
    expect(getTerminalSuggestions("demo", 6, { testCommandsEnabled: false })).toEqual([]);
    expect(getTerminalHelpLines({ testCommandsEnabled: false })).not.toContain(
      "task.demo.start {\"taskId\":\"demo-task\"}"
    );
  });

  it("hides host crash command when crash is explicitly disabled", () => {
    expect(getTerminalSuggestions("crash", 6, {
      testCommandsEnabled: true,
      allowHostCrashCommand: false
    })).toEqual([]);
  });

  it("parses local clear command", () => {
    expect(parseTerminalCommand("clear")).toEqual({
      kind: "local",
      action: "clear",
      raw: "clear"
    });
  });
});
