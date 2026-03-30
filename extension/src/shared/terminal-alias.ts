import { COMMANDS } from "./constants";
import type { AiServiceTier } from "./ai";
import type { OverlayTab, PopupTab } from "./config";

export const TERMINAL_HELP_TOPICS = [
  "config",
  "chat",
  "text",
  "models",
  "logs",
  "overlay",
  "popup",
  "ai",
  "runtime",
  "tests",
  "raw"
] as const;

export type TerminalHelpTopic = (typeof TERMINAL_HELP_TOPICS)[number];
export type TerminalCommandAvailabilityOptions = {
  testCommandsEnabled?: boolean;
  allowHostCrashCommand?: boolean;
};
export type TerminalHelpLabel = "SECRET" | "DANGER" | "TEST" | "RAW" | "GATED";

export type TerminalHelpEntry = {
  command: string;
  description: string;
  examples: string[];
  labels?: TerminalHelpLabel[];
  gatingNote?: string | null;
};

export type TerminalOverlayTarget =
  | {
      type: "current";
    }
  | {
      type: "tab";
      tabId: number;
    }
  | {
      type: "url";
      url: string;
    };

export type TerminalChatTarget =
  | {
      type: "current";
    }
  | {
      type: "url";
      url: string;
    }
  | {
      type: "key";
      pageKey: string;
      pageUrl: string | null;
    };

export type TerminalAliasCommand =
  | {
      kind: "alias";
      namespace: "config";
      action: "paths";
      prefix: string | null;
      raw: string;
    }
  | {
      kind: "alias";
      namespace: "config";
      action: "get";
      path: string | null;
      raw: string;
    }
  | {
      kind: "alias";
      namespace: "config";
      action: "set";
      path: string;
      valueText: string;
      raw: string;
    }
  | {
      kind: "alias";
      namespace: "config";
      action: "reset-field";
      path: string;
      raw: string;
    }
  | {
      kind: "alias";
      namespace: "config";
      action: "reset";
      scope: "local" | "session";
      raw: string;
    }
  | {
      kind: "alias";
      namespace: "chat";
      action: "status" | "resume" | "reset";
      target: TerminalChatTarget;
      raw: string;
    }
  | {
      kind: "alias";
      namespace: "chat";
      action: "send" | "code";
      target: TerminalChatTarget;
      text: string;
      raw: string;
    }
  | {
      kind: "alias";
      namespace: "chat";
      action: "compact";
      mode: "safe" | "force";
      target: TerminalChatTarget;
      raw: string;
    }
  | {
      kind: "alias";
      namespace: "chat";
      action: "list";
      raw: string;
    }
  | {
      kind: "alias";
      namespace: "text";
      action: "status" | "scan" | "download";
      raw: string;
    }
  | {
      kind: "alias";
      namespace: "text";
      action: "list";
      filter: "all" | "changed";
      raw: string;
    }
  | {
      kind: "alias";
      namespace: "text";
      action: "set";
      bindingId: string;
      text: string;
      raw: string;
    }
  | {
      kind: "alias";
      namespace: "text";
      action: "revert";
      bindingId: string;
      raw: string;
    }
  | {
      kind: "alias";
      namespace: "text";
      action: "mode";
      mode: "effective" | "original";
      raw: string;
    }
  | {
      kind: "alias";
      namespace: "text";
      action: "reset";
      scope: "page" | "all";
      raw: string;
    }
  | {
      kind: "alias";
      namespace: "text";
      action: "delete";
      scope: "page" | "all";
      raw: string;
    }
  | {
      kind: "alias";
      namespace: "text";
      action: "delete";
      bindingId: string;
      raw: string;
    }
  | {
      kind: "alias";
      namespace: "models";
      action: "list";
      raw: string;
    }
  | {
      kind: "alias";
      namespace: "models";
      action: "allow-list" | "allow-clear";
      raw: string;
    }
  | {
      kind: "alias";
      namespace: "models";
      action: "allow-add" | "allow-remove";
      model: string;
      tier: AiServiceTier;
      raw: string;
    }
  | {
      kind: "alias";
      namespace: "models";
      action: "select";
      target: "chat" | "compaction";
      model: string;
      tier: AiServiceTier;
      raw: string;
    }
  | {
      kind: "alias";
      namespace: "logs";
      action: "tail";
      limit: number;
      raw: string;
    }
  | {
      kind: "alias";
      namespace: "logs";
      action: "subscribe";
      since: string | null;
      raw: string;
    }
  | {
      kind: "alias";
      namespace: "logs";
      action: "note";
      summary: string;
      raw: string;
    }
  | {
      kind: "alias";
      namespace: "overlay";
      action: "probe" | "open" | "close";
      target: TerminalOverlayTarget;
      raw: string;
    }
  | {
      kind: "alias";
      namespace: "overlay";
      action: "tab";
      tab: OverlayTab;
      raw: string;
    }
  | {
      kind: "alias";
      namespace: "overlay";
      action: "hide";
      raw: string;
    }
  | {
      kind: "alias";
      namespace: "popup";
      action: "tab";
      tab: PopupTab;
      raw: string;
    }
  | {
      kind: "alias";
      namespace: "host";
      action: "connect" | "disconnect" | "status" | "restart" | "crash";
      raw: string;
    }
  | {
      kind: "alias";
      namespace: "worker";
      action: "start" | "stop" | "status";
      raw: string;
    }
  | {
      kind: "alias";
      namespace: "demo";
      action: "start";
      taskId: string | null;
      raw: string;
    }
  | {
      kind: "alias";
      namespace: "demo";
      action: "stop";
      raw: string;
    }
  | {
      kind: "alias";
      namespace: "ai-key";
      action: "status" | "clear" | "unmanage";
      raw: string;
    }
  | {
      kind: "alias";
      namespace: "ai-key";
      action: "set";
      valueText: string;
      raw: string;
    };

type RegistryTopic = Exclude<TerminalHelpTopic, "raw">;
type RegistryGate = "test" | "host-crash";
type TerminalHelpEntrySpec = {
  topic: RegistryTopic;
  command: string;
  description: string;
  examples: string[];
  labels?: Exclude<TerminalHelpLabel, "GATED" | "RAW">[];
  gate?: RegistryGate;
  coversActions?: string[];
};

const HELP_ENTRY_REGISTRY: readonly TerminalHelpEntrySpec[] = [
  {
    topic: "runtime",
    command: "host.connect",
    description: "Подключает extension к native host.",
    examples: ["host.connect"],
    coversActions: [COMMANDS.hostConnect]
  },
  {
    topic: "runtime",
    command: "host.disconnect",
    description: "Разрывает текущее подключение к native host.",
    examples: ["host.disconnect"],
    coversActions: [COMMANDS.hostDisconnect]
  },
  {
    topic: "runtime",
    command: "host.status",
    description: "Показывает текущее состояние подключения к native host.",
    examples: ["host.status"],
    coversActions: [COMMANDS.hostStatus]
  },
  {
    topic: "runtime",
    command: "host.restart",
    description: "Перезапускает native host и переподключает runtime.",
    examples: ["host.restart"],
    coversActions: [COMMANDS.hostRestart]
  },
  {
    topic: "runtime",
    command: "worker.start",
    description: "Запускает background worker native host.",
    examples: ["worker.start"],
    coversActions: [COMMANDS.workerStart]
  },
  {
    topic: "runtime",
    command: "worker.stop",
    description: "Останавливает background worker native host.",
    examples: ["worker.stop"],
    coversActions: [COMMANDS.workerStop]
  },
  {
    topic: "runtime",
    command: "worker.status",
    description: "Показывает статус worker, boot/session/task и heartbeat.",
    examples: ["worker.status"],
    coversActions: [COMMANDS.workerStatus]
  },
  {
    topic: "overlay",
    command: "overlay.probe [current|tab <id>|url <url>]",
    description: "Проверяет, можно ли открыть overlay на текущей вкладке, указанной вкладке или URL.",
    examples: ["overlay.probe", "overlay.probe tab 123", "overlay.probe url https://example.com/path"],
    coversActions: [COMMANDS.overlayProbe]
  },
  {
    topic: "overlay",
    command: "overlay.open [current|tab <id>|url <url>]",
    description: "Открывает overlay на текущей вкладке, указанной вкладке или URL.",
    examples: ["overlay.open", "overlay.open tab 123", "overlay.open url https://example.com/path"],
    coversActions: [COMMANDS.overlayOpen]
  },
  {
    topic: "overlay",
    command: "overlay.close [current|tab <id>|url <url>]",
    description: "Закрывает overlay на текущей вкладке, указанной вкладке или URL.",
    examples: ["overlay.close", "overlay.close tab 123", "overlay.close url https://example.com/path"],
    coversActions: [COMMANDS.overlayClose]
  },
  {
    topic: "overlay",
    command: "overlay.hide",
    description: "Закрывает текущий overlay тем же способом, что и кнопка закрытия.",
    examples: ["overlay.hide"],
    coversActions: [COMMANDS.overlayClose]
  },
  {
    topic: "overlay",
    command: "overlay.tab <console|chat>",
    description: "Переключает активную вкладку overlay и сохраняет выбор в session config.",
    examples: ["overlay.tab console", "overlay.tab chat"],
    coversActions: [COMMANDS.configPatch]
  },
  {
    topic: "popup",
    command: "popup.tab <control|config>",
    description: "Переключает активную вкладку popup и сохраняет выбор в session config.",
    examples: ["popup.tab control", "popup.tab config"],
    coversActions: [COMMANDS.configPatch]
  },
  {
    topic: "config",
    command: "config.paths [prefix]",
    description: "Показывает все доступные для консоли пути конфига без секретных полей.",
    examples: ["config.paths", "config.paths ai."],
    coversActions: [COMMANDS.configGet]
  },
  {
    topic: "config",
    command: "config.get [path]",
    description: "Читает безопасный effective config или конкретное поле с указанием scope.",
    examples: ["config.get", "config.get ai.chat.streamingEnabled"],
    coversActions: [COMMANDS.configGet]
  },
  {
    topic: "config",
    command: "config.set <path> <value>",
    description: "Меняет несекретное поле конфига через ту же валидацию, что и popup.",
    examples: [
      "config.set logging.level warn",
      "config.set ai.chat.instructions \"\"",
      "config.set ai.chat.instructions Reply tersely and follow the requested token exactly."
    ],
    coversActions: [COMMANDS.configPatch]
  },
  {
    topic: "config",
    command: "config.reset-field <path>",
    description: "Сбрасывает конкретное поле к значению по умолчанию.",
    examples: ["config.reset-field ai.chat.instructions", "config.reset-field ui.overlay.activeTab"],
    coversActions: [COMMANDS.configPatch]
  },
  {
    topic: "config",
    command: "config.reset <local|session>",
    description: "Сбрасывает целую область конфига и возвращает свежий snapshot.",
    examples: ["config.reset local", "config.reset session"],
    coversActions: [COMMANDS.configReset]
  },
  {
    topic: "ai",
    command: "ai.key.status",
    description: "Показывает безопасный статус API key: managed, environment или missing.",
    examples: ["ai.key.status"],
    labels: ["SECRET"],
    coversActions: [COMMANDS.configGet, COMMANDS.aiChatList]
  },
  {
    topic: "ai",
    command: "ai.key.set <value>",
    description: "Устанавливает managed OpenAI API key без вывода значения в логах терминала.",
    examples: ["ai.key.set sk-example-secret"],
    labels: ["SECRET"],
    coversActions: [COMMANDS.configPatch]
  },
  {
    topic: "ai",
    command: "ai.key.clear",
    description: "Очищает managed API key и удаляет управляемое значение.",
    examples: ["ai.key.clear"],
    labels: ["SECRET"],
    coversActions: [COMMANDS.configPatch]
  },
  {
    topic: "ai",
    command: "ai.key.unmanage",
    description: "Переключает runtime обратно на чтение API key из внешнего окружения.",
    examples: ["ai.key.unmanage"],
    labels: ["SECRET"],
    coversActions: [COMMANDS.configPatch]
  },
  {
    topic: "chat",
    command: "chat.status [current|url <url>|key <pageKey> [pageUrl <url>]]",
    description: "Показывает текущую AI-сессию для target страницы.",
    examples: ["chat.status", "chat.status url https://example.com/path", "chat.status key https://example.com/path"],
    coversActions: [COMMANDS.aiChatStatus]
  },
  {
    topic: "chat",
    command: "chat.send [target] -- <text>",
    description: "Отправляет пользовательское сообщение в AI-чат target страницы.",
    examples: [
      "chat.send Reply with the exact token EDGE_CHAT_OK and nothing else.",
      "chat.send url https://example.com/path -- Reply with the exact token EDGE_CHAT_OK and nothing else."
    ],
    coversActions: [COMMANDS.aiChatSend]
  },
  {
    topic: "chat",
    command: "chat.code [target] -- <text>",
    description: "Отправляет code-сообщение в AI-чат target страницы.",
    examples: [
      "chat.code Reply with the exact token EDGE_CODE_OK and nothing else.",
      "chat.code key https://example.com/path pageUrl https://example.com/path -- Reply with the exact token EDGE_CODE_OK and nothing else."
    ],
    coversActions: [COMMANDS.aiChatSend]
  },
  {
    topic: "chat",
    command: "chat.resume [current|url <url>|key <pageKey> [pageUrl <url>]]",
    description: "Пытается продолжить остановленную или ожидающую AI-сессию target страницы.",
    examples: ["chat.resume", "chat.resume url https://example.com/path"],
    coversActions: [COMMANDS.aiChatResume]
  },
  {
    topic: "chat",
    command: "chat.reset [current|url <url>|key <pageKey> [pageUrl <url>]]",
    description: "Сбрасывает AI-сессию target страницы.",
    examples: ["chat.reset", "chat.reset key https://example.com/path"],
    coversActions: [COMMANDS.aiChatReset]
  },
  {
    topic: "chat",
    command: "chat.list",
    description: "Возвращает список всех известных AI-сессий по страницам.",
    examples: ["chat.list"],
    coversActions: [COMMANDS.aiChatList]
  },
  {
    topic: "chat",
    command: "chat.compact [current|url <url>|key <pageKey> [pageUrl <url>]]",
    description: "Немедленно запускает безопасное сжатие контекста, обходя только token-threshold.",
    examples: ["chat.compact", "chat.compact url https://example.com/path"],
    coversActions: [COMMANDS.aiChatCompact]
  },
  {
    topic: "chat",
    command: "chat.compact.force [current|url <url>|key <pageKey> [pageUrl <url>]]",
    description: "Принудительно запускает сжатие контекста даже при disabled/maxPasses; опасная команда.",
    examples: ["chat.compact.force", "chat.compact.force key https://example.com/path"],
    labels: ["DANGER"],
    coversActions: [COMMANDS.aiChatCompact]
  },
  {
    topic: "text",
    command: "text.status",
    description: "Показывает summary по найденным текстовым элементам текущей страницы и режиму отображения.",
    examples: ["text.status"]
  },
  {
    topic: "text",
    command: "text.scan",
    description: "Пересканирует страницу, обновляет binding-map и переприменяет сохранённые замены.",
    examples: ["text.scan"]
  },
  {
    topic: "text",
    command: "text.list [all|changed]",
    description: "Показывает JSON-список найденных текстовых binding-элементов, при changed только изменённые.",
    examples: ["text.list", "text.list changed"]
  },
  {
    topic: "text",
    command: "text.set <bindingId> -- <text>",
    description: "Сохраняет замену для binding и немедленно применяет её на странице.",
    examples: ["text.set txt_ab12cd34 -- New text"]
  },
  {
    topic: "text",
    command: "text.revert <bindingId>",
    description: "Убирает замену для binding и возвращает исходный текст.",
    examples: ["text.revert txt_ab12cd34"]
  },
  {
    topic: "text",
    command: "text.mode <effective|original>",
    description: "Переключает режим показа: исходные тексты или изменённые/текущие.",
    examples: ["text.mode effective", "text.mode original"]
  },
  {
    topic: "text",
    command: "text.download",
    description: "Скачивает текущую JSON-карту текстовых binding-элементов.",
    examples: ["text.download"]
  },
  {
    topic: "text",
    command: "text.reset <page|all>",
    description: "Сбрасывает замены и сохранённую карту для текущей страницы или полностью для всех страниц.",
    examples: ["text.reset page", "text.reset all"]
  },
  {
    topic: "text",
    command: "text.delete <bindingId|page|all>",
    description: "РЈРґР°Р»СЏРµС‚ binding-Р·Р°РїРёСЃРё РёР· РєР°СЂС‚С‹ С‚РµРєСЃС‚РѕРІ РёР»Рё РїРѕР»РЅРѕСЃС‚СЊСЋ РѕС‡РёС‰Р°РµС‚ С…СЂР°РЅРёРјС‹Рµ РґР°РЅРЅС‹Рµ.",
    examples: ["text.delete txt_ab12cd34", "text.delete page", "text.delete all"]
  },
  {
    topic: "models",
    command: "models.list",
    description: "Загружает каталог моделей OpenAI с доступностью и ценами.",
    examples: ["models.list"],
    coversActions: [COMMANDS.aiModelsCatalog]
  },
  {
    topic: "models",
    command: "models.allow list",
    description: "Показывает текущее содержимое ai.allowedModels.",
    examples: ["models.allow list"],
    coversActions: [COMMANDS.configGet]
  },
  {
    topic: "models",
    command: "models.allow add <model> [tier]",
    description: "Добавляет модель в ai.allowedModels после проверки по каталогу.",
    examples: ["models.allow add gpt-5", "models.allow add gpt-5 priority"],
    coversActions: [COMMANDS.aiModelsCatalog, COMMANDS.configPatch]
  },
  {
    topic: "models",
    command: "models.allow remove <model> [tier]",
    description: "Удаляет правило модели из ai.allowedModels.",
    examples: ["models.allow remove gpt-5", "models.allow remove gpt-5 flex"],
    coversActions: [COMMANDS.configPatch]
  },
  {
    topic: "models",
    command: "models.allow clear",
    description: "Полностью очищает ai.allowedModels.",
    examples: ["models.allow clear"],
    coversActions: [COMMANDS.configPatch]
  },
  {
    topic: "models",
    command: "models.select <chat|compaction> <model> [tier]",
    description: "Выбирает модель для chat или compaction, если она уже разрешена.",
    examples: ["models.select chat gpt-5", "models.select compaction gpt-5-mini flex"],
    coversActions: [COMMANDS.aiModelsCatalog, COMMANDS.configPatch]
  },
  {
    topic: "logs",
    command: "logs.tail [limit]",
    description: "Показывает последние runtime-логи через log.list.",
    examples: ["logs.tail", "logs.tail 5"],
    coversActions: [COMMANDS.logList]
  },
  {
    topic: "logs",
    command: "logs.subscribe [all|since <iso-ts>]",
    description: "Возвращает snapshot для подписки на runtime log stream.",
    examples: ["logs.subscribe", "logs.subscribe all", "logs.subscribe since 2026-03-22T12:00:00.000Z"],
    coversActions: [COMMANDS.logSubscribe]
  },
  {
    topic: "logs",
    command: "logs.note <summary>",
    description: "Пишет ручную заметку в unified runtime log.",
    examples: ["logs.note Manual terminal note"],
    coversActions: [COMMANDS.logRecord]
  },
  {
    topic: "tests",
    command: "demo.start [taskId]",
    description: "Запускает demo-задачу для runtime smoke-flow.",
    examples: ["demo.start", "demo.start demo-task"],
    labels: ["TEST"],
    gate: "test",
    coversActions: [COMMANDS.taskDemoStart]
  },
  {
    topic: "tests",
    command: "demo.stop",
    description: "Останавливает demo-задачу runtime smoke-flow.",
    examples: ["demo.stop"],
    labels: ["TEST"],
    gate: "test",
    coversActions: [COMMANDS.taskDemoStop]
  },
  {
    topic: "tests",
    command: "host.crash",
    description: "Имитирует аварийное завершение native host. Нужна только для тестов.",
    examples: ["host.crash"],
    labels: ["TEST", "DANGER"],
    gate: "host-crash",
    coversActions: [COMMANDS.testHostCrash]
  }
] as const;

const TOPIC_ORDER = [
  "config",
  "chat",
  "text",
  "models",
  "logs",
  "overlay",
  "popup",
  "ai",
  "runtime",
  "tests"
] as const satisfies readonly RegistryTopic[];

export function isTerminalHelpTopic(value: string): value is TerminalHelpTopic {
  return (TERMINAL_HELP_TOPICS as readonly string[]).includes(value);
}

export function getTerminalAliasCommandTemplates(options?: TerminalCommandAvailabilityOptions): string[] {
  const templates = new Set<string>();
  for (const entry of HELP_ENTRY_REGISTRY) {
    if (!isRegistryEntryVisible(entry, options)) {
      continue;
    }
    for (const example of entry.examples) {
      templates.add(example);
    }
  }

  return [...templates];
}

export function getTerminalAliasHelpEntries(
  topic?: Exclude<TerminalHelpTopic, "raw">,
  options?: TerminalCommandAvailabilityOptions
): TerminalHelpEntry[] {
  const entries = HELP_ENTRY_REGISTRY.filter((entry) => (topic ? entry.topic === topic : true));
  return entries.map((entry) => materializeHelpEntry(entry, options));
}

export function getTerminalAliasHelpLines(
  topic?: Exclude<TerminalHelpTopic, "raw">,
  options?: TerminalCommandAvailabilityOptions
): string[] {
  if (topic) {
    return [
      `[${topic}]`,
      ...getTerminalAliasHelpEntries(topic, options).map((entry) => entry.command)
    ];
  }

  const lines: string[] = [];
  for (const section of TOPIC_ORDER) {
    const entries = getTerminalAliasHelpEntries(section, options);
    if (entries.length === 0) {
      continue;
    }
    if (lines.length > 0) {
      lines.push("");
    }
    lines.push(`[${section}]`, ...entries.map((entry) => entry.command));
  }

  return lines;
}

export function getTerminalAliasCoverageActions(): string[] {
  return [
    ...new Set(
      HELP_ENTRY_REGISTRY.flatMap((entry) => entry.coversActions ?? [])
    )
  ];
}

export function parseTerminalAliasCommand(rawInput: string): TerminalAliasCommand | null {
  const raw = rawInput.trim();
  if (!raw) {
    return null;
  }

  if (raw === "config.paths") {
    return {
      kind: "alias",
      namespace: "config",
      action: "paths",
      prefix: null,
      raw
    };
  }
  if (raw.startsWith("config.paths ")) {
    return {
      kind: "alias",
      namespace: "config",
      action: "paths",
      prefix: raw.slice("config.paths ".length).trim() || null,
      raw
    };
  }

  if (raw === "config.get") {
    return {
      kind: "alias",
      namespace: "config",
      action: "get",
      path: null,
      raw
    };
  }
  if (raw.startsWith("config.get ")) {
    const path = raw.slice("config.get ".length).trim();
    if (!path || path.startsWith("{")) {
      return null;
    }
    return {
      kind: "alias",
      namespace: "config",
      action: "get",
      path,
      raw
    };
  }

  if (raw.startsWith("config.set ")) {
    const remainder = raw.slice("config.set ".length);
    const separatorIndex = remainder.indexOf(" ");
    if (separatorIndex === -1) {
      throw new Error("config.set требует путь и значение.");
    }
    const path = remainder.slice(0, separatorIndex).trim();
    const valueText = remainder.slice(separatorIndex + 1);
    if (!path || !valueText.length) {
      throw new Error("config.set требует путь и значение.");
    }
    return {
      kind: "alias",
      namespace: "config",
      action: "set",
      path,
      valueText,
      raw
    };
  }

  if (raw.startsWith("config.reset-field ")) {
    const path = raw.slice("config.reset-field ".length).trim();
    if (!path) {
      throw new Error("config.reset-field требует путь.");
    }
    return {
      kind: "alias",
      namespace: "config",
      action: "reset-field",
      path,
      raw
    };
  }

  if (raw === "config.reset local" || raw === "config.reset session") {
    return {
      kind: "alias",
      namespace: "config",
      action: "reset",
      scope: raw.endsWith("session") ? "session" : "local",
      raw
    };
  }

  if (raw === "ai.key.status" || raw === "ai.key.clear" || raw === "ai.key.unmanage") {
    return {
      kind: "alias",
      namespace: "ai-key",
      action: raw.slice("ai.key.".length) as "status" | "clear" | "unmanage",
      raw
    };
  }
  if (raw.startsWith("ai.key.set ")) {
    const valueText = raw.slice("ai.key.set ".length);
    if (!valueText.trim()) {
      throw new Error("ai.key.set требует значение.");
    }
    return {
      kind: "alias",
      namespace: "ai-key",
      action: "set",
      valueText,
      raw
    };
  }

  if (raw === "host.connect" || raw === "host.disconnect" || raw === "host.status" || raw === "host.restart" || raw === "host.crash") {
    return {
      kind: "alias",
      namespace: "host",
      action: raw === "host.crash" ? "crash" : raw.slice("host.".length) as "connect" | "disconnect" | "status" | "restart",
      raw
    };
  }

  if (raw === "worker.start" || raw === "worker.stop" || raw === "worker.status") {
    return {
      kind: "alias",
      namespace: "worker",
      action: raw.slice("worker.".length) as "start" | "stop" | "status",
      raw
    };
  }

  if (raw === "demo.start") {
    return {
      kind: "alias",
      namespace: "demo",
      action: "start",
      taskId: null,
      raw
    };
  }
  if (raw.startsWith("demo.start ")) {
    const taskId = raw.slice("demo.start ".length).trim();
    if (!taskId) {
      throw new Error("demo.start принимает необязательный taskId.");
    }
    return {
      kind: "alias",
      namespace: "demo",
      action: "start",
      taskId,
      raw
    };
  }
  if (raw === "demo.stop") {
    return {
      kind: "alias",
      namespace: "demo",
      action: "stop",
      raw
    };
  }

  if (raw === "popup.tab control" || raw === "popup.tab config") {
    return {
      kind: "alias",
      namespace: "popup",
      action: "tab",
      tab: raw.endsWith("config") ? "config" : "control",
      raw
    };
  }

  if (raw === "overlay.hide") {
    return {
      kind: "alias",
      namespace: "overlay",
      action: "hide",
      raw
    };
  }
  if (raw === "overlay.tab console" || raw === "overlay.tab chat") {
    return {
      kind: "alias",
      namespace: "overlay",
      action: "tab",
      tab: raw.endsWith("chat") ? "chat" : "console",
      raw
    };
  }
  for (const action of ["probe", "open", "close"] as const) {
    const prefix = `overlay.${action}`;
    if (raw === prefix) {
      return {
        kind: "alias",
        namespace: "overlay",
        action,
        target: {
          type: "current"
        },
        raw
      };
    }
    if (raw.startsWith(`${prefix} `)) {
      const remainder = raw.slice(`${prefix} `.length).trim();
      if (remainder.startsWith("{")) {
        return null;
      }
      return {
        kind: "alias",
        namespace: "overlay",
        action,
        target: parseOverlayTarget(remainder, prefix),
        raw
      };
    }
  }

  if (raw === "chat.list") {
    return {
      kind: "alias",
      namespace: "chat",
      action: "list",
      raw
    };
  }

  if (raw === "text.status" || raw === "text.scan" || raw === "text.download") {
    return {
      kind: "alias",
      namespace: "text",
      action: raw.slice("text.".length) as "status" | "scan" | "download",
      raw
    };
  }
  if (raw === "text.list" || raw === "text.list all" || raw === "text.list changed") {
    return {
      kind: "alias",
      namespace: "text",
      action: "list",
      filter: raw.endsWith("changed") ? "changed" : "all",
      raw
    };
  }
  if (raw === "text.reset page" || raw === "text.reset all") {
    return {
      kind: "alias",
      namespace: "text",
      action: "reset",
      scope: raw.endsWith("all") ? "all" : "page",
      raw
    };
  }
  if (raw === "text.delete page" || raw === "text.delete all") {
    return {
      kind: "alias",
      namespace: "text",
      action: "delete",
      scope: raw.endsWith("all") ? "all" : "page",
      raw
    };
  }
  if (raw === "text.mode effective" || raw === "text.mode original") {
    return {
      kind: "alias",
      namespace: "text",
      action: "mode",
      mode: raw.endsWith("original") ? "original" : "effective",
      raw
    };
  }
  if (raw.startsWith("text.revert ")) {
    const bindingId = raw.slice("text.revert ".length).trim();
    if (!bindingId) {
      throw new Error("text.revert requires a bindingId.");
    }
    return {
      kind: "alias",
      namespace: "text",
      action: "revert",
      bindingId,
      raw
    };
  }
  if (raw === "text.delete") {
    throw new Error("text.delete requires a bindingId, page, or all.");
  }
  if (raw.startsWith("text.delete ")) {
    const bindingId = raw.slice("text.delete ".length).trim();
    if (!bindingId) {
      throw new Error("text.delete requires a bindingId, page, or all.");
    }
    return {
      kind: "alias",
      namespace: "text",
      action: "delete",
      bindingId,
      raw
    };
  }
  if (raw.startsWith("text.set ")) {
    const remainder = raw.slice("text.set ".length).trim();
    const delimiterIndex = remainder.indexOf(" -- ");
    if (delimiterIndex === -1) {
      throw new Error("text.set requires <bindingId> -- <text>.");
    }
    const bindingId = remainder.slice(0, delimiterIndex).trim();
    const text = remainder.slice(delimiterIndex + " -- ".length);
    if (!bindingId || !text.trim()) {
      throw new Error("text.set requires <bindingId> -- <text>.");
    }
    return {
      kind: "alias",
      namespace: "text",
      action: "set",
      bindingId,
      text,
      raw
    };
  }

  for (const action of ["status", "resume", "reset"] as const) {
    const prefix = `chat.${action}`;
    if (raw === prefix) {
      return {
        kind: "alias",
        namespace: "chat",
        action,
        target: {
          type: "current"
        },
        raw
      };
    }
    if (raw.startsWith(`${prefix} `)) {
      return {
        kind: "alias",
        namespace: "chat",
        action,
        target: parseChatTarget(raw.slice(`${prefix} `.length), prefix),
        raw
      };
    }
  }

  for (const commandLabel of ["chat.compact.force", "chat.compact"] as const) {
    if (raw === commandLabel) {
      return {
        kind: "alias",
        namespace: "chat",
        action: "compact",
        mode: commandLabel.endsWith(".force") ? "force" : "safe",
        target: {
          type: "current"
        },
        raw
      };
    }
    if (raw.startsWith(`${commandLabel} `)) {
      return {
        kind: "alias",
        namespace: "chat",
        action: "compact",
        mode: commandLabel.endsWith(".force") ? "force" : "safe",
        target: parseChatTarget(raw.slice(`${commandLabel} `.length), commandLabel),
        raw
      };
    }
  }

  if (raw.startsWith("chat.send ") || raw.startsWith("chat.code ")) {
    const isCode = raw.startsWith("chat.code ");
    const remainder = raw.slice(isCode ? "chat.code ".length : "chat.send ".length);
    const { target, text } = parseChatTextCommand(remainder, isCode ? "chat.code" : "chat.send");
    return {
      kind: "alias",
      namespace: "chat",
      action: isCode ? "code" : "send",
      target,
      text,
      raw
    };
  }

  if (raw === "models.list") {
    return {
      kind: "alias",
      namespace: "models",
      action: "list",
      raw
    };
  }
  if (raw === "models.allow list" || raw === "models.allow clear") {
    return {
      kind: "alias",
      namespace: "models",
      action: raw.endsWith("list") ? "allow-list" : "allow-clear",
      raw
    };
  }
  if (raw.startsWith("models.allow add ") || raw.startsWith("models.allow remove ")) {
    const isAdd = raw.startsWith("models.allow add ");
    const remainder = raw.slice(isAdd ? "models.allow add ".length : "models.allow remove ".length).trim();
    const [model, tier] = splitModelAndTier(remainder, isAdd ? "models.allow add" : "models.allow remove");
    return {
      kind: "alias",
      namespace: "models",
      action: isAdd ? "allow-add" : "allow-remove",
      model,
      tier,
      raw
    };
  }
  if (raw.startsWith("models.select ")) {
    const remainder = raw.slice("models.select ".length).trim();
    const [target, ...rest] = remainder.split(/\s+/);
    if (target !== "chat" && target !== "compaction") {
      throw new Error("models.select требует target chat или compaction.");
    }
    const [model, tier] = splitModelAndTier(rest.join(" "), "models.select");
    return {
      kind: "alias",
      namespace: "models",
      action: "select",
      target,
      model,
      tier,
      raw
    };
  }

  if (raw === "logs.tail") {
    return {
      kind: "alias",
      namespace: "logs",
      action: "tail",
      limit: 50,
      raw
    };
  }
  if (raw.startsWith("logs.tail ")) {
    const limit = Number.parseInt(raw.slice("logs.tail ".length).trim(), 10);
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error("logs.tail принимает положительное целое limit.");
    }
    return {
      kind: "alias",
      namespace: "logs",
      action: "tail",
      limit,
      raw
    };
  }

  if (raw === "logs.subscribe" || raw === "logs.subscribe all") {
    return {
      kind: "alias",
      namespace: "logs",
      action: "subscribe",
      since: null,
      raw
    };
  }
  if (raw === "logs.subscribe since") {
    throw new Error("logs.subscribe since требует ISO timestamp.");
  }
  if (raw.startsWith("logs.subscribe since ")) {
    const since = raw.slice("logs.subscribe since ".length).trim();
    if (!since) {
      throw new Error("logs.subscribe since требует ISO timestamp.");
    }
    return {
      kind: "alias",
      namespace: "logs",
      action: "subscribe",
      since,
      raw
    };
  }

  if (raw.startsWith("logs.note ")) {
    const summary = raw.slice("logs.note ".length);
    if (!summary.trim()) {
      throw new Error("logs.note требует непустой summary.");
    }
    return {
      kind: "alias",
      namespace: "logs",
      action: "note",
      summary,
      raw
    };
  }

  return null;
}

function materializeHelpEntry(
  entry: TerminalHelpEntrySpec,
  options?: TerminalCommandAvailabilityOptions
): TerminalHelpEntry {
  const enabled = isRegistryEntryVisible(entry, options);
  return {
    command: entry.command,
    description: entry.description,
    examples: [...entry.examples],
    labels: [
      ...(entry.labels ?? []),
      ...(enabled ? [] : ["GATED" as const])
    ],
    gatingNote: enabled ? null : getGateDisabledMessage(entry.gate)
  };
}

function isRegistryEntryVisible(
  entry: TerminalHelpEntrySpec,
  options?: TerminalCommandAvailabilityOptions
): boolean {
  switch (entry.gate) {
    case "test":
      return options?.testCommandsEnabled ?? true;
    case "host-crash":
      return (options?.testCommandsEnabled ?? true) && (options?.allowHostCrashCommand ?? true);
    default:
      return true;
  }
}

function getGateDisabledMessage(gate?: RegistryGate): string | null {
  switch (gate) {
    case "test":
      return "Отключено текущим config: protocol.testCommandsEnabled=false.";
    case "host-crash":
      return "Отключено текущим config: protocol.testCommandsEnabled=false или test.allowHostCrashCommand=false.";
    default:
      return null;
  }
}

function parseOverlayTarget(rawValue: string, commandLabel: string): TerminalOverlayTarget {
  const trimmed = rawValue.trim();
  if (!trimmed || trimmed === "current") {
    return {
      type: "current"
    };
  }

  if (trimmed.startsWith("tab ")) {
    const tabId = Number.parseInt(trimmed.slice("tab ".length).trim(), 10);
    if (!Number.isInteger(tabId) || tabId < 1) {
      throw new Error(`${commandLabel} требует положительный tab id.`);
    }
    return {
      type: "tab",
      tabId
    };
  }

  if (trimmed.startsWith("url ")) {
    const url = trimmed.slice("url ".length).trim();
    if (!url) {
      throw new Error(`${commandLabel} требует URL.`);
    }
    return {
      type: "url",
      url
    };
  }

  throw new Error(`${commandLabel} принимает current, tab <id> или url <url>.`);
}

function parseChatTarget(rawValue: string, commandLabel: string): TerminalChatTarget {
  const trimmed = rawValue.trim();
  if (!trimmed || trimmed === "current") {
    return {
      type: "current"
    };
  }

  if (trimmed.startsWith("url ")) {
    const url = trimmed.slice("url ".length).trim();
    if (!url) {
      throw new Error(`${commandLabel} требует URL.`);
    }
    return {
      type: "url",
      url
    };
  }

  if (trimmed.startsWith("key ")) {
    const remainder = trimmed.slice("key ".length).trim();
    const pageUrlMarker = " pageUrl ";
    const pageUrlIndex = remainder.indexOf(pageUrlMarker);
    const pageKey = (pageUrlIndex === -1 ? remainder : remainder.slice(0, pageUrlIndex)).trim();
    const pageUrl = pageUrlIndex === -1 ? null : remainder.slice(pageUrlIndex + pageUrlMarker.length).trim();

    if (!pageKey) {
      throw new Error(`${commandLabel} требует pageKey.`);
    }
    if (pageUrlIndex !== -1 && !pageUrl) {
      throw new Error(`${commandLabel} требует pageUrl после pageUrl.`);
    }

    return {
      type: "key",
      pageKey,
      pageUrl: pageUrl || null
    };
  }

  throw new Error(`${commandLabel} принимает current, url <url> или key <pageKey> [pageUrl <url>].`);
}

function parseChatTextCommand(
  rawValue: string,
  commandLabel: string
): { target: TerminalChatTarget; text: string } {
  const remainder = rawValue.trim();
  if (!remainder) {
    throw new Error(`${commandLabel} требует текст.`);
  }

  if (/^--\s*$/.test(remainder)) {
    throw new Error(`${commandLabel} требует текст после --.`);
  }

  if (remainder.startsWith("-- ")) {
    const text = remainder.slice("-- ".length);
    if (!text.trim()) {
      throw new Error(`${commandLabel} требует текст после --.`);
    }
    return {
      target: {
        type: "current"
      },
      text
    };
  }

  const delimiterIndex = remainder.indexOf(" -- ");
  if (delimiterIndex === -1) {
    return {
      target: {
        type: "current"
      },
      text: remainder
    };
  }

  const targetText = remainder.slice(0, delimiterIndex).trim();
  const text = remainder.slice(delimiterIndex + " -- ".length);
  if (!text.trim()) {
    throw new Error(`${commandLabel} требует текст после --.`);
  }

  return {
    target: parseChatTarget(targetText, commandLabel),
    text
  };
}

function splitModelAndTier(
  rawValue: string,
  commandLabel: string
): [model: string, tier: AiServiceTier] {
  const parts = rawValue.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    throw new Error(`${commandLabel} требует model.`);
  }
  if (parts.length > 2) {
    throw new Error(`${commandLabel} принимает model и необязательный tier.`);
  }

  const [model, tierCandidate] = parts;
  const tier = parseAiServiceTier(tierCandidate);
  return [model, tier];
}

function parseAiServiceTier(value?: string): AiServiceTier {
  switch ((value ?? "standard").toLowerCase()) {
    case "standard":
      return "standard";
    case "flex":
      return "flex";
    case "priority":
      return "priority";
    default:
      throw new Error(`Неизвестный tier: ${value}. Используйте standard, flex или priority.`);
  }
}
