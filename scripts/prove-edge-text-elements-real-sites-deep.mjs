import assert from "node:assert/strict";
import path from "node:path";
import { promises as fs } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

import { Builder, Browser } from "selenium-webdriver";

import {
  ensureExtensionKeyMetadata,
  paths,
  writeJson
} from "./lib/common.mjs";
import {
  createEdgeOptions,
  ensurePopupReady,
  launchEdgeWithExtension,
  normalizePageKey,
  openBrowserTab,
  openConfigTab,
  prepareEdgeAiArtifacts,
  pruneBrowserTabs,
  sendCommand,
  setPopupRuntimeHandle,
  setSelectValue,
  switchToHandle,
  waitFor,
  waitForTabIdByUrl
} from "./lib/edge-ai-harness.mjs";

const REPORT_PATH = path.join(paths.artifacts, "test-results", "edge-text-elements-real-sites-deep-report.json");
const OUTPUT_ROOT = path.join(paths.artifacts, "test-results", "edge-text-elements-real-sites-deep");
const DEFAULT_REAL_PROFILE_ROOT = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, "Microsoft", "Edge", "User Data")
  : null;
const SITE_SCROLL_TARGET_PX = 60000;
const SITE_SCROLL_STEP_PX = 2500;
const SITE_SCROLL_WAIT_MS = 1800;
const SITE_SCROLL_MAX_STEPS = 36;
const SCREENSHOT_CHECKPOINT_PX = 5000;
const PAGE_READY_TIMEOUT_MS = 90000;
const PAGE_SETTLE_TIMEOUT_MS = 30000;
const DRIVER_SCRIPT_TIMEOUT_MS = 300000;
const DRIVER_PAGELOAD_TIMEOUT_MS = 300000;
const TEXT_SCAN_TIMEOUT_MS = 120000;
const TEXT_MAP_TIMEOUT_MS = 90000;
const PROOF_BLOCK_HOST_ID = "lextrace-real-sites-proof-host";
const REAL_SITES = [
  {
    key: "openapi310",
    label: "OpenAPI 3.1.0",
    url: "https://spec.openapis.org/oas/v3.1.0.html",
    loadWaitMs: 6000
  },
  {
    key: "openapi303",
    label: "OpenAPI 3.0.3",
    url: "https://spec.openapis.org/oas/v3.0.3.html",
    loadWaitMs: 6000
  },
  {
    key: "openapi302",
    label: "OpenAPI 3.0.2",
    url: "https://spec.openapis.org/oas/v3.0.2.html",
    loadWaitMs: 6000
  },
  {
    key: "openapi301",
    label: "OpenAPI 3.0.1",
    url: "https://spec.openapis.org/oas/v3.0.1.html",
    loadWaitMs: 6000
  },
  {
    key: "openapi300",
    label: "OpenAPI 3.0.0",
    url: "https://spec.openapis.org/oas/v3.0.0.html",
    loadWaitMs: 6000
  },
  {
    key: "openapi20",
    label: "OpenAPI 2.0",
    url: "https://spec.openapis.org/oas/v2.0.html",
    loadWaitMs: 6000
  },
  {
    key: "postgresql",
    label: "PostgreSQL Book Index",
    url: "https://www.postgresql.org/docs/current/bookindex.html",
    loadWaitMs: 3000
  },
  {
    key: "kernel-devices",
    label: "Linux Allocated Devices",
    url: "https://www.kernel.org/doc/html/latest/admin-guide/devices.html",
    loadWaitMs: 3000
  },
  {
    key: "kernel-cgroupv2",
    label: "Linux Control Group v2",
    url: "https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html",
    loadWaitMs: 3000
  },
  {
    key: "kernel",
    label: "Linux Kernel Parameters",
    url: "https://www.kernel.org/doc/html/latest/admin-guide/kernel-parameters.html",
    loadWaitMs: 3000
  }
];

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const sites = filterSites(options.onlyKeys);
  if (sites.length === 0) {
    throw new Error("No sites selected. Pass valid values to --only.");
  }

  await prepareEdgeAiArtifacts({
    reuseArtifacts: options.reuseArtifacts,
    runPreflight: options.runPreflight
  });

  const extensionMetadata = await ensureExtensionKeyMetadata();
  const popupUrl = `chrome-extension://${extensionMetadata.extensionId}/popup.html`;
  await fs.rm(OUTPUT_ROOT, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(OUTPUT_ROOT, { recursive: true });
  const report = {
    executedAt: new Date().toISOString(),
    popupUrl,
    reportPath: REPORT_PATH,
    outputRoot: OUTPUT_ROOT,
    options: {
      useRealProfile: options.useRealProfile,
      realProfileRoot: options.useRealProfile ? (options.realProfileRoot ?? DEFAULT_REAL_PROFILE_ROOT) : null,
      profileDirectory: options.useRealProfile ? options.profileDirectory : null,
      reuseInstalledExtension: options.reuseInstalledExtension,
      reuseArtifacts: options.reuseArtifacts,
      runPreflight: options.runPreflight,
      onlyKeys: options.onlyKeys
    },
    sites: []
  };

  for (const site of sites) {
    const siteDir = path.join(OUTPUT_ROOT, site.key);
    await fs.mkdir(siteDir, { recursive: true });
    const siteResult = await runSiteProofInFreshBrowser({
      options,
      popupUrl,
      site,
      siteDir
    });
    report.sites.push(siteResult);
    await writeJson(REPORT_PATH, report);
  }

  report.summary = {
    total: report.sites.length,
    passed: report.sites.filter((site) => !site.error).length,
    failed: report.sites.filter((site) => site.error).length,
    meets50kActualScroll: report.sites.filter((site) => site.scrollProof?.actualScrollPx >= 50000).length
  };
  await writeJson(REPORT_PATH, report);
  console.log(`Deep real-site proof saved to ${REPORT_PATH}`);

  if (report.sites.some((site) => site.error)) {
    process.exitCode = 1;
  }
}

async function runSiteProofInFreshBrowser({ options, popupUrl, site, siteDir }) {
  const browserSession = await launchProofBrowser(options);
  let popupHandle = null;
  let mainHandle = null;

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

    return await runSiteProof(driver, {
      site,
      siteDir,
      popupHandle,
      mainHandle
    });
  } finally {
    setPopupRuntimeHandle(null);
    await browserSession.driver.quit().catch(() => {});
    if (browserSession.userDataDir) {
      await fs.rm(browserSession.userDataDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

function parseArgs(args) {
  const onlyArg = args.find((value) => value.startsWith("--only="))
    ?? (args.includes("--only") ? args[args.indexOf("--only") + 1] : null);

  return {
    onlyKeys: onlyArg
      ? onlyArg.replace("--only=", "").split(",").map((value) => value.trim()).filter(Boolean)
      : [],
    useRealProfile: !args.includes("--test-profile"),
    reuseInstalledExtension: args.includes("--reuse-installed-extension"),
    reuseArtifacts: args.includes("--reuse-artifacts"),
    runPreflight: args.includes("--run-preflight"),
    realProfileRoot: args.find((value) => value.startsWith("--real-profile-root="))
      ?.slice("--real-profile-root=".length)
      ?? null,
    profileDirectory: args.find((value) => value.startsWith("--profile-directory="))
      ?.slice("--profile-directory=".length)
      ?? "Default"
  };
}

function filterSites(onlyKeys) {
  if (!onlyKeys || onlyKeys.length === 0) {
    return REAL_SITES;
  }

  const wanted = new Set(onlyKeys.map((value) => value.toLowerCase()));
  return REAL_SITES.filter((site) => wanted.has(site.key.toLowerCase()));
}

async function launchProofBrowser(options) {
  if (!options.useRealProfile) {
    const session = await launchEdgeWithExtension();
    return {
      ...session,
      profileRoot: null,
      profileDirectory: null
    };
  }

  const profileRoot = options.realProfileRoot ?? DEFAULT_REAL_PROFILE_ROOT;
  if (!profileRoot) {
    throw new Error("Cannot determine the default Edge profile root. Pass --real-profile-root=<path>.");
  }

  const edgeOptions = createEdgeOptions(profileRoot);
  edgeOptions.addArguments(`--profile-directory=${options.profileDirectory}`);
  if (!options.reuseInstalledExtension) {
    edgeOptions.addExtensions(paths.packagedCrx);
  }

  const driver = await new Builder()
    .forBrowser(Browser.EDGE)
    .setEdgeOptions(edgeOptions)
    .build();

  return {
    driver,
    userDataDir: null,
    profileRoot,
    profileDirectory: options.profileDirectory
  };
}

async function enableTextDebugConfig(driver) {
  await openConfigTab(driver);
  await setSelectValueWithRetry(driver, "debug.textElements.highlightEnabled", "true");
  await setSelectValueWithRetry(driver, "debug.textElements.inlineEditingEnabled", "true");
  await setSelectValueWithRetry(driver, "debug.textElements.displayMode", "effective");
  await setSelectValueWithRetry(driver, "debug.textElements.autoScanMode", "incremental");
}

async function setSelectValueWithRetry(driver, configPath, value) {
  await waitFor(async () => {
    const present = await driver.executeScript(
      `return !!document.querySelector("button[data-config-path='" + arguments[0] + "']");`,
      configPath
    );
    return present === true;
  }, 10000, `Popup config control did not appear for ${configPath}.`);

  let lastError = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await setSelectValue(driver, configPath, value);
      return;
    } catch (error) {
      lastError = error;
      await delay(250);
    }
  }

  throw lastError ?? new Error(`Failed to set popup select ${configPath}.`);
}

async function runSiteProof(driver, context) {
  const { site, siteDir, popupHandle, mainHandle } = context;
  const result = {
    key: site.key,
    label: site.label,
    url: site.url,
    siteDir,
    screenshots: [],
    error: null
  };

  try {
    await recordTestLog(driver, "proof.real-sites.site.start", `Start ${site.key}`, {
      siteKey: site.key,
      siteLabel: site.label,
      url: site.url
    });

    await switchToHandle(driver, mainHandle);
    await navigateToSite(driver, site.url, site.loadWaitMs);
    await dismissCommonInterference(driver);
    await waitForPageStateToSettle(driver, site.url, PAGE_SETTLE_TIMEOUT_MS, 1200);

    const currentUrl = await driver.getCurrentUrl();
    let pageKey = normalizePageKey(currentUrl);
    result.currentUrl = currentUrl;
    result.pageKey = pageKey;

    await ensureOverlayOpenForCurrentPage(driver);
    const scanResult = await runOverlayTerminalCommand(driver, "text.scan", TEXT_SCAN_TIMEOUT_MS);
    assert.equal(scanResult.ok, true, `text.scan failed on ${site.key}: ${scanResult.error ?? "unknown error"}`);
    const scanStatus = parseTerminalJson(scanResult.lastTerminalResult);
    if (typeof scanStatus?.pageKey === "string" && scanStatus.pageKey.trim().length > 0) {
      pageKey = scanStatus.pageKey;
      result.pageKey = pageKey;
    }
    if (typeof scanStatus?.pageUrl === "string" && scanStatus.pageUrl.trim().length > 0) {
      result.currentUrl = scanStatus.pageUrl;
    }
    await waitForTextMap(driver, popupHandle, pageKey, 1, `Stored text map did not appear for ${site.key}.`);
    await waitForTextMapToSettle(
      driver,
      popupHandle,
      pageKey,
      1,
      `Stored text map did not settle after text.scan on ${site.key}.`
    );

    const baseline = await captureStructuredSiteArtifacts(driver, {
      popupHandle,
      siteDir,
      pageKey,
      phase: "baseline"
    });
    result.baseline = {
      entryCount: baseline.textsSnapshot.entryCount,
      highlightCount: baseline.highlightSnapshot.count,
      storedBindingCount: baseline.storedPageMap?.bindings?.length ?? 0,
      terminalResult: scanResult.lastTerminalResult,
      pageHtmlPath: baseline.files.pageHtmlPath,
      textMapPath: baseline.files.textMapPath,
      logsPath: baseline.files.logsPath,
      textsSnapshotPath: baseline.files.textsSnapshotPath,
      highlightSnapshotPath: baseline.files.highlightSnapshotPath
    };

    await closeOverlay(driver);
    const baselineScreenshotPath = path.join(siteDir, "01-baseline-highlighted.png");
    await captureScreenshot(driver, baselineScreenshotPath);
    result.screenshots.push(baselineScreenshotPath);

    const autoscan = await performAutoscanProof(driver, {
      popupHandle,
      siteDir,
      siteKey: site.key,
      pageKey
    });
    result.autoscan = autoscan.summary;
    result.screenshots.push(autoscan.screenshotPath);

    const inlineEdit = await performInlineEditProof(driver, {
      popupHandle,
      siteDir,
      pageKey,
      proofBlock: autoscan.proofBlock,
      proofBindings: autoscan.proofBindings
    });
    result.inlineEdit = inlineEdit.summary;
    result.screenshots.push(inlineEdit.screenshotPath);

    const scrollProof = await performDeepScrollProof(driver, {
      siteDir,
      siteKey: site.key
    });
    assert.ok(scrollProof.actualScrollReached50k, `Deep scroll did not reach 50k actual pixels on ${site.key}.`);
    result.scrollProof = scrollProof;
    result.screenshots.push(...scrollProof.screenshotPaths);

    await scrollAllTargetsToTop(driver);
    await delay(1000);

    const blanking = await performBlankingProof(driver, {
      popupHandle,
      siteDir,
      pageKey,
      proofBlock: autoscan.proofBlock
    });
    result.blanking = blanking.summary;
    result.screenshots.push(blanking.screenshotPath);

    const finalArtifacts = await captureStructuredSiteArtifacts(driver, {
      popupHandle,
      siteDir,
      pageKey,
      phase: "final"
    });
    result.final = {
      entryCount: finalArtifacts.textsSnapshot.entryCount,
      highlightCount: finalArtifacts.highlightSnapshot.count,
      storedBindingCount: finalArtifacts.storedPageMap?.bindings?.length ?? 0,
      pageHtmlPath: finalArtifacts.files.pageHtmlPath,
      textMapPath: finalArtifacts.files.textMapPath,
      logsPath: finalArtifacts.files.logsPath,
      textsSnapshotPath: finalArtifacts.files.textsSnapshotPath,
      highlightSnapshotPath: finalArtifacts.files.highlightSnapshotPath
    };

    await recordTestLog(driver, "proof.real-sites.site.finish", `Finish ${site.key}`, {
      siteKey: site.key,
      pageKey,
      actualScrollPx: result.scrollProof.actualScrollPx,
      residualVisibleTextCount: result.blanking.residualVisibleTextCount
    });
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    try {
      const errorScreenshotPath = path.join(siteDir, "99-error.png");
      await captureScreenshot(driver, errorScreenshotPath);
      result.screenshots.push(errorScreenshotPath);
    } catch {
      // Best-effort diagnostics only.
    }
    try {
      const errorHtmlPath = path.join(siteDir, "99-error.html");
      await capturePageHtml(driver, errorHtmlPath);
      result.errorHtmlPath = errorHtmlPath;
    } catch {
      // Best-effort diagnostics only.
    }
  }

  return result;
}

async function captureStructuredSiteArtifacts(driver, options) {
  const { popupHandle, siteDir, pageKey, phase } = options;
  const currentUrl = await driver.getCurrentUrl();
  await ensureOverlayOpenForCurrentPage(driver);
  const textsSnapshot = await getTextsTabSnapshot(driver);
  const highlightSnapshot = await getHighlightSnapshot(driver);
  const storedPageMap = await readStoredTextPageMap(driver, popupHandle, pageKey);
  const runtimeLogs = await readRuntimeLogs(driver, 250);
  const pageState = await readPageState(driver);
  const pageHtmlPath = path.join(siteDir, `${phase}-page.html`);
  const textMapPath = path.join(siteDir, `${phase}-text-map.json`);
  const textsSnapshotPath = path.join(siteDir, `${phase}-texts-snapshot.json`);
  const highlightSnapshotPath = path.join(siteDir, `${phase}-highlight-snapshot.json`);
  const logsPath = path.join(siteDir, `${phase}-runtime-logs.json`);
  const pageStatePath = path.join(siteDir, `${phase}-page-state.json`);

  await capturePageHtml(driver, pageHtmlPath);
  await writeJson(textMapPath, storedPageMap);
  await writeJson(textsSnapshotPath, textsSnapshot);
  await writeJson(highlightSnapshotPath, highlightSnapshot);
  await writeJson(logsPath, {
    currentUrl,
    pageKey,
    logs: runtimeLogs
  });
  await writeJson(pageStatePath, pageState);

  return {
    currentUrl,
    textsSnapshot,
    highlightSnapshot,
    storedPageMap,
    runtimeLogs,
    files: {
      pageHtmlPath,
      textMapPath,
      textsSnapshotPath,
      highlightSnapshotPath,
      logsPath,
      pageStatePath
    }
  };
}

async function performAutoscanProof(driver, options) {
  const { popupHandle, siteDir, siteKey, pageKey } = options;
  const beforeMap = await readStoredTextPageMap(driver, popupHandle, pageKey);
  assert.ok(beforeMap?.lastScanAt, "Baseline page map is missing lastScanAt before autoscan proof.");
  const beforeBindingCount = beforeMap?.bindings?.length ?? 0;
  const beforeUpdatedAt = beforeMap?.updatedAt ?? null;

  await beginHighlightMutationWatch(driver);
  const proofBlock = await injectProofBlock(driver, siteKey);
  const startedAt = Date.now();
  let proofDebugState = null;
  let storedAutoscanDetected = false;

  let afterMap = null;
  await waitFor(async () => {
    afterMap = await readStoredTextPageMap(driver, popupHandle, pageKey);
    proofDebugState = await readProofDebugState(driver, proofBlock);
    storedAutoscanDetected = Boolean(
      afterMap &&
      afterMap.lastScanAt === beforeMap.lastScanAt &&
      afterMap.updatedAt !== beforeUpdatedAt &&
      (afterMap.bindings?.length ?? 0) > beforeBindingCount &&
      afterMap.bindings?.some((binding) => binding.originalText.includes(proofBlock.headingText)) &&
      afterMap.bindings?.some((binding) => binding.originalText.includes(proofBlock.paragraphText))
    );
    const runtimeAutoscanDetected = Boolean(
      proofDebugState?.headingBindingId &&
      proofDebugState?.paragraphBindingId
    );
    return storedAutoscanDetected || runtimeAutoscanDetected;
  }, 60000, `Incremental autoscan did not discover the proof block on ${siteKey}.`);

  const highlightMutation = await finishHighlightMutationWatch(driver);
  const autoscanHighlightSnapshot = await getHighlightSnapshot(driver);
  proofDebugState = proofDebugState ?? await readProofDebugState(driver, proofBlock);
  assert.equal(
    highlightMutation.removed,
    0,
    `Incremental autoscan replaced existing highlight boxes instead of extending them on ${siteKey}.`
  );
  assert.ok(
    highlightMutation.added > 0 ||
      autoscanHighlightSnapshot.count > beforeBindingCount ||
      Boolean(proofDebugState.headingBindingId && proofDebugState.paragraphBindingId),
    `Incremental autoscan did not expose any new highlight evidence for the injected block on ${siteKey}.`
  );

  await ensureOverlayOpenForCurrentPage(driver);
  const textsSnapshot = await getTextsTabSnapshot(driver);
  assert.ok(
    textsSnapshot.entries.some((entry) => entry.originalText.includes(proofBlock.headingText)),
    `Texts tab did not render the injected heading binding on ${siteKey}.`
  );
  assert.ok(
    textsSnapshot.entries.some((entry) => entry.originalText.includes(proofBlock.paragraphText)),
    `Texts tab did not render the injected paragraph binding on ${siteKey}.`
  );
  afterMap = (await readStoredTextPageMap(driver, popupHandle, pageKey)) ?? afterMap;
  proofDebugState = await readProofDebugState(driver, proofBlock);

  const proofBindings = {
    headingBindingId: afterMap?.bindings?.find((binding) => binding.originalText.includes(proofBlock.headingText))?.bindingId
      ?? proofDebugState?.headingBindingId
      ?? null,
    paragraphBindingId: afterMap?.bindings?.find((binding) => binding.originalText.includes(proofBlock.paragraphText))?.bindingId
      ?? proofDebugState?.paragraphBindingId
      ?? null
  };
  assert.ok(proofBindings.headingBindingId, `Heading binding was not persisted for ${siteKey}.`);
  assert.ok(proofBindings.paragraphBindingId, `Paragraph binding was not persisted for ${siteKey}.`);

  await closeOverlay(driver);
  const screenshotPath = path.join(siteDir, "02-autoscan-proof.png");
  await captureScreenshot(driver, screenshotPath);

  const autoscanLogs = (await readRuntimeLogs(driver, 120))
    .filter((entry) => String(entry?.event ?? "").startsWith("text."))
    .slice(-25);
  const logsPath = path.join(siteDir, "autoscan-runtime-logs.json");
  await writeJson(logsPath, autoscanLogs);

  return {
    proofBlock,
    proofBindings,
    screenshotPath,
    summary: {
      headingText: proofBlock.headingText,
      paragraphText: proofBlock.paragraphText,
      headingBindingId: proofBindings.headingBindingId,
      paragraphBindingId: proofBindings.paragraphBindingId,
      storedAutoscanDetected,
      lastScanPreserved: afterMap?.lastScanAt === beforeMap.lastScanAt,
      updatedAtChanged: afterMap?.updatedAt !== beforeUpdatedAt,
      bindingCountBefore: beforeBindingCount,
      bindingCountAfter: afterMap?.bindings?.length ?? 0,
      detectionLatencyMs: Date.now() - startedAt,
      highlightMutation,
      highlightCountAfter: autoscanHighlightSnapshot.count,
      proofDebugState,
      logsPath
    }
  };
}

async function performInlineEditProof(driver, options) {
  const { popupHandle, siteDir, pageKey, proofBlock, proofBindings } = options;
  await scrollAllTargetsToTop(driver);
  await delay(500);

  await beginHighlightMutationWatch(driver);
  const editedText = `LexTrace blank-proof edit ${Date.now()}`;
  const commandResult = await runOverlayTerminalCommand(
    driver,
    `text.set ${proofBindings.paragraphBindingId} -- ${editedText}`,
    60000
  );
  assert.equal(commandResult.ok, true, `Element edit failed: ${commandResult.error ?? "unknown error"}`);
  await waitForPageText(driver, proofBlock.paragraphSelector, editedText);
  const highlightMutation = await finishHighlightMutationWatch(driver);
  assert.equal(
    highlightMutation.removed,
    0,
    "Inline edit rebuilt existing debug boxes instead of updating the edited binding in place."
  );

  const storedPageMap = await readStoredTextPageMap(driver, popupHandle, pageKey);
  const editedBinding = storedPageMap?.bindings?.find((binding) => binding.bindingId === proofBindings.paragraphBindingId);
  assert.equal(
    editedBinding?.replacementText,
    editedText,
    "Inline edit did not persist replacementText for the proof paragraph."
  );
  assert.equal(editedBinding?.changed, true, "Inline edit did not mark the proof paragraph as changed.");

  const highlightSnapshot = await getHighlightSnapshot(driver);
  const elementDebugState = await driver.executeScript(
    `
      const element = document.querySelector(arguments[0]);
      return {
        bindingId: element?.getAttribute('data-lextrace-text-binding-id') ?? null,
        editable: element?.getAttribute('data-lextrace-text-editable') ?? null
      };
    `,
    proofBlock.paragraphSelector
  );

  await closeOverlay(driver);
  const screenshotPath = path.join(siteDir, "03-inline-edit-proof.png");
  await captureScreenshot(driver, screenshotPath);
  const editLogs = (await readRuntimeLogs(driver, 120))
    .filter((entry) => String(entry?.event ?? "").startsWith("text."))
    .slice(-25);
  const logsPath = path.join(siteDir, "inline-edit-runtime-logs.json");
  await writeJson(logsPath, editLogs);

  return {
    screenshotPath,
    summary: {
      bindingId: proofBindings.paragraphBindingId,
      editedText,
      highlightMutation,
      elementDebugState,
      changedHighlightCount: highlightSnapshot.changedCount,
      totalHighlightCount: highlightSnapshot.count,
      logsPath
    }
  };
}

async function performDeepScrollProof(driver, options) {
  const { siteDir, siteKey } = options;
  const checkpoints = [];
  const screenshotPaths = [];
  let requestedScrollPx = 0;
  let actualScrollPx = 0;
  let lastCheckpointThreshold = 0;
  let stagnantSteps = 0;

  for (let step = 1; step <= SITE_SCROLL_MAX_STEPS && requestedScrollPx < SITE_SCROLL_TARGET_PX; step += 1) {
    const scrollStep = await scrollDominantTarget(driver, SITE_SCROLL_STEP_PX);
    requestedScrollPx += SITE_SCROLL_STEP_PX;
    actualScrollPx += scrollStep.deltaPx;
    stagnantSteps = scrollStep.deltaPx <= 2 ? stagnantSteps + 1 : 0;
    await delay(SITE_SCROLL_WAIT_MS);

    const highlightSnapshot = await getHighlightSnapshot(driver);
    const checkpoint = {
      step,
      via: scrollStep.via,
      before: scrollStep.before,
      after: scrollStep.after,
      deltaPx: scrollStep.deltaPx,
      requestedScrollPx,
      actualScrollPx,
      scrollHeight: scrollStep.scrollHeight,
      highlightCount: highlightSnapshot.count
    };

    const shouldCapture =
      step === 1 ||
      actualScrollPx >= lastCheckpointThreshold + SCREENSHOT_CHECKPOINT_PX ||
      requestedScrollPx >= lastCheckpointThreshold + SCREENSHOT_CHECKPOINT_PX;

    if (shouldCapture) {
      const filePath = path.join(siteDir, `scroll-${String(step).padStart(2, "0")}.png`);
      await captureScreenshot(driver, filePath);
      screenshotPaths.push(filePath);
      checkpoint.screenshotPath = filePath;
      lastCheckpointThreshold = Math.max(actualScrollPx, requestedScrollPx);
    }

    checkpoints.push(checkpoint);

    if (stagnantSteps >= 6 && requestedScrollPx >= SITE_SCROLL_TARGET_PX) {
      break;
    }
  }

  const checkpointsPath = path.join(siteDir, "scroll-proof.json");
  await writeJson(checkpointsPath, checkpoints);
  await recordTestLog(driver, "proof.real-sites.scroll", `Scroll proof ${siteKey}`, {
    siteKey,
    requestedScrollPx,
    actualScrollPx,
    checkpoints: checkpoints.length
  });

  return {
    requestedScrollPx,
    actualScrollPx,
    screenshotPaths,
    checkpointsPath,
    checkpoints,
    actualScrollReached50k: actualScrollPx >= 50000
  };
}

async function performBlankingProof(driver, options) {
  const { popupHandle, siteDir, pageKey, proofBlock } = options;
  await scrollAllTargetsToTop(driver);
  await delay(500);

  const blankedTextResult = await blankAllLiveBindingsViaTerminal(driver, popupHandle, pageKey);
  const blankedMediaResult = await blankPageMedia(driver);
  await closeOverlay(driver);
  await delay(1200);
  const screenshotPath = path.join(siteDir, "04-blanked-page.png");
  await captureScreenshot(driver, screenshotPath);

  const residualVisibleText = await collectResidualVisibleText(driver);
  const residualPath = path.join(siteDir, "blanking-residual-visible-text.json");
  await writeJson(residualPath, residualVisibleText);
  const blankLogs = (await readRuntimeLogs(driver, 150))
    .filter((entry) => String(entry?.event ?? "").startsWith("text."))
    .slice(-40);
  const logsPath = path.join(siteDir, "blanking-runtime-logs.json");
  await writeJson(logsPath, blankLogs);
  const blankingState = await readBlankingState(driver, popupHandle, pageKey, proofBlock);
  const blankingStatePath = path.join(siteDir, "blanking-state.json");
  await writeJson(blankingStatePath, {
    command: blankedTextResult.commandResult,
    expectedUpdatedCount: blankedTextResult.updatedCount,
    mediaBlanking: blankedMediaResult,
    ...blankingState
  });

  assert.ok(
    blankingState.blankReplacementCount >= blankedTextResult.updatedCount,
    "Stored page map did not persist empty-string replacements for the blanking proof."
  );
  assert.ok(
    isBlankTerminalText(blankingState.proofHeadingText) && isBlankTerminalText(blankingState.proofParagraphText),
    "Proof texts remained visible after text.blank page."
  );

  return {
    screenshotPath,
    summary: {
      textBindingCount: blankedTextResult.totalBindings,
      blankedLiveBindingCount: blankedTextResult.updatedCount,
      mediaBlanking: blankedMediaResult,
      storedBlankReplacementCount: blankingState.blankReplacementCount,
      proofElementsPresent: blankingState.proofElementsPresent,
      proofHeadingText: blankingState.proofHeadingText,
      proofParagraphText: blankingState.proofParagraphText,
      residualVisibleTextCount: residualVisibleText.count,
      residualVisibleTextSample: residualVisibleText.items.slice(0, 12),
      residualVisibleTextPath: residualPath,
      logsPath,
      blankingStatePath
    }
  };
}

async function navigateToSite(driver, url, loadWaitMs) {
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
  await delay(loadWaitMs);
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

async function readPageState(driver) {
  return driver.executeScript(`
    const bodyMetric = document.body?.childElementCount ?? 0;
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
        const failedRaw = entry?.details?.raw;
        if (typeof failedRaw === "string" && failedRaw.length > 0) {
          return failedRaw === command;
        }
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

async function getHighlightSnapshot(driver) {
  return driver.executeScript(`
    const registry = typeof CSS !== 'undefined' && 'highlights' in CSS ? CSS.highlights : null;
    const nativeRangeCount =
      Number(registry?.get?.('lextrace-text-source')?.size ?? 0) +
      Number(registry?.get?.('lextrace-text-changed')?.size ?? 0);
    const items = [...document.querySelectorAll('[data-lextrace-text-highlight-box="true"]')].map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        bindingId: element.getAttribute('data-lextrace-text-binding-id') ?? '',
        debugState: element.getAttribute('data-lextrace-text-debug') ?? '',
        rect: {
          left: Math.round(rect.left),
          top: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        }
      };
    });
    return {
      count: items.length + nativeRangeCount,
      overlayBoxCount: items.length,
      nativeRangeCount,
      sourceCount: items.filter((item) => item.debugState === 'source').length,
      changedCount: items.filter((item) => item.debugState === 'changed').length,
      items
    };
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
    .sort((left, right) => Date.parse(String(right.pageMap?.updatedAt ?? 0)) - Date.parse(String(left.pageMap?.updatedAt ?? 0)));

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

async function waitForTextMapToSettle(driver, popupHandle, pageKey, minimumBindings, message) {
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
  }, TEXT_MAP_TIMEOUT_MS, message);
}

async function readRuntimeLogs(driver, limit = 200) {
  const previousHandle = await driver.getWindowHandle();
  const result = await sendCommand(driver, "log.list", { limit });
  await switchToHandle(driver, previousHandle);
  return Array.isArray(result?.logs) ? result.logs : [];
}

async function recordTestLog(driver, event, summary, details) {
  const previousHandle = await driver.getWindowHandle();
  await sendCommand(driver, "log.record", {
    level: "info",
    source: "tests",
    event,
    summary,
    details
  });
  await switchToHandle(driver, previousHandle);
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

async function injectProofBlock(driver, siteKey) {
  const token = `${siteKey}-${Date.now()}`;
  const proofBlock = {
    token,
    hostSelector: `#${PROOF_BLOCK_HOST_ID} [data-lextrace-proof-token="${token}"]`,
    headingSelector: `#${PROOF_BLOCK_HOST_ID} [data-lextrace-proof-token="${token}"] [data-lextrace-proof-role="heading"]`,
    paragraphSelector: `#${PROOF_BLOCK_HOST_ID} [data-lextrace-proof-token="${token}"] [data-lextrace-proof-role="paragraph"]`,
    headingText: `LexTrace proof heading ${token}`,
    paragraphText: `LexTrace proof paragraph ${token}`
  };

  await driver.executeScript(
    `
      const token = arguments[0];
      const headingText = arguments[1];
      const paragraphText = arguments[2];
      let host = document.getElementById(arguments[3]);
      if (!(host instanceof HTMLElement)) {
        host = document.createElement('div');
        host.id = arguments[3];
        host.style.display = 'block';
        host.style.margin = '0';
        host.style.padding = '0';
        if (document.body instanceof HTMLBodyElement) {
          document.body.prepend(host);
        } else {
          document.documentElement.appendChild(host);
        }
      }

      const block = document.createElement('section');
      block.setAttribute('data-lextrace-proof-token', token);
      block.style.position = 'relative';
      block.style.zIndex = '2147483000';
      block.style.margin = '16px';
      block.style.padding = '18px';
      block.style.border = '2px dashed #d97706';
      block.style.background = '#fff7d6';
      block.style.color = '#111111';
      block.style.font = '16px/1.45 Segoe UI, Arial, sans-serif';
      block.style.boxShadow = '0 8px 24px rgba(0,0,0,0.12)';
      block.style.maxWidth = '720px';

      const heading = document.createElement('h2');
      heading.setAttribute('data-lextrace-proof-role', 'heading');
      heading.style.margin = '0 0 8px';
      heading.textContent = headingText;

      const paragraph = document.createElement('p');
      paragraph.setAttribute('data-lextrace-proof-role', 'paragraph');
      paragraph.style.margin = '0';
      paragraph.textContent = paragraphText;

      block.append(heading, paragraph);
      host.prepend(block);
    `,
    proofBlock.token,
    proofBlock.headingText,
    proofBlock.paragraphText,
    PROOF_BLOCK_HOST_ID
  );

  return proofBlock;
}

async function readProofDebugState(driver, proofBlock) {
  return driver.executeScript(
    `
      const heading = document.querySelector(arguments[0]);
      const paragraph = document.querySelector(arguments[1]);
      return {
        headingBindingId: heading?.getAttribute('data-lextrace-text-binding-id') ?? null,
        paragraphBindingId: paragraph?.getAttribute('data-lextrace-text-binding-id') ?? null,
        headingEditable: heading?.getAttribute('data-lextrace-text-editable') ?? null,
        paragraphEditable: paragraph?.getAttribute('data-lextrace-text-editable') ?? null
      };
    `,
    proofBlock.headingSelector,
    proofBlock.paragraphSelector
  );
}

async function beginHighlightMutationWatch(driver) {
  await driver.executeScript(`
    const layer = document.querySelector('.lextrace-text-highlight-layer');
    if (!(layer instanceof HTMLElement)) {
      window.__lextraceHighlightMutationWatch = { observer: null, stats: null };
      return;
    }

    const stats = { added: 0, removed: 0 };
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        stats.added += record.addedNodes.length;
        stats.removed += record.removedNodes.length;
      }
    });
    observer.observe(layer, { childList: true });
    window.__lextraceHighlightMutationWatch = { observer, stats };
  `);
}

async function finishHighlightMutationWatch(driver) {
  return driver.executeScript(`
    const watch = window.__lextraceHighlightMutationWatch;
    if (!watch || !watch.stats) {
      return { added: 0, removed: 0 };
    }

    watch.observer?.disconnect?.();
    window.__lextraceHighlightMutationWatch = null;
    return {
      added: Number(watch.stats.added ?? 0),
      removed: Number(watch.stats.removed ?? 0)
    };
  `);
}

async function triggerInlineEditor(driver, selector) {
  await driver.executeScript(
    `
      const element = document.querySelector(arguments[0]);
      if (!(element instanceof HTMLElement)) {
        throw new Error('Inline edit target is unavailable for ' + arguments[0]);
      }
      element.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        button: 2,
        buttons: 2,
        view: window
      }));
    `,
    selector
  );

  await waitFor(async () => {
    const present = await driver.executeScript(`
      return document.querySelector('.lextrace-inline-text-editor') instanceof HTMLElement;
    `);
    return present === true;
  }, 5000, `Inline editor did not appear for ${selector}.`);
}

async function commitInlineEditor(driver, value) {
  await driver.executeScript(
    `
      const editor = document.querySelector('.lextrace-inline-text-editor');
      if (!(editor instanceof HTMLElement)) {
        throw new Error('Inline editor is unavailable.');
      }
      if (editor instanceof HTMLTextAreaElement) {
        editor.value = arguments[0];
      } else {
        editor.textContent = arguments[0];
      }
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      editor.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true
      }));
    `,
    value
  );
}

async function waitForPageText(driver, selector, expectedText) {
  await waitFor(async () => {
    return (await readVisibleText(driver, selector)) === expectedText;
  }, 10000, `Element ${selector} did not become "${expectedText}".`);
}

async function readVisibleText(driver, selector) {
  const value = await driver.executeScript(
    `
      const element = document.querySelector(arguments[0]);
      if (!element) {
        return null;
      }
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
        return element.value;
      }
      return (element.textContent ?? '').trim();
    `,
    selector
  );

  return typeof value === "string" ? value : null;
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

async function scrollAllTargetsToTop(driver) {
  await driver.executeScript(`
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    for (const element of document.querySelectorAll('*')) {
      if (!(element instanceof HTMLElement)) {
        continue;
      }
      if (element === document.body || element === document.documentElement) {
        continue;
      }
      const style = window.getComputedStyle(element);
      if (style.overflowY !== 'auto' && style.overflowY !== 'scroll') {
        continue;
      }
      if (element.scrollHeight <= element.clientHeight + 80) {
        continue;
      }
      const rect = element.getBoundingClientRect();
      if (rect.width < viewportWidth * 0.4 || rect.height < viewportHeight * 0.4) {
        continue;
      }
      element.scrollTop = 0;
    }
    window.scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
    if (document.body) {
      document.body.scrollTop = 0;
    }
  `);
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

async function readBlankingState(driver, popupHandle, pageKey, proofBlock) {
  await waitForTextMapToSettle(
    driver,
    popupHandle,
    pageKey,
    1,
    "Stored text map did not settle after text.blank page."
  );
  const storedPageMap = await readStoredTextPageMap(driver, popupHandle, pageKey);
  const proofHeadingText = await readVisibleText(driver, proofBlock.headingSelector);
  const proofParagraphText = await readVisibleText(driver, proofBlock.paragraphSelector);
  const blankReplacementCount = (storedPageMap?.bindings ?? []).filter((binding) => binding.replacementText === "").length;

  return {
    blankReplacementCount,
    proofHeadingText,
    proofParagraphText,
    proofElementsPresent: proofHeadingText !== null || proofParagraphText !== null,
    storedPageMap
  };
}

function isBlankTerminalText(value) {
  return value === null || value === "";
}

async function blankPageMedia(driver) {
  return driver.executeScript(`
    const stats = {
      images: 0,
      videos: 0,
      posters: 0,
      sources: 0,
      backgrounds: 0
    };

    for (const image of document.querySelectorAll('img')) {
      if (!(image instanceof HTMLImageElement)) {
        continue;
      }
      stats.images += 1;
      image.removeAttribute('srcset');
      image.removeAttribute('sizes');
      image.setAttribute('src', '');
      image.style.visibility = 'hidden';
      image.style.background = 'transparent';
    }

    for (const video of document.querySelectorAll('video')) {
      if (!(video instanceof HTMLVideoElement)) {
        continue;
      }
      stats.videos += 1;
      if (video.getAttribute('poster')) {
        stats.posters += 1;
      }
      video.pause?.();
      video.removeAttribute('poster');
      video.removeAttribute('src');
      video.load?.();
      video.style.visibility = 'hidden';
    }

    for (const source of document.querySelectorAll('picture source, video source')) {
      if (!(source instanceof HTMLSourceElement)) {
        continue;
      }
      stats.sources += 1;
      source.removeAttribute('src');
      source.removeAttribute('srcset');
    }

    for (const element of document.querySelectorAll('*')) {
      if (!(element instanceof HTMLElement)) {
        continue;
      }
      const style = window.getComputedStyle(element);
      if (style.backgroundImage && style.backgroundImage !== 'none') {
        stats.backgrounds += 1;
        element.style.backgroundImage = 'none';
      }
    }

    return stats;
  `);
}

async function collectResidualVisibleText(driver) {
  return driver.executeScript(`
    function buildSelector(element) {
      const parts = [];
      let current = element;
      while (current instanceof HTMLElement && parts.length < 4 && current !== document.body) {
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

    const items = [];
    const seen = new Set();
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
        if (parent.closest('#lextrace-overlay-root, .lextrace-inline-text-editor')) {
          return NodeFilter.FILTER_REJECT;
        }
        if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'OPTION'].includes(parent.tagName)) {
          return NodeFilter.FILTER_REJECT;
        }
        const range = document.createRange();
        range.selectNodeContents(node);
        const rects = [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
        return rects.length > 0 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });

    while (walker.nextNode() && items.length < 80) {
      const node = walker.currentNode;
      const text = (node.textContent ?? '').replace(/\\s+/g, ' ').trim();
      const parent = node.parentElement;
      if (!(parent instanceof HTMLElement) || seen.has(text)) {
        continue;
      }
      seen.add(text);
      items.push({
        text,
        selector: buildSelector(parent)
      });
    }

    return {
      count: items.length,
      items
    };
  `);
}

async function dismissCommonInterference(driver) {
  await driver.actions().sendKeys("\uE00C").perform().catch(() => {});
  await delay(250);
  await driver.executeScript(`
    const closeWords = ['close', 'dismiss', 'skip', 'not now', 'got it', 'ok'];
    const candidates = [...document.querySelectorAll('button, [role="button"], a')]
      .filter((element) => element instanceof HTMLElement)
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 &&
          rect.height > 0 &&
          rect.bottom >= 0 &&
          rect.top <= window.innerHeight * 1.5;
      })
      .slice(0, 240);
    for (const button of candidates) {
      if (!(button instanceof HTMLElement)) {
        continue;
      }
      if (button.tagName === 'A') {
        const href = button.getAttribute('href') ?? '';
        const isNonNavigatingAnchor = href === '' || href === '#' || href.startsWith('javascript:') || href.startsWith('#');
        if (!isNonNavigatingAnchor) {
          continue;
        }
      }
      const text = (button.innerText ?? button.getAttribute('aria-label') ?? '').trim().toLowerCase();
      const rect = button.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        continue;
      }
      if (closeWords.some((word) => text.includes(word))) {
        button.click();
      }
    }
  `).catch(() => {});
  await delay(300);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
