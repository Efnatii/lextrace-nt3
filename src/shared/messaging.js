export function sendRuntimeMessage(payload) {
  return chrome.runtime.sendMessage(payload);
}

export function sendTabMessage(tabId, payload) {
  return chrome.tabs.sendMessage(tabId, payload);
}

export function addRuntimeListener(handler) {
  const listener = (message, sender, sendResponse) => {
    Promise.resolve(handler(message, sender)).then(
      (result) => sendResponse({ ok: true, result }),
      (error) => sendResponse({ ok: false, error: error?.message || String(error) })
    );
    return true;
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}