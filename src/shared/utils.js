export function deepClone(value) {
  return structuredClone(value);
}

export function nowIso() {
  return new Date().toISOString();
}

export function estimateTokens(text) {
  if (!text) {
    return 0;
  }
  return Math.max(1, Math.ceil(text.length / 4));
}

export function stableHash(input) {
  const text = typeof input === "string" ? input : JSON.stringify(input);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash +=
      (hash << 1) +
      (hash << 4) +
      (hash << 7) +
      (hash << 8) +
      (hash << 24);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function buildPageSessionId({ tabId, url, nonce }) {
  const safeUrl = String(url || "unknown").slice(0, 1200);
  const ts = Date.now();
  return `ps_${tabId}_${stableHash(`${safeUrl}_${nonce || ts}_${ts}`)}`;
}

export function buildBatchId(pageSessionId, index, blockIds) {
  return `b_${stableHash(`${pageSessionId}_${index}_${blockIds.join("|")}`)}`;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function parseRetryAfterSeconds(headers) {
  if (!headers || typeof headers.get !== "function") {
    return null;
  }
  const raw = headers.get("retry-after");
  if (!raw) {
    return null;
  }
  const seconds = Number.parseInt(raw, 10);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds);
  }
  const parsedDate = Date.parse(raw);
  if (Number.isFinite(parsedDate)) {
    const delayMs = parsedDate - Date.now();
    return Math.max(0, Math.ceil(delayMs / 1000));
  }
  return null;
}

export function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

export function asErrorObject(error) {
  if (!error) {
    return null;
  }
  if (typeof error === "string") {
    return { message: error };
  }
  return {
    name: error.name,
    message: error.message,
    stack: error.stack
  };
}

export function getValueByPath(obj, path) {
  return path.split(".").reduce((acc, part) => {
    if (acc === null || acc === undefined) {
      return undefined;
    }
    return acc[part];
  }, obj);
}

export function setValueByPath(obj, path, value) {
  const parts = path.split(".");
  const last = parts.pop();
  if (!last) {
    return obj;
  }
  let cursor = obj;
  for (const part of parts) {
    if (typeof cursor[part] !== "object" || cursor[part] === null) {
      cursor[part] = {};
    }
    cursor = cursor[part];
  }
  cursor[last] = value;
  return obj;
}

export function toSortedJson(value) {
  return JSON.stringify(sortObject(value), null, 2);
}

function sortObject(value) {
  if (Array.isArray(value)) {
    return value.map(sortObject);
  }
  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = sortObject(value[key]);
        return acc;
      }, {});
  }
  return value;
}

export function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}