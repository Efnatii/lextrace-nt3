(function initUiIcons(global) {
  const NT = global.NT || (global.NT = {});

  function svg(paths) {
    return [
      '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">',
      paths,
      '</svg>'
    ].join('');
  }

  const iconMap = {
    play: svg('<path d="M8 6v12l10-6z"/>'),
    stop: svg('<rect x="7" y="7" width="10" height="10" rx="1.5"/>'),
    trash: svg('<path d="M5 7h14"/><path d="M9 7V5h6v2"/><path d="M8 10v8"/><path d="M12 10v8"/><path d="M16 10v8"/><path d="M6 7l1 13h10l1-13"/>'),
    bug: svg('<path d="M9 9V7a3 3 0 1 1 6 0v2"/><rect x="7" y="9" width="10" height="10" rx="4"/><path d="M4 13h3"/><path d="M17 13h3"/><path d="M5 9l2 2"/><path d="M19 9l-2 2"/><path d="M5 19l2-2"/><path d="M19 19l-2-2"/>'),
    gear: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1 1 0 0 0 .2 1.1l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1 1 0 0 0-1.1-.2 1 1 0 0 0-.6.9V20a2 2 0 1 1-4 0v-.2a1 1 0 0 0-.6-.9 1 1 0 0 0-1.1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1 1 0 0 0 .2-1.1 1 1 0 0 0-.9-.6H4a2 2 0 1 1 0-4h.2a1 1 0 0 0 .9-.6 1 1 0 0 0-.2-1.1l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1 1 0 0 0 1.1.2H9a1 1 0 0 0 .6-.9V4a2 2 0 1 1 4 0v.2a1 1 0 0 0 .6.9 1 1 0 0 0 1.1-.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1 1 0 0 0-.2 1.1V9c0 .4.2.8.6.9H20a2 2 0 1 1 0 4h-.2a1 1 0 0 0-.4.1z"/>'),
    key: svg('<circle cx="8.5" cy="12" r="3.5"/><path d="M12 12h8"/><path d="M17 12v3"/><path d="M20 12v2"/>'),
    eye: svg('<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z"/><circle cx="12" cy="12" r="3"/>'),
    eyeOff: svg('<path d="M3 3l18 18"/><path d="M10.6 6.2A10.8 10.8 0 0 1 12 6c6.5 0 10 6 10 6a17.4 17.4 0 0 1-3 3.8"/><path d="M6.2 6.2A17.5 17.5 0 0 0 2 12s3.5 6 10 6c1.8 0 3.3-.4 4.7-1.1"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>'),
    save: svg('<path d="M5 4h11l3 3v13H5z"/><path d="M8 4v6h8"/><path d="M8 20v-6h8v6"/>'),
    refresh: svg('<path d="M20 11a8 8 0 1 0 2 5.3"/><path d="M20 4v7h-7"/>'),
    copy: svg('<rect x="9" y="9" width="10" height="11" rx="2"/><rect x="5" y="4" width="10" height="11" rx="2"/>'),
    export: svg('<path d="M12 3v12"/><path d="M8 7l4-4 4 4"/><rect x="4" y="14" width="16" height="7" rx="2"/>'),
    wand: svg('<path d="M4 20l7-7"/><path d="M14 6l4-4"/><path d="M13 3l1 2"/><path d="M17 7l2 1"/><path d="M6 14l6-6 4 4-6 6z"/>')
  };

  function get(name) {
    const key = String(name || '').trim();
    return key && Object.prototype.hasOwnProperty.call(iconMap, key)
      ? iconMap[key]
      : '';
  }

  function createNode(name) {
    const doc = global.document;
    if (!doc || typeof doc.createElement !== 'function') {
      return null;
    }
    const host = doc.createElement('span');
    host.className = 'nt-icon';
    host.setAttribute('aria-hidden', 'true');
    host.innerHTML = get(name);
    return host;
  }

  NT.UiIcons = {
    ...iconMap,
    get,
    createNode
  };
})(globalThis);
