import { COMMANDS } from "./constants";
import {
  getTerminalAliasCommandTemplates,
  getTerminalAliasCoverageActions,
  getTerminalAliasHelpEntries,
  isTerminalHelpTopic,
  parseTerminalAliasCommand,
  type TerminalAliasCommand,
  type TerminalCommandAvailabilityOptions,
  type TerminalHelpEntry,
  type TerminalHelpTopic
} from "./terminal-alias";

export type TerminalCatalogOptions = TerminalCommandAvailabilityOptions;

export type ParsedTerminalCommand =
  | {
      kind: "local";
      action: "help";
      topic: TerminalHelpTopic | null;
      raw: string;
    }
  | {
      kind: "local";
      action: "status" | "clear";
      raw: string;
    }
  | TerminalAliasCommand
  | {
      kind: "protocol";
      action: string;
      payload?: unknown;
      raw: string;
    };

type TerminalProtocolAction = (typeof COMMANDS)[keyof typeof COMMANDS];

const TEST_ONLY_PROTOCOL_ACTIONS = [
  COMMANDS.taskDemoStart,
  COMMANDS.taskDemoStop,
  COMMANDS.testHostCrash
] as const satisfies readonly TerminalProtocolAction[];

type TestOnlyTerminalProtocolAction = (typeof TEST_ONLY_PROTOCOL_ACTIONS)[number];
type BaseTerminalProtocolAction = Exclude<TerminalProtocolAction, TestOnlyTerminalProtocolAction>;

const PROTOCOL_ACTIONS = new Set<TerminalProtocolAction>(Object.values(COMMANDS) as TerminalProtocolAction[]);

const BASE_PROTOCOL_COMMAND_TEMPLATES = {
  [COMMANDS.ping]: ["ping"],
  [COMMANDS.overlayProbe]: ["overlay.probe", "overlay.probe {\"expectedUrl\":\"https://example.com/path\"}"],
  [COMMANDS.overlayOpen]: ["overlay.open", "overlay.open {\"expectedUrl\":\"https://example.com/path\"}"],
  [COMMANDS.overlayClose]: ["overlay.close"],
  [COMMANDS.hostConnect]: ["host.connect", "host.connect {\"reason\":\"manual\"}"],
  [COMMANDS.hostDisconnect]: ["host.disconnect", "host.disconnect {\"reason\":\"manual\"}"],
  [COMMANDS.hostStatus]: ["host.status"],
  [COMMANDS.hostRestart]: ["host.restart", "host.restart {\"reason\":\"manual\"}"],
  [COMMANDS.workerStart]: ["worker.start", "worker.start {\"reason\":\"manual\"}"],
  [COMMANDS.workerStop]: ["worker.stop", "worker.stop {\"reason\":\"manual\"}"],
  [COMMANDS.workerStatus]: ["worker.status"],
  [COMMANDS.configGet]: ["config.get {}"],
  [COMMANDS.configPatch]: ["config.patch {\"scope\":\"local\",\"patch\":{\"logging\":{\"level\":\"warn\"}}}"],
  [COMMANDS.configReset]: ["config.reset {\"scope\":\"local\"}", "config.reset {\"scope\":\"session\"}"],
  [COMMANDS.logList]: ["log.list {\"limit\":50}"],
  [COMMANDS.logSubscribe]: ["log.subscribe {\"since\":null}"],
  [COMMANDS.logRecord]: [
    "log.record {\"level\":\"info\",\"source\":\"overlay\",\"event\":\"manual.note\",\"summary\":\"Manual terminal note\"}"
  ],
  [COMMANDS.aiModelsCatalog]: ["ai.models.catalog"],
  [COMMANDS.aiChatStatus]: [
    "ai.chat.status {\"pageKey\":\"https://example.com/path\",\"pageUrl\":\"https://example.com/path\"}"
  ],
  [COMMANDS.aiChatSend]: [
    "ai.chat.send {\"pageKey\":\"https://example.com/path\",\"pageUrl\":\"https://example.com/path\",\"origin\":\"user\",\"text\":\"Reply with the exact token EDGE_CHAT_OK and nothing else.\"}",
    "ai.chat.send {\"pageKey\":\"https://example.com/path\",\"pageUrl\":\"https://example.com/path\",\"origin\":\"code\",\"text\":\"Reply with the exact token EDGE_CODE_OK and nothing else.\"}"
  ],
  [COMMANDS.aiChatCompact]: [
    "ai.chat.compact {\"pageKey\":\"https://example.com/path\",\"pageUrl\":\"https://example.com/path\",\"mode\":\"safe\"}",
    "ai.chat.compact {\"pageKey\":\"https://example.com/path\",\"mode\":\"force\"}"
  ],
  [COMMANDS.aiChatResume]: ["ai.chat.resume {\"pageKey\":\"https://example.com/path\"}"],
  [COMMANDS.aiChatReset]: ["ai.chat.reset {\"pageKey\":\"https://example.com/path\"}"],
  [COMMANDS.aiChatList]: ["ai.chat.list"]
} as const satisfies Record<BaseTerminalProtocolAction, readonly string[]>;

const TEST_PROTOCOL_COMMAND_TEMPLATES = {
  [COMMANDS.taskDemoStart]: ["task.demo.start {\"taskId\":\"demo-task\"}"],
  [COMMANDS.taskDemoStop]: ["task.demo.stop"],
  [COMMANDS.testHostCrash]: ["test.host.crash"]
} as const satisfies Record<TestOnlyTerminalProtocolAction, readonly string[]>;

const LOCAL_TERMINAL_COMMAND_TEMPLATES = [
  "help",
  "status",
  "clear"
] as const satisfies readonly string[];

const LOCAL_HELP_ENTRIES: TerminalHelpEntry[] = [
  {
    command: "help",
    description: "Показывает полный встроенный manual по консоли: first-class команды, предупреждения и raw fallback.",
    examples: ["help"]
  },
  {
    command: "status",
    description: "Возвращает компактный snapshot текущего состояния overlay, runtime и AI-чата.",
    examples: ["status"]
  },
  {
    command: "clear",
    description: "Очищает terminal activity feed внутри overlay.",
    examples: ["clear"]
  }
];

const PING_HELP_ENTRY: TerminalHelpEntry = {
  command: "ping",
  description: "Проверяет, что background-роутинг и протокол команд отвечают.",
  examples: ["ping"]
};

const RAW_PROTOCOL_DESCRIPTIONS: Record<TerminalProtocolAction, string> = {
  [COMMANDS.ping]: "Низкоуровневая проверка background command-router.",
  [COMMANDS.overlayProbe]: "Проверяет, можно ли открыть overlay на целевой вкладке или URL.",
  [COMMANDS.overlayOpen]: "Открывает overlay на целевой вкладке или URL.",
  [COMMANDS.overlayClose]: "Закрывает overlay на целевой вкладке.",
  [COMMANDS.hostConnect]: "Низкоуровневое подключение к native host.",
  [COMMANDS.hostDisconnect]: "Низкоуровневое отключение от native host.",
  [COMMANDS.hostStatus]: "Возвращает служебный статус native host.",
  [COMMANDS.hostRestart]: "Перезапускает native host на raw-слое.",
  [COMMANDS.workerStart]: "Запускает worker через raw protocol.",
  [COMMANDS.workerStop]: "Останавливает worker через raw protocol.",
  [COMMANDS.workerStatus]: "Возвращает raw worker status.",
  [COMMANDS.configGet]: "Возвращает полный runtime snapshot без alias-обертки.",
  [COMMANDS.configPatch]: "Применяет raw config patch с явным scope и patch-object.",
  [COMMANDS.configReset]: "Сбрасывает raw config scope local или session.",
  [COMMANDS.logList]: "Возвращает список runtime-логов через raw protocol.",
  [COMMANDS.logSubscribe]: "Возвращает snapshot для подписки на логи и runtime stream.",
  [COMMANDS.logRecord]: "Пишет запись в runtime log напрямую.",
  [COMMANDS.aiModelsCatalog]: "Возвращает каталог моделей OpenAI без alias-логики.",
  [COMMANDS.aiChatStatus]: "Возвращает статус AI-сессии по pageKey/pageUrl.",
  [COMMANDS.aiChatSend]: "Отправляет raw AI-chat запрос с явным page payload.",
  [COMMANDS.aiChatCompact]: "Принудительно запускает raw AI context compaction по pageKey/pageUrl.",
  [COMMANDS.aiChatResume]: "Возобновляет raw AI-chat сессию по pageKey.",
  [COMMANDS.aiChatReset]: "Сбрасывает raw AI-chat сессию по pageKey.",
  [COMMANDS.aiChatList]: "Возвращает список всех AI-сессий через raw protocol.",
  [COMMANDS.taskDemoStart]: "Raw test-команда запуска demo task.",
  [COMMANDS.taskDemoStop]: "Raw test-команда остановки demo task.",
  [COMMANDS.testHostCrash]: "Raw test-команда аварийного падения native host."
};

function flattenCommandTemplateGroups(templateGroups: Record<string, readonly string[]>): string[] {
  return Object.values(templateGroups).flatMap((templates) => [...templates]);
}

const BASE_PROTOCOL_TEMPLATES = flattenCommandTemplateGroups(BASE_PROTOCOL_COMMAND_TEMPLATES);
const TEST_PROTOCOL_TEMPLATES = flattenCommandTemplateGroups(TEST_PROTOCOL_COMMAND_TEMPLATES);

const BASE_TERMINAL_COMMAND_TEMPLATES = [
  ...LOCAL_TERMINAL_COMMAND_TEMPLATES,
  ...getTerminalAliasCommandTemplates(),
  ...BASE_PROTOCOL_TEMPLATES
] as const satisfies readonly string[];

const TEST_TERMINAL_COMMAND_TEMPLATES = [...TEST_PROTOCOL_TEMPLATES] as const satisfies readonly string[];

export const TERMINAL_COMMAND_TEMPLATES = [
  ...BASE_TERMINAL_COMMAND_TEMPLATES,
  ...TEST_TERMINAL_COMMAND_TEMPLATES
] as const;

export function getTerminalCommandTemplates(options?: TerminalCatalogOptions): string[] {
  return [
    ...LOCAL_TERMINAL_COMMAND_TEMPLATES,
    ...getTerminalAliasCommandTemplates(options),
    ...getRawTerminalCommandTemplates(options)
  ];
}

export function getRawTerminalCommandTemplates(options?: TerminalCatalogOptions): string[] {
  const templates = [...BASE_PROTOCOL_TEMPLATES];
  if ((options?.testCommandsEnabled ?? true) === true) {
    templates.push(
      ...TEST_PROTOCOL_COMMAND_TEMPLATES[COMMANDS.taskDemoStart],
      ...TEST_PROTOCOL_COMMAND_TEMPLATES[COMMANDS.taskDemoStop]
    );
    if ((options?.allowHostCrashCommand ?? true) === true) {
      templates.push(...TEST_PROTOCOL_COMMAND_TEMPLATES[COMMANDS.testHostCrash]);
    }
  }

  return templates;
}

export function getTerminalHelpLines(
  options?: TerminalCatalogOptions,
  topic?: TerminalHelpTopic | null
): string[] {
  if (topic === "raw") {
    return formatHelpSections([
      {
        title: "raw fallback",
        entries: getRawProtocolHelpEntries(options)
      }
    ]);
  }

  if (topic === "runtime") {
    return formatHelpSections([
      {
        title: "runtime",
        entries: [PING_HELP_ENTRY, ...getTerminalAliasHelpEntries("runtime", options)]
      }
    ]);
  }

  if (topic) {
    return formatHelpSections([
      {
        title: topic,
        entries: getTerminalAliasHelpEntries(topic, options)
      }
    ]);
  }

  return [
    "Справка по консоли LexTrace",
    "Один manual показывает весь first-class каталог, предупреждения и raw fallback.",
    "",
    ...formatHelpSections([
      {
        title: "основное",
        entries: LOCAL_HELP_ENTRIES
      },
      {
        title: "config",
        entries: getTerminalAliasHelpEntries("config", options)
      },
      {
        title: "chat",
        entries: getTerminalAliasHelpEntries("chat", options)
      },
      {
        title: "models",
        entries: getTerminalAliasHelpEntries("models", options)
      },
      {
        title: "logs",
        entries: getTerminalAliasHelpEntries("logs", options)
      },
      {
        title: "overlay",
        entries: getTerminalAliasHelpEntries("overlay", options)
      },
      {
        title: "popup",
        entries: getTerminalAliasHelpEntries("popup", options)
      },
      {
        title: "ai",
        entries: getTerminalAliasHelpEntries("ai", options)
      },
      {
        title: "runtime",
        entries: [PING_HELP_ENTRY, ...getTerminalAliasHelpEntries("runtime", options)]
      },
      {
        title: "tests",
        entries: getTerminalAliasHelpEntries("tests", options)
      },
      {
        title: "raw fallback",
        entries: getRawProtocolHelpEntries(options)
      }
    ])
  ];
}

export function getTerminalSuggestions(rawInput: string, limit = 6, options?: TerminalCatalogOptions): string[] {
  const normalizedInput = rawInput.trim().toLowerCase();
  if (!normalizedInput) {
    return [];
  }

  const suggestions: string[] = [];
  const seen = new Set<string>();
  const addSuggestions = (templates: readonly string[]) => {
    for (const template of templates) {
      if (suggestions.length >= limit) {
        return;
      }
      if (seen.has(template)) {
        continue;
      }
      seen.add(template);
      if (template.toLowerCase().includes(normalizedInput)) {
        suggestions.push(template);
      }
    }
  };

  const rawTemplates = getRawTerminalCommandTemplates(options);
  const rawTemplatesByCommand = new Map<string, string[]>();
  for (const template of rawTemplates) {
    const command = getCommandToken(template);
    const group = rawTemplatesByCommand.get(command) ?? [];
    group.push(template);
    rawTemplatesByCommand.set(command, group);
  }

  addSuggestions(LOCAL_TERMINAL_COMMAND_TEMPLATES);
  addSuggestions(getTerminalAliasCommandTemplates(options));

  // Prefer raw commands that expose uncovered functionality before showing
  // duplicate JSON examples for commands that already have a first-class alias.
  addSuggestions(
    [...rawTemplatesByCommand.entries()]
      .filter(([command]) => !seen.has(command))
      .map(([, templates]) => templates[0]!)
  );

  addSuggestions(
    [...rawTemplatesByCommand.entries()]
      .filter(([command]) => seen.has(command))
      .map(([, templates]) => templates[0]!)
  );

  addSuggestions(rawTemplates);

  return suggestions;
}

export function getTerminalCoveredProtocolActions(): string[] {
  return [
    ...new Set([
      ...getTerminalAliasCoverageActions(),
      ...Object.values(COMMANDS)
    ])
  ];
}

function getRawProtocolHelpEntries(options?: TerminalCatalogOptions): TerminalHelpEntry[] {
  const actions = getRawTerminalCommandTemplates(options);
  const actionExamples = new Map<string, string[]>();

  for (const template of actions) {
    const command = template.split(" ", 1)[0] ?? template;
    const examples = actionExamples.get(command) ?? [];
    examples.push(template);
    actionExamples.set(command, examples);
  }

  return [...actionExamples.entries()].map(([command, examples]) => ({
    command,
    description: RAW_PROTOCOL_DESCRIPTIONS[command as TerminalProtocolAction] ?? "Низкоуровневая protocol-команда.",
    examples,
    labels: ["RAW"]
  }));
}

function getCommandToken(template: string): string {
  return template.split(" ", 1)[0] ?? template;
}

function formatHelpSections(
  sections: Array<{
    title: string;
    entries: TerminalHelpEntry[];
  }>
): string[] {
  const lines: string[] = [];

  for (const section of sections) {
    if (section.entries.length === 0) {
      continue;
    }
    if (lines.length > 0) {
      lines.push("");
    }

    lines.push(`[${section.title}]`);
    for (const entry of section.entries) {
      const labels = entry.labels?.length ? ` ${entry.labels.map((label) => `[${label}]`).join(" ")}` : "";
      lines.push(`${entry.command}${labels}`);
      lines.push(`  Что делает: ${entry.description}`);
      if (entry.gatingNote) {
        lines.push(`  Статус: ${entry.gatingNote}`);
      }
      lines.push("  Примеры:");
      for (const example of entry.examples) {
        lines.push(`    ${example}`);
      }
    }
  }

  return lines;
}

export function parseTerminalCommand(rawInput: string): ParsedTerminalCommand | null {
  const raw = rawInput.trim();
  if (!raw) {
    return null;
  }

  if (raw === "clear" || raw === "status") {
    return {
      kind: "local",
      action: raw,
      raw
    };
  }

  if (raw === "help") {
    return {
      kind: "local",
      action: "help",
      topic: null,
      raw
    };
  }

  if (raw.startsWith("help ")) {
    const topic = raw.slice("help ".length).trim().toLowerCase();
    if (!isTerminalHelpTopic(topic)) {
      throw new Error(`Неизвестная тема help: ${topic}`);
    }
    return {
      kind: "local",
      action: "help",
      topic,
      raw
    };
  }

  const aliasCommand = parseTerminalAliasCommand(raw);
  if (aliasCommand) {
    return aliasCommand;
  }

  const whitespaceIndex = raw.indexOf(" ");
  const action = whitespaceIndex === -1 ? raw : raw.slice(0, whitespaceIndex);
  const payloadText = whitespaceIndex === -1 ? "" : raw.slice(whitespaceIndex + 1).trim();

  if (!PROTOCOL_ACTIONS.has(action as TerminalProtocolAction)) {
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
