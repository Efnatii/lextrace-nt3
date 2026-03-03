export async function callRuntime(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response?.ok) {
    throw new Error(response?.error || `Runtime message failed: ${type}`);
  }
  return response.result;
}

export function safeRuntimeCall(type, payload = {}) {
  return callRuntime(type, payload).catch((error) => ({
    __runtimeError: true,
    message: error?.message || String(error)
  }));
}

export function connectPort(name) {
  return chrome.runtime.connect({ name });
}
