import assert from "node:assert/strict";
import path from "node:path";
import { promises as fs } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

import {
  ensureExtensionKeyMetadata,
  paths,
  writeJson
} from "./lib/common.mjs";
import {
  ensurePopupReady,
  launchEdgeWithExtension,
  normalizePageKey,
  openBrowserTab,
  patchConfig,
  prepareEdgeAiArtifacts,
  pruneBrowserTabs,
  sendCommand,
  setPopupRuntimeHandle,
  switchToHandle,
  waitFor,
  waitForTabIdByUrl
} from "./lib/edge-ai-harness.mjs";

const REPORT_PATH = path.join(paths.artifacts, "test-results", "edge-text-elements-youtube-targeted-report.json");
const OUTPUT_ROOT = path.join(paths.artifacts, "test-results", "edge-text-elements-youtube-targeted");
const YOUTUBE_URL = "https://www.youtube.com/results?search_query=programming&sp=EgIQAQ%253D%253D&hl=en&gl=US&persist_hl=1&persist_gl=1";

const PAGE_READY_TIMEOUT_MS = 90000;
const PAGE_SETTLE_TIMEOUT_MS = 30000;
const PAGE_SOFT_SETTLE_TIMEOUT_MS = 6000;
const TEXT_MAP_TIMEOUT_MS = 90000;
const TEXT_MAP_SOFT_SETTLE_TIMEOUT_MS = 8000;
const TERMINAL_TIMEOUT_MS = 120000;
const DRIVER_SCRIPT_TIMEOUT_MS = 300000;
const DRIVER_PAGELOAD_TIMEOUT_MS = 300000;

const DEFAULT_TARGET_SCROLL_PX = 100000;
const DEFAULT_SCROLL_STEP_PX = 2500;
const DEFAULT_SCROLL_WAIT_MS = 1800;
const DEFAULT_CHECKPOINT_EVERY_PX = 5000;
const DEFAULT_HEAVY_CHECKPOINT_EVERY_PX = 50000;
const DEFAULT_MAX_STEPS = 90;

async function main() {
  const options = parseArgs(process.argv.slice(2));

  await prepareEdgeAiArtifacts({
    reuseArtifacts: options.reuseArtifacts,
    runPreflight: options.runPreflight
  });

  const extensionMetadata = await ensureExtensionKeyMetadata();
  const popupUrl = `chrome-extension://${extensionMetadata.extensionId}/popup.html`;

  await fs.rm(OUTPUT_ROOT, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(OUTPUT_ROOT, { recursive: true });

  const browserSession = await launchEdgeWithExtension();
  let popupHandle = null;
  let mainHandle = null;

  const report = {
    executedAt: new Date().toISOString(),
    popupUrl,
    outputRoot: OUTPUT_ROOT,
    reportPath: REPORT_PATH,
    options: {
      url: options.url,
      targetScrollPx: options.targetScrollPx,
      scrollStepPx: options.scrollStepPx,
      scrollWaitMs: options.scrollWaitMs,
      checkpointEveryPx: options.checkpointEveryPx,
      heavyCheckpointEveryPx: options.heavyCheckpointEveryPx,
      maxSteps: options.maxSteps,
      reuseArtifacts: options.reuseArtifacts,
      runPreflight: options.runPreflight
    },
    checkpoints: [],
    error: null
  };

  try {
    const { driver } = browserSession;
    await driver.manage().setTimeouts({
      script: DRIVER_SCRIPT_TIMEOUT_MS,
      pageLoad: DRIVER_PAGELOAD_TIMEOUT_MS,
      implicit: 0
    });
    await driver.manage().window().setRect({
      width: 1680,
      height: 1200,
      x: 24,
      y: 24
    });

    await driver.get("about:blank");
    mainHandle = await driver.getWindowHandle();
    popupHandle = await openBrowserTab(driver, popupUrl);
    await pruneBrowserTabs(driver, [mainHandle, popupHandle]);
    setPopupRuntimeHandle(popupHandle);
    await ensurePopupReady(driver);
    await enableTextDebugConfig(driver);

    await switchToHandle(driver, mainHandle);
    await navigateToSite(driver, options.url);
    await dismissYouTubeInterference(driver);
    await waitForPageStateToSettle(driver, options.url, PAGE_SETTLE_TIMEOUT_MS, 1400);

    let currentUrl = await driver.getCurrentUrl();
    let pageKey = normalizePageKey(currentUrl);
    let requestedScrollPx = 0;
    let actualScrollPx = 0;
    let checkpointIndex = 0;
    let nextCheckpointThreshold = options.checkpointEveryPx;
    let stagnantSteps = 0;

    report.initialUrl = currentUrl;
    report.initialPageKey = pageKey;

    const initialCheckpoint = await runCheckpoint(driver, {
      checkpointIndex,
      outputRoot: OUTPUT_ROOT,
      popupHandle,
      requestedScrollPx,
      actualScrollPx,
      currentUrl,
      pageKey,
      captureHeavyArtifacts: true
    });
    report.checkpoints.push(initialCheckpoint);
    checkpointIndex += 1;
    await writeJson(REPORT_PATH, report);

    for (let step = 1; step <= options.maxSteps && actualScrollPx < options.targetScrollPx; step += 1) {
      await dismissYouTubeInterference(driver);
      const scrollStep = await scrollDominantTarget(driver, options.scrollStepPx);
      requestedScrollPx += options.scrollStepPx;
      actualScrollPx += scrollStep.deltaPx;
      stagnantSteps = scrollStep.deltaPx <= 2 ? stagnantSteps + 1 : 0;

      await delay(options.scrollWaitMs);
      await dismissYouTubeInterference(driver);
      const pageSettle = await waitForPageStateToBecomeCheckpointSafe(
        driver,
        options.url,
        PAGE_SOFT_SETTLE_TIMEOUT_MS,
        900
      );

      currentUrl = await driver.getCurrentUrl();
      pageKey = normalizePageKey(currentUrl);

      const shouldCapture =
        actualScrollPx >= options.targetScrollPx ||
        Math.max(actualScrollPx, requestedScrollPx) >= nextCheckpointThreshold;

      if (shouldCapture) {
        const checkpoint = await runCheckpoint(driver, {
          checkpointIndex,
          outputRoot: OUTPUT_ROOT,
          popupHandle,
          requestedScrollPx,
          actualScrollPx,
          currentUrl,
          pageKey,
          scrollStep,
          pageSettle,
          captureHeavyArtifacts:
            actualScrollPx >= options.targetScrollPx ||
            requestedScrollPx >= options.targetScrollPx ||
            requestedScrollPx % options.heavyCheckpointEveryPx === 0
        });
        report.checkpoints.push(checkpoint);
        checkpointIndex += 1;
        nextCheckpointThreshold += options.checkpointEveryPx;
        await writeJson(REPORT_PATH, report);
      }

      if (stagnantSteps >= 10 && actualScrollPx < options.targetScrollPx) {
        throw new Error(
          `YouTube scroll stagnated before reaching ${options.targetScrollPx}px. actualScrollPx=${actualScrollPx}`
        );
      }
    }

    report.finalUrl = await driver.getCurrentUrl();
    report.finalPageKey = normalizePageKey(report.finalUrl);
    report.summary = buildSummary(report.checkpoints, {
      targetScrollPx: options.targetScrollPx,
      actualScrollPx,
      requestedScrollPx
    });
    assert.ok(
      actualScrollPx >= options.targetScrollPx,
      `YouTube proof reached only ${actualScrollPx}px actual scroll instead of ${options.targetScrollPx}px.`
    );
    await writeJson(REPORT_PATH, report);
    console.log(`YouTube targeted proof saved to ${REPORT_PATH}`);
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    try {
      const errorScreenshotPath = path.join(OUTPUT_ROOT, "99-error.png");
      await captureScreenshot(browserSession.driver, errorScreenshotPath);
      report.errorScreenshotPath = errorScreenshotPath;
    } catch {}
    try {
      const errorHtmlPath = path.join(OUTPUT_ROOT, "99-error.html");
      await capturePageHtml(browserSession.driver, errorHtmlPath);
      report.errorHtmlPath = errorHtmlPath;
    } catch {}
    await writeJson(REPORT_PATH, report);
    throw error;
  } finally {
    setPopupRuntimeHandle(null);
    await browserSession.driver.quit().catch(() => {});
    if (browserSession.userDataDir) {
      await fs.rm(browserSession.userDataDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

function parseArgs(args) {
  return {
    url: args.find((value) => value.startsWith("--url="))?.slice("--url=".length) ?? YOUTUBE_URL,
    targetScrollPx: parseIntegerArg(args, "--target-scroll=", DEFAULT_TARGET_SCROLL_PX),
    scrollStepPx: parseIntegerArg(args, "--scroll-step=", DEFAULT_SCROLL_STEP_PX),
    scrollWaitMs: parseIntegerArg(args, "--scroll-wait=", DEFAULT_SCROLL_WAIT_MS),
    checkpointEveryPx: parseIntegerArg(args, "--checkpoint-every=", DEFAULT_CHECKPOINT_EVERY_PX),
    heavyCheckpointEveryPx: parseIntegerArg(
      args,
      "--heavy-checkpoint-every=",
      DEFAULT_HEAVY_CHECKPOINT_EVERY_PX
    ),
    maxSteps: parseIntegerArg(args, "--max-steps=", DEFAULT_MAX_STEPS),
    reuseArtifacts: args.includes("--reuse-artifacts"),
    runPreflight: args.includes("--run-preflight")
  };
}

function parseIntegerArg(args, prefix, fallback) {
  const value = args.find((entry) => entry.startsWith(prefix));
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value.slice(prefix.length), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function enableTextDebugConfig(driver) {
  await patchConfig(driver, {
    debug: {
      textElements: {
        highlightEnabled: false,
        inlineEditingEnabled: true,
        displayMode: "effective",
        autoScanMode: "incremental"
      }
    }
  });
}

async function runCheckpoint(driver, context) {
  const {
    checkpointIndex,
    outputRoot,
    popupHandle,
    requestedScrollPx,
    actualScrollPx,
    currentUrl,
    pageKey,
    scrollStep = null,
    pageSettle = null,
    captureHeavyArtifacts = true
  } = context;
  const prefix = buildCheckpointPrefix(checkpointIndex, actualScrollPx);

  await dismissYouTubeInterference(driver);
  const scanResult = await runOverlayTerminalCommand(driver, "text.scan", TERMINAL_TIMEOUT_MS);
  assert.equal(scanResult.ok, true, `text.scan failed at checkpoint ${prefix}: ${scanResult.error ?? "unknown error"}`);
  const scanStatus = parseTerminalJson(scanResult.lastTerminalResult);
  const effectivePageKey =
    typeof scanStatus?.pageKey === "string" && scanStatus.pageKey.trim().length > 0
      ? scanStatus.pageKey
      : pageKey;
  const effectivePageUrl =
    typeof scanStatus?.pageUrl === "string" && scanStatus.pageUrl.trim().length > 0
      ? scanStatus.pageUrl
      : currentUrl;

  await waitForTextMap(driver, popupHandle, effectivePageKey, 1, `Stored text map did not appear for checkpoint ${prefix}.`);
  const scanMapSettle = await waitForTextMapToBecomeCheckpointSafe(
    driver,
    popupHandle,
    effectivePageKey,
    1,
    `Stored text map did not settle after text.scan for checkpoint ${prefix}.`
  );

  const blankResult = await blankAllLiveBindingsViaTerminal(driver, popupHandle, effectivePageKey);
  const blankMapSettle = await waitForTextMapToBecomeCheckpointSafe(
    driver,
    popupHandle,
    effectivePageKey,
    1,
    `Stored text map did not settle after text.blank page for checkpoint ${prefix}.`
  );

  const artifacts = await captureCheckpointArtifacts(driver, {
    popupHandle,
    outputRoot,
    prefix,
    pageKey: effectivePageKey,
    currentUrl: effectivePageUrl,
    requestedScrollPx,
    actualScrollPx,
    captureHeavyArtifacts
  });

  await closeOverlay(driver);
  await delay(900);
  const screenshotPath = path.join(outputRoot, `${prefix}-blanked.png`);
  await captureScreenshot(driver, screenshotPath);

  const residualDiagnostics = await collectResidualVisibleTextDiagnostics(driver);
  const residualPath = path.join(outputRoot, `${prefix}-residual-visible-text.json`);
  await writeJson(residualPath, residualDiagnostics);

  return {
    checkpointIndex,
    prefix,
    currentUrl: effectivePageUrl,
    pageKey: effectivePageKey,
    requestedScrollPx,
    actualScrollPx,
    scrollStep,
    pageSettle,
    captureHeavyArtifacts,
    scanMapSettle,
    blankMapSettle,
    scanResult: {
      submittedValue: scanResult.submittedValue,
      selectedSuggestion: scanResult.selectedSuggestion,
      suggestionCount: scanResult.suggestionCount,
      lastTerminalResult: scanResult.lastTerminalResult
    },
    blankResult: {
      totalBindings: blankResult.totalBindings,
      updatedCount: blankResult.updatedCount,
      terminalResult: blankResult.commandResult.lastTerminalResult
    },
    artifacts,
    screenshotPath,
    residualVisibleTextCount: residualDiagnostics.count,
    residualVisibleTextSample: residualDiagnostics.items.slice(0, 12),
    residualVisibleTextPath: residualPath
  };
}

function buildCheckpointPrefix(checkpointIndex, actualScrollPx) {
  return `${String(checkpointIndex).padStart(2, "0")}-${String(Math.max(0, Math.floor(actualScrollPx))).padStart(6, "0")}px`;
}

function buildSummary(checkpoints, scrollStats) {
  const residualCounts = checkpoints.map((checkpoint) => checkpoint.residualVisibleTextCount ?? 0);
  const noisyCheckpointCount = checkpoints.filter(
    (checkpoint) => checkpoint.pageSettle?.status === "noisy"
  ).length;
  const noisyMapCheckpointCount = checkpoints.filter(
    (checkpoint) =>
      checkpoint.scanMapSettle?.status === "noisy" ||
      checkpoint.blankMapSettle?.status === "noisy"
  ).length;
  const maxResidualVisibleTextCount = residualCounts.length > 0 ? Math.max(...residualCounts) : 0;
  const lastCheckpoint = checkpoints.at(-1) ?? null;
  return {
    checkpointCount: checkpoints.length,
    noisyCheckpointCount,
    noisyMapCheckpointCount,
    targetScrollPx: scrollStats.targetScrollPx,
    actualScrollPx: scrollStats.actualScrollPx,
    requestedScrollPx: scrollStats.requestedScrollPx,
    reachedTarget: scrollStats.actualScrollPx >= scrollStats.targetScrollPx,
    maxResidualVisibleTextCount,
    finalResidualVisibleTextCount: lastCheckpoint?.residualVisibleTextCount ?? 0
  };
}

async function captureCheckpointArtifacts(driver, options) {
  const {
    popupHandle,
    outputRoot,
    prefix,
    pageKey,
    currentUrl,
    requestedScrollPx,
    actualScrollPx,
    captureHeavyArtifacts
  } = options;
  await ensureOverlayOpenForCurrentPage(driver);
  const runtimeLogs = await readRuntimeLogs(driver, 150);
  const pageState = await readPageState(driver);
  const storedPageMap = captureHeavyArtifacts
    ? await readStoredTextPageMap(driver, popupHandle, pageKey)
    : null;
  const textsSnapshot = captureHeavyArtifacts
    ? await getTextsTabSnapshot(driver)
    : null;

  const runtimeLogsPath = path.join(outputRoot, `${prefix}-runtime-logs.json`);
  const pageStatePath = path.join(outputRoot, `${prefix}-page-state.json`);

  await writeJson(runtimeLogsPath, {
    currentUrl,
    pageKey,
    requestedScrollPx,
    actualScrollPx,
    logs: runtimeLogs
  });
  await writeJson(pageStatePath, pageState);

  let textMapPath = null;
  let textsSnapshotPath = null;
  let pageHtmlPath = null;
  if (captureHeavyArtifacts) {
    textMapPath = path.join(outputRoot, `${prefix}-text-map.json`);
    textsSnapshotPath = path.join(outputRoot, `${prefix}-texts-snapshot.json`);
    pageHtmlPath = path.join(outputRoot, `${prefix}-page.html`);
    await writeJson(textMapPath, storedPageMap);
    await writeJson(textsSnapshotPath, textsSnapshot);
    await capturePageHtml(driver, pageHtmlPath);
  }

  return {
    textMapPath,
    textsSnapshotPath,
    runtimeLogsPath,
    pageStatePath,
    pageHtmlPath,
    bindingCount: storedPageMap?.bindings?.length ?? null,
    entryCount: textsSnapshot?.entryCount ?? null
  };
}

async function navigateToSite(driver, url) {
  try {
    await driver.get(url);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const rendererTimeout =
      message.includes("Timed out receiving message from renderer") ||
      message.includes("timeout: Timed out receiving message from renderer");
    if (!rendererTimeout) {
      throw error;
    }
  }

  await waitForPageReady(driver, url, PAGE_READY_TIMEOUT_MS);
  await delay(5000);
}

async function waitForPageReady(driver, expectedUrl, timeoutMs) {
  await waitFor(async () => {
    const state = await readPageState(driver);
    return state.href !== "about:blank" &&
      state.readyState !== "loading" &&
      state.hasBody === true &&
      typeof state.bodyTextLength === "number";
  }, timeoutMs, `Page ${expectedUrl} did not become ready.`);
}

async function waitForPageStateToSettle(driver, expectedUrl, timeoutMs = 15000, minStableMs = 1000) {
  let lastSignature = null;
  let stableSince = 0;

  await waitFor(async () => {
    const state = await readPageState(driver);
    if (state.href === "about:blank" || state.readyState === "loading" || state.hasBody !== true) {
      lastSignature = null;
      stableSince = 0;
      return false;
    }

    const signature = [
      state.href,
      state.title,
      state.readyState,
      state.bodyTextLength,
      state.scroll.height
    ].join("::");
    const now = Date.now();
    if (signature !== lastSignature) {
      lastSignature = signature;
      stableSince = now;
      return false;
    }

    return now - stableSince >= minStableMs;
  }, timeoutMs, `Page ${expectedUrl} did not settle.`);
}

async function waitForPageStateToBecomeCheckpointSafe(
  driver,
  expectedUrl,
  timeoutMs = 15000,
  minStableMs = 1000
) {
  const startedAt = Date.now();

  try {
    await waitForPageStateToSettle(driver, expectedUrl, timeoutMs, minStableMs);
    return {
      status: "settled",
      elapsedMs: Date.now() - startedAt,
      pageState: await readPageState(driver)
    };
  } catch (error) {
    await waitForPageReady(driver, expectedUrl, Math.min(timeoutMs, 10000));
    await delay(Math.max(600, Math.floor(minStableMs / 2)));

    return {
      status: "noisy",
      elapsedMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
      pageState: await readPageState(driver)
    };
  }
}

async function readPageState(driver) {
  return driver.executeScript(`
    const bodyMetric = document.body?.innerText?.length ?? 0;
    return {
      href: window.location.href,
      title: document.title,
      readyState: document.readyState,
      hasBody: document.body instanceof HTMLBodyElement,
      bodyTextLength: bodyMetric,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight
      },
      scroll: {
        x: window.scrollX,
        y: window.scrollY,
        height: document.documentElement.scrollHeight
      }
    };
  `);
}

async function ensureOverlayOpenForCurrentPage(driver) {
  const previousHandle = await driver.getWindowHandle();
  const currentUrl = await driver.getCurrentUrl();
  const tabId = await waitForTabIdByUrl(driver, currentUrl);
  await sendCommand(driver, "overlay.open", {
    tabId,
    expectedUrl: currentUrl
  });
  await switchToHandle(driver, previousHandle);
  await waitForOverlayVisible(driver);
}

async function waitForOverlayVisible(driver) {
  await waitFor(async () => {
    const visible = await driver.executeScript(`
      const host = document.querySelector('#lextrace-overlay-root');
      if (!(host instanceof HTMLElement)) {
        return false;
      }
      return window.getComputedStyle(host).display !== 'none';
    `);
    return visible === true;
  }, 15000, "Overlay did not become visible.");
}

async function waitForOverlayHidden(driver) {
  await waitFor(async () => {
    const hidden = await driver.executeScript(`
      const host = document.querySelector('#lextrace-overlay-root');
      if (!(host instanceof HTMLElement)) {
        return true;
      }
      return window.getComputedStyle(host).display === 'none';
    `);
    return hidden === true;
  }, 10000, "Overlay did not hide.");
}

async function closeOverlay(driver) {
  await driver.executeScript(`
    document.querySelector('#lextrace-overlay-root')
      ?.shadowRoot
      ?.querySelector('[data-close="true"]')
      ?.click();
  `);
  await waitForOverlayHidden(driver);
}

async function runOverlayTerminalCommand(driver, command, timeoutMs = 15000) {
  await ensureOverlayOpenForCurrentPage(driver);
  const countBefore = (await readOverlayTerminalEntries(driver)).length;
  const startedAt = new Date().toISOString();

  const submission = await driver.executeScript(
    `
      const root = document.querySelector('#lextrace-overlay-root')?.shadowRoot;
      const consoleTab = root?.querySelector(".overlay-tab-button[data-tab='console']");
      const input = root?.querySelector('[data-role="terminal-input"]');
      const form = root?.querySelector('[data-role="terminal-form"]');
      if (consoleTab instanceof HTMLButtonElement) {
        consoleTab.click();
      }
      if (!(input instanceof HTMLInputElement) || !(form instanceof HTMLFormElement)) {
        throw new Error('Overlay terminal is unavailable.');
      }
      input.focus();
      input.value = arguments[0];
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.setSelectionRange(input.value.length, input.value.length);
      const submittedValue = input.value;
      const suggestionText = root?.querySelector('.terminal-suggestion-item.is-selected')?.textContent?.trim() ?? '';
      const suggestionCount = root?.querySelectorAll('.terminal-suggestion-item').length ?? 0;
      form.requestSubmit();
      return {
        submittedValue,
        suggestionText,
        suggestionCount,
        valueAfterSubmit: input.value
      };
    `,
    command
  );

  let completionLog = null;
  await waitFor(async () => {
    const entries = await readOverlayTerminalEntries(driver);
    if (entries.length < countBefore + 2) {
      const latestOverlayLog = await findLatestOverlayCommandLog(driver, startedAt, command);
      if (!latestOverlayLog) {
        return false;
      }
      completionLog = latestOverlayLog;
      return true;
    }

    const lastEntry = entries.at(-1);
    if (lastEntry && lastEntry.kind !== "command") {
      return true;
    }

    const latestOverlayLog = await findLatestOverlayCommandLog(driver, startedAt, command);
    if (!latestOverlayLog) {
      return false;
    }
    completionLog = latestOverlayLog;
    return true;
  }, timeoutMs, `Terminal command "${command}" did not finish in time.`);

  const entries = await readOverlayTerminalEntries(driver);
  const lastEntry = entries.at(-1) ?? null;
  if (lastEntry && lastEntry.kind !== "command") {
    return {
      ok: lastEntry.kind !== "error",
      kind: lastEntry.kind,
      lastTerminalResult: lastEntry.text ?? "",
      recentTerminalEntries: entries.slice(-8),
      error: lastEntry.kind === "error" ? lastEntry.text : null,
      submittedValue: submission?.submittedValue ?? "",
      selectedSuggestion: submission?.suggestionText ?? "",
      suggestionCount: submission?.suggestionCount ?? 0,
      valueAfterSubmit: submission?.valueAfterSubmit ?? ""
    };
  }

  if (completionLog) {
    const failureMessage =
      completionLog.event === "overlay.command.failed"
        ? completionLog.details?.message ?? completionLog.summary ?? "Unknown overlay command failure."
        : null;
    return {
      ok: completionLog.event === "overlay.command",
      kind: completionLog.event === "overlay.command" ? "result" : "error",
      lastTerminalResult: completionLog.summary ?? "",
      recentTerminalEntries: entries.slice(-8),
      error: failureMessage,
      submittedValue: submission?.submittedValue ?? "",
      selectedSuggestion: submission?.suggestionText ?? "",
      suggestionCount: submission?.suggestionCount ?? 0,
      valueAfterSubmit: submission?.valueAfterSubmit ?? ""
    };
  }

  return {
    ok: false,
    kind: null,
    lastTerminalResult: "",
    recentTerminalEntries: entries.slice(-8),
    error: "Terminal command completed without a detectable result entry or overlay command log.",
    submittedValue: submission?.submittedValue ?? "",
    selectedSuggestion: submission?.suggestionText ?? "",
    suggestionCount: submission?.suggestionCount ?? 0,
    valueAfterSubmit: submission?.valueAfterSubmit ?? ""
  };
}

async function readOverlayTerminalEntries(driver) {
  return driver.executeScript(`
    const root = document.querySelector('#lextrace-overlay-root')?.shadowRoot;
    return [...(root?.querySelectorAll('.activity-entry.activity-terminal') ?? [])]
      .map((entry) => {
        const kindClass = [...entry.classList].find((className) => className.startsWith('terminal-')) ?? '';
        return {
          kind: kindClass.replace('terminal-', '') || 'system',
          text: entry.querySelector('.activity-body')?.textContent?.trim() ?? '',
          summary: entry.querySelector('.activity-summary')?.textContent?.trim() ?? ''
        };
      })
      .filter((entry) => entry.text || entry.summary);
  `);
}

async function findLatestOverlayCommandLog(driver, startedAt, command) {
  const logs = await readRuntimeLogs(driver, 80);
  const startedAtMs = Date.parse(startedAt);
  return [...logs]
    .reverse()
    .find((entry) => {
      const ts = Date.parse(String(entry?.ts ?? ""));
      if (!Number.isFinite(ts) || ts < startedAtMs) {
        return false;
      }
      if (entry?.event === "overlay.command") {
        return entry?.details?.raw === command;
      }
      if (entry?.event === "overlay.command.failed") {
        return entry?.details?.raw === command;
      }
      return false;
    }) ?? null;
}

async function getTextsTabSnapshot(driver) {
  return driver.executeAsyncScript(`
    const done = arguments[arguments.length - 1];
    const root = document.querySelector('#lextrace-overlay-root')?.shadowRoot;
    root?.querySelector(".overlay-tab-button[data-tab='texts']")?.click();
    window.setTimeout(() => {
      const entries = [...(root?.querySelectorAll('.text-binding-entry') ?? [])].map((entry) => {
        const fieldMap = Object.fromEntries(
          [...entry.querySelectorAll('.text-binding-field')].map((field) => [
            field.getAttribute('data-binding-field') ?? '',
            field.querySelector('.text-binding-value')?.textContent ?? ''
          ])
        );
        return {
          bindingId: entry.getAttribute('data-binding-id') ?? '',
          category: entry.getAttribute('data-binding-category') ?? '',
          presence: entry.getAttribute('data-binding-presence') ?? '',
          changed: entry.classList.contains('is-changed'),
          originalText: fieldMap.original ?? '',
          displayedText: fieldMap.displayed ?? '',
          replacementText: fieldMap.replacement ?? '',
          contextText: fieldMap.context ?? '',
          statusText: fieldMap.status ?? ''
        };
      });
      done({
        activeTab: root?.querySelector('.overlay-tab-button.is-active')?.getAttribute('data-tab') ?? null,
        entryCount: entries.length,
        summaryText: root?.querySelector('.texts-summary-card')?.textContent ?? '',
        emptyStateText: root?.querySelector('.texts-empty-state')?.textContent ?? '',
        entries
      });
    }, 75);
  `);
}

async function readStoredTextPageMap(driver, popupHandle, pageKey) {
  const previousHandle = await driver.getWindowHandle();
  await switchToHandle(driver, popupHandle);
  const envelope = await driver.executeAsyncScript(
    `
      const done = arguments[arguments.length - 1];
      chrome.storage.local.get(['lextrace.page.textMaps'], (items) => {
        done(items['lextrace.page.textMaps'] ?? null);
      });
    `
  );
  await switchToHandle(driver, previousHandle);
  return resolveStoredTextPageMap(envelope, pageKey);
}

function resolveStoredTextPageMap(envelope, expectedPageKey) {
  const pages = envelope?.pages && typeof envelope.pages === "object"
    ? envelope.pages
    : null;
  if (!pages) {
    return null;
  }

  if (pages[expectedPageKey]) {
    return pages[expectedPageKey];
  }

  const matchingEntries = Object.entries(pages)
    .map(([storedKey, pageMap]) => ({
      storedKey,
      pageMap,
      comparableKey: normalizeStoredPageKey(pageMap?.pageUrl ?? storedKey)
    }))
    .filter((entry) => entry.comparableKey === expectedPageKey)
    .sort(
      (left, right) =>
        Date.parse(String(right.pageMap?.updatedAt ?? 0)) - Date.parse(String(left.pageMap?.updatedAt ?? 0))
    );

  return matchingEntries[0]?.pageMap ?? null;
}

function normalizeStoredPageKey(rawUrl) {
  try {
    return normalizePageKey(rawUrl);
  } catch {
    return null;
  }
}

function parseTerminalJson(raw) {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function waitForTextMap(driver, popupHandle, pageKey, minimumBindings, message) {
  await waitFor(async () => {
    const pageMap = await readStoredTextPageMap(driver, popupHandle, pageKey);
    return (pageMap?.bindings?.length ?? 0) >= minimumBindings;
  }, TEXT_MAP_TIMEOUT_MS, message);
}

async function waitForTextMapToSettle(
  driver,
  popupHandle,
  pageKey,
  minimumBindings,
  message,
  timeoutMs = TEXT_MAP_TIMEOUT_MS
) {
  let lastSignature = null;
  let stableSince = 0;

  await waitFor(async () => {
    const pageMap = await readStoredTextPageMap(driver, popupHandle, pageKey);
    if ((pageMap?.bindings?.length ?? 0) < minimumBindings) {
      lastSignature = null;
      stableSince = 0;
      return false;
    }

    const signature = [
      pageMap.updatedAt ?? "",
      pageMap.lastScanAt ?? "",
      pageMap.bindings.length
    ].join("::");
    const now = Date.now();
    if (signature !== lastSignature) {
      lastSignature = signature;
      stableSince = now;
      return false;
    }

    return now - stableSince >= 1000;
  }, timeoutMs, message);
}

async function waitForTextMapToBecomeCheckpointSafe(driver, popupHandle, pageKey, minimumBindings, message) {
  const startedAt = Date.now();

  try {
    await waitForTextMapToSettle(
      driver,
      popupHandle,
      pageKey,
      minimumBindings,
      message,
      TEXT_MAP_SOFT_SETTLE_TIMEOUT_MS
    );
    const pageMap = await readStoredTextPageMap(driver, popupHandle, pageKey);
    return {
      status: "settled",
      elapsedMs: Date.now() - startedAt,
      bindingCount: pageMap?.bindings?.length ?? 0,
      updatedAt: pageMap?.updatedAt ?? null,
      lastScanAt: pageMap?.lastScanAt ?? null
    };
  } catch (error) {
    let pageMap = await readStoredTextPageMap(driver, popupHandle, pageKey);
    if ((pageMap?.bindings?.length ?? 0) < minimumBindings) {
      await waitForTextMap(driver, popupHandle, pageKey, minimumBindings, message);
      pageMap = await readStoredTextPageMap(driver, popupHandle, pageKey);
    }
    return {
      status: "noisy",
      elapsedMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
      bindingCount: pageMap?.bindings?.length ?? 0,
      updatedAt: pageMap?.updatedAt ?? null,
      lastScanAt: pageMap?.lastScanAt ?? null
    };
  }
}

async function readRuntimeLogs(driver, limit = 200) {
  const previousHandle = await driver.getWindowHandle();
  const result = await sendCommand(driver, "log.list", { limit });
  await switchToHandle(driver, previousHandle);
  return Array.isArray(result?.logs) ? result.logs : [];
}

async function capturePageHtml(driver, filePath) {
  let html = "";
  try {
    html = await driver.getPageSource();
  } catch {
    html = await driver.executeScript(`
      return document.documentElement.outerHTML;
    `);
  }
  await fs.writeFile(filePath, html, "utf8");
  return filePath;
}

async function captureScreenshot(driver, filePath) {
  const base64 = await driver.takeScreenshot();
  await fs.writeFile(filePath, base64, "base64");
  return filePath;
}

async function scrollDominantTarget(driver, amountPx) {
  return driver.executeScript(
    `
      const amount = arguments[0];

      function chooseTarget() {
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;
        const candidates = Array.from(document.querySelectorAll('*')).filter((element) => {
          if (!(element instanceof HTMLElement)) {
            return false;
          }
          if (element === document.body || element === document.documentElement) {
            return false;
          }
          const style = window.getComputedStyle(element);
          if (style.overflowY !== 'auto' && style.overflowY !== 'scroll') {
            return false;
          }
          if (element.scrollHeight <= element.clientHeight + 80) {
            return false;
          }
          const rect = element.getBoundingClientRect();
          return rect.width >= viewportWidth * 0.4 && rect.height >= viewportHeight * 0.4;
        });

        if (candidates.length === 0) {
          return null;
        }

        return candidates.reduce((best, element) => {
          const bestDepth = best.scrollHeight - best.clientHeight;
          const nextDepth = element.scrollHeight - element.clientHeight;
          return nextDepth > bestDepth ? element : best;
        });
      }

      const target = chooseTarget();
      if (target) {
        const before = target.scrollTop;
        target.scrollBy(0, amount);
        return {
          via: target.tagName.toLowerCase() + (target.id ? '#' + target.id : ''),
          before,
          after: target.scrollTop,
          deltaPx: Math.max(0, target.scrollTop - before),
          scrollHeight: target.scrollHeight
        };
      }

      const before = window.scrollY;
      window.scrollBy(0, amount);
      return {
        via: 'window',
        before,
        after: window.scrollY,
        deltaPx: Math.max(0, window.scrollY - before),
        scrollHeight: document.documentElement.scrollHeight
      };
    `,
    amountPx
  );
}

async function blankAllLiveBindingsViaTerminal(driver, popupHandle, pageKey) {
  const storedPageMap = await readStoredTextPageMap(driver, popupHandle, pageKey);
  const liveBindings = (storedPageMap?.bindings ?? []).filter((binding) => binding.presence === "live");
  const commandResult = await runOverlayTerminalCommand(driver, "text.blank page", 60000);
  assert.equal(
    commandResult.ok,
    true,
    `Bulk blank replacement failed: ${commandResult.error ?? "unknown error"}`
  );

  return {
    totalBindings: liveBindings.length,
    updatedCount: liveBindings.length,
    commandResult
  };
}

async function collectResidualVisibleTextDiagnostics(driver) {
  return driver.executeScript(`
    function buildSelector(element) {
      const parts = [];
      let current = element;
      while (current instanceof HTMLElement && parts.length < 5 && current !== document.body) {
        const name = current.tagName.toLowerCase();
        if (current.id) {
          parts.unshift(name + '#' + current.id);
          break;
        }
        let index = 1;
        let sibling = current;
        while ((sibling = sibling.previousElementSibling)) {
          if (sibling.tagName === current.tagName) {
            index += 1;
          }
        }
        parts.unshift(name + ':nth-of-type(' + index + ')');
        current = current.parentElement;
      }
      return parts.join(' > ');
    }

    function roundRect(rect) {
      return {
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        right: Math.round(rect.right),
        bottom: Math.round(rect.bottom)
      };
    }

    function buildUnionRect(range) {
      const rects = [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
      if (rects.length === 0) {
        return null;
      }
      const union = rects.reduce((accumulator, rect) => ({
        left: Math.min(accumulator.left, rect.left),
        top: Math.min(accumulator.top, rect.top),
        right: Math.max(accumulator.right, rect.right),
        bottom: Math.max(accumulator.bottom, rect.bottom)
      }), {
        left: rects[0].left,
        top: rects[0].top,
        right: rects[0].right,
        bottom: rects[0].bottom
      });
      return roundRect({
        left: union.left,
        top: union.top,
        right: union.right,
        bottom: union.bottom,
        width: union.right - union.left,
        height: union.bottom - union.top
      });
    }

    function snippet(html) {
      if (typeof html !== 'string') {
        return '';
      }
      return html.replace(/\\s+/g, ' ').trim().slice(0, 500);
    }

    function classifyReason(context) {
      if (context.bindingIdOnAncestor) {
        return 'visible-text-inside-bound-host-after-blank';
      }
      if (context.rootNodeType === 'shadow-root') {
        return 'shadow-dom-visible-text';
      }
      if (context.flags.insideSvg) {
        return 'svg-text';
      }
      if (context.flags.ariaHiddenAncestor) {
        return 'aria-hidden-visible-text';
      }
      if (context.flags.hiddenAncestor) {
        return 'hidden-ancestor-visible-text';
      }
      if (context.flags.insideYtFormattedString) {
        return 'youtube-formatted-string-unbound';
      }
      if (context.flags.insideInteractive) {
        return 'interactive-text-missed';
      }
      if (context.flags.insideBadgeOrTooltip) {
        return 'badge-or-tooltip-text';
      }
      return 'unclassified-visible-text';
    }

    const items = [];
    const seen = new Set();
    let totalVisibleTextNodesConsidered = 0;
    const root = document.body ?? document.documentElement;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!(node instanceof Text)) {
          return NodeFilter.FILTER_REJECT;
        }
        const text = (node.textContent ?? '').replace(/\\s+/g, ' ').trim();
        if (!text) {
          return NodeFilter.FILTER_REJECT;
        }
        const parent = node.parentElement;
        if (!(parent instanceof HTMLElement)) {
          return NodeFilter.FILTER_REJECT;
        }
        if (parent.closest('#lextrace-overlay-root, .lextrace-inline-text-editor, [data-lextrace-text-debug-skip="true"]')) {
          return NodeFilter.FILTER_REJECT;
        }
        if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'OPTION'].includes(parent.tagName)) {
          return NodeFilter.FILTER_REJECT;
        }

        const range = document.createRange();
        range.selectNodeContents(node);
        const rect = buildUnionRect(range);
        if (!rect || rect.width <= 0 || rect.height <= 0) {
          return NodeFilter.FILTER_REJECT;
        }
        if (rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth) {
          return NodeFilter.FILTER_REJECT;
        }
        const style = window.getComputedStyle(parent);
        if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity || '1') === 0) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    while (walker.nextNode()) {
      const node = walker.currentNode;
      const parent = node.parentElement;
      if (!(parent instanceof HTMLElement)) {
        continue;
      }
      totalVisibleTextNodesConsidered += 1;
      const text = (node.textContent ?? '').replace(/\\s+/g, ' ').trim();
      const selector = buildSelector(parent);
      const dedupeKey = selector + '::' + text;
      if (seen.has(dedupeKey)) {
        continue;
      }
      seen.add(dedupeKey);
      if (items.length >= 200) {
        continue;
      }

      const range = document.createRange();
      range.selectNodeContents(node);
      const rect = buildUnionRect(range);
      const boundAncestor = parent.closest('[data-lextrace-text-binding-id]');
      const interactiveAncestor = parent.closest('button, [role="button"], a');
      const badgeOrTooltipAncestor = parent.closest('yt-badge-supported-renderer, yt-tooltip, tp-yt-paper-tooltip');
      const ytFormattedAncestor = parent.closest('yt-formatted-string');
      const svgAncestor = parent.closest('svg');
      const ariaHiddenAncestor = parent.closest('[aria-hidden="true"]');
      const hiddenAncestor = parent.closest('[hidden]');
      const rootNode = parent.getRootNode();
      const computed = window.getComputedStyle(parent);

      const item = {
        text,
        selector,
        rect,
        parentTag: parent.tagName.toLowerCase(),
        parentRole: parent.getAttribute('role'),
        parentClassName: parent.className,
        bindingIdOnAncestor: boundAncestor?.getAttribute('data-lextrace-text-binding-id') ?? null,
        editableOnAncestor: boundAncestor?.getAttribute('data-lextrace-text-editable') ?? null,
        rootNodeType: rootNode instanceof ShadowRoot ? 'shadow-root' : 'document',
        computed: {
          display: computed.display,
          visibility: computed.visibility,
          opacity: computed.opacity,
          whiteSpace: computed.whiteSpace,
          textTransform: computed.textTransform
        },
        flags: {
          ariaHiddenAncestor: Boolean(ariaHiddenAncestor),
          hiddenAncestor: Boolean(hiddenAncestor),
          insideSvg: Boolean(svgAncestor),
          insideInteractive: Boolean(interactiveAncestor),
          insideBadgeOrTooltip: Boolean(badgeOrTooltipAncestor),
          insideYtFormattedString: parent.tagName === 'YT-FORMATTED-STRING' || Boolean(ytFormattedAncestor)
        },
        likelyReason: '',
        parentHtmlSnippet: snippet(parent.outerHTML)
      };

      item.likelyReason = classifyReason(item);
      items.push(item);
    }

    return {
      count: items.length,
      totalVisibleTextNodesConsidered,
      truncated: totalVisibleTextNodesConsidered > items.length,
      items
    };
  `);
}

async function dismissYouTubeInterference(driver) {
  await driver.actions().sendKeys("\uE00C").perform().catch(() => {});
  await delay(250);
  await driver.executeScript(`
    const labelMatches = [
      'reject all',
      'accept all',
      'i agree',
      'not now',
      'no thanks',
      'dismiss',
      'close',
      'skip',
      'continue without signing in',
      'stay signed out'
    ];

    function normalizedText(element) {
      return (
        element.innerText ??
        element.textContent ??
        element.getAttribute('aria-label') ??
        element.getAttribute('title') ??
        ''
      ).replace(/\\s+/g, ' ').trim().toLowerCase();
    }

    function isVisible(element) {
      if (!(element instanceof HTMLElement)) {
        return false;
      }
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        return false;
      }
      const style = window.getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || '1') > 0;
    }

    const selectors = [
      'button',
      '[role="button"]',
      'tp-yt-paper-button',
      'yt-button-shape button',
      'form[action*="consent"] button'
    ];

    const clicked = [];
    for (const element of document.querySelectorAll(selectors.join(','))) {
      if (!(element instanceof HTMLElement) || !isVisible(element)) {
        continue;
      }
      const label = normalizedText(element);
      if (!labelMatches.some((candidate) => label.includes(candidate))) {
        continue;
      }
      element.click();
      clicked.push(label);
    }

    for (const dialog of document.querySelectorAll('tp-yt-paper-dialog, ytd-popup-container, ytd-modal-with-title-and-button-renderer')) {
      if (!(dialog instanceof HTMLElement) || !isVisible(dialog)) {
        continue;
      }
      const closeButton = dialog.querySelector(
        'button[aria-label*="Close"], button[aria-label*="close"], [role="button"][aria-label*="Close"], [role="button"][aria-label*="close"]'
      );
      if (closeButton instanceof HTMLElement && isVisible(closeButton)) {
        closeButton.click();
      }
    }

    return clicked;
  `);
  await delay(500);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
