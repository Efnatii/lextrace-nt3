import {
  DEFAULT_PROFILE_TEMPLATE,
  EVENT_CATEGORY,
  EVENT_STREAM_PORT,
  MESSAGE,
  PIPELINE_STAGE,
  VIEW_MODE
} from "../shared/constants.js";
import { PROFILE_FIELD_META } from "../shared/profile-field-meta.js";
import { callRuntime, connectPort } from "../shared/runtime-api.js";
import { deepClone, getValueByPath, setValueByPath, toSortedJson } from "../shared/utils.js";

const app = document.getElementById("app");

const EMPTY_PROGRESS = Object.freeze({
  done: 0,
  pending: 0,
  failed: 0,
  total: 0,
  errorCount: 0
});

const EMPTY_UI_STATE = Object.freeze({
  pageSessionId: null,
  stage: PIPELINE_STAGE.IDLE,
  progress: EMPTY_PROGRESS,
  viewMode: VIEW_MODE.ORIGINAL,
  hasTranslatedBlocks: false,
  isRunning: false,
  hasData: false,
  canCancel: false,
  canClear: false,
  lastError: null
});

const CUSTOM_PROFILE_OPTION = "__custom__";

const state = {
  tabId: null,
  tabUrl: "",
  uiState: deepClone(EMPTY_UI_STATE),
  settings: null,
  profiles: {},
  modelsCatalog: [],
  panel: "status",
  profileNameDraft: "default",
  fieldEditor: {
    path: ""
  },
  eventFilters: {
    category: "",
    onlyErrors: false
  },
  streamPort: null,
  refreshTimer: null
};

renderShell();
wireTabs();
wireHeaderActions();
await init();

async function init() {
  try {
    await resolveActiveTab();
    await loadSettings();
    await refreshState();
    renderEventsPanel();
    await refreshLogs();
    connectStateStream();

    state.refreshTimer = setInterval(() => {
      refreshLogs().catch(() => {});
    }, 1800);

    window.addEventListener("beforeunload", () => {
      if (state.refreshTimer) {
        clearInterval(state.refreshTimer);
      }
      try {
        state.streamPort?.disconnect();
      } catch {
        // ignore disconnect race
      }
    });
  } catch (error) {
    setTransientError(error?.message || "Popup init failed");
    renderStatusPanel();
  }
}

async function resolveActiveTab() {
  const params = new URLSearchParams(location.search);
  const forcedTabId = Number(params.get("tabId"));
  const forcedUrl = params.get("url");

  if (Number.isInteger(forcedTabId) && forcedTabId > 0) {
    state.tabId = forcedTabId;
    state.tabUrl = forcedUrl || "";
    return;
  }

  const tabs = await chrome.tabs.query({ currentWindow: true });
  const activeHttp = tabs.find((tab) => tab.active && /^https?:/i.test(tab.url || ""));
  const fallbackHttp = tabs.find((tab) => /^https?:/i.test(tab.url || ""));
  const fallbackAny = tabs.find((tab) => Number.isInteger(tab.id));
  const target = activeHttp || fallbackHttp || fallbackAny || null;

  state.tabId = target?.id || null;
  state.tabUrl = target?.url || "";
}

function renderShell() {
  app.innerHTML = `
    <header class="popup-header">
      <div>
        <h1 class="popup-title">Neuro Translate</h1>
      </div>
      <button class="icon-btn" id="btn-open-debug" title="Открыть debug">⚙</button>
    </header>
    <nav class="top-tabs" role="tablist">
      <button class="tab-btn" data-tab="status" aria-selected="true" title="Статус">Статус</button>
      <button class="tab-btn" data-tab="settings" aria-selected="false" title="Настройки">Настройки</button>
      <button class="tab-btn" data-tab="events" aria-selected="false" title="События">События</button>
    </nav>
    <section class="panel active" data-panel="status"></section>
    <section class="panel" data-panel="settings"></section>
    <section class="panel" data-panel="events"></section>
  `;
}

function wireTabs() {
  app.querySelectorAll(".tab-btn").forEach((button) => {
    button.addEventListener("click", () => {
      switchPanel(button.dataset.tab);
    });
  });
}

function wireHeaderActions() {
  app.querySelector("#btn-open-debug")?.addEventListener("click", openDebugPage);
}

function switchPanel(panelName) {
  state.panel = panelName;

  app.querySelectorAll(".tab-btn").forEach((button) => {
    const selected = button.dataset.tab === panelName;
    button.setAttribute("aria-selected", String(selected));
  });

  app.querySelectorAll(".panel").forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.panel === panelName);
  });

  if (panelName === "events") {
    refreshLogs().catch(() => {});
  }
}

function connectStateStream() {
  try {
    state.streamPort = connectPort(EVENT_STREAM_PORT);
  } catch {
    return;
  }

  state.streamPort.postMessage({
    type: "stream.subscribe",
    tabId: state.tabId
  });

  state.streamPort.onMessage.addListener((message) => {
    if (message?.type !== "stream.state") {
      return;
    }
    if (message.tabId !== state.tabId) {
      return;
    }
    state.uiState = mergeUiState(message.state);
    renderStatusPanel();
  });

  state.streamPort.onDisconnect.addListener(() => {
    state.streamPort = null;
    setTimeout(() => {
      if (!state.streamPort) {
        connectStateStream();
      }
    }, 600);
  });
}

function mergeUiState(nextState) {
  const merged = {
    ...deepClone(EMPTY_UI_STATE),
    ...(nextState || {})
  };
  merged.progress = {
    ...EMPTY_PROGRESS,
    ...(nextState?.progress || {})
  };
  return merged;
}

async function loadSettings() {
  state.settings = await callRuntime(MESSAGE.UI_LOAD_SETTINGS);
  state.profiles = await callRuntime(MESSAGE.UI_LIST_PROFILES);

  const activeName = state.settings.activeProfileName || "default";
  const profileExists = state.profiles[activeName];
  if (!profileExists) {
    state.settings.activeProfileName = "default";
  }

  if (!state.settings.profileDraft) {
    const selectedProfile = state.profiles[state.settings.activeProfileName] || deepClone(DEFAULT_PROFILE_TEMPLATE);
    state.settings.profileDraft = deepClone(selectedProfile);
  }

  state.profileNameDraft = state.settings.activeProfileName || "default";
  renderSettingsPanel();
}

async function refreshState() {
  const uiState = await callRuntime(MESSAGE.UI_STATE, { tabId: state.tabId });
  state.uiState = mergeUiState(uiState);
  renderStatusPanel();
}

function renderStatusPanel() {
  const panel = app.querySelector('[data-panel="status"]');
  if (!panel) {
    return;
  }

  const ui = mergeUiState(state.uiState);
  const progress = ui.progress;
  const total = Number(progress.total) || 0;
  const done = Number(progress.done) || 0;
  const pending = Number(progress.pending) || 0;
  const failed = Number(progress.failed) || 0;
  const errorCount = Number(progress.errorCount) || 0;
  const completed = done + failed;
  const percent = total > 0 ? Math.round((completed / total) * 100) : 0;

  const hasTranslated = Boolean(ui.hasTranslatedBlocks);
  const isRunning = Boolean(ui.isRunning);
  const canClear = Boolean(ui.canClear);
  const canStart = canRunOnCurrentTab() && !isRunning;
  const stage = ui.stage || PIPELINE_STAGE.IDLE;
  const viewMode = ui.viewMode || VIEW_MODE.ORIGINAL;

  const hintIfNoTab = canRunOnCurrentTab() ? "" : "Откройте активную http/https страницу";
  const lastError = ui.lastError?.message || hintIfNoTab;

  panel.innerHTML = `
    <div class="status-grid">
      <div class="progress-shell">
        <progress max="100" value="${percent}"></progress>
        <div class="summary-line">
          <span title="done / pending / failed">${done} / ${pending} / ${failed}</span>
          <span class="error-pill" id="error-pill" title="Показать ошибки">err: ${errorCount}</span>
        </div>
        <div class="summary-line">
          <span title="Стадия">${escapeHtml(stage)}</span>
          <span>${percent}%</span>
        </div>
        ${lastError ? `<div class="summary-line"><span title="Последняя ошибка">${escapeHtml(lastError)}</span></div>` : ""}
      </div>

      <div class="action-row">
        <button class="icon-btn" id="btn-start" title="Запуск перевода" ${canStart ? "" : "disabled"}>▶</button>
        <button class="icon-btn" id="btn-cancel" title="Жёсткая отмена" ${isRunning ? "" : "disabled"}>■</button>
        <button class="icon-btn" id="btn-clear" title="Стереть всё" ${canClear ? "" : "disabled"}>⌫</button>
      </div>

      <div class="view-row">
        <button class="icon-btn ${viewMode === VIEW_MODE.TRANSLATION ? "active" : ""}" id="btn-view-translation" title="Показать перевод" ${hasTranslated ? "" : "disabled"}>T</button>
        <button class="icon-btn ${viewMode === VIEW_MODE.ORIGINAL ? "active" : ""}" id="btn-view-original" title="Показать оригинал">O</button>
        <button class="icon-btn ${viewMode === VIEW_MODE.DIFF ? "active" : ""}" id="btn-view-diff" title="Показать diff" ${hasTranslated ? "" : "disabled"}>D</button>
      </div>
    </div>
  `;

  panel.querySelector("#btn-start")?.addEventListener("click", () => runStatusAction("start"));
  panel.querySelector("#btn-cancel")?.addEventListener("click", () => runStatusAction("cancel"));
  panel.querySelector("#btn-clear")?.addEventListener("click", () => runStatusAction("clear"));
  panel.querySelector("#btn-view-translation")?.addEventListener("click", () => switchView(VIEW_MODE.TRANSLATION));
  panel.querySelector("#btn-view-original")?.addEventListener("click", () => switchView(VIEW_MODE.ORIGINAL));
  panel.querySelector("#btn-view-diff")?.addEventListener("click", () => switchView(VIEW_MODE.DIFF));

  panel.querySelector("#error-pill")?.addEventListener("click", () => {
    state.eventFilters.onlyErrors = true;
    switchPanel("events");
    renderEventsPanel();
    refreshLogs().catch(() => {});
  });
}

async function runStatusAction(action) {
  try {
    if (action === "start") {
      state.uiState = mergeUiState(await callRuntime(MESSAGE.UI_START, { tabId: state.tabId, url: state.tabUrl }));
    } else if (action === "cancel") {
      state.uiState = mergeUiState(await callRuntime(MESSAGE.UI_CANCEL, { tabId: state.tabId }));
    } else if (action === "clear") {
      state.uiState = mergeUiState(await callRuntime(MESSAGE.UI_CLEAR, { tabId: state.tabId }));
    }
    renderStatusPanel();
    await refreshLogs();
  } catch (error) {
    setTransientError(error?.message || "Action failed");
    renderStatusPanel();
  }
}

async function switchView(mode) {
  const ui = mergeUiState(state.uiState);
  if (!ui.hasTranslatedBlocks && (mode === VIEW_MODE.TRANSLATION || mode === VIEW_MODE.DIFF)) {
    return;
  }
  try {
    state.uiState = mergeUiState(await callRuntime(MESSAGE.UI_SWITCH_VIEW, { tabId: state.tabId, mode }));
    renderStatusPanel();
  } catch (error) {
    setTransientError(error?.message || "View switch failed");
    renderStatusPanel();
  }
}

function renderSettingsPanel() {
  const panel = app.querySelector('[data-panel="settings"]');
  if (!panel || !state.settings) {
    return;
  }

  const activeProfileName = state.settings.activeProfileName || "default";
  const profileNames = Object.keys(state.profiles).sort((a, b) => a.localeCompare(b));
  const isDirty = isProfileDirty();
  const customSelected = isDirty ? "selected" : "";

  const profileOptions = profileNames
    .map((name) => `<option value="${escapeHtml(name)}" ${!isDirty && name === activeProfileName ? "selected" : ""}>${escapeHtml(name)}</option>`)
    .join("");

  panel.innerHTML = `
    <div class="settings-grid">
      <div class="block">
        <div class="profile-toolbar">
          <select id="profile-select" title="Активный профиль">${profileOptions}<option value="${CUSTOM_PROFILE_OPTION}" ${customSelected}>*</option></select>
          <input id="profile-name" type="text" title="Имя профиля" placeholder="profile" value="${escapeHtml(state.profileNameDraft || "")}" autocomplete="off" />
          <button class="icon-btn" id="profile-save" title="Сохранить профиль">⤓</button>
          <button class="icon-btn" id="settings-save" title="Сохранить настройки">✓</button>
          <span id="profile-dirty-flag" class="right" title="Профиль изменён">${isDirty ? "*" : ""}</span>
        </div>

        <textarea id="profile-json" title="JSON профиля">${escapeHtml(toSortedJson(state.settings.profileDraft || {}))}</textarea>
        <div class="profile-fields" id="profile-fields"></div>

        <div class="editor-row" id="field-editor-row" hidden>
          <input id="field-editor-input" list="field-editor-list" autocomplete="off" />
          <button class="icon-btn" id="field-editor-apply" title="Применить">✓</button>
          <button class="icon-btn" id="field-editor-close" title="Закрыть">✕</button>
          <datalist id="field-editor-list"></datalist>
        </div>
      </div>

      <div class="block">
        <div class="access-switch" title="Режим доступа">
          <button id="mode-byok" class="${state.settings.accessMode === "BYOK" ? "active" : ""}">BYOK</button>
          <button id="mode-proxy" class="${state.settings.accessMode === "PROXY" ? "active" : ""}">PROXY</button>
        </div>

        <div id="access-byok" class="access-panel ${state.settings.accessMode === "BYOK" ? "active" : ""}">
          <div class="inline">
            <input type="password" id="byok-key" value="${escapeHtml(state.settings.byokApiKey || "")}" placeholder="API key" autocomplete="off" />
            <button class="icon-btn" id="toggle-byok-key" title="Показать/скрыть">◉</button>
          </div>
          <input type="text" id="byok-url" value="${escapeHtml(state.settings.byokBaseUrl || "")}" placeholder="Base URL" autocomplete="off" />
        </div>

        <div id="access-proxy" class="access-panel ${state.settings.accessMode === "PROXY" ? "active" : ""}">
          <div class="inline">
            <input type="password" id="proxy-token" value="${escapeHtml(state.settings.proxyToken || "")}" placeholder="Proxy token" autocomplete="off" />
            <button class="icon-btn" id="toggle-proxy-token" title="Показать/скрыть">◉</button>
          </div>
          <input type="text" id="proxy-url" value="${escapeHtml(state.settings.proxyBaseUrl || "")}" placeholder="Proxy URL" autocomplete="off" />
        </div>
      </div>

      <div class="block">
        <div class="models-toolbar">
          <button class="icon-btn" id="load-models" title="Загрузить модели">↻</button>
          <select id="priority-context" title="Приоритет context"></select>
          <select id="priority-translation" title="Приоритет translation"></select>
        </div>
        <div id="models-list" class="models-list"></div>
      </div>
    </div>
  `;

  wireSettingsControls();
  renderProfileFields();
  renderModels();
}

function wireSettingsControls() {
  const profileSelect = app.querySelector("#profile-select");
  const profileNameInput = app.querySelector("#profile-name");
  const profileJson = app.querySelector("#profile-json");

  profileSelect?.addEventListener("change", () => {
    if (profileSelect.value === CUSTOM_PROFILE_OPTION) {
      return;
    }
    state.settings.activeProfileName = profileSelect.value;
    state.profileNameDraft = profileSelect.value;
    state.settings.profileDraft = deepClone(state.profiles[profileSelect.value] || DEFAULT_PROFILE_TEMPLATE);
    syncProfileDraftToSettings();
    renderSettingsPanel();
  });

  profileNameInput?.addEventListener("input", () => {
    state.profileNameDraft = profileNameInput.value;
  });

  app.querySelector("#profile-save")?.addEventListener("click", async () => {
    const name = normalizeProfileName(state.profileNameDraft, state.settings.activeProfileName);
    await callRuntime(MESSAGE.UI_SAVE_PROFILE, {
      name,
      profile: state.settings.profileDraft
    });
    state.profiles = await callRuntime(MESSAGE.UI_LIST_PROFILES);
    state.settings.activeProfileName = name;
    state.profileNameDraft = name;
    renderSettingsPanel();
  });

  app.querySelector("#settings-save")?.addEventListener("click", async () => {
    syncProfileDraftToSettings();
    state.settings = await callRuntime(MESSAGE.UI_SAVE_SETTINGS, { settings: state.settings });
    state.settings.profileDraft = deepClone(state.settings.profileDraft || state.profiles[state.settings.activeProfileName] || DEFAULT_PROFILE_TEMPLATE);
    renderSettingsPanel();
    await refreshState();
    await refreshLogs();
  });

  profileJson?.addEventListener("change", () => {
    try {
      state.settings.profileDraft = JSON.parse(profileJson.value);
      syncProfileDraftToSettings();
      renderProfileFields();
      profileJson.style.borderColor = "";
    } catch {
      profileJson.style.borderColor = "#111";
    }
  });

  app.querySelector("#mode-byok")?.addEventListener("click", () => {
    state.settings.accessMode = "BYOK";
    renderSettingsPanel();
  });

  app.querySelector("#mode-proxy")?.addEventListener("click", () => {
    state.settings.accessMode = "PROXY";
    renderSettingsPanel();
  });

  bindInput("#byok-key", (value) => {
    state.settings.byokApiKey = value;
  });
  bindInput("#byok-url", (value) => {
    state.settings.byokBaseUrl = value;
  });
  bindInput("#proxy-token", (value) => {
    state.settings.proxyToken = value;
  });
  bindInput("#proxy-url", (value) => {
    state.settings.proxyBaseUrl = value;
  });

  app.querySelector("#toggle-byok-key")?.addEventListener("click", () => togglePassword("#byok-key"));
  app.querySelector("#toggle-proxy-token")?.addEventListener("click", () => togglePassword("#proxy-token"));

  app.querySelector("#load-models")?.addEventListener("click", async () => {
    try {
      state.modelsCatalog = await callRuntime(MESSAGE.UI_LIST_MODELS);
      renderModels();
    } catch (error) {
      setTransientError(error?.message || "Failed to load models");
      renderStatusPanel();
    }
  });
}

function bindInput(selector, setter) {
  const element = app.querySelector(selector);
  element?.addEventListener("input", () => setter(element.value));
}

function togglePassword(selector) {
  const input = app.querySelector(selector);
  if (!input) {
    return;
  }
  input.type = input.type === "password" ? "text" : "password";
}

function renderProfileFields() {
  const list = app.querySelector("#profile-fields");
  if (!list) {
    return;
  }

  const selectedProfile = state.profiles[state.settings.activeProfileName] || {};
  const draft = state.settings.profileDraft || {};
  const rows = flattenLeafPaths(draft);

  list.innerHTML = rows
    .map(({ path, value }) => {
      const selectedValue = getValueByPath(selectedProfile, path);
      const changed = JSON.stringify(selectedValue) !== JSON.stringify(value);
      return `
        <button class="profile-field ${changed ? "changed" : ""}" data-path="${escapeHtml(path)}" title="${escapeHtml(path)}">
          <span>${escapeHtml(path)}</span>
          <span class="value-preview">${escapeHtml(formatValue(value))}</span>
        </button>
      `;
    })
    .join("");

  list.querySelectorAll(".profile-field").forEach((button) => {
    button.addEventListener("click", () => {
      openFieldEditor(button.dataset.path);
    });
  });

  const profileJson = app.querySelector("#profile-json");
  if (profileJson && document.activeElement !== profileJson) {
    profileJson.value = toSortedJson(draft);
  }

  const dirtyFlag = app.querySelector("#profile-dirty-flag");
  if (dirtyFlag) {
    dirtyFlag.textContent = isProfileDirty() ? "*" : "";
  }

  const profileSelect = app.querySelector("#profile-select");
  if (profileSelect) {
    const dirty = isProfileDirty();
    profileSelect.value = dirty ? CUSTOM_PROFILE_OPTION : state.settings.activeProfileName || "default";
  }
}

function openFieldEditor(path) {
  const row = app.querySelector("#field-editor-row");
  const input = app.querySelector("#field-editor-input");
  const datalist = app.querySelector("#field-editor-list");
  const applyButton = app.querySelector("#field-editor-apply");
  const closeButton = app.querySelector("#field-editor-close");
  if (!row || !input || !datalist || !applyButton || !closeButton) {
    return;
  }

  state.fieldEditor.path = path;
  const meta = PROFILE_FIELD_META[path] || null;
  const currentValue = getValueByPath(state.settings.profileDraft, path);

  datalist.innerHTML = "";
  if (Array.isArray(meta?.enum)) {
    datalist.innerHTML = meta.enum.map((value) => `<option value="${escapeHtml(String(value))}"></option>`).join("");
  }

  input.value = formatValue(currentValue);
  input.title = path;
  row.hidden = false;
  input.focus();

  const commit = () => {
    const editorPath = state.fieldEditor.path;
    const parsed = parseFieldValue(input.value, meta);
    setValueByPath(state.settings.profileDraft, editorPath, parsed);
    syncProfileDraftToSettings();
    renderSettingsPanel();
  };

  applyButton.onclick = commit;
  closeButton.onclick = () => {
    row.hidden = true;
    state.fieldEditor.path = "";
  };

  input.onkeydown = (event) => {
    if (event.key === "Enter") {
      commit();
    }
    if (event.key === "Escape") {
      row.hidden = true;
      state.fieldEditor.path = "";
    }
  };
}

function syncProfileDraftToSettings() {
  const draft = state.settings.profileDraft || {};
  for (const key of Object.keys(draft)) {
    state.settings[key] = deepClone(draft[key]);
  }
}

function captureProfileDraftFromSettings() {
  const draft = {};
  for (const key of Object.keys(DEFAULT_PROFILE_TEMPLATE)) {
    draft[key] = deepClone(state.settings[key]);
  }
  state.settings.profileDraft = draft;
}

function isProfileDirty() {
  const selectedProfile = state.profiles[state.settings.activeProfileName] || {};
  const draft = state.settings.profileDraft || {};
  return JSON.stringify(selectedProfile) !== JSON.stringify(draft);
}

function renderModels() {
  const list = app.querySelector("#models-list");
  const contextSelect = app.querySelector("#priority-context");
  const translationSelect = app.querySelector("#priority-translation");
  if (!list || !contextSelect || !translationSelect) {
    return;
  }

  if (!state.settings.models) {
    state.settings.models = { selected: [] };
  }
  if (!Array.isArray(state.settings.models.selected)) {
    state.settings.models.selected = [];
  }
  if (!state.settings.modelPriority) {
    state.settings.modelPriority = { context: [], translation: [] };
  }

  const selectedSet = new Set(state.settings.models.selected);
  const source =
    state.modelsCatalog.length > 0
      ? [...state.modelsCatalog]
      : state.settings.models.selected.map((id) => ({ id, pricing: null, totalPricePer1M: Number.POSITIVE_INFINITY }));

  source.sort((left, right) => {
    const leftPrice = Number.isFinite(left.totalPricePer1M)
      ? left.totalPricePer1M
      : left.pricing
        ? Number(left.pricing.input || 0) + Number(left.pricing.output || 0)
        : Number.POSITIVE_INFINITY;
    const rightPrice = Number.isFinite(right.totalPricePer1M)
      ? right.totalPricePer1M
      : right.pricing
        ? Number(right.pricing.input || 0) + Number(right.pricing.output || 0)
        : Number.POSITIVE_INFINITY;
    return leftPrice - rightPrice || String(left.id).localeCompare(String(right.id));
  });

  list.innerHTML = source
    .map((model) => {
      const checked = selectedSet.has(model.id) ? "checked" : "";
      const priceText = model.pricing
        ? `i:${model.pricing.input} o:${model.pricing.output} c:${model.pricing.cachedInput}`
        : "i:- o:- c:-";
      return `
        <label class="model-item">
          <input type="checkbox" data-model-id="${escapeHtml(model.id)}" ${checked} />
          <span title="input/output/cached per 1M">${escapeHtml(model.id)} (${escapeHtml(priceText)})</span>
        </label>
      `;
    })
    .join("");

  list.querySelectorAll("input[type='checkbox']").forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      const modelId = checkbox.dataset.modelId;
      if (checkbox.checked) {
        if (!state.settings.models.selected.includes(modelId)) {
          state.settings.models.selected.push(modelId);
        }
      } else {
        state.settings.models.selected = state.settings.models.selected.filter((id) => id !== modelId);
      }

      normalizeModelPriorities();
      captureProfileDraftFromSettings();
      renderModels();
      renderProfileFields();
    });
  });

  const options = state.settings.models.selected
    .map((id) => `<option value="${escapeHtml(id)}">${escapeHtml(id)}</option>`)
    .join("");

  contextSelect.innerHTML = options;
  translationSelect.innerHTML = options;

  normalizeModelPriorities();

  contextSelect.value = state.settings.modelPriority.context[0] || "";
  translationSelect.value = state.settings.modelPriority.translation[0] || "";

  contextSelect.onchange = () => {
    reorderPriority("context", contextSelect.value);
  };

  translationSelect.onchange = () => {
    reorderPriority("translation", translationSelect.value);
  };
}

function normalizeModelPriorities() {
  const selected = state.settings.models.selected;
  const priority = state.settings.modelPriority;

  priority.context = (priority.context || []).filter((id) => selected.includes(id));
  priority.translation = (priority.translation || []).filter((id) => selected.includes(id));

  const first = selected[0] || "";
  if (first && priority.context.length === 0) {
    priority.context.push(first);
  }
  if (first && priority.translation.length === 0) {
    priority.translation.push(first);
  }
}

function reorderPriority(key, modelId) {
  if (!modelId || !state.settings.modelPriority?.[key]) {
    return;
  }
  state.settings.modelPriority[key] = [modelId, ...state.settings.modelPriority[key].filter((id) => id !== modelId)];
  captureProfileDraftFromSettings();
  renderProfileFields();
}

function renderEventsPanel(logData = null) {
  const panel = app.querySelector('[data-panel="events"]');
  if (!panel) {
    return;
  }

  if (!panel.dataset.ready) {
    panel.innerHTML = `
      <div class="events-toolbar">
        <select id="event-category" title="Категория">
          <option value="">all</option>
          ${Object.values(EVENT_CATEGORY)
            .map((category) => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`)
            .join("")}
        </select>
        <button class="icon-btn" id="event-errors-only" title="Только ошибки">!</button>
        <button class="icon-btn" id="event-download" title="Скачать лог">↓</button>
        <button class="icon-btn" id="event-copy" title="Копировать лог">⎘</button>
      </div>
      <div id="logs" class="logs"></div>
    `;

    panel.dataset.ready = "1";

    panel.querySelector("#event-category")?.addEventListener("change", async (event) => {
      state.eventFilters.category = event.target.value;
      await refreshLogs();
    });

    panel.querySelector("#event-errors-only")?.addEventListener("click", async () => {
      state.eventFilters.onlyErrors = !state.eventFilters.onlyErrors;
      await refreshLogs();
    });

    panel.querySelector("#event-download")?.addEventListener("click", downloadLogs);
    panel.querySelector("#event-copy")?.addEventListener("click", copyLogs);
  }

  panel.querySelector("#event-category").value = state.eventFilters.category;
  panel.querySelector("#event-errors-only")?.classList.toggle("active", state.eventFilters.onlyErrors);

  if (!logData) {
    return;
  }

  panel.querySelector("#logs").innerHTML = logData.items
    .map((row) => {
      const summary = `${row.ts} | ${row.level} | ${row.category} | ${row.name}`;
      const payload = JSON.stringify(
        {
          pageSessionId: row.pageSessionId,
          tabId: row.tabId,
          batchId: row.batchId,
          blockId: row.blockId,
          data: row.data,
          error: row.error
        },
        null,
        2
      );
      return `<details><summary>${escapeHtml(summary)}</summary><pre>${escapeHtml(payload)}</pre></details>`;
    })
    .join("");
}

async function refreshLogs() {
  renderEventsPanel();
  const logs = await callRuntime(MESSAGE.LOG_QUERY, {
    filters: {
      ...state.eventFilters,
      pageSessionId: state.uiState?.pageSessionId || null,
      limit: 400
    }
  });
  renderEventsPanel(logs);
}

async function downloadLogs() {
  const json = await callRuntime(MESSAGE.LOG_EXPORT, {
    filters: {
      ...state.eventFilters,
      pageSessionId: state.uiState?.pageSessionId || null
    }
  });
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  await chrome.downloads.download({
    url,
    filename: `neuro-translate-log-${Date.now()}.json`,
    saveAs: true
  });
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function copyLogs() {
  const json = await callRuntime(MESSAGE.LOG_EXPORT, {
    filters: {
      ...state.eventFilters,
      pageSessionId: state.uiState?.pageSessionId || null
    }
  });
  await navigator.clipboard.writeText(json);
}

async function openDebugPage() {
  const url = chrome.runtime.getURL("debug/debug.html");
  await chrome.tabs.create({ url });
}

function normalizeProfileName(rawName, fallbackName) {
  const normalized = String(rawName || "").trim();
  if (normalized) {
    return normalized;
  }
  const fallback = String(fallbackName || "").trim();
  if (fallback) {
    return fallback;
  }
  return `profile-${new Date().toISOString().replace(/[:.]/g, "-")}`;
}

function canRunOnCurrentTab() {
  return Number.isInteger(state.tabId) && /^https?:/i.test(state.tabUrl || "");
}

function setTransientError(message) {
  const next = mergeUiState(state.uiState);
  next.lastError = { message };
  state.uiState = next;
}

function flattenLeafPaths(obj, prefix = "") {
  const rows = [];
  for (const [key, value] of Object.entries(obj || {})) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      rows.push(...flattenLeafPaths(value, path));
      continue;
    }
    rows.push({ path, value });
  }
  return rows;
}

function formatValue(value) {
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value);
}

function parseFieldValue(raw, meta) {
  if (!meta) {
    return parseFallback(raw);
  }

  switch (meta.type) {
    case "boolean":
      return raw === "true";
    case "number":
      return Number(raw);
    case "array":
      try {
        return JSON.parse(raw);
      } catch {
        return raw
          .split(",")
          .map((part) => part.trim())
          .filter(Boolean);
      }
    default:
      return raw;
  }
}

function parseFallback(raw) {
  if (raw === "true") {
    return true;
  }
  if (raw === "false") {
    return false;
  }
  const num = Number(raw);
  if (raw.trim() !== "" && Number.isFinite(num)) {
    return num;
  }
  if ((raw.startsWith("{") && raw.endsWith("}")) || (raw.startsWith("[") && raw.endsWith("]"))) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
