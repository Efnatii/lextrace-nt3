import {
  ALARM_RESUME_PIPELINE,
  EVENT_CATEGORY,
  LOG_LEVEL,
  MESSAGE,
  PIPELINE_STAGE,
  VIEW_MODE
} from "../shared/constants.js";
import { createBatches } from "../shared/batching.js";
import { BatchWindowManager } from "../shared/batch-window.js";
import { CancellationRegistry } from "../shared/cancellation-registry.js";
import { InflightRequestStore } from "../shared/inflight-request-store.js";
import { JobQueue } from "../shared/job-queue.js";
import { BudgetThroughputController, RateLimitError } from "../shared/rate-limit-controller.js";
import { validateStructuredTranslation } from "../shared/translation-schema.js";
import { asErrorObject, buildPageSessionId, estimateTokens, nowIso, stableHash, parseRetryAfterSeconds } from "../shared/utils.js";

export class PipelineOrchestrator {
  constructor({ settingsStore, tabStateStore, eventLogStore, offscreenClient, onStateChanged }) {
    this.settingsStore = settingsStore;
    this.tabStateStore = tabStateStore;
    this.eventLogStore = eventLogStore;
    this.offscreenClient = offscreenClient;
    this.onStateChanged = onStateChanged;

    this.running = new Map();
    this.queues = new Map();
    this.cancellation = new CancellationRegistry();
    this.inflightRequests = new InflightRequestStore();
    this.controllerBySession = new Map();
    this.uiErrorsByTab = new Map();
  }

  async init() {
    await this.settingsStore.init();
    await this.tabStateStore.init();
    await this.inflightRequests.init();
    await this.runGc();
    await chrome.alarms.create(ALARM_RESUME_PIPELINE, { periodInMinutes: 1 });
  }

  async runGc() {
    const settings = await this.settingsStore.getSettings();
    this.eventLogStore.maxRecords = settings.storagePolicy.maxRecords;
    this.eventLogStore.maxAgeMs = settings.storagePolicy.maxAgeMs;
    this.eventLogStore.maxBytes = settings.storagePolicy.maxBytes;
    const result = await this.eventLogStore.gc();
    if (result.removed > 0) {
      await this.log({
        level: LOG_LEVEL.INFO,
        category: EVENT_CATEGORY.STORAGE_GC,
        name: "event_log_gc",
        data: result
      });
    }
  }

  async startForTab({ tabId, url }) {
    try {
      const resolvedUrl = await this.validateStartRequest(tabId, url);
      url = resolvedUrl;
      this.uiErrorsByTab.delete(String(tabId));
    } catch (error) {
      this.uiErrorsByTab.set(String(tabId), error?.message || "Cannot start translation");
      await this.log({
        level: LOG_LEVEL.ERROR,
        category: EVENT_CATEGORY.ERROR,
        name: "start_rejected",
        tabId,
        error: asErrorObject(error)
      });
      return this.getUiState(tabId);
    }

    const existingSession = await this.tabStateStore.getActiveSessionByTab(tabId);
    if (existingSession && this.running.has(existingSession)) {
      return this.getUiState(tabId);
    }

    const settings = await this.settingsStore.getSettings();
    if (!settings?.mockMode?.enabled && !this.hasAccessCredentials(settings)) {
      this.uiErrorsByTab.set(String(tabId), "Set BYOK API key or PROXY token in Settings");
      await this.log({
        level: LOG_LEVEL.WARN,
        category: EVENT_CATEGORY.UI_ACTION,
        name: "start_blocked_missing_credentials",
        tabId,
        data: {
          accessMode: settings.accessMode
        }
      });
      return this.getUiState(tabId);
    }

    const pageSessionId = buildPageSessionId({ tabId, url, nonce: crypto.randomUUID() });
    const signal = this.cancellation.createSession(pageSessionId);

    const controller = new BudgetThroughputController({
      modelLimits: settings.rateLimits.perModel,
      safetyBufferTokens: settings.rateLimits.safetyBufferTokens,
      logger: (data) => {
        this.log({
          level: LOG_LEVEL.INFO,
          category: EVENT_CATEGORY.OPENAI_RATE_LIMIT,
          name: "throughput_wait",
          pageSessionId,
          tabId,
          data
        });
      }
    });
    this.controllerBySession.set(pageSessionId, controller);

    const queueConcurrency = Math.max(1, settings.rateLimits.perModel[settings.modelPriority.translation[0]]?.concurrency || 1);
    const queue = new JobQueue({ concurrency: queueConcurrency });
    this.queues.set(pageSessionId, queue);

    await this.tabStateStore.setActiveSession(tabId, pageSessionId);
    await this.tabStateStore.upsertState(pageSessionId, {
      tabId,
      url,
      stage: PIPELINE_STAGE.SCANNING,
      startedAt: Date.now(),
      cancelled: false,
      hasTranslatedBlocks: false,
      viewMode: VIEW_MODE.TRANSLATION,
      progress: {
        done: 0,
        pending: 0,
        failed: 0,
        total: 0,
        errorCount: 0
      }
    });

    try {
      await this.sendTabMessageStrict(tabId, {
        type: MESSAGE.CONTENT_SWITCH_VIEW,
        mode: VIEW_MODE.TRANSLATION
      });
    } catch {
      // Ignore switch errors before content script handshake.
    }

    await this.log({
      category: EVENT_CATEGORY.UI_ACTION,
      name: "start_translation",
      pageSessionId,
      tabId,
      data: { url }
    });
    await this.notifyState(tabId);

    const runPromise = this.executePipeline({ pageSessionId, tabId, url, signal, settings })
      .catch((error) => {
        if (error?.name === "AbortError") {
          return;
        }
        return this.failSession({ pageSessionId, tabId, error });
      })
      .finally(async () => {
        this.running.delete(pageSessionId);
        this.queues.delete(pageSessionId);
        this.controllerBySession.delete(pageSessionId);
        this.cancellation.clearSession(pageSessionId);
        this.inflightRequests.clearSession(pageSessionId);
        await this.notifyState(tabId);
      });

    this.running.set(pageSessionId, runPromise);
    return this.getUiState(tabId);
  }

  async validateStartRequest(tabId, urlHint) {
    if (!Number.isInteger(tabId) || tabId <= 0) {
      throw new Error("No active tab selected");
    }
    const tab = await chrome.tabs.get(tabId);
    const url = String(tab?.url || urlHint || "").trim();
    if (!/^https?:/i.test(url)) {
      throw new Error("Translation can run only on http/https pages");
    }
    await this.ensureContentScriptReady(tabId);
    return url;
  }

  async ensureContentScriptReady(tabId) {
    const pingPayload = { type: MESSAGE.UI_PING };
    try {
      await this.sendTabMessageStrict(tabId, pingPayload);
      return;
    } catch {
      // Try runtime injection fallback.
    }

    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ["content/content.css"]
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content/content.js"]
    });

    await this.sendTabMessageStrict(tabId, pingPayload);
  }

  async executePipeline({ pageSessionId, tabId, signal, settings }) {
    await this.updateStage(pageSessionId, tabId, PIPELINE_STAGE.SCANNING);

    const scanResult = await this.sendTabMessageStrict(tabId, {
      type: MESSAGE.CONTENT_SCAN,
      pageSessionId,
      tabId
    });
    await this.throwIfCancelled(signal);
    const blocks = scanResult.blocks || [];

    await this.log({
      category: EVENT_CATEGORY.DOM_SCAN,
      name: "scan_complete",
      pageSessionId,
      tabId,
      data: { blocks: blocks.length }
    });

    await this.tabStateStore.upsertState(pageSessionId, {
      progress: {
        total: blocks.length,
        pending: blocks.length,
        done: 0,
        failed: 0,
        errorCount: 0
      }
    });
    await this.notifyState(tabId);

    if (blocks.length === 0) {
      await this.updateStage(pageSessionId, tabId, PIPELINE_STAGE.DONE);
      await this.log({
        level: LOG_LEVEL.WARN,
        category: EVENT_CATEGORY.PIPELINE_STAGE,
        name: "pipeline_no_blocks",
        pageSessionId,
        tabId,
        data: { blocks: 0 }
      });
      await this.notifyState(tabId);
      return;
    }

    await this.throwIfCancelled(signal);

    await this.updateStage(pageSessionId, tabId, PIPELINE_STAGE.CONTEXT);
    const globalContext = await this.generateGlobalContext({
      pageSessionId,
      tabId,
      settings,
      blocks,
      signal
    });

    await this.throwIfCancelled(signal);

    await this.updateStage(pageSessionId, tabId, PIPELINE_STAGE.BATCHING);
    const batches = createBatches({
      blocks,
      pageSessionId,
      settings
    });
    await this.throwIfCancelled(signal);

    await this.tabStateStore.upsertState(pageSessionId, {
      stage: PIPELINE_STAGE.BATCHING,
      batches: batches.map((batch) => ({
        batchId: batch.batchId,
        index: batch.index,
        status: "pending",
        size: batch.blocks.length,
        tokensEstimate: batch.tokensEstimate
      })),
      progress: {
        total: batches.length,
        pending: batches.length,
        done: 0,
        failed: 0
      }
    });

    await this.log({
      category: EVENT_CATEGORY.BATCH_CREATE,
      name: "batches_created",
      pageSessionId,
      tabId,
      data: {
        batchCount: batches.length,
        avgBlocksPerBatch:
          batches.length > 0
            ? Number((batches.reduce((acc, batch) => acc + batch.blocks.length, 0) / batches.length).toFixed(2))
            : 0
      }
    });
    await this.notifyState(tabId);

    await this.updateStage(pageSessionId, tabId, PIPELINE_STAGE.TRANSLATING);

    const translatedBatches = [];
    const windowManager = new BatchWindowManager(settings);
    const batchJobs = [];
    const queue = this.queues.get(pageSessionId);
    if (!queue) {
      throw new Error("Pipeline queue is not available");
    }

    for (const batch of batches) {
      await this.throwIfCancelled(signal);
      batchJobs.push(queue.push(async () => {
        const result = await this.translateSingleBatch({
          pageSessionId,
          tabId,
          settings,
          globalContext,
          batch,
          translatedBatches,
          windowManager,
          signal
        });
        translatedBatches.push(result);
      }));
    }

    await Promise.all(batchJobs);
    await this.waitQueueIdle(pageSessionId);
    await this.throwIfCancelled(signal);

    await this.updateStage(pageSessionId, tabId, PIPELINE_STAGE.DONE);
    await this.tabStateStore.upsertState(pageSessionId, {
      hasTranslatedBlocks: translatedBatches.length > 0,
      progress: {
        done: translatedBatches.length,
        pending: 0
      }
    });
    await this.log({
      category: EVENT_CATEGORY.PIPELINE_STAGE,
      name: "pipeline_done",
      pageSessionId,
      tabId,
      data: { batches: translatedBatches.length }
    });
    await this.notifyState(tabId);
  }

  async translateSingleBatch({
    pageSessionId,
    tabId,
    settings,
    globalContext,
    batch,
    translatedBatches,
    windowManager,
    signal
  }) {
    const controller = this.controllerBySession.get(pageSessionId);
    if (!controller) {
      throw new Error("Throughput controller is not available");
    }
    const model = settings.modelPriority.translation[0] || settings.globalContext.model;

    const previousWindow = windowManager.buildWindow(translatedBatches, batch.index);
    windowManager.pushCompactionIfNeeded(translatedBatches, batch.index);

    const payload = {
      role: "translation",
      model,
      promptCaching: settings.promptCaching,
      mockMode: settings.mockMode,
      pageSessionId,
      batchId: batch.batchId,
      input: {
        globalContext,
        previousWindow,
        compactedHistory: windowManager.getCompactionContext(),
        blocks: batch.blocks.map((item) => ({
          blockId: item.blockId,
          text: item.text,
          category: item.category
        }))
      },
      schema: "translation"
    };

    const serializedInput = JSON.stringify(payload.input);
    const tokensEstimate = estimateTokens(serializedInput) + 800;
    const requestId = `req_${stableHash(`${pageSessionId}_${batch.batchId}_${Date.now()}`)}`;

    this.cancellation.registerRequest(pageSessionId, requestId);
    this.inflightRequests.add({ requestId, pageSessionId, tabId, batchId: batch.batchId, model, kind: "translation" });

    await this.log({
      category: EVENT_CATEGORY.OPENAI_REQUEST,
      name: "translation_request_sent",
      pageSessionId,
      tabId,
      batchId: batch.batchId,
      data: {
        requestId,
        model,
        tokensEstimate,
        promptCachingEnabled: settings.promptCaching.enabled
      }
    });

    let raw;
    try {
      raw = await controller.retryWithBackoff(
        async (attempt) => {
          await this.throwIfCancelled(signal);
          const response = await controller.runWithBudget({
            model,
            tokensEstimate,
            signal,
            onRateLimit: (error) => {
              this.syncQueueConcurrency(pageSessionId, model);
              this.log({
                level: LOG_LEVEL.WARN,
                category: EVENT_CATEGORY.OPENAI_RATE_LIMIT,
                name: "rate_limit_hit",
                pageSessionId,
                tabId,
                batchId: batch.batchId,
                data: {
                  requestId,
                  retryAfterMs: error.retryAfterMs,
                  status: error.status,
                  attempt
                }
              });
            },
            fn: () =>
              this.offscreenClient
                .execute({
                  requestId,
                  pageSessionId,
                  tabId,
                  operation: "openai.responses",
                  payload,
                  access: this.buildAccess(settings)
                })
                .catch((error) => {
                  if (Number(error?.status) === 429) {
                    throw new RateLimitError(error.message, {
                      retryAfterMs: error?.retryAfterMs || 1000,
                      status: 429
                    });
                  }
                  throw error;
                })
          });
          this.syncQueueConcurrency(pageSessionId, model);
          return response;
        },
        {
          signal,
          maxAttempts: 6,
          onAttempt: ({ attempt, sleepMs, error }) => {
            this.log({
              level: LOG_LEVEL.WARN,
              category: EVENT_CATEGORY.OPENAI_RATE_LIMIT,
              name: "retry_backoff",
              pageSessionId,
              tabId,
              batchId: batch.batchId,
              data: {
                attempt,
                sleepMs,
                reason: error?.message || "unknown"
              }
            });
          },
          shouldRetry: (error) => {
            if (error?.name === "AbortError") {
              return false;
            }
            if (error instanceof RateLimitError) {
              return true;
            }
            const status = Number(error?.status || 0);
            return status === 429 || (status >= 500 && status < 600);
          }
        }
      );
    } finally {
      this.cancellation.unregisterRequest(pageSessionId, requestId);
      this.inflightRequests.remove(requestId);
    }

    const translation = validateStructuredTranslation(raw.structured);
    await this.throwIfCancelled(signal);
    if (translation.batchId !== batch.batchId) {
      throw new Error(`Batch mismatch: expected ${batch.batchId}, got ${translation.batchId}`);
    }

    const applyPayload = {
      batchId: batch.batchId,
      translations: translation.translations
    };

    await this.sendTabMessageStrict(tabId, {
      type: MESSAGE.CONTENT_APPLY_BATCH,
      pageSessionId,
      tabId,
      payload: applyPayload
    });
    await this.throwIfCancelled(signal);

    const currentState = await this.tabStateStore.getState(pageSessionId);
    const done = (currentState?.progress?.done || 0) + 1;
    const failed = currentState?.progress?.failed || 0;
    const total = currentState?.progress?.total || 0;
    const pending = Math.max(0, total - done - failed);

    await this.tabStateStore.upsertState(pageSessionId, {
      hasTranslatedBlocks: true,
      progress: {
        done,
        pending,
        failed,
        total
      }
    });

    await this.log({
      category: EVENT_CATEGORY.OPENAI_RESPONSE,
      name: "translation_response_ok",
      pageSessionId,
      tabId,
      batchId: batch.batchId,
      data: {
        requestId,
        translationRows: translation.translations.length,
        usage: raw?.usage || null
      }
    });

    await this.log({
      category: EVENT_CATEGORY.BATCH_TRANSLATE,
      name: "batch_translated",
      pageSessionId,
      tabId,
      batchId: batch.batchId,
      data: {
        progressDone: done,
        progressTotal: total
      }
    });

    await this.notifyState(tabId);

    return {
      index: batch.index,
      batchId: batch.batchId,
      joinedText: translation.translations.map((row) => row.translatedText).join("\n")
    };
  }

  async generateGlobalContext({ pageSessionId, tabId, settings, blocks, signal }) {
    const model = settings.modelPriority.context[0] || settings.globalContext.model;
    const blockText = blocks.map((block) => `[${block.blockId}] (${block.category}) ${block.text}`).join("\n");
    const targetTokens = Math.max(15000, Number(settings.globalContext.targetTokens) || 15000);

    const payload = {
      role: "context",
      model,
      promptCaching: settings.promptCaching,
      mockMode: settings.mockMode,
      pageSessionId,
      input: {
        targetTokens,
        instruction:
          "Build a detailed global translation context for this page. Preserve entities, style, product names, legal terminology, and consistency constraints.",
        orderedBlocks: blockText
      },
      schema: "context"
    };

    const requestId = `req_${stableHash(`${pageSessionId}_context_${Date.now()}`)}`;
    this.cancellation.registerRequest(pageSessionId, requestId);
    this.inflightRequests.add({ requestId, pageSessionId, tabId, model, kind: "context" });

    await this.log({
      category: EVENT_CATEGORY.OPENAI_REQUEST,
      name: "context_request_sent",
      pageSessionId,
      tabId,
      data: {
        requestId,
        model,
        targetTokens,
        blocks: blocks.length
      }
    });

    const controller = this.controllerBySession.get(pageSessionId);
    let response;
    try {
      response = await controller.retryWithBackoff(
        async (attempt) =>
          controller
            .runWithBudget({
              model,
              tokensEstimate: estimateTokens(blockText) + targetTokens,
              signal,
              onRateLimit: (error) => {
                this.log({
                  level: LOG_LEVEL.WARN,
                  category: EVENT_CATEGORY.OPENAI_RATE_LIMIT,
                  name: "context_rate_limit_hit",
                  pageSessionId,
                  tabId,
                  data: {
                    requestId,
                    retryAfterMs: error.retryAfterMs,
                    status: error.status,
                    attempt
                  }
                });
              },
              fn: () =>
                this.offscreenClient
                  .execute({
                    requestId,
                    pageSessionId,
                    tabId,
                    operation: "openai.responses",
                    payload,
                    access: this.buildAccess(settings)
                  })
                  .catch((error) => {
                    if (Number(error?.status) === 429) {
                      throw new RateLimitError(error.message, {
                        retryAfterMs: error?.retryAfterMs || 1000,
                        status: 429
                      });
                    }
                    throw error;
                  })
            })
            .catch((error) => {
              if (error instanceof RateLimitError) {
                throw error;
              }
              const retryAfterMs = parseRetryAfterSeconds(error?.headers);
              if (Number(error?.status) === 429) {
                throw new RateLimitError(error.message, {
                  retryAfterMs: retryAfterMs ? retryAfterMs * 1000 : 1000,
                  status: 429
                });
              }
              throw error;
            }),
        {
          signal,
          maxAttempts: 5,
          onAttempt: ({ attempt, sleepMs, error }) => {
            this.log({
              level: LOG_LEVEL.WARN,
              category: EVENT_CATEGORY.OPENAI_RATE_LIMIT,
              name: "context_retry_backoff",
              pageSessionId,
              tabId,
              data: {
                requestId,
                attempt,
                sleepMs,
                reason: error?.message || "unknown"
              }
            });
          },
          shouldRetry: (error) => {
            if (error?.name === "AbortError") {
              return false;
            }
            if (error instanceof RateLimitError) {
              return true;
            }
            const status = Number(error?.status || 0);
            return status === 429 || (status >= 500 && status < 600);
          }
        }
      );
    } finally {
      this.cancellation.unregisterRequest(pageSessionId, requestId);
      this.inflightRequests.remove(requestId);
    }

    const contextText = response?.structured?.context || response?.text || "";

    await this.log({
      category: EVENT_CATEGORY.CONTEXT_GENERATE,
      name: "global_context_ready",
      pageSessionId,
      tabId,
      data: {
        requestId,
        tokensApprox: estimateTokens(contextText),
        usage: response?.usage || null
      }
    });

    return {
      text: contextText,
      model,
      targetTokens
    };
  }

  buildAccess(settings) {
    if (settings.accessMode === "PROXY") {
      return {
        mode: "PROXY",
        baseUrl: settings.proxyBaseUrl,
        token: settings.proxyToken
      };
    }
    return {
      mode: "BYOK",
      baseUrl: settings.byokBaseUrl,
      apiKey: settings.byokApiKey
    };
  }

  hasAccessCredentials(settings) {
    if (settings.accessMode === "PROXY") {
      return Boolean(settings.proxyToken && settings.proxyBaseUrl);
    }
    return Boolean(settings.byokApiKey && settings.byokBaseUrl);
  }

  async hardCancel({ tabId, reason = "ui_cancel" }) {
    const pageSessionId = await this.tabStateStore.getActiveSessionByTab(tabId);
    if (!pageSessionId) {
      return this.getUiState(tabId);
    }

    const { requestIds } = this.cancellation.cancelSession(pageSessionId);
    this.queues.get(pageSessionId)?.stop(new DOMException("Cancelled", "AbortError"));

    await Promise.all(requestIds.map((requestId) => this.offscreenClient.cancel(requestId, pageSessionId)));
    await this.offscreenClient.cancel(null, pageSessionId);
    this.inflightRequests.clearSession(pageSessionId);

    const state = await this.tabStateStore.getState(pageSessionId);
    await this.tabStateStore.upsertState(pageSessionId, {
      stage: PIPELINE_STAGE.CANCELLED,
      cancelled: true,
      progress: {
        pending: 0,
        failed: state?.progress?.failed || 0,
        done: state?.progress?.done || 0,
        total: state?.progress?.total || 0
      }
    });

    await this.log({
      level: LOG_LEVEL.WARN,
      category: EVENT_CATEGORY.CANCELLATION,
      name: "hard_cancel",
      pageSessionId,
      tabId,
      data: {
        reason,
        requestIds
      }
    });

    await this.notifyState(tabId);
    return this.getUiState(tabId);
  }

  async switchView({ tabId, mode }) {
    const pageSessionId = await this.tabStateStore.getActiveSessionByTab(tabId);
    if (pageSessionId) {
      await this.tabStateStore.upsertState(pageSessionId, { viewMode: mode });
    }
    await this.sendTabMessageStrict(tabId, {
      type: MESSAGE.CONTENT_SWITCH_VIEW,
      mode
    });
    await this.log({
      category: EVENT_CATEGORY.UI_ACTION,
      name: "switch_view",
      pageSessionId,
      tabId,
      data: { mode }
    });
    await this.notifyState(tabId);
    return this.getUiState(tabId);
  }

  async clearAll({ tabId }) {
    const pageSessionId = await this.tabStateStore.getActiveSessionByTab(tabId);
    if (pageSessionId && this.running.has(pageSessionId)) {
      await this.hardCancel({ tabId, reason: "clear_all" });
    }

    try {
      await this.sendTabMessageStrict(tabId, { type: MESSAGE.CONTENT_CLEAR });
    } catch {
      // Ignore missing content script when tab is not compatible.
    }

    if (pageSessionId) {
      await this.tabStateStore.clearSession(pageSessionId);
      this.inflightRequests.clearSession(pageSessionId);
    }
    this.uiErrorsByTab.delete(String(tabId));

    await this.eventLogStore.clear();
    await this.log({
      category: EVENT_CATEGORY.UI_ACTION,
      name: "clear_all",
      tabId,
      data: { clearedSession: pageSessionId || null }
    });
    await this.notifyState(tabId);
    return this.getUiState(tabId);
  }

  async resumePending() {
    const all = await this.tabStateStore.getAllStates();
    for (const state of Object.values(all)) {
      if (!state || !state.tabId) {
        continue;
      }
      if (!this.isRunningStage(state.stage)) {
        continue;
      }
      if (this.running.has(state.pageSessionId)) {
        continue;
      }

      await this.log({
        level: LOG_LEVEL.WARN,
        category: EVENT_CATEGORY.PIPELINE_STAGE,
        name: "resume_orphan_session_detected",
        pageSessionId: state.pageSessionId,
        tabId: state.tabId,
        data: {
          previousStage: state.stage
        }
      });

      await this.tabStateStore.upsertState(state.pageSessionId, {
        stage: PIPELINE_STAGE.CANCELLED,
        cancelled: true,
        lastError: {
          message: "Service worker restarted. Session will be restarted."
        },
        progress: {
          ...(state.progress || {}),
          pending: 0
        }
      });

      const activeSession = await this.tabStateStore.getActiveSessionByTab(state.tabId);
      if (activeSession === state.pageSessionId) {
        await this.tabStateStore.setActiveSession(state.tabId, null);
      }

      await this.notifyState(state.tabId);

      try {
        await this.startForTab({
          tabId: state.tabId,
          url: state.url
        });
        await this.log({
          level: LOG_LEVEL.INFO,
          category: EVENT_CATEGORY.PIPELINE_STAGE,
          name: "resume_restarted_session",
          tabId: state.tabId,
          data: {
            previousSessionId: state.pageSessionId
          }
        });
      } catch (error) {
        await this.log({
          level: LOG_LEVEL.ERROR,
          category: EVENT_CATEGORY.ERROR,
          name: "resume_restart_failed",
          tabId: state.tabId,
          pageSessionId: state.pageSessionId,
          error: asErrorObject(error)
        });
      }
    }
  }

  async failSession({ pageSessionId, tabId, error }) {
    const state = await this.tabStateStore.getState(pageSessionId);
    await this.tabStateStore.upsertState(pageSessionId, {
      stage: PIPELINE_STAGE.FAILED,
      lastError: asErrorObject(error),
      progress: {
        ...(state?.progress || {}),
        errorCount: (state?.progress?.errorCount || 0) + 1
      }
    });

    await this.log({
      level: LOG_LEVEL.ERROR,
      category: EVENT_CATEGORY.ERROR,
      name: "pipeline_failed",
      pageSessionId,
      tabId,
      error: asErrorObject(error)
    });
    await this.notifyState(tabId);
  }

  async getUiState(tabId) {
    const pageSessionId = await this.tabStateStore.getActiveSessionByTab(tabId);
    const state = pageSessionId ? await this.tabStateStore.getState(pageSessionId) : null;

    if (!state) {
      const transientError = this.uiErrorsByTab.get(String(tabId)) || null;
      return {
        pageSessionId: null,
        stage: PIPELINE_STAGE.IDLE,
        progress: {
          done: 0,
          pending: 0,
          failed: 0,
          total: 0,
          errorCount: 0
        },
        viewMode: VIEW_MODE.ORIGINAL,
        hasTranslatedBlocks: false,
        isRunning: false,
        hasData: false,
        canCancel: false,
        canClear: false,
        lastError: transientError ? { message: transientError } : null
      };
    }

    const isRunning = this.running.has(pageSessionId) && !state.cancelled;
    const hasData = (state.progress?.total || 0) > 0 || !!state.hasTranslatedBlocks;

    return {
      ...state,
      isRunning,
      hasData,
      canCancel: isRunning,
      canClear: hasData
    };
  }

  async queryLogs(filters) {
    return this.eventLogStore.query(filters);
  }

  async exportLogs(filters) {
    return this.eventLogStore.exportJson(filters);
  }

  async appendEvent(event) {
    await this.log(event);
  }

  async log(event) {
    await this.eventLogStore.append({
      ts: event.ts || nowIso(),
      level: event.level || LOG_LEVEL.INFO,
      category: event.category,
      name: event.name,
      pageSessionId: event.pageSessionId || null,
      tabId: event.tabId ?? null,
      batchId: event.batchId || null,
      blockId: event.blockId || null,
      data: event.data || {},
      error: event.error || null
    });

    if (event.tabId !== null && event.tabId !== undefined) {
      await this.notifyState(event.tabId);
    } else {
      this.onStateChanged?.({ tabId: null });
    }
  }

  async updateStage(pageSessionId, tabId, stage) {
    await this.tabStateStore.upsertState(pageSessionId, { stage });
    await this.log({
      category: EVENT_CATEGORY.PIPELINE_STAGE,
      name: `stage_${stage}`,
      pageSessionId,
      tabId,
      data: { stage }
    });
    await this.notifyState(tabId);
  }

  async notifyState(tabId) {
    const state = await this.getUiState(tabId);
    this.onStateChanged?.({ tabId, state });
  }

  async waitQueueIdle(pageSessionId) {
    const queue = this.queues.get(pageSessionId);
    if (!queue) {
      return;
    }
    while (queue.size() > 0 || queue.active > 0) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  syncQueueConcurrency(pageSessionId, model) {
    const queue = this.queues.get(pageSessionId);
    const controller = this.controllerBySession.get(pageSessionId);
    if (!queue || !controller) {
      return;
    }
    const snapshot = controller.getSnapshot(model);
    const nextConcurrency = Math.max(
      1,
      Number(snapshot?.dynamicConcurrency || snapshot?.limits?.concurrency || queue.concurrency || 1)
    );
    if (queue.concurrency !== nextConcurrency) {
      queue.setConcurrency(nextConcurrency);
    }
  }

  isRunningStage(stage) {
    return [
      PIPELINE_STAGE.SCANNING,
      PIPELINE_STAGE.CONTEXT,
      PIPELINE_STAGE.BATCHING,
      PIPELINE_STAGE.TRANSLATING,
      PIPELINE_STAGE.APPLYING
    ].includes(stage);
  }

  async sendTabMessageStrict(tabId, payload) {
    const response = await chrome.tabs.sendMessage(tabId, payload);
    if (!response?.ok) {
      throw new Error(response?.error || "Tab message failed");
    }
    return response.result;
  }

  async throwIfCancelled(signal) {
    if (signal?.aborted) {
      throw new DOMException("Session cancelled", "AbortError");
    }
  }

  async handleMessage(message, sender) {
    switch (message?.type) {
      case MESSAGE.UI_START:
        return this.startForTab({ tabId: message.tabId, url: message.url });
      case MESSAGE.UI_CANCEL:
        return this.hardCancel({ tabId: message.tabId, reason: "ui_cancel" });
      case MESSAGE.UI_CLEAR:
        return this.clearAll({ tabId: message.tabId });
      case MESSAGE.UI_SWITCH_VIEW:
        return this.switchView({ tabId: message.tabId, mode: message.mode });
      case MESSAGE.UI_STATE:
        return this.getUiState(message.tabId);
      case MESSAGE.UI_LOAD_SETTINGS:
        return this.settingsStore.getSettings();
      case MESSAGE.UI_SAVE_SETTINGS:
        return this.saveSettings(message.settings);
      case MESSAGE.UI_SAVE_PROFILE:
        return this.saveProfile(message.name, message.profile);
      case MESSAGE.UI_LIST_MODELS:
        return this.listModels();
      case MESSAGE.UI_LIST_PROFILES:
        return this.settingsStore.listProfiles();
      case MESSAGE.LOG_QUERY:
        return this.queryLogs(message.filters || {});
      case MESSAGE.LOG_EXPORT:
        return this.exportLogs(message.filters || {});
      case MESSAGE.LOG_CLEAR:
        await this.eventLogStore.clear();
        return { cleared: true };
      case "event.emit":
        await this.appendEvent(message.event);
        return { logged: true };
      case MESSAGE.PIPELINE_RESUME:
        await this.resumePending();
        return { resumed: true };
      default:
        return null;
    }
  }

  async saveSettings(nextSettings) {
    await this.settingsStore.saveSettings(nextSettings);
    await this.log({
      category: EVENT_CATEGORY.UI_ACTION,
      name: "settings_saved",
      data: {
        accessMode: nextSettings.accessMode,
        promptCachingEnabled: nextSettings?.promptCaching?.enabled
      }
    });
    return nextSettings;
  }

  async saveProfile(name, profile) {
    const profiles = await this.settingsStore.saveProfile(name, profile);
    await this.log({
      category: EVENT_CATEGORY.UI_ACTION,
      name: "profile_saved",
      data: {
        name
      }
    });
    return profiles;
  }

  async listModels() {
    const settings = await this.settingsStore.getSettings();
    const useProxy = settings.accessMode === "PROXY";
    const baseUrl = useProxy ? settings.proxyBaseUrl : settings.byokBaseUrl;
    const token = useProxy ? settings.proxyToken : settings.byokApiKey;

    if (!baseUrl || !token) {
      return [];
    }

    const response = await this.offscreenClient.execute({
      requestId: `req_${stableHash(`models_${Date.now()}`)}`,
      pageSessionId: null,
      tabId: null,
      operation: "openai.models",
      payload: {
        baseUrl,
        useProxy
      },
      access: useProxy
        ? { mode: "PROXY", baseUrl, token }
        : { mode: "BYOK", baseUrl, apiKey: token }
    });

    return response.models || [];
  }

  async handleAlarm(alarm) {
    if (alarm.name === ALARM_RESUME_PIPELINE) {
      await this.runGc();
      await this.resumePending();
    }
  }
}
