const SECRET_KEYS = ["apikey", "api_key", "token", "authorization", "proxytoken"];

export function redactSecrets(input) {
  return redactRecursively(input);
}

function redactRecursively(value) {
  if (Array.isArray(value)) {
    return value.map(redactRecursively);
  }
  if (value && typeof value === "object") {
    const next = {};
    for (const [key, nestedValue] of Object.entries(value)) {
      if (isSecretKey(key)) {
        next[key] = "***REDACTED***";
      } else {
        next[key] = redactRecursively(nestedValue);
      }
    }
    return next;
  }
  return value;
}

function isSecretKey(key) {
  const normalized = String(key).replace(/[^a-zA-Z]/g, "").toLowerCase();
  return SECRET_KEYS.some((secretKey) => normalized.includes(secretKey));
}