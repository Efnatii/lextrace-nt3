(function initUiStateStore(global) {
  const NT = global.NT || (global.NT = {});

  const STORAGE_KEY = 'nt.uiState.v1';
  const POPUP_TABS = ['status', 'settings', 'history', 'errors'];
  const DEBUG_TABS = ['overview', 'plan', 'tools', 'diff', 'categories', 'memory', 'ratelimits', 'perf', 'security', 'export'];

  class UiStateStore {
    constructor({ chromeApi, storageKey, debounceMs } = {}) {
      this.chromeApi = chromeApi || global.chrome || null;
      this.storageKey = typeof storageKey === 'string' && storageKey ? storageKey : STORAGE_KEY;
      this.debounceMs = Math.max(100, Math.min(800, Number(debounceMs) || 200));

      this._loadedPromise = null;
      this._cache = null;
      this._writeTimer = null;
    }

    async getPopupState() {
      await this._ensureLoaded();
      const popup = this._cache && this._cache.popup && typeof this._cache.popup === 'object'
        ? this._cache.popup
        : this._defaultState().popup;
      return this._cloneJson(popup, { activeTab: 'status' });
    }

    async setPopupState(patch) {
      await this._ensureLoaded();
      return this._setSectionState('popup', patch);
    }

    async getDebugState() {
      await this._ensureLoaded();
      const debug = this._cache && this._cache.debug && typeof this._cache.debug === 'object'
        ? this._cache.debug
        : this._defaultState().debug;
      return this._cloneJson(debug, { activeTab: 'overview' });
    }

    async setDebugState(patch) {
      await this._ensureLoaded();
      return this._setSectionState('debug', patch);
    }

    _setSectionState(section, patch) {
      const source = patch && typeof patch === 'object' ? patch : {};
      const current = this._cache && this._cache[section] && typeof this._cache[section] === 'object'
        ? this._cache[section]
        : {};
      const merged = { ...current, ...source };

      if (section === 'popup') {
        merged.activeTab = this._normalizePopupTab(merged.activeTab);
      }
      if (section === 'debug') {
        merged.activeTab = this._normalizeDebugTab(merged.activeTab);
      }

      this._cache = {
        ...(this._cache || this._defaultState()),
        [section]: merged
      };
      const needsImmediatePersist = Object.prototype.hasOwnProperty.call(source, 'activeTab');
      if (needsImmediatePersist) {
        if (this._writeTimer) {
          global.clearTimeout(this._writeTimer);
          this._writeTimer = null;
        }
        this._flushWrite().catch(() => {});
      } else {
        this._queueWrite();
      }
      return this._cloneJson(merged, {});
    }

    async _ensureLoaded() {
      if (this._cache) {
        return this._cache;
      }
      if (this._loadedPromise) {
        return this._loadedPromise;
      }
      this._loadedPromise = (async () => {
        const raw = await this._readRaw().catch(() => null);
        this._cache = this._normalizeState(raw);
        return this._cache;
      })().finally(() => {
        this._loadedPromise = null;
      });
      return this._loadedPromise;
    }

    _normalizeState(value) {
      const src = value && typeof value === 'object' ? value : {};
      const popup = src.popup && typeof src.popup === 'object' ? src.popup : {};
      const debug = src.debug && typeof src.debug === 'object' ? src.debug : {};
      return {
        popup: {
          ...popup,
          activeTab: this._normalizePopupTab(popup.activeTab)
        },
        debug: {
          ...debug,
          activeTab: this._normalizeDebugTab(debug.activeTab)
        }
      };
    }

    _normalizePopupTab(value) {
      const key = String(value || '').trim().toLowerCase();
      return POPUP_TABS.includes(key) ? key : 'status';
    }

    _normalizeDebugTab(value) {
      const keyRaw = String(value || '').trim().toLowerCase();
      const key = keyRaw === 'diff-patches' ? 'diff' : keyRaw;
      return DEBUG_TABS.includes(key) ? key : 'overview';
    }

    _defaultState() {
      return {
        popup: {
          activeTab: 'status'
        },
        debug: {
          activeTab: 'overview'
        }
      };
    }

    _queueWrite() {
      if (this._writeTimer) {
        global.clearTimeout(this._writeTimer);
      }
      this._writeTimer = global.setTimeout(() => {
        this._writeTimer = null;
        this._flushWrite().catch(() => {});
      }, this.debounceMs);
    }

    async _flushWrite() {
      const snapshot = this._cloneJson(this._cache, this._defaultState());
      await this._writeRaw(snapshot);
    }

    async _readRaw() {
      const area = this._localStorageArea();
      if (!area || typeof area.get !== 'function') {
        return this._defaultState();
      }
      return new Promise((resolve) => {
        try {
          area.get({ [this.storageKey]: null }, (result) => {
            const raw = result && typeof result === 'object' ? result[this.storageKey] : null;
            resolve(raw);
          });
        } catch (_) {
          resolve(this._defaultState());
        }
      });
    }

    async _writeRaw(value) {
      const area = this._localStorageArea();
      if (!area || typeof area.set !== 'function') {
        return;
      }
      return new Promise((resolve) => {
        try {
          area.set({ [this.storageKey]: value }, () => resolve());
        } catch (_) {
          resolve();
        }
      });
    }

    _localStorageArea() {
      return this.chromeApi
        && this.chromeApi.storage
        && this.chromeApi.storage.local
        && typeof this.chromeApi.storage.local === 'object'
        ? this.chromeApi.storage.local
        : null;
    }

    _cloneJson(value, fallback) {
      try {
        return JSON.parse(JSON.stringify(value));
      } catch (_) {
        return fallback;
      }
    }
  }

  NT.UiStateStore = UiStateStore;
})(globalThis);
