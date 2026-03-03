(function initUiKit(global) {
  const NT = global.NT || (global.NT = {});

  function createElement(tagName, options = {}) {
    const el = global.document.createElement(String(tagName || 'div'));
    if (options.className) {
      el.className = String(options.className);
    }
    if (options.text !== undefined && options.text !== null) {
      el.textContent = String(options.text);
    }
    if (options.html !== undefined && options.html !== null) {
      el.innerHTML = String(options.html);
    }
    if (options.attrs && typeof options.attrs === 'object') {
      Object.keys(options.attrs).forEach((key) => {
        const value = options.attrs[key];
        if (value === null || value === undefined) {
          return;
        }
        el.setAttribute(key, String(value));
      });
    }
    if (Array.isArray(options.children)) {
      options.children.forEach((child) => {
        if (!child) {
          return;
        }
        el.appendChild(child);
      });
    }
    return el;
  }

  function clearNode(el) {
    if (!el) {
      return;
    }
    while (el.firstChild) {
      el.removeChild(el.firstChild);
    }
  }

  function setText(el, value, fallback = '') {
    if (!el) {
      return;
    }
    const next = value === null || value === undefined || value === ''
      ? String(fallback)
      : String(value);
    if (el.textContent !== next) {
      el.textContent = next;
    }
  }

  function setHidden(el, hidden) {
    if (!el) {
      return;
    }
    el.hidden = hidden === true;
  }

  function escapeHtml(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function createBadge(text, tone = 'neutral') {
    return createElement('span', {
      className: `nt-badge nt-badge--${tone}`,
      text: text || ''
    });
  }

  function applyTooltip(el, { label, tooltip } = {}) {
    if (!el || typeof el.setAttribute !== 'function') {
      return el;
    }
    const resolvedLabel = typeof label === 'string' ? label.trim() : '';
    const resolvedTooltip = typeof tooltip === 'string' ? tooltip.trim() : '';
    const value = resolvedTooltip || resolvedLabel;
    if (resolvedLabel) {
      el.setAttribute('aria-label', resolvedLabel);
    }
    if (value) {
      el.setAttribute('title', value);
      el.setAttribute('data-tooltip', value);
    }
    return el;
  }

  function resolveIconMarkup(icon) {
    if (!icon) {
      return '';
    }
    if (typeof icon === 'string') {
      const raw = icon.trim();
      if (raw.startsWith('<svg')) {
        return raw;
      }
      const UiIcons = NT.UiIcons || {};
      if (typeof UiIcons.get === 'function') {
        return UiIcons.get(raw);
      }
      return typeof UiIcons[raw] === 'string' ? UiIcons[raw] : '';
    }
    if (typeof icon === 'function') {
      const value = icon();
      return typeof value === 'string' ? value : '';
    }
    return '';
  }

  function createIconButton({
    icon,
    label,
    tooltip,
    tone = 'neutral',
    className = '',
    attrs = {},
    showLabel = false
  } = {}) {
    const markup = resolveIconMarkup(icon);
    const btn = createElement('button', {
      className: `nt-icon-btn nt-icon-btn--${tone}${className ? ` ${className}` : ''}`,
      attrs: {
        type: 'button',
        ...attrs
      }
    });

    applyTooltip(btn, {
      label: typeof label === 'string' ? label : '',
      tooltip: typeof tooltip === 'string' ? tooltip : ''
    });

    if (markup) {
      const iconHost = createElement('span', {
        className: 'nt-icon',
        attrs: {
          'aria-hidden': 'true'
        },
        html: markup
      });
      btn.appendChild(iconHost);
    }

    if (showLabel || !markup) {
      btn.appendChild(createElement('span', {
        className: showLabel ? 'nt-icon-btn__label' : 'nt-sr-only',
        text: String(label || '')
      }));
    } else if (label) {
      btn.appendChild(createElement('span', {
        className: 'nt-sr-only',
        text: String(label)
      }));
    }

    return btn;
  }

  class RenderScheduler {
    constructor() {
      this._tasks = [];
      this._scheduled = false;
    }

    queueRender(fn) {
      if (typeof fn !== 'function') {
        return;
      }
      this._tasks.push(fn);
      if (this._scheduled) {
        return;
      }
      this._scheduled = true;
      const flush = () => {
        this._scheduled = false;
        const queue = this._tasks.slice();
        this._tasks.length = 0;
        for (let i = 0; i < queue.length; i += 1) {
          try {
            queue[i]();
          } catch (_) {
            // best-effort rendering
          }
        }
      };
      if (typeof global.requestAnimationFrame === 'function') {
        global.requestAnimationFrame(flush);
      } else {
        global.setTimeout(flush, 16);
      }
    }
  }

  class Accordion {
    constructor(root, { onToggle } = {}) {
      this.root = root || null;
      this.onToggle = typeof onToggle === 'function' ? onToggle : null;
      this.state = {};
      this._boundClick = this._onClick.bind(this);
      if (this.root) {
        this.root.addEventListener('click', this._boundClick);
      }
    }

    destroy() {
      if (this.root) {
        this.root.removeEventListener('click', this._boundClick);
      }
    }

    setOpen(id, isOpen) {
      if (!this.root || !id) {
        return;
      }
      const section = this.root.querySelector(`[data-acc-section="${id}"]`);
      const body = this.root.querySelector(`[data-acc-body="${id}"]`);
      const toggle = this.root.querySelector(`[data-acc-toggle="${id}"]`);
      if (!section || !body || !toggle) {
        return;
      }
      const open = Boolean(isOpen);
      section.setAttribute('data-open', open ? 'true' : 'false');
      body.hidden = !open;
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      this.state[id] = open;
      if (this.onToggle) {
        this.onToggle(id, open, { ...this.state });
      }
    }

    sync(stateMap) {
      const src = stateMap && typeof stateMap === 'object' ? stateMap : {};
      Object.keys(src).forEach((id) => {
        this.setOpen(id, src[id] === true);
      });
    }

    _onClick(event) {
      if (!event || !event.target || typeof event.target.closest !== 'function') {
        return;
      }
      const btn = event.target.closest('[data-acc-toggle]');
      if (!btn || !this.root || !this.root.contains(btn)) {
        return;
      }
      const id = btn.getAttribute('data-acc-toggle');
      if (!id) {
        return;
      }
      const section = this.root.querySelector(`[data-acc-section="${id}"]`);
      const currentlyOpen = section && section.getAttribute('data-open') === 'true';
      this.setOpen(id, !currentlyOpen);
    }
  }

  class TabsController {
    constructor(root, {
      defaultTab = null,
      onChange = null,
      hashMode = false,
      normalizeHashTab = null,
      serializeHashTab = null
    } = {}) {
      this.root = root || null;
      this.onChange = typeof onChange === 'function' ? onChange : null;
      this.hashMode = hashMode === true;
      this.normalizeHashTab = typeof normalizeHashTab === 'function' ? normalizeHashTab : null;
      this.serializeHashTab = typeof serializeHashTab === 'function' ? serializeHashTab : null;

      this.buttons = [];
      this.panels = [];
      this.activeTab = null;
      this.tabIds = [];

      this._boundClick = this._onClick.bind(this);
      this._boundKeydown = this._onKeydown.bind(this);
      this._boundHashChange = this._onHashChange.bind(this);

      this._collect();
      this._bind();

      const initial = this._resolveInitialTab(defaultTab);
      if (initial) {
        this.setActive(initial, { emit: false, fromHash: false });
      }
    }

    destroy() {
      if (!this.root) {
        return;
      }
      this.root.removeEventListener('click', this._boundClick);
      this.root.removeEventListener('keydown', this._boundKeydown);
      if (this.hashMode) {
        global.removeEventListener('hashchange', this._boundHashChange);
      }
    }

    setActive(tabId, { emit = true, fromHash = false } = {}) {
      const next = this._normalizeTab(tabId);
      if (!next) {
        return false;
      }

      this.activeTab = next;
      this.buttons.forEach((button) => {
        const isActive = button.getAttribute('data-tab') === next;
        button.setAttribute('aria-selected', isActive ? 'true' : 'false');
        button.setAttribute('tabindex', isActive ? '0' : '-1');
        button.classList.toggle('is-active', isActive);
      });

      this.panels.forEach((panel) => {
        const isActive = panel.getAttribute('data-tab-panel') === next;
        panel.hidden = !isActive;
      });

      if (this.hashMode && !fromHash) {
        this._writeHash(next);
      }

      if (emit && this.onChange) {
        this.onChange(next);
      }
      return true;
    }

    _collect() {
      if (!this.root) {
        return;
      }
      this.buttons = Array.from(this.root.querySelectorAll('[data-tab]'));
      this.panels = Array.from(this.root.querySelectorAll('[data-tab-panel]'));
      const panelMap = new Map();

      this.panels.forEach((panel) => {
        const id = panel.getAttribute('data-tab-panel');
        if (!id) {
          return;
        }
        panelMap.set(id, panel);
      });

      this.tabIds = this.buttons
        .map((button) => button.getAttribute('data-tab'))
        .filter((value) => typeof value === 'string' && value);

      this.buttons.forEach((button, index) => {
        const tabId = button.getAttribute('data-tab');
        if (!tabId) {
          return;
        }
        const panel = panelMap.get(tabId);
        const panelId = panel && panel.id ? panel.id : `nt-tab-panel-${tabId}`;
        if (panel && !panel.id) {
          panel.id = panelId;
        }
        button.setAttribute('role', 'tab');
        button.setAttribute('aria-controls', panelId);
        button.setAttribute('aria-selected', 'false');
        button.setAttribute('tabindex', index === 0 ? '0' : '-1');
      });

      this.panels.forEach((panel) => {
        panel.setAttribute('role', 'tabpanel');
      });
    }

    _bind() {
      if (!this.root) {
        return;
      }
      this.root.addEventListener('click', this._boundClick);
      this.root.addEventListener('keydown', this._boundKeydown);
      if (this.hashMode) {
        global.addEventListener('hashchange', this._boundHashChange);
      }
    }

    _resolveInitialTab(defaultTab) {
      if (this.hashMode) {
        const fromHash = this._tabFromHash(global.location && global.location.hash ? global.location.hash : '');
        if (fromHash) {
          return fromHash;
        }
      }
      const normalizedDefault = this._normalizeTab(defaultTab);
      if (normalizedDefault) {
        return normalizedDefault;
      }
      return this.tabIds.length ? this.tabIds[0] : null;
    }

    _normalizeTab(value) {
      const key = String(value || '').trim();
      return this.tabIds.includes(key) ? key : null;
    }

    _tabFromHash(hash) {
      let key = String(hash || '').replace(/^#/, '').trim();
      if (!key) {
        return null;
      }
      key = decodeURIComponent(key).toLowerCase();
      if (this.normalizeHashTab) {
        key = this.normalizeHashTab(key);
      }
      return this._normalizeTab(key);
    }

    _writeHash(tabId) {
      const raw = this.serializeHashTab ? this.serializeHashTab(tabId) : tabId;
      const key = String(raw || '').trim();
      if (!key) {
        return;
      }
      const nextHash = `#${encodeURIComponent(key)}`;
      if (global.location && global.location.hash === nextHash) {
        return;
      }
      if (global.history && typeof global.history.replaceState === 'function') {
        global.history.replaceState(null, '', nextHash);
      } else if (global.location) {
        global.location.hash = nextHash;
      }
    }

    _onClick(event) {
      if (!event || !event.target || typeof event.target.closest !== 'function') {
        return;
      }
      const button = event.target.closest('[data-tab]');
      if (!button || !this.root.contains(button)) {
        return;
      }
      const tabId = button.getAttribute('data-tab');
      if (!tabId) {
        return;
      }
      this.setActive(tabId, { emit: true, fromHash: false });
    }

    _onKeydown(event) {
      const key = event && event.key ? event.key : '';
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key)) {
        return;
      }
      const target = event && event.target && typeof event.target.closest === 'function'
        ? event.target.closest('[data-tab]')
        : null;
      if (!target || !this.root.contains(target)) {
        return;
      }
      const currentId = target.getAttribute('data-tab');
      const currentIndex = this.tabIds.indexOf(currentId);
      if (currentIndex < 0) {
        return;
      }
      event.preventDefault();

      let nextIndex = currentIndex;
      if (key === 'ArrowLeft') {
        nextIndex = (currentIndex - 1 + this.tabIds.length) % this.tabIds.length;
      } else if (key === 'ArrowRight') {
        nextIndex = (currentIndex + 1) % this.tabIds.length;
      } else if (key === 'Home') {
        nextIndex = 0;
      } else if (key === 'End') {
        nextIndex = this.tabIds.length - 1;
      }

      const nextId = this.tabIds[nextIndex];
      this.setActive(nextId, { emit: true, fromHash: false });
      const nextButton = this.buttons.find((button) => button.getAttribute('data-tab') === nextId);
      if (nextButton && typeof nextButton.focus === 'function') {
        nextButton.focus();
      }
    }

    _onHashChange() {
      const next = this._tabFromHash(global.location && global.location.hash ? global.location.hash : '');
      if (!next || next === this.activeTab) {
        return;
      }
      this.setActive(next, { emit: true, fromHash: true });
    }
  }

  class Toasts {
    constructor(host) {
      this.host = host || null;
    }

    show(message, { tone = 'info', timeoutMs = 2600 } = {}) {
      if (!this.host || !message) {
        return;
      }
      const item = createElement('div', {
        className: `nt-toast nt-toast--${tone}`,
        text: String(message)
      });
      this.host.appendChild(item);
      const ttl = Math.max(900, Number(timeoutMs) || 2600);
      global.setTimeout(() => {
        try {
          item.remove();
        } catch (_) {
          // ignore
        }
      }, ttl);
    }
  }

  function debounce(fn, waitMs = 220) {
    let timer = null;
    return function debounced(...args) {
      if (timer) {
        global.clearTimeout(timer);
      }
      timer = global.setTimeout(() => {
        timer = null;
        fn.apply(this, args);
      }, Math.max(40, Number(waitMs) || 220));
    };
  }

  NT.Ui = {
    createElement,
    clearNode,
    setText,
    setHidden,
    escapeHtml,
    createBadge,
    applyTooltip,
    createIconButton,
    RenderScheduler,
    Accordion,
    TabsController,
    Toasts,
    debounce
  };
})(globalThis);
