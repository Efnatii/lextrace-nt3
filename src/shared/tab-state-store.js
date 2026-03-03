import { PIPELINE_STAGE, STORAGE_KEYS, VIEW_MODE } from "./constants.js";

export class TabStateStore {
  async init() {
    const raw = await chrome.storage.local.get([STORAGE_KEYS.TAB_STATES, STORAGE_KEYS.ACTIVE_SESSION_BY_TAB]);
    const updates = {};
    if (!raw?.[STORAGE_KEYS.TAB_STATES]) {
      updates[STORAGE_KEYS.TAB_STATES] = {};
    }
    if (!raw?.[STORAGE_KEYS.ACTIVE_SESSION_BY_TAB]) {
      updates[STORAGE_KEYS.ACTIVE_SESSION_BY_TAB] = {};
    }
    if (Object.keys(updates).length > 0) {
      await chrome.storage.local.set(updates);
    }
  }

  async getAllStates() {
    await this.init();
    const raw = await chrome.storage.local.get([STORAGE_KEYS.TAB_STATES]);
    return raw?.[STORAGE_KEYS.TAB_STATES] || {};
  }

  async getState(pageSessionId) {
    const states = await this.getAllStates();
    return states[pageSessionId] || null;
  }

  async upsertState(pageSessionId, patch) {
    const states = await this.getAllStates();
    const previous = states[pageSessionId] || createEmptyState(pageSessionId);
    const next = {
      ...previous,
      ...patch,
      progress: {
        ...previous.progress,
        ...(patch.progress || {})
      },
      updatedAt: Date.now()
    };
    states[pageSessionId] = next;
    await chrome.storage.local.set({ [STORAGE_KEYS.TAB_STATES]: states });
    return next;
  }

  async setActiveSession(tabId, pageSessionId) {
    await this.init();
    const raw = await chrome.storage.local.get([STORAGE_KEYS.ACTIVE_SESSION_BY_TAB]);
    const map = raw?.[STORAGE_KEYS.ACTIVE_SESSION_BY_TAB] || {};
    if (pageSessionId) {
      map[String(tabId)] = pageSessionId;
    } else {
      delete map[String(tabId)];
    }
    await chrome.storage.local.set({ [STORAGE_KEYS.ACTIVE_SESSION_BY_TAB]: map });
  }

  async getActiveSessionByTab(tabId) {
    await this.init();
    const raw = await chrome.storage.local.get([STORAGE_KEYS.ACTIVE_SESSION_BY_TAB]);
    const map = raw?.[STORAGE_KEYS.ACTIVE_SESSION_BY_TAB] || {};
    return map[String(tabId)] || null;
  }

  async clearSession(pageSessionId) {
    const states = await this.getAllStates();
    delete states[pageSessionId];
    await chrome.storage.local.set({ [STORAGE_KEYS.TAB_STATES]: states });

    const raw = await chrome.storage.local.get([STORAGE_KEYS.ACTIVE_SESSION_BY_TAB]);
    const map = raw?.[STORAGE_KEYS.ACTIVE_SESSION_BY_TAB] || {};
    for (const [tabId, sessionId] of Object.entries(map)) {
      if (sessionId === pageSessionId) {
        delete map[tabId];
      }
    }
    await chrome.storage.local.set({ [STORAGE_KEYS.ACTIVE_SESSION_BY_TAB]: map });
  }

  async clearAll() {
    await chrome.storage.local.set({
      [STORAGE_KEYS.TAB_STATES]: {},
      [STORAGE_KEYS.ACTIVE_SESSION_BY_TAB]: {}
    });
  }
}

export function createEmptyState(pageSessionId) {
  return {
    pageSessionId,
    stage: PIPELINE_STAGE.IDLE,
    tabId: null,
    url: "",
    startedAt: null,
    updatedAt: Date.now(),
    cancelled: false,
    hasTranslatedBlocks: false,
    viewMode: VIEW_MODE.ORIGINAL,
    progress: {
      done: 0,
      pending: 0,
      failed: 0,
      total: 0,
      errorCount: 0
    },
    batches: [],
    batchWindow: {
      previous: [],
      compacted: []
    },
    lastError: null,
    queueSize: 0
  };
}