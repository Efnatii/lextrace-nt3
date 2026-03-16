import { COMMANDS } from "./constants";

export type TerminalCatalogOptions = {
  testCommandsEnabled?: boolean;
  allowHostCrashCommand?: boolean;
};

export type ParsedTerminalCommand =
  | {
      kind: "local";
      action: "help" | "clear";
      raw: string;
    }
  | {
      kind: "protocol";
      action: string;
      payload?: unknown;
      raw: string;
    };

const PROTOCOL_ACTIONS = new Set<string>([
  COMMANDS.workerStart,
  COMMANDS.workerStop,
  COMMANDS.workerStatus,
  COMMANDS.taskDemoStart,
  COMMANDS.taskDemoStop,
  COMMANDS.configGet,
  COMMANDS.configPatch,
  COMMANDS.logList,
  COMMANDS.ping,
  COMMANDS.overlayClose,
  COMMANDS.aiChatStatus,
  COMMANDS.aiChatSend,
  COMMANDS.aiChatResume,
  COMMANDS.aiChatReset,
  COMMANDS.aiChatList,
  COMMANDS.testHostCrash
]);

const BASE_TERMINAL_COMMAND_TEMPLATES = [
  "help",
  "clear",
  "worker.start",
  "worker.stop",
  "worker.status",
  "config.get",
  "config.patch {\"scope\":\"local\",\"patch\":{\"logging\":{\"level\":\"warn\"}}}",
  "log.list {\"limit\":50}",
  "ping",
  "overlay.close",
  "ai.chat.status {\"pageKey\":\"https://example.com/path\",\"pageUrl\":\"https://example.com/path\"}",
  "ai.chat.send {\"pageKey\":\"https://example.com/path\",\"pageUrl\":\"https://example.com/path\",\"origin\":\"code\",\"text\":\"Reply with exact token EDGE_CODE_OK and nothing else.\"}",
  "ai.chat.resume {\"pageKey\":\"https://example.com/path\"}",
  "ai.chat.reset {\"pageKey\":\"https://example.com/path\"}",
  "ai.chat.list"
] as const satisfies readonly string[];

const TEST_TERMINAL_COMMAND_TEMPLATES = [
  "task.demo.start {\"taskId\":\"demo-task\"}",
  "task.demo.stop",
  "test.host.crash"
] as const satisfies readonly string[];

export const TERMINAL_COMMAND_TEMPLATES = [
  ...BASE_TERMINAL_COMMAND_TEMPLATES,
  ...TEST_TERMINAL_COMMAND_TEMPLATES
] as const;

export function getTerminalCommandTemplates(options?: TerminalCatalogOptions): string[] {
  const testCommandsEnabled = options?.testCommandsEnabled ?? true;
  const allowHostCrashCommand = options?.allowHostCrashCommand ?? true;

  const templates: string[] = [...BASE_TERMINAL_COMMAND_TEMPLATES];
  if (testCommandsEnabled) {
    templates.push(TEST_TERMINAL_COMMAND_TEMPLATES[0], TEST_TERMINAL_COMMAND_TEMPLATES[1]);
    if (allowHostCrashCommand) {
      templates.push(TEST_TERMINAL_COMMAND_TEMPLATES[2]);
    }
  }

  return templates;
}

export function getTerminalHelpLines(options?: TerminalCatalogOptions): string[] {
  return getTerminalCommandTemplates(options);
}

export function getTerminalSuggestions(rawInput: string, limit = 6, options?: TerminalCatalogOptions): string[] {
  const normalizedInput = rawInput.trim().toLowerCase();
  if (!normalizedInput) {
    return [];
  }

  const suggestions = getTerminalCommandTemplates(options).filter((template) => {
    return template.toLowerCase().includes(normalizedInput);
  });

  return suggestions.slice(0, limit);
}

export function parseTerminalCommand(rawInput: string): ParsedTerminalCommand | null {
  const raw = rawInput.trim();
  if (!raw) {
    return null;
  }

  if (raw === "help" || raw === "clear") {
    return {
      kind: "local",
      action: raw,
      raw
    };
  }

  const whitespaceIndex = raw.indexOf(" ");
  const action = whitespaceIndex === -1 ? raw : raw.slice(0, whitespaceIndex);
  const payloadText = whitespaceIndex === -1 ? "" : raw.slice(whitespaceIndex + 1).trim();

  if (!PROTOCOL_ACTIONS.has(action)) {
    throw new Error(`Unknown terminal command: ${action}`);
  }

  if (!payloadText) {
    return {
      kind: "protocol",
      action,
      raw
    };
  }

  return {
    kind: "protocol",
    action,
    payload: JSON.parse(payloadText),
    raw
  };
}
