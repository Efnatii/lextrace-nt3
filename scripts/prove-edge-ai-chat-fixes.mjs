import assert from "node:assert/strict";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { ensureDir, paths, writeJson } from "./lib/common.mjs";
import {
  COMMANDS,
  chooseModelFromCatalog,
  closeAiHarnessSession,
  getAvailableTiers,
  getAiStatus,
  getRuntimeSnapshot,
  getTabIdByUrl,
  importOverlayChatQueue,
  normalizePageKey,
  patchConfig,
  prepareEdgeAiArtifacts,
  readNativeHostState,
  resetAllSessions,
  selectOverlayTab,
  sendCommand,
  sendOverlayChat,
  startAiHarnessSession,
  switchToHandle,
  waitFor,
  waitForSession,
  waitForAllSessionsIdle,
  waitForOverlay
} from "./lib/edge-ai-harness.mjs";

const DEFAULT_REPORT_PATH = path.join(paths.artifacts, "test-results", "edge-ai-chat-fixes-proof.json");
const CONVERSATIONAL_KINDS = new Set(["user", "assistant", "code"]);
const QUEUE_PROMPTS = [
  "Объясни, как защищать время для глубокой работы. Ответ: 280-320 токенов. Включи маркер EDGE_QUEUE_1 ровно один раз.",
  "Расскажи, как писать понятные инструкции для коллег. Ответ: 280-320 токенов. Включи маркер EDGE_QUEUE_2 ровно один раз.",
  "Объясни, как выстраивать долгосрочные приоритеты в работе. Ответ: 280-320 токенов. Включи маркер EDGE_QUEUE_3 ровно один раз.",
  "Расскажи, как анализировать риски перед запуском задачи. Ответ: 280-320 токенов. Включи маркер EDGE_QUEUE_4 ровно один раз.",
  "Объясни, как системно внедрять изменения в процесс. Ответ: 280-320 токенов. Включи маркер EDGE_QUEUE_5 ровно один раз.",
  "Расскажи, как сохранять концентрацию в среде постоянных отвлечений. Ответ: 280-320 токенов. Включи маркер EDGE_QUEUE_6 ровно один раз."
];
const PROOF_QUEUE_PROMPTS = QUEUE_PROMPTS
  .slice(0, 5)
  .map((prompt) => prompt.replace("280-320", "160-200"));
const SCROLL_PROMPT = [
  "Напиши 220 коротких нумерованных строк.",
  "Каждая строка должна начинаться с маркера EDGE_SCROLL.",
  "Не используй markdown-таблицы.",
  "Не останавливайся раньше 220 строк."
].join(" ");

function parseArgs(argv) {
  const options = {
    reportPath: DEFAULT_REPORT_PATH,
    reuseArtifacts: false,
    skipPreflight: false
  };

  for (const argument of argv) {
    if (argument === "--reuse-artifacts") {
      options.reuseArtifacts = true;
      continue;
    }

    if (argument === "--skip-preflight") {
      options.skipPreflight = true;
      continue;
    }

    if (argument.startsWith("--report=")) {
      options.reportPath = path.resolve(argument.slice("--report=".length));
      continue;
    }

    throw new Error(`Unsupported argument: ${argument}`);
  }

  return options;
}

function createReport() {
  return {
    startedAt: new Date().toISOString(),
    finishedAt: null,
    environment: {},
    proofs: [],
    summary: null
  };
}

const RETRYABLE_PROOF_ERROR_PATTERNS = [
  /ssl connection/i,
  /timed out/i,
  /did not reach the expected state/i,
  /response ended/i,
  /status failed/i,
  /overlay .* unavailable/i,
  /no usable model is available/i
];
const OPENAI_API_KEY_FRAGMENT_PATTERN = /\bsk-(?:proj-|live-|test-)?[a-z0-9_-]{16,}\b/i;

function isRetryableProofError(error) {
  const message = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
  return RETRYABLE_PROOF_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

function chooseProofModel(models) {
  for (const preferredId of ["gpt-5-mini", "gpt-4.1-mini", "gpt-5", "gpt-4.1"]) {
    const match = models.find((item) => item?.id === preferredId && getAvailableTiers(item).includes("standard"));
    if (match) {
      return {
        model: match.id,
        tier: "standard"
      };
    }
  }

  return chooseModelFromCatalog(models);
}

async function runProof(report, id, execute, options = {}) {
  const entry = {
    id,
    status: "running",
    startedAt: new Date().toISOString(),
    attempts: []
  };
  report.proofs.push(entry);
  try {
    const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    let attempt = 0;
    while (attempt < maxAttempts) {
      attempt += 1;
      const attemptEntry = {
        attempt,
        startedAt: new Date().toISOString()
      };
      entry.attempts.push(attemptEntry);
      try {
        attemptEntry.details = await execute({ attempt });
        attemptEntry.status = "passed";
        entry.details = attemptEntry.details;
        entry.status = "passed";
        return;
      } catch (error) {
        attemptEntry.status = "failed";
        attemptEntry.error = error instanceof Error ? error.message : String(error);
        attemptEntry.stack = error instanceof Error ? error.stack : null;
        attemptEntry.retryable = isRetryableProofError(error);
        attemptEntry.finishedAt = new Date().toISOString();
        if (attempt >= maxAttempts || !attemptEntry.retryable) {
          entry.status = "failed";
          entry.error = attemptEntry.error;
          entry.stack = attemptEntry.stack;
          throw error;
        }
        await delay(1500);
        continue;
      } finally {
        attemptEntry.finishedAt ??= new Date().toISOString();
      }
    }
  } finally {
    entry.finishedAt = new Date().toISOString();
  }
}

async function sendCommandWithRetries(driver, action, payload, options = {}) {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await sendCommand(driver, action, payload);
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !isRetryableProofError(error)) {
        throw error;
      }
      await delay(1500);
    }
  }
  throw lastError ?? new Error(`${action} failed.`);
}

async function refreshOverlayChatSnapshot(driver) {
  await driver.executeAsyncScript(`
    const done = arguments[arguments.length - 1];
    Promise.resolve(globalThis.__lextraceNt3OverlayController?.loadAiSnapshot?.())
      .then(() => done(true))
      .catch((error) => done({ message: error?.message ?? String(error) }));
  `);
  await delay(300);
}

function getCurrentSessionFromHostState(hostState, pageKey) {
  return hostState?.aiSessions?.find((session) => session?.pageKey === pageKey) ?? null;
}

function getConversationalMessages(messages) {
  return (messages ?? []).filter((message) => CONVERSATIONAL_KINDS.has(message?.kind));
}

function assertAlternatingTurns(messages, label) {
  const conversational = getConversationalMessages(messages);
  assert.ok(conversational.length > 0, `${label} is empty.`);
  assert.equal(conversational.length % 2, 0, `${label} must contain full user/assistant pairs.`);

  for (let index = 0; index < conversational.length; index += 2) {
    const userMessage = conversational[index];
    const assistantMessage = conversational[index + 1];
    assert.ok(userMessage, `${label} is missing user message at index ${index}.`);
    assert.ok(assistantMessage, `${label} is missing assistant message at index ${index + 1}.`);
    assert.ok(userMessage.kind === "user" || userMessage.kind === "code", `${label} expected user/code at index ${index}, got ${userMessage.kind}.`);
    assert.equal(assistantMessage.kind, "assistant", `${label} expected assistant at index ${index + 1}, got ${assistantMessage.kind}.`);
    assert.equal(
      assistantMessage.requestId,
      userMessage.requestId,
      `${label} requestId mismatch between paired turn ${index / 2}.`
    );
  }

  return conversational.map((message) => ({
    kind: message.kind,
    requestId: message.requestId,
    text: String(message.text ?? "").slice(0, 80)
  }));
}

async function openOverlayForPage(session, pageUrl) {
  const { driver, popupHandle, mainHandle } = session;
  const pageKey = normalizePageKey(pageUrl);

  await switchToHandle(driver, mainHandle);
  await driver.get(pageUrl);
  const tabId = await getTabIdByUrl(driver, pageUrl);
  assert.ok(typeof tabId === "number", `Unable to resolve Edge tab for ${pageUrl}.`);

  await switchToHandle(driver, popupHandle);
  await sendCommand(driver, COMMANDS.overlayOpen, {
    tabId,
    expectedUrl: pageUrl
  });

  await switchToHandle(driver, mainHandle);
  await waitForOverlay(driver);
  return pageKey;
}

async function readOverlayTranscript(driver) {
  return driver.executeScript(`
    const root = document.querySelector('#lextrace-overlay-root')?.shadowRoot;
    const feed = root?.querySelector('[data-role="chat-feed"]');
    if (!(feed instanceof HTMLElement)) {
      throw new Error('Overlay chat feed is unavailable.');
    }

    function readEntry(entry) {
      const kindClass = [...entry.classList].find((value) => value.startsWith('kind-')) ?? '';
      return {
        kind: kindClass.replace(/^kind-/, ''),
        badge: entry.querySelector('.chat-entry-badge')?.textContent?.trim() ?? '',
        meta: entry.querySelector('.chat-entry-meta')?.textContent?.trim() ?? '',
        body: entry.querySelector('.chat-entry-body')?.textContent?.trim() ?? ''
      };
    }

    return {
      items: [...feed.children].map((child) => {
        if (child instanceof HTMLElement && child.matches('article.chat-entry')) {
          return {
            type: 'entry',
            ...readEntry(child)
          };
        }

        if (child instanceof HTMLDetailsElement && child.matches('details.chat-range')) {
          return {
            type: 'range',
            summary: child.querySelector('.chat-range-title')?.textContent?.trim() ?? '',
            badge: child.querySelector('.chat-range-badge')?.textContent?.trim() ?? '',
            items: [...child.querySelectorAll('.chat-range-body > article.chat-entry')].map((entry) => readEntry(entry))
          };
        }

        return {
          type: child instanceof HTMLElement ? child.tagName.toLowerCase() : 'unknown',
          text: child instanceof HTMLElement ? (child.textContent?.trim() ?? '') : ''
        };
      }),
      scrollTop: feed.scrollTop,
      scrollHeight: feed.scrollHeight,
      clientHeight: feed.clientHeight
    };
  `);
}

function flattenTranscriptConversation(transcript) {
  const flattened = [];
  for (const item of transcript.items ?? []) {
    if (item.type === "entry") {
      if (item.kind === "user" || item.kind === "assistant" || item.kind === "code") {
        flattened.push(item);
      }
      continue;
    }

    if (item.type === "range") {
      for (const nested of item.items ?? []) {
        if (nested.kind === "user" || nested.kind === "assistant" || nested.kind === "code") {
          flattened.push(nested);
        }
      }
    }
  }

  return flattened;
}

function assertTranscriptRangesAreWholeTurns(transcript) {
  const ranges = (transcript.items ?? []).filter((item) => item.type === "range");
  for (const range of ranges) {
    assert.ok(range.items.length > 1, "Compacted transcript range collapsed to a single message.");
    assert.equal(range.items.length % 2, 0, "Compacted transcript range must contain full user/assistant pairs.");
    for (let index = 0; index < range.items.length; index += 2) {
      assert.ok(["user", "code"].includes(range.items[index].kind), "Compacted range must start each pair with user/code.");
      assert.equal(range.items[index + 1]?.kind, "assistant", "Compacted range must keep assistant paired with its user turn.");
    }
  }

  return ranges.map((range) => ({
    summary: range.summary,
    itemCount: range.items.length
  }));
}

async function readConsoleProviderEntries(driver) {
  return driver.executeScript(`
    const root = document.querySelector('#lextrace-overlay-root')?.shadowRoot;
    const feed = root?.querySelector('[data-role="activity-feed"]');
    if (!(feed instanceof HTMLElement)) {
      throw new Error('Overlay activity feed is unavailable.');
    }

    return [...feed.querySelectorAll('details.activity-log')].map((entry) => ({
      heading: entry.querySelector('.log-heading')?.textContent?.trim() ?? '',
      meta: entry.querySelector('.log-meta')?.textContent?.trim() ?? '',
      body: entry.querySelector('.log-body')?.textContent?.trim() ?? ''
    })).filter((entry) =>
      entry.meta.includes('ai.provider.request.chat') || entry.meta.includes('ai.provider.request.compaction')
    );
  `);
}

async function getChatFeedMetrics(driver) {
  return driver.executeScript(`
    const root = document.querySelector('#lextrace-overlay-root')?.shadowRoot;
    const feed = root?.querySelector('[data-role="chat-feed"]');
    if (!(feed instanceof HTMLElement)) {
      throw new Error('Overlay chat feed is unavailable.');
    }

    return {
      scrollTop: feed.scrollTop,
      scrollHeight: feed.scrollHeight,
      clientHeight: feed.clientHeight,
      distanceFromBottom: feed.scrollHeight - feed.scrollTop - feed.clientHeight
    };
  `);
}

async function setChatFeedScrollTop(driver, scrollTop) {
  return driver.executeScript(`
    const root = document.querySelector('#lextrace-overlay-root')?.shadowRoot;
    const feed = root?.querySelector('[data-role="chat-feed"]');
    if (!(feed instanceof HTMLElement)) {
      throw new Error('Overlay chat feed is unavailable.');
    }

    feed.scrollTop = arguments[0];
    return {
      scrollTop: feed.scrollTop,
      scrollHeight: feed.scrollHeight,
      clientHeight: feed.clientHeight,
      maxScrollTop: Math.max(0, feed.scrollHeight - feed.clientHeight)
    };
  `, scrollTop);
}

async function setChatFeedToBottom(driver) {
  return driver.executeScript(`
    const root = document.querySelector('#lextrace-overlay-root')?.shadowRoot;
    const feed = root?.querySelector('[data-role="chat-feed"]');
    if (!(feed instanceof HTMLElement)) {
      throw new Error('Overlay chat feed is unavailable.');
    }

    feed.scrollTop = feed.scrollHeight;
    return {
      scrollTop: feed.scrollTop,
      scrollHeight: feed.scrollHeight,
      clientHeight: feed.clientHeight,
      distanceFromBottom: feed.scrollHeight - feed.scrollTop - feed.clientHeight
    };
  `);
}

function summarizeProviderLogs(logs) {
  return logs.map((entry) => ({
    event: entry.event,
    endpoint: entry.details?.endpoint ?? null,
    method: entry.details?.method ?? null,
    hasBody: Boolean(entry.details?.body),
    bodyKeys: entry.details?.body ? Object.keys(entry.details.body) : []
  }));
}

function extractCompactionLogs(logs) {
  return logs.filter((entry) => entry.event === "ai.chat.compaction.completed");
}

function extractProviderLogs(logs) {
  return logs.filter((entry) =>
    entry.event === "ai.provider.request.chat" || entry.event === "ai.provider.request.compaction"
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = createReport();
  let session = null;

  try {
    await prepareEdgeAiArtifacts({
      runPreflight: !options.skipPreflight,
      reuseArtifacts: options.reuseArtifacts
    });
    session = await startAiHarnessSession();
    report.environment.extensionId = session.extensionId;

    const catalog = await sendCommandWithRetries(session.driver, COMMANDS.aiModelsCatalog, {}, { maxAttempts: 4 });
    const model = chooseProofModel(catalog.models);
    assert.ok(model, "No usable model is available for live AI proof.");
    report.environment.model = model;

    await patchConfig(session.driver, {
      logging: {
        level: "debug",
        maxEntries: 1000
      },
      ai: {
        allowedModels: [model],
        chat: {
          model,
          streamingEnabled: true,
          instructions: "",
          structuredOutput: {
            name: "chat_response",
            description: "",
            schema: "",
            strict: true
          }
        },
        compaction: {
          enabled: true,
          streamingEnabled: true,
          modelOverride: model,
          instructions: "Summarize the conversation history into compact, faithful context for the next turn. Preserve the user's goals, accepted decisions, constraints, important facts, open questions, unfinished work, and any code or data details that still matter. Remove repetition and low-value chatter. Do not invent facts or change meaning.",
          triggerPromptTokens: 1100,
          preserveRecentTurns: 0,
          maxPassesPerPage: 16
        },
        promptCaching: {
          routing: "stable_session_prefix",
          retention: "in_memory"
        },
        retries: {
          maxRetries: 6,
          baseDelayMs: 500,
          maxDelayMs: 5000
        },
        queueRetries: {
          maxRetries: 6,
          baseDelayMs: 500,
          maxDelayMs: 5000
        },
        rateLimits: {
          reserveOutputTokens: 512,
          maxQueuedPerPage: 50,
          maxQueuedGlobal: 100
        }
      }
    });

    await resetAllSessions(session.driver);
    await waitForAllSessionsIdle(session.driver);

    await runProof(report, "queue-compaction-order-console", async ({ attempt }) => {
      await resetAllSessions(session.driver);
      await waitForAllSessionsIdle(session.driver, 90000);
      const pageUrl = session.server.makeUrl(`/proof-chat-fixes-queue-attempt-${attempt}`);
      const pageKey = await openOverlayForPage(session, pageUrl);

      await selectOverlayTab(session.driver, "chat");
      await importOverlayChatQueue(session.driver, PROOF_QUEUE_PROMPTS, "queue-proof.json");

      const sessionState = await waitForSession(
        session.driver,
        pageKey,
        pageUrl,
        (candidate) => {
          const userCount = candidate.messages.filter((message) => message.origin === "user").length;
          const assistantCount = candidate.messages.filter((message) => message.origin === "assistant").length;
          return candidate.status.requestState === "idle" &&
            candidate.status.queueCount === 0 &&
            userCount === PROOF_QUEUE_PROMPTS.length &&
            assistantCount === PROOF_QUEUE_PROMPTS.length;
        },
        600000
      );

      await delay(1500);
      await refreshOverlayChatSnapshot(session.driver);
      const runtimeSnapshot = await getRuntimeSnapshot(session.driver);
      const hostState = await readNativeHostState();
      const hostSession = getCurrentSessionFromHostState(hostState, pageKey);
      assert.ok(hostSession, "Native host journal did not persist the proof session.");

      const providerLogs = extractProviderLogs(runtimeSnapshot.logs ?? []);
      assert.ok(providerLogs.length > 0, "Provider request logs did not reach the runtime snapshot.");
      assert.ok(providerLogs.some((entry) => entry.event === "ai.provider.request.chat"), "Chat provider request log is missing.");
      assert.ok(providerLogs.some((entry) => entry.event === "ai.provider.request.compaction"), "Compaction provider request log is missing.");
      for (const entry of providerLogs) {
        assert.ok(entry.details?.body, `${entry.event} is missing raw JSON body.`);
        const bodyText = JSON.stringify(entry.details.body);
        assert.ok(!/authorization/i.test(bodyText), `${entry.event} leaked authorization data.`);
        assert.ok(!OPENAI_API_KEY_FRAGMENT_PATTERN.test(bodyText), `${entry.event} leaked an API key fragment.`);
      }

      const compactionLogs = extractCompactionLogs(runtimeSnapshot.logs ?? []);
      assert.ok(compactionLogs.length > 0, "Compaction never completed during the queue proof.");
      for (const entry of compactionLogs) {
        assert.ok(
          Number(entry.details?.postPromptTokens) < Number(entry.details?.prePromptTokens),
          `Compaction did not shrink prompt tokens: ${entry.details?.prePromptTokens} -> ${entry.details?.postPromptTokens}.`
        );
      }

      await switchToHandle(session.driver, session.mainHandle);
      const hostConversation = assertAlternatingTurns(hostSession.messages, "Host session conversational order");
      const transcript = await readOverlayTranscript(session.driver);
      const transcriptRanges = assertTranscriptRangesAreWholeTurns(transcript);
      const flattenedTranscript = flattenTranscriptConversation(transcript);
      assert.equal(flattenedTranscript.length, hostConversation.length, "Rendered transcript lost conversational messages.");
      for (let index = 0; index < flattenedTranscript.length; index += 2) {
        assert.ok(["user", "code"].includes(flattenedTranscript[index].kind), `Transcript expected user/code at ${index}.`);
        assert.equal(flattenedTranscript[index + 1]?.kind, "assistant", `Transcript expected assistant at ${index + 1}.`);
      }

      await selectOverlayTab(session.driver, "console");
      await waitFor(async () => {
        const entries = await readConsoleProviderEntries(session.driver);
        return entries.length >= 2;
      }, 30000, "Console tab did not render provider request logs.");
      const consoleProviderEntries = await readConsoleProviderEntries(session.driver);
      assert.ok(consoleProviderEntries.some((entry) => entry.meta.includes("ai.provider.request.chat")), "Console tab does not show chat provider request log.");
      assert.ok(consoleProviderEntries.some((entry) => entry.meta.includes("ai.provider.request.compaction")), "Console tab does not show compaction provider request log.");
      assert.ok(consoleProviderEntries.some((entry) => entry.body.includes("\"input\"")), "Console tab provider log body is not raw JSON.");

      return {
        pageKey,
        attempt,
        queueLength: PROOF_QUEUE_PROMPTS.length,
        providerLogs: summarizeProviderLogs(providerLogs),
        compactionLogs: compactionLogs.map((entry) => ({
          prePromptTokens: entry.details?.prePromptTokens,
          postPromptTokens: entry.details?.postPromptTokens,
          compactedItemCount: entry.details?.compactedItemCount,
          preservedTailCount: entry.details?.preservedTailCount
        })),
        hostConversationSample: hostConversation.slice(0, 8),
        transcriptRanges,
        consoleProviderEntries: consoleProviderEntries.map((entry) => ({
          meta: entry.meta,
          heading: entry.heading,
          bodyPreview: entry.body.slice(0, 200)
        }))
      };
    }, { maxAttempts: 4 });

    await runProof(report, "streaming-scroll-behavior", async ({ attempt }) => {
      await resetAllSessions(session.driver);
      await waitForAllSessionsIdle(session.driver, 90000);
      const pageUrl = session.server.makeUrl(`/proof-chat-fixes-scroll-attempt-${attempt}`);
      const pageKey = await openOverlayForPage(session, pageUrl);

      await selectOverlayTab(session.driver, "chat");
      await sendOverlayChat(session.driver, SCROLL_PROMPT);

      await waitForSession(
        session.driver,
        pageKey,
        pageUrl,
        (candidate) => candidate.status.requestState === "streaming" || candidate.status.requestState === "running",
        60000
      );

      await switchToHandle(session.driver, session.mainHandle);
      await waitFor(async () => {
        const metrics = await getChatFeedMetrics(session.driver);
        return metrics.scrollHeight > metrics.clientHeight * 2;
      }, 60000, "Streaming chat feed never became scrollable.");

      const topScroll = await setChatFeedScrollTop(session.driver, 0);
      const topBaselineHeight = topScroll.scrollHeight;
      await waitFor(async () => {
        const state = await getAiStatus(session.driver, pageUrl);
        await switchToHandle(session.driver, session.mainHandle);
        const metrics = await getChatFeedMetrics(session.driver);
        return state.status.requestState === "streaming" && metrics.scrollHeight > topBaselineHeight + 120;
      }, 45000, "Streaming response did not continue growing after scrolling away from the bottom.");
      const topAfterGrowth = await getChatFeedMetrics(session.driver);
      assert.ok(topAfterGrowth.scrollTop <= 24, `Chat feed jumped back to the bottom while user scrolled up (${topAfterGrowth.scrollTop}).`);

      const bottomBaseline = await setChatFeedToBottom(session.driver);
      await waitFor(async () => {
        const state = await getAiStatus(session.driver, pageUrl);
        await switchToHandle(session.driver, session.mainHandle);
        const metrics = await getChatFeedMetrics(session.driver);
        return state.status.requestState === "streaming" && metrics.scrollHeight > bottomBaseline.scrollHeight + 120;
      }, 45000, "Streaming response did not keep growing while pinned to the bottom.");
      const bottomAfterGrowth = await getChatFeedMetrics(session.driver);
      assert.ok(
        bottomAfterGrowth.distanceFromBottom <= 40,
        `Pinned-bottom autoscroll drifted away from the latest message (${bottomAfterGrowth.distanceFromBottom}).`
      );

      const finalSession = await waitForSession(
        session.driver,
        pageKey,
        pageUrl,
        (candidate) => candidate.status.requestState === "idle" && candidate.messages.some((message) => message.origin === "assistant" && String(message.text ?? "").includes("EDGE_SCROLL")),
        180000
      );

      return {
        pageKey,
        attempt,
        topAfterGrowth,
        bottomAfterGrowth,
        finalAssistantLength: finalSession.messages
          .filter((message) => message.origin === "assistant")
          .map((message) => String(message.text ?? "").length)
          .sort((left, right) => right - left)[0] ?? 0
      };
    }, { maxAttempts: 4 });
  } finally {
    report.finishedAt = new Date().toISOString();
    report.summary = {
      passed: report.proofs.filter((entry) => entry.status === "passed").length,
      failed: report.proofs.filter((entry) => entry.status === "failed").length
    };
    await ensureDir(path.dirname(options.reportPath));
    await writeJson(options.reportPath, report);
    await closeAiHarnessSession(session);
  }

  const failed = report.proofs.filter((entry) => entry.status === "failed");
  if (failed.length > 0) {
    throw new Error(`Live AI proof failed (${failed.length} proof(s)). Report: ${options.reportPath}`);
  }

  console.log(`Live AI proof passed. Report: ${options.reportPath}`);
}

await main();
