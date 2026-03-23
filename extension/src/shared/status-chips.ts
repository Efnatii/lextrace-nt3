export type StatusChipKind = "chat" | "console";

export type StatusChipWidth = "default" | "short" | "wide" | "page";

export type StatusChipIconPath = {
  d: string;
  fill?: "currentColor";
  stroke?: "none";
};

export type StatusChipIcon = {
  viewBox: string;
  paths: readonly StatusChipIconPath[];
};

type StatusChipMeta = {
  tooltipLabel: string;
  icon: StatusChipIcon;
  width?: StatusChipWidth;
};

export type StatusChipFragment = {
  key: string;
  value: string;
  fullValue?: string | null;
};

export type StatusChipDescriptor = {
  key: string;
  tooltipLabel: string;
  icon: StatusChipIcon;
  width: StatusChipWidth;
  value: string;
  fullValue: string;
};

const DEFAULT_VIEWBOX = "0 0 16 16";

const fallbackIcon: StatusChipIcon = {
  viewBox: DEFAULT_VIEWBOX,
  paths: [
    { d: "M8 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10Z" },
    { d: "M8 7.75h.01", fill: "currentColor", stroke: "none" },
    { d: "M8 10.75h.01", fill: "currentColor", stroke: "none" }
  ]
};

const consoleStatusChipMeta: Readonly<Record<string, StatusChipMeta>> = {
  состояние: {
    tooltipLabel: "Состояние",
    icon: {
      viewBox: DEFAULT_VIEWBOX,
      paths: [
        { d: "M8 2.75v4.25" },
        { d: "M5.15 4.05a4.75 4.75 0 1 0 5.7 0" }
      ]
    }
  },
  хост: {
    tooltipLabel: "Хост",
    icon: {
      viewBox: DEFAULT_VIEWBOX,
      paths: [
        { d: "M6 3.5v3.25" },
        { d: "M10 3.5v3.25" },
        { d: "M4.5 6.25h7" },
        { d: "M8 6.25v4.75" },
        { d: "M6.5 11h3" }
      ]
    }
  },
  запуск: {
    tooltipLabel: "Запуск",
    width: "short",
    icon: {
      viewBox: DEFAULT_VIEWBOX,
      paths: [
        { d: "M6 3l-1 10" },
        { d: "M10 3 9 13" },
        { d: "M3.5 6.5h8.75" },
        { d: "M3 9.5h8.75" }
      ]
    }
  },
  сессия: {
    tooltipLabel: "Сессия",
    width: "wide",
    icon: {
      viewBox: DEFAULT_VIEWBOX,
      paths: [
        { d: "M8 3 12 5.25 8 7.5 4 5.25 8 3Z" },
        { d: "M12 8.25 8 10.5 4 8.25" }
      ]
    }
  },
  задача: {
    tooltipLabel: "Задача",
    width: "wide",
    icon: {
      viewBox: DEFAULT_VIEWBOX,
      paths: [
        { d: "M3.5 3.5h9v9h-9z" },
        { d: "M5.5 8 7 9.5l3.5-3.5" }
      ]
    }
  },
  пульс: {
    tooltipLabel: "Пульс",
    width: "wide",
    icon: {
      viewBox: DEFAULT_VIEWBOX,
      paths: [{ d: "M2.5 8h2l1.2-2.5L8 10.5l1.5-4.5 1.2 2H13.5" }]
    }
  }
};

const chatStatusChipMeta: Readonly<Record<string, StatusChipMeta>> = {
  provider: {
    tooltipLabel: "Провайдер",
    icon: {
      viewBox: DEFAULT_VIEWBOX,
      paths: [{ d: "M5 11.5h5.25a2.25 2.25 0 0 0 .2-4.5A3.5 3.5 0 0 0 4.1 6 2.55 2.55 0 0 0 5 11.5Z" }]
    }
  },
  key: {
    tooltipLabel: "API key",
    icon: {
      viewBox: DEFAULT_VIEWBOX,
      paths: [
        { d: "M7 9a2 2 0 1 1 1.6-3.2L13 6v2h-1.5v1.5H10V11H8.6L8.2 9.6A2 2 0 0 1 7 9Z" }
      ]
    }
  },
  model: {
    tooltipLabel: "Модель",
    width: "wide",
    icon: {
      viewBox: DEFAULT_VIEWBOX,
      paths: [
        { d: "M5 4.5h6v7H5z" },
        { d: "M7 2.5v2" },
        { d: "M9 2.5v2" },
        { d: "M7 11.5v2" },
        { d: "M9 11.5v2" },
        { d: "M2.5 7h2.5" },
        { d: "M11 7h2.5" }
      ]
    }
  },
  rpm: {
    tooltipLabel: "RPM",
    icon: {
      viewBox: DEFAULT_VIEWBOX,
      paths: [
        { d: "M8 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10Z" },
        { d: "M8 5.25V8l2 1.25" }
      ]
    }
  },
  tpm: {
    tooltipLabel: "TPM",
    icon: {
      viewBox: DEFAULT_VIEWBOX,
      paths: [
        { d: "M8 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10Z" },
        { d: "M8 5v6" },
        { d: "M6.5 6.25h3" }
      ]
    }
  },
  reset: {
    tooltipLabel: "Сброс лимита",
    width: "wide",
    icon: {
      viewBox: DEFAULT_VIEWBOX,
      paths: [
        { d: "M5 3.75H2.5v2.5" },
        { d: "M2.75 6.25A5.25 5.25 0 1 0 4.5 3.9" }
      ]
    }
  },
  served: {
    tooltipLabel: "Выданный tier",
    icon: {
      viewBox: DEFAULT_VIEWBOX,
      paths: [
        {
          d: "M8 2.5 9.55 5.65 13 6.15 10.5 8.6 11.1 12 8 10.35 4.9 12 5.5 8.6 3 6.15 6.45 5.65Z",
          fill: "currentColor",
          stroke: "none"
        }
      ]
    }
  },
  format: {
    tooltipLabel: "Формат",
    icon: {
      viewBox: DEFAULT_VIEWBOX,
      paths: [
        { d: "M6 3.5c-1.5.75-1.5 3.5 0 4.25-1.5.75-1.5 3.5 0 4.25" },
        { d: "M10 3.5c1.5.75 1.5 3.5 0 4.25 1.5.75 1.5 3.5 0 4.25" }
      ]
    }
  },
  stream: {
    tooltipLabel: "Поток",
    icon: {
      viewBox: DEFAULT_VIEWBOX,
      paths: [
        { d: "M3 5.5h7" },
        { d: "m8 3.75 2 1.75L8 7.25" },
        { d: "M3 10.5h10" }
      ]
    }
  },
  state: {
    tooltipLabel: "Состояние",
    icon: {
      viewBox: DEFAULT_VIEWBOX,
      paths: [
        { d: "M8 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10Z" },
        { d: "M5 8h1.5l.75-1.5L8.5 9.5 9.75 6l.75 2H12" }
      ]
    }
  },
  tokens: {
    tooltipLabel: "Контекст токены",
    width: "short",
    icon: {
      viewBox: DEFAULT_VIEWBOX,
      paths: [
        { d: "M8 2.75 12 4.75 8 6.75 4 4.75 8 2.75Z" },
        { d: "M12 4.75v3.5L8 10.25 4 8.25v-3.5" },
        { d: "M12 8.25v3L8 13.25 4 11.25v-3" }
      ]
    }
  },
  page: {
    tooltipLabel: "Страница",
    width: "page",
    icon: {
      viewBox: DEFAULT_VIEWBOX,
      paths: [
        { d: "M5 2.75h4l2 2v6.5H5z" },
        { d: "M9 2.75v2h2" }
      ]
    }
  },
  queue: {
    tooltipLabel: "Очередь",
    icon: {
      viewBox: DEFAULT_VIEWBOX,
      paths: [
        { d: "M4 4.75h8" },
        { d: "M4 8h8" },
        { d: "M4 11.25h8" }
      ]
    }
  },
  cache: {
    tooltipLabel: "Cache hit",
    icon: {
      viewBox: DEFAULT_VIEWBOX,
      paths: [
        { d: "M4.25 5h7.5v6H4.25z" },
        { d: "M4.25 6.75h7.5" }
      ]
    }
  },
  "cache-s": {
    tooltipLabel: "Cache session",
    icon: {
      viewBox: DEFAULT_VIEWBOX,
      paths: [
        { d: "M5.25 3.75h6.5v5.5H5.25z" },
        { d: "M3.25 6.75h6.5v5.5H3.25z" }
      ]
    }
  },
  "cache-state": {
    tooltipLabel: "Cache status",
    width: "wide",
    icon: {
      viewBox: DEFAULT_VIEWBOX,
      paths: [
        { d: "M4.25 5h7.5v6H4.25z" },
        { d: "M6 8.25 7.25 9.5l2.5-2.5" }
      ]
    }
  },
  "cache-ret": {
    tooltipLabel: "Cache retention",
    width: "wide",
    icon: {
      viewBox: DEFAULT_VIEWBOX,
      paths: [
        { d: "M4.25 5h6.25v6H4.25z" },
        { d: "M11.25 12a1.75 1.75 0 1 0 0-3.5 1.75 1.75 0 0 0 0 3.5Z" },
        { d: "M11.25 9.25v1.15l.75.45" }
      ]
    }
  },
  "cache-src": {
    tooltipLabel: "Cache source",
    width: "wide",
    icon: {
      viewBox: DEFAULT_VIEWBOX,
      paths: [
        { d: "M4.25 5h6.25v6H4.25z" },
        { d: "M9.75 6.75h3" },
        { d: "m11.5 5.75 1.25 1-1.25 1" }
      ]
    }
  }
};

const statusChipMetaByKind: Readonly<Record<StatusChipKind, Readonly<Record<string, StatusChipMeta>>>> = {
  console: consoleStatusChipMeta,
  chat: chatStatusChipMeta
};

function createFallbackMeta(key: string): StatusChipMeta {
  return {
    tooltipLabel: key,
    icon: fallbackIcon
  };
}

export function buildStatusChipDescriptors(
  kind: StatusChipKind,
  fragments: readonly StatusChipFragment[]
): StatusChipDescriptor[] {
  const catalog = statusChipMetaByKind[kind];
  return fragments.map((fragment) => {
    const meta = catalog[fragment.key] ?? createFallbackMeta(fragment.key);
    return {
      key: fragment.key,
      tooltipLabel: meta.tooltipLabel,
      icon: meta.icon,
      width: meta.width ?? "default",
      value: fragment.value,
      fullValue: fragment.fullValue ?? fragment.value
    };
  });
}

export function findMissingStatusChipKeys(
  kind: StatusChipKind,
  keys: readonly string[]
): string[] {
  const catalog = statusChipMetaByKind[kind];
  return [...new Set(keys.filter((key) => !(key in catalog)))].sort();
}

export function getStatusChipKeys(kind: StatusChipKind): string[] {
  return Object.keys(statusChipMetaByKind[kind]).sort();
}
