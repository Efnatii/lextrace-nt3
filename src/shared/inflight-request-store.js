export class InflightRequestStore {
  constructor({ storageKey = "inflightRequestMeta", maxRecords = 500 } = {}) {
    this.requests = new Map();
    this.storageKey = storageKey;
    this.maxRecords = maxRecords;
    this.flushTimer = null;
    this.initialized = false;
  }

  async init() {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    if (!globalThis.chrome?.storage?.local) {
      return;
    }

    try {
      const raw = await chrome.storage.local.get([this.storageKey]);
      const rows = Array.isArray(raw?.[this.storageKey]) ? raw[this.storageKey] : [];
      for (const row of rows) {
        if (!row?.requestId) {
          continue;
        }
        this.requests.set(row.requestId, {
          ...row,
          startedAt: Number(row.startedAt) || Date.now()
        });
      }
    } catch {
      // best-effort hydration
    }
  }

  add(meta) {
    if (!meta?.requestId) {
      return;
    }
    this.requests.set(meta.requestId, {
      ...meta,
      startedAt: Date.now()
    });
    this.scheduleFlush();
  }

  remove(requestId) {
    if (!requestId) {
      return;
    }
    this.requests.delete(requestId);
    this.scheduleFlush();
  }

  clearSession(pageSessionId) {
    if (!pageSessionId) {
      return;
    }
    let changed = false;
    for (const [requestId, request] of this.requests.entries()) {
      if (request.pageSessionId === pageSessionId) {
        this.requests.delete(requestId);
        changed = true;
      }
    }
    if (changed) {
      this.scheduleFlush();
    }
  }

  listBySession(pageSessionId) {
    return [...this.requests.values()].filter((item) => item.pageSessionId === pageSessionId);
  }

  list() {
    return [...this.requests.values()];
  }

  clear() {
    this.requests.clear();
    this.scheduleFlush();
  }

  scheduleFlush() {
    if (!globalThis.chrome?.storage?.local) {
      return;
    }
    clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      this.flush().catch(() => {});
    }, 40);
  }

  async flush() {
    if (!globalThis.chrome?.storage?.local) {
      return;
    }
    const rows = [...this.requests.values()]
      .sort((left, right) => (left.startedAt || 0) - (right.startedAt || 0))
      .slice(-this.maxRecords);
    await chrome.storage.local.set({ [this.storageKey]: rows });
  }
}
