import { sleep } from "./utils.js";

export class RateLimitError extends Error {
  constructor(message, { retryAfterMs = 0, status = 429 } = {}) {
    super(message);
    this.name = "RateLimitError";
    this.retryAfterMs = retryAfterMs;
    this.status = status;
  }
}

export class BudgetThroughputController {
  constructor({ modelLimits = {}, roleModelLimits = {}, safetyBufferTokens = 500, logger = null } = {}) {
    this.modelLimits = modelLimits;
    this.roleModelLimits = roleModelLimits;
    this.safetyBufferTokens = safetyBufferTokens;
    this.logger = logger;
    this.state = new Map();
  }

  resolveLimits(model, role) {
    const byRole = this.roleModelLimits?.[role];
    if (byRole && byRole[model]) {
      return byRole[model];
    }
    return this.modelLimits[model] || { tpm: 60_000, rpm: 300, concurrency: 2 };
  }

  buildStateKey(model, role) {
    return `${role}:${model}`;
  }

  ensureModelState(model, role = "translation") {
    const stateKey = this.buildStateKey(model, role);
    if (!this.state.has(stateKey)) {
      const limits = this.resolveLimits(model, role);
      this.state.set(stateKey, {
        stateKey,
        role,
        model,
        limits,
        dynamicConcurrency: limits.concurrency,
        active: 0,
        tokenWindow: [],
        requestWindow: [],
        lastRateLimitAt: 0,
        consecutiveSuccesses: 0
      });
    }
    return this.state.get(stateKey);
  }

  prune(modelState, nowMs) {
    const oneMinuteAgo = nowMs - 60_000;
    modelState.tokenWindow = modelState.tokenWindow.filter((item) => item.ts >= oneMinuteAgo);
    modelState.requestWindow = modelState.requestWindow.filter((ts) => ts >= oneMinuteAgo);
  }

  estimateWaitMs(modelState, nowMs, tokensEstimate) {
    const { tpm, rpm } = modelState.limits;
    const concurrency = Math.max(1, Number(modelState.dynamicConcurrency) || 1);

    if (modelState.active >= concurrency) {
      return 100;
    }

    const usedTokens = modelState.tokenWindow.reduce((sum, item) => sum + item.tokens, 0);
    if (usedTokens + tokensEstimate + this.safetyBufferTokens > tpm) {
      const earliest = modelState.tokenWindow[0]?.ts;
      if (earliest) {
        return Math.max(100, earliest + 60_000 - nowMs);
      }
    }

    if (modelState.requestWindow.length >= rpm) {
      const earliestReq = modelState.requestWindow[0];
      return Math.max(100, earliestReq + 60_000 - nowMs);
    }

    return 0;
  }

  async acquire(model, tokensEstimate, { signal, role = "translation" } = {}) {
    const modelState = this.ensureModelState(model, role);

    while (true) {
      if (signal?.aborted) {
        throw new DOMException("Request aborted", "AbortError");
      }
      const nowMs = Date.now();
      this.prune(modelState, nowMs);
      const waitMs = this.estimateWaitMs(modelState, nowMs, tokensEstimate);
      if (waitMs <= 0) {
        modelState.active += 1;
        modelState.requestWindow.push(nowMs);
        modelState.tokenWindow.push({ ts: nowMs, tokens: tokensEstimate });
        return;
      }
      this.logger?.({
        name: "rate_limit_wait",
        model,
        role,
        waitMs,
        tokensEstimate
      });
      await sleep(Math.min(waitMs, 1500));
    }
  }

  release(model, { role = "translation" } = {}) {
    const modelState = this.ensureModelState(model, role);
    modelState.active = Math.max(0, modelState.active - 1);
  }

  noteRateLimit(model, { role = "translation" } = {}) {
    const modelState = this.ensureModelState(model, role);
    modelState.lastRateLimitAt = Date.now();
    modelState.consecutiveSuccesses = 0;
    modelState.dynamicConcurrency = Math.max(1, (modelState.dynamicConcurrency || modelState.limits.concurrency) - 1);
    this.logger?.({
      name: "rate_limit_concurrency_down",
      model,
      role,
      dynamicConcurrency: modelState.dynamicConcurrency
    });
  }

  noteSuccess(model, { role = "translation" } = {}) {
    const modelState = this.ensureModelState(model, role);
    modelState.consecutiveSuccesses += 1;
    const target = Math.max(1, modelState.limits.concurrency);
    const now = Date.now();
    const coolDownPassed = now - (modelState.lastRateLimitAt || 0) > 30_000;
    if (coolDownPassed && modelState.dynamicConcurrency < target && modelState.consecutiveSuccesses >= 4) {
      modelState.dynamicConcurrency += 1;
      modelState.consecutiveSuccesses = 0;
      this.logger?.({
        name: "rate_limit_concurrency_up",
        model,
        role,
        dynamicConcurrency: modelState.dynamicConcurrency
      });
    }
  }

  getSnapshot(model, { role = "translation" } = {}) {
    const modelState = this.ensureModelState(model, role);
    return {
      limits: { ...modelState.limits },
      role: modelState.role,
      model: modelState.model,
      dynamicConcurrency: modelState.dynamicConcurrency,
      active: modelState.active,
      lastRateLimitAt: modelState.lastRateLimitAt,
      consecutiveSuccesses: modelState.consecutiveSuccesses
    };
  }

  async runWithBudget({ model, role = "translation", tokensEstimate, fn, signal, onRateLimit }) {
    await this.acquire(model, tokensEstimate, { signal, role });
    try {
      const result = await fn();
      this.noteSuccess(model, { role });
      return result;
    } catch (error) {
      if (error instanceof RateLimitError) {
        this.noteRateLimit(model, { role });
        if (typeof onRateLimit === "function") {
          onRateLimit(error);
        }
      }
      throw error;
    } finally {
      this.release(model, { role });
    }
  }

  async retryWithBackoff(task, {
    maxAttempts = 5,
    minDelayMs = 500,
    maxDelayMs = 30_000,
    jitterMs = 350,
    signal,
    onAttempt,
    shouldRetry
  } = {}) {
    let attempt = 0;
    let delayMs = minDelayMs;

    while (attempt < maxAttempts) {
      if (signal?.aborted) {
        throw new DOMException("Request aborted", "AbortError");
      }
      attempt += 1;
      try {
        return await task(attempt);
      } catch (error) {
        const retry = shouldRetry ? shouldRetry(error) : error instanceof RateLimitError;
        if (!retry || attempt >= maxAttempts) {
          throw error;
        }
        const retryAfterMs = error?.retryAfterMs || 0;
        const randomJitter = Math.floor(Math.random() * jitterMs);
        const sleepMs = Math.min(maxDelayMs, Math.max(delayMs, retryAfterMs) + randomJitter);
        onAttempt?.({ attempt, sleepMs, error });
        await sleep(sleepMs);
        delayMs = Math.min(maxDelayMs, delayMs * 2);
      }
    }

    throw new Error("Retry budget exhausted");
  }
}
