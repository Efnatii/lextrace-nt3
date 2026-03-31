import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { promises as fs } from "node:fs";

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
  openConfigTab,
  prepareEdgeAiArtifacts,
  pruneBrowserTabs,
  selectOverlayTab,
  setPopupRuntimeHandle,
  setSelectValue,
  switchToHandle,
  waitFor,
  waitForOverlay
} from "./lib/edge-ai-harness.mjs";

const REPORT_PATH = path.join(paths.artifacts, "test-results", "edge-text-elements-proof.json");
const SCREENSHOT_DIR = path.join(paths.artifacts, "test-results", "edge-text-elements-visuals");

async function main() {
  await prepareEdgeAiArtifacts({
    runPreflight: false,
    reuseArtifacts: false
  });

  const extensionMetadata = await ensureExtensionKeyMetadata();
  const popupUrl = `chrome-extension://${extensionMetadata.extensionId}/popup.html`;
  const proofServer = await startProofServer();
  const downloadDir = path.join(paths.artifacts, "tmp", "edge-text-downloads");
  await fs.rm(SCREENSHOT_DIR, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(SCREENSHOT_DIR, { recursive: true });
  await fs.rm(downloadDir, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(downloadDir, { recursive: true });
  const { driver, userDataDir } = await launchEdgeWithExtension({
    userPreferences: {
      download: {
        default_directory: downloadDir,
        prompt_for_download: false,
        directory_upgrade: true
      },
      profile: {
        default_content_setting_values: {
          automatic_downloads: 1
        }
      }
    }
  });

  const report = {
    executedAt: new Date().toISOString(),
    popupUrl,
    proofServerOrigin: proofServer.origin,
    downloadDir,
    screenshotDir: SCREENSHOT_DIR,
    visuals: {},
    assertions: {}
  };

  let popupHandle = null;
  let mainHandle = null;

  try {
    await driver.manage().setTimeouts({
      script: 120000,
      pageLoad: 120000,
      implicit: 0
    });
    await driver.manage().window().setRect({
      width: 1600,
      height: 1200,
      x: 32,
      y: 32
    });

    mainHandle = await driver.getWindowHandle();
    await navigateCurrentTabToUrl(driver, proofServer.makeUrl("/weird-dom"));
    popupHandle = await openBrowserTab(driver, popupUrl);
    await pruneBrowserTabs(driver, [mainHandle, popupHandle]);
    setPopupRuntimeHandle(popupHandle);
    await ensurePopupReady(driver);

    report.assertions.popupDebugFields = await verifyPopupDebugFields(driver);
    report.visuals.popupConfig = await captureScreenshot(driver, "popup-config-debug-fields.png");

    const weirdPageUrl = proofServer.makeUrl("/weird-dom");
    const weirdPageKey = normalizePageKey(weirdPageUrl);

    await switchToHandle(driver, mainHandle);
    await waitForNoHighlights(driver, "Text elements auto-scanned before any explicit scan or debug toggle.");
    const initialStoredPageMap = await readStoredTextPageMap(driver, popupHandle, weirdPageKey);
    assert.equal(initialStoredPageMap, null, "A text map was stored before any explicit scan.");
    report.visuals.weirdPageNoAutoScan = await captureScreenshot(driver, "weird-page-no-autoscan.png");
    report.assertions.noAutoScanInitial = {
      highlightCount: 0,
      storedPageMapPresent: false
    };

    await openOverlayAndWait(driver, popupHandle, mainHandle, weirdPageUrl);
    await selectOverlayTab(driver, "texts");
    await waitFor(
      async () => {
        const snapshot = await getTextsTabSnapshot(driver);
        return snapshot.entryCount === 0 && snapshot.emptyStateText.includes("text.scan");
      },
      10000,
      "Texts tab auto-scanned the page instead of waiting for text.scan."
    );
    report.visuals.weirdPageTextsTabInitial = await captureScreenshot(driver, "weird-page-texts-tab-initial.png");
    report.assertions.noAutoScanTextsTab = {
      entryCount: 0,
      emptyStateMentionsScan: true
    };

    const textScanCommand = await runOverlayTerminalCommand(driver, "text.scan");
    assert.equal(textScanCommand.ok, true, `text.scan failed: ${textScanCommand.error ?? "unknown error"}`);
    report.assertions.consoleCommands = {
      textScanResult: textScanCommand.lastTerminalResult
    };
    await selectOverlayTab(driver, "texts");
    await waitForTextsEntryCount(driver, 12, "Texts tab did not populate after explicit text.scan.");
    const scannedPageMapBeforeIncremental = await readStoredTextPageMap(driver, popupHandle, weirdPageKey);
    const lastScanBeforeIncremental = scannedPageMapBeforeIncremental?.lastScanAt ?? null;
    const updatedAtBeforeIncremental = scannedPageMapBeforeIncremental?.updatedAt ?? null;
    const bindingCountBeforeIncremental = scannedPageMapBeforeIncremental?.bindings?.length ?? 0;
    assert.ok(lastScanBeforeIncremental, "Failed to capture lastScanAt before incremental auto-scan proof.");

    await setTextAutoScanMode(driver, "incremental");
    await switchToHandle(driver, mainHandle);
    await openOverlayAndWait(driver, popupHandle, mainHandle, weirdPageUrl);
    await selectOverlayTab(driver, "texts");

    const incrementalHeadingText = `Incremental block heading ${Date.now()}`;
    const incrementalParagraphText = `Incremental live paragraph ${Date.now()}`;
    const incrementalStartedAt = Date.now();
    await injectDynamicProofBlock(driver, {
      headingText: incrementalHeadingText,
      paragraphText: incrementalParagraphText
    });
    await waitFor(
      async () => {
        const snapshot = await getTextsTabSnapshot(driver);
        return snapshot.entries.some((entry) => entry.originalText.includes(incrementalHeadingText));
      },
      15000,
      "Dynamic text insertion was not discovered by the live text observer."
    );
    const incrementalDetectedAt = Date.now();
    report.visuals.weirdPageDynamicObserver = await captureScreenshot(driver, "weird-page-dynamic-observer.png");
    let incrementalPersistedSoon = false;
    try {
      await waitFor(
        async () => {
          const stored = await readStoredTextPageMap(driver, popupHandle, weirdPageKey);
          return (stored?.bindings?.length ?? 0) > bindingCountBeforeIncremental &&
            (stored?.updatedAt ?? null) !== updatedAtBeforeIncremental;
        },
        5000,
        "Incremental auto-scan did not persist the updated page map soon enough."
      );
      incrementalPersistedSoon = true;
    } catch {
      incrementalPersistedSoon = false;
    }
    const incrementalPersistedAt = Date.now();
    const storedAfterIncremental = await readStoredTextPageMap(driver, popupHandle, weirdPageKey);
    report.assertions.incrementalAutoScan = {
      preservedLastScanAt: (storedAfterIncremental?.lastScanAt ?? null) === lastScanBeforeIncremental,
      updatedAtChanged: (storedAfterIncremental?.updatedAt ?? null) !== updatedAtBeforeIncremental,
      bindingCountAfterIncremental: storedAfterIncremental?.bindings?.length ?? null,
      incrementalHeadingText,
      detectionLatencyMs: incrementalDetectedAt - incrementalStartedAt,
      persistenceLatencyMs: incrementalPersistedAt - incrementalStartedAt,
      persistedSoon: incrementalPersistedSoon
    };

    const updatedAtBeforeNoiseMutation = storedAfterIncremental?.updatedAt ?? null;
    await beginHighlightMutationWatch(driver);
    await driver.executeScript(`
      const host = document.querySelector('#noise-host');
      if (host instanceof HTMLElement) {
        host.hidden = false;
        host.hidden = true;
      }
    `);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const storedAfterNoiseMutation = await readStoredTextPageMap(driver, popupHandle, weirdPageKey);
    const noOpMutationStats = await finishHighlightMutationWatch(driver);
    report.assertions.incrementalNoOpMutation = {
      updatedAtUnchanged: (storedAfterNoiseMutation?.updatedAt ?? null) === updatedAtBeforeNoiseMutation,
      addedBoxes: noOpMutationStats.added,
      removedBoxes: noOpMutationStats.removed
    };
    assert.equal(
      report.assertions.incrementalNoOpMutation.updatedAtUnchanged,
      true,
      "Irrelevant autoscan mutation still rewrote the page map."
    );
    assert.equal(noOpMutationStats.added, 0, "Irrelevant autoscan mutation recreated highlight boxes.");
    assert.equal(noOpMutationStats.removed, 0, "Irrelevant autoscan mutation removed highlight boxes.");

    const weirdTextsSnapshot = await getTextsTabSnapshot(driver);
    const titleBinding = weirdTextsSnapshot.entries.find((entry) => entry.originalText.includes("Alpha title"));
    const leadBinding = weirdTextsSnapshot.entries.find((entry) => entry.originalText.includes("Alpha paragraph for replacement"));
    const captionBinding = weirdTextsSnapshot.entries.find((entry) => entry.originalText.includes("Figure caption text"));
    assert.ok(titleBinding?.bindingId, "Failed to locate the heading binding in the texts tab.");
    assert.ok(leadBinding?.bindingId, "Failed to locate the lead paragraph binding in the texts tab.");
    assert.ok(
      !weirdTextsSnapshot.entries.some((entry) => entry.originalText.includes("Tooltip title text")),
      "title attribute text should not be captured by the visible-only scanner."
    );
    assert.ok(
      !weirdTextsSnapshot.entries.some((entry) => entry.originalText.includes("Aria only action")),
      "aria-label text should not be captured by the visible-only scanner."
    );
    assert.ok(
      !weirdTextsSnapshot.entries.some((entry) => entry.originalText.includes("Hidden text should not be scanned")),
      "Hidden text leaked into the visible-only scanner."
    );
    assert.ok(
      weirdTextsSnapshot.entries.some((entry) => entry.originalText.includes("Figure caption text")),
      "figcaption text was not captured by the scanner."
    );
    assert.ok(
      weirdTextsSnapshot.entries.some((entry) => entry.originalText.includes("Head cell text")),
      "table header text was not captured by the scanner."
    );
    assert.ok(
      weirdTextsSnapshot.entries.some((entry) => entry.originalText.includes("Display contents visible text")),
      "display: contents visible text was not captured by the scanner."
    );
    report.assertions.scanCoverage = {
      entryCount: weirdTextsSnapshot.entryCount,
      includesIncrementalHeading: weirdTextsSnapshot.entries.some((entry) =>
        entry.originalText.includes(incrementalHeadingText)
      ),
      excludesTitleAttribute: true,
      excludesAriaLabel: true,
      excludesHiddenText: true,
      includesDisplayContentsText: true,
      includesFigureCaption: true,
      includesTableHeader: true,
      includesVisibleSelectOptionText: weirdTextsSnapshot.entries.some((entry) =>
        entry.originalText.includes("Option alpha")
      )
    };

    assert.ok(captionBinding?.bindingId, "Failed to locate the figure caption binding in the texts tab.");
    const deleteBindingCommand = await runOverlayTerminalCommand(driver, `text.delete ${captionBinding.bindingId}`);
    assert.equal(deleteBindingCommand.ok, true, `text.delete binding failed: ${deleteBindingCommand.error ?? "unknown error"}`);
    await waitFor(
      async () => {
        const snapshot = await getTextsTabSnapshot(driver);
        return !snapshot.entries.some((entry) => entry.bindingId === captionBinding.bindingId);
      },
      10000,
      "Deleted binding still appears in the texts tab."
    );
    const storedAfterDelete = await readStoredTextPageMap(driver, popupHandle, weirdPageKey);
    assert.ok(
      storedAfterDelete && !storedAfterDelete.bindings.some((binding) => binding.bindingId === captionBinding.bindingId),
      "Deleted binding remained in the stored page map."
    );
    report.assertions.deleteCommand = {
      deletedBindingId: captionBinding.bindingId,
      remainingBindings: storedAfterDelete?.bindings.length ?? null
    };

    const scannedPageMapBeforeReload = await readStoredTextPageMap(driver, popupHandle, weirdPageKey);
    const lastScanBeforeReload = scannedPageMapBeforeReload?.lastScanAt ?? null;
    assert.ok(lastScanBeforeReload, "Failed to capture lastScanAt before the no-autoscan reload check.");

    await switchToHandle(driver, mainHandle);
    await closeOverlayAndWait(driver);
    await driver.navigate().refresh();
    await waitForNoHighlights(driver, "Stored text map auto-scanned on page reload with debug disabled.");
    const storedAfterReload = await readStoredTextPageMap(driver, popupHandle, weirdPageKey);
    assert.equal(
      storedAfterReload?.lastScanAt ?? null,
      lastScanBeforeReload,
      "Stored lastScanAt changed after a plain reload, which indicates an unwanted auto-scan."
    );
    assert.ok(
      storedAfterReload?.bindings?.some((binding) => binding.originalText.includes(incrementalHeadingText)),
      "Incremental binding was not restored from storage after reload."
    );
    report.assertions.noAutoScanStoredMap = {
      highlightCount: 0,
      lastScanAtUnchanged: true,
      incrementalBindingRestored: true
    };

    await enableTextDebugConfig(driver);
    await switchToHandle(driver, mainHandle);
    await waitForHighlights(driver, 8, "Highlighting did not activate on the weird local page after enabling debug.");
    const weirdHighlightSnapshot = await getHighlightSnapshot(driver);
    report.visuals.weirdPageSourceHighlights = await captureScreenshot(driver, "weird-page-source-highlights.png");
    report.assertions.weirdLocalPage = {
      initialHighlightCount: weirdHighlightSnapshot.count,
      sourceHighlights: weirdHighlightSnapshot.sourceCount
    };

    await openOverlayAndWait(driver, popupHandle, mainHandle, weirdPageUrl);
    await selectOverlayTab(driver, "texts");

    await driver.executeScript(`
      const lead = document.querySelector('#lead-copy');
      if (lead instanceof HTMLElement) {
        window.__lextraceLeadCopyText = lead.textContent ?? 'Alpha paragraph for replacement';
        lead.remove();
      }
    `);
    await waitFor(
      async () => {
        const snapshot = await getTextsTabSnapshot(driver);
        return snapshot.entries.some((entry) => entry.bindingId === leadBinding.bindingId && entry.presence === "stale");
      },
      15000,
      "Removed text binding did not transition to stale."
    );
    const staleLeadHighlights = await getHighlightSnapshot(driver);
    assert.ok(
      !staleLeadHighlights.items.some((item) => item.bindingId === leadBinding.bindingId),
      "A stale binding still produced in-page highlight boxes."
    );
    const storedAfterLeadRemoval = await readStoredTextPageMap(driver, popupHandle, weirdPageKey);
    assert.equal(
      storedAfterLeadRemoval?.bindings?.find((binding) => binding.bindingId === leadBinding.bindingId)?.presence ?? null,
      "stale",
      "Removed binding was not marked stale in storage."
    );

    await driver.executeScript(`
      const proofRoot = document.querySelector('#proof-root > section.panel');
      if (!(proofRoot instanceof HTMLElement)) {
        return;
      }
      const lead = document.createElement('p');
      lead.id = 'lead-copy';
      lead.textContent = window.__lextraceLeadCopyText ?? 'Alpha paragraph for replacement';
      const repeatParagraph = [...proofRoot.querySelectorAll('p')].find((element) => (element.textContent ?? '').includes('Repeat me'));
      proofRoot.insertBefore(lead, repeatParagraph ?? null);
    `);
    await waitFor(
      async () => {
        const snapshot = await getTextsTabSnapshot(driver);
        return snapshot.entries.some((entry) => entry.bindingId === leadBinding.bindingId && entry.presence === "live");
      },
      15000,
      "Restored text binding did not reactivate from stale to live."
    );
    await waitForPageText(driver, "#lead-copy", "Alpha paragraph for replacement");
    const storedAfterLeadRestore = await readStoredTextPageMap(driver, popupHandle, weirdPageKey);
    report.assertions.staleLifecycle = {
      bindingId: leadBinding.bindingId,
      stalePresencePersisted: storedAfterLeadRemoval?.bindings?.find((binding) => binding.bindingId === leadBinding.bindingId)?.presence ?? null,
      livePresencePersisted: storedAfterLeadRestore?.bindings?.find((binding) => binding.bindingId === leadBinding.bindingId)?.presence ?? null
    };

    const headingReplacement = "Live heading replacement";
    const setHeadingCommand = await runOverlayTerminalCommand(
      driver,
      `text.set ${titleBinding.bindingId} -- ${headingReplacement}`
    );
    assert.equal(setHeadingCommand.ok, true, `text.set failed: ${setHeadingCommand.error ?? "unknown error"}`);
    await waitForPageText(driver, "#main-title", headingReplacement);
    report.visuals.weirdPageChangedHighlight = await captureScreenshot(driver, "weird-page-changed-highlight.png");

    const changedHighlightSnapshot = await getHighlightSnapshot(driver);
    const changedHeadingState = await driver.executeScript(
      `
        const bindingId = arguments[0];
        const element = document.querySelector('[data-lextrace-text-binding-id="' + CSS.escape(bindingId) + '"]');
        return {
          debugState: element?.getAttribute('data-lextrace-text-debug') ?? null,
          hasNativeChangedHighlight: Number(CSS?.highlights?.get?.('lextrace-text-changed')?.size ?? 0) > 0
        };
      `,
      titleBinding.bindingId
    );
    assert(
      changedHeadingState?.debugState === "changed" || changedHeadingState?.hasNativeChangedHighlight === true,
      "Changed bindings are not highlighted in green mode."
    );

    const modeOriginalCommand = await runOverlayTerminalCommand(driver, "text.mode original");
    assert.equal(modeOriginalCommand.ok, true, `text.mode original failed: ${modeOriginalCommand.error ?? "unknown error"}`);
    await waitForPageText(driver, "#main-title", "Alpha title");

    const modeEffectiveCommand = await runOverlayTerminalCommand(driver, "text.mode effective");
    assert.equal(modeEffectiveCommand.ok, true, `text.mode effective failed: ${modeEffectiveCommand.error ?? "unknown error"}`);
    await waitForPageText(driver, "#main-title", headingReplacement);
    report.assertions.replacementAndModes = {
      headingBindingId: titleBinding.bindingId,
      replacementText: headingReplacement,
      changedHighlightState: changedHeadingState?.debugState ?? null,
      originalModeText: "Alpha title",
      effectiveModeText: headingReplacement
    };

    await triggerInlineEditor(driver, "#lead-copy");
    report.visuals.inlineEditor = await captureScreenshot(driver, "weird-page-inline-editor.png");
    await triggerInlineEditor(driver, "#lead-copy");
    await commitInlineEditor(driver, "Inline lead replacement");
    await waitForPageText(driver, "#lead-copy", "Inline lead replacement");
    report.assertions.inlineEdit = {
      bindingId: leadBinding.bindingId,
      finalText: "Inline lead replacement"
    };

    const downloadCommand = await runOverlayTerminalCommand(driver, "text.download");
    assert.equal(downloadCommand.ok, true, `text.download failed: ${downloadCommand.error ?? "unknown error"}`);
    const downloadedFile = await waitForDownloadedJsonFile(downloadDir);
    const downloadJson = JSON.parse(await fs.readFile(downloadedFile.filePath, "utf8"));
    assert.equal(downloadJson.scope, "text-map", "Downloaded payload has an unexpected scope.");
    assert.ok(Array.isArray(downloadJson.pageMap?.bindings), "Downloaded payload is missing pageMap.bindings.");

    report.assertions.download = {
      fileName: downloadedFile.fileName,
      bindingCount: downloadJson.pageMap.bindings.length
    };

    await driver.navigate().refresh();
    await waitFor(
      async () => (await readVisibleText(driver, "#main-title")) === headingReplacement,
      15000,
      "Stored replacement was not restored after page reload."
    );
    report.assertions.persistence = {
      restoredAfterReload: true
    };

    await openOverlayAndWait(driver, popupHandle, mainHandle, proofServer.makeUrl("/weird-dom"));

    const resetAllCommand = await runOverlayTerminalCommand(driver, "text.reset all");
    assert.equal(resetAllCommand.ok, true, `text.reset all failed: ${resetAllCommand.error ?? "unknown error"}`);

    await driver.navigate().refresh();
    await waitFor(
      async () => (await readVisibleText(driver, "#main-title")) === "Alpha title",
      15000,
      "Reset all did not clear the stored replacement."
    );
    report.assertions.reset = {
      resetAllClearedReplacement: true
    };

    await closeOverlayAndWait(driver);
    await driver.get(proofServer.makeUrl("/scroll-lab"));
    await waitForHighlights(driver, 1, "Scroll-lab page did not auto-scan after enabling incremental mode.");
    const scrollLabHighlightSnapshot = await getHighlightSnapshot(driver);
    const scrollLabPageKey = normalizePageKey(proofServer.makeUrl("/scroll-lab"));
    const storedScrollLabPageMap = await readStoredTextPageMap(driver, popupHandle, scrollLabPageKey);
    assert.equal(
      storedScrollLabPageMap,
      null,
      "Incremental bootstrap on a fresh page should remain runtime-only until a real semantic change."
    );
    report.assertions.incrementalAutoBootstrap = {
      scrollLabHighlightCount: scrollLabHighlightSnapshot.count,
      storedPageMapPresent: false
    };
    await openOverlayAndWait(driver, popupHandle, mainHandle, proofServer.makeUrl("/scroll-lab"));
    await selectOverlayTab(driver, "texts");
    await driver.executeScript(`
      document.querySelector('#scroll-target')?.scrollIntoView({ block: 'center' });
    `);
    await triggerInlineEditor(driver, "#scroll-target");
    const inlineBeforeScroll = await getInlineEditorAnchorSnapshot(driver, "#scroll-target");
    await driver.executeScript(`
      window.scrollBy({ top: 180, left: 0, behavior: 'instant' });
    `);
    await waitFor(async () => {
      const snapshot = await getInlineEditorAnchorSnapshot(driver, "#scroll-target");
      return snapshot.editorPresent === true;
    }, 10000, "Inline editor disappeared during the scroll proof.");
    const inlineAfterScroll = await getInlineEditorAnchorSnapshot(driver, "#scroll-target");
    assert.ok(
      Math.abs(inlineAfterScroll.deltaLeft) <= 6 &&
        Math.abs(inlineAfterScroll.deltaTop) <= 6 &&
        Math.abs(inlineAfterScroll.deltaWidth) <= 2 &&
        Math.abs(inlineAfterScroll.deltaHeight) <= 2,
      `Inline editor drifted away from the target after scroll: ${JSON.stringify(inlineAfterScroll)}`
    );
    report.visuals.inlineEditorScroll = await captureScreenshot(driver, "scroll-lab-inline-editor-scrolled.png");
    report.assertions.inlineScroll = {
      before: inlineBeforeScroll,
      after: inlineAfterScroll
    };
    await dismissInlineEditor(driver);
    await setTextAutoScanMode(driver, "off");
    await switchToHandle(driver, mainHandle);
    await closeOverlayAndWait(driver);

    await driver.get(proofServer.makeUrl("/duplicate-chaos"));
    await waitForNoHighlights(driver, "Duplicate chaos page auto-scanned with autoScanMode off.");
    await openOverlayAndWait(driver, popupHandle, mainHandle, proofServer.makeUrl("/duplicate-chaos"));
    await selectOverlayTab(driver, "texts");
    await waitFor(
      async () => {
        const snapshot = await getTextsTabSnapshot(driver);
        return snapshot.entryCount === 0 && snapshot.emptyStateText.includes("text.scan");
      },
      10000,
      "Duplicate chaos page auto-scanned before text.scan."
    );
    const duplicateScanCommand = await runOverlayTerminalCommand(driver, "text.scan");
    assert.equal(duplicateScanCommand.ok, true, `duplicate text.scan failed: ${duplicateScanCommand.error ?? "unknown error"}`);
    await selectOverlayTab(driver, "texts");
    await waitForTextsEntryCount(driver, 6, "Texts tab did not populate on the duplicate chaos page after text.scan.");
    report.visuals.duplicateChaosTextsTab = await captureScreenshot(driver, "duplicate-chaos-texts-tab.png");
    const duplicateSnapshot = await getTextsTabSnapshot(driver);
    const repeatBindings = duplicateSnapshot.entries.filter((entry) => entry.originalText === "Repeat me");
    assert.ok(repeatBindings.length >= 3, "Repeated texts were not preserved as separate bindings.");
    assert.equal(
      new Set(repeatBindings.map((entry) => entry.bindingId)).size,
      repeatBindings.length,
      "Repeated texts collapsed into duplicate binding ids."
    );
    report.assertions.duplicateChaosPage = {
      repeatedBindingCount: repeatBindings.length
    };
    const deletePageCommand = await runOverlayTerminalCommand(driver, "text.delete page");
    assert.equal(deletePageCommand.ok, true, `text.delete page failed: ${deletePageCommand.error ?? "unknown error"}`);
    await selectOverlayTab(driver, "texts");
    const duplicatePageKey = normalizePageKey(proofServer.makeUrl("/duplicate-chaos"));
    await waitFor(
      async () => {
        const snapshot = await getTextsTabSnapshot(driver);
        const storedPageMap = await readStoredTextPageMap(driver, popupHandle, duplicatePageKey);
        await switchToHandle(driver, mainHandle);
        return snapshot.entryCount === 0 && storedPageMap === null;
      },
      10000,
      "text.delete page did not clear the duplicate-chaos text map."
    );
    report.assertions.deletePageCommand = {
      clearedPageMap: true
    };

    await driver.get(proofServer.makeUrl("/dense-grid"));
    await waitForNoHighlights(driver, "Dense grid page auto-scanned with autoScanMode off.");
    await openOverlayAndWait(driver, popupHandle, mainHandle, proofServer.makeUrl("/dense-grid"));
    const denseScanCommand = await runOverlayTerminalCommand(driver, "text.scan");
    assert.equal(denseScanCommand.ok, true, `dense-grid text.scan failed: ${denseScanCommand.error ?? "unknown error"}`);
    const denseTexts = await getTextsTabSnapshot(driver);
    const denseHighlights = await getHighlightSnapshot(driver);
    assert.ok(denseTexts.entryCount >= 240, `Dense visible page under-scanned: ${denseTexts.entryCount}`);
    assert.ok(denseHighlights.count >= 240, `Dense visible page lost highlight boxes: ${denseHighlights.count}`);
    report.assertions.denseVisiblePage = {
      entryCount: denseTexts.entryCount,
      highlightCount: denseHighlights.count
    };

    const realSites = [
      "https://example.com/",
      "https://www.wikipedia.org/"
    ];
    report.assertions.realSites = [];
    report.visuals.realSites = [];

    for (const url of realSites) {
      await driver.get(url);
      await openOverlayAndWait(driver, popupHandle, mainHandle, url);
      const smokeCommand = await runOverlayTerminalCommand(driver, "text.scan");
      assert.equal(smokeCommand.ok, true, `Real-site text.scan failed for ${url}: ${smokeCommand.error ?? "unknown error"}`);
      const smokeTexts = await getTextsTabSnapshot(driver);
      const smokeHighlights = await getHighlightSnapshot(driver);
      assert.ok(smokeTexts.entryCount > 0, `No text bindings were detected on ${url}.`);
      assert.ok(smokeHighlights.count > 0, `No highlighted text elements were detected on ${url}.`);
      const screenshotPath = await captureScreenshot(
        driver,
        `real-site-${normalizePageKey(url).replace(/[^a-z0-9._-]+/gi, "-")}.png`
      );
      report.assertions.realSites.push({
        url,
        pageKey: normalizePageKey(url),
        entryCount: smokeTexts.entryCount,
        highlightCount: smokeHighlights.count
      });
      report.visuals.realSites.push({
        url,
        screenshotPath
      });
    }

    await writeJson(REPORT_PATH, report);
    console.log(`Edge text-elements proof saved to ${REPORT_PATH}`);
  } finally {
    setPopupRuntimeHandle(null);
    await driver.quit().catch(() => {});
    await proofServer.close().catch(() => {});
    if (userDataDir) {
      await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

async function verifyPopupDebugFields(driver) {
  await openConfigTab(driver);
  await waitFor(
    async () => {
      const count = await driver.executeScript(`
        return document.querySelectorAll("button[data-config-path^='debug.textElements.']").length;
      `);
      return Number(count) >= 3;
    },
    15000,
    "Popup config viewer did not render debug.textElements fields."
  );
  const debugPaths = await driver.executeScript(`
    return [...document.querySelectorAll("button[data-config-path^='debug.textElements.']")]
      .map((button) => button.getAttribute('data-config-path'))
      .filter((value) => typeof value === 'string')
      .sort();
  `);

  assert.deepEqual(debugPaths, [
    "debug.textElements.autoScanMode",
    "debug.textElements.displayMode",
    "debug.textElements.highlightEnabled",
    "debug.textElements.inlineEditingEnabled"
  ]);
  await driver.executeScript(`
    document
      .querySelector("button[data-config-path='debug.textElements.inlineEditingEnabled']")
      ?.scrollIntoView({ block: 'center' });
  `);

  return {
    paths: debugPaths
  };
}

async function enableTextDebugConfig(driver) {
  await openConfigTab(driver);
  await setSelectValue(driver, "debug.textElements.highlightEnabled", "true");
  await setSelectValue(driver, "debug.textElements.inlineEditingEnabled", "true");
  await setSelectValue(driver, "debug.textElements.displayMode", "effective");
  await setSelectValue(driver, "debug.textElements.autoScanMode", "incremental");
}

async function setTextAutoScanMode(driver, value) {
  await openConfigTab(driver);
  await setSelectValue(driver, "debug.textElements.autoScanMode", value);
}

async function openOverlayAndWait(driver, popupHandle, mainHandle, expectedUrl) {
  await switchToHandle(driver, mainHandle);
  await waitFor(
    async () => {
      const readyState = await driver.executeScript("return document.readyState;");
      return readyState === "complete" || readyState === "interactive";
    },
    15000,
    `Page ${expectedUrl} did not finish loading before overlay open.`
  );

  let lastError = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await clickOpenTerminalFromPopup(driver, popupHandle);
      await switchToHandle(driver, mainHandle);
      await waitForOverlay(driver);
      return;
    } catch (error) {
      lastError = error;
      await switchToHandle(driver, mainHandle);
      await driver.navigate().refresh();
      await waitFor(
        async () => {
          const readyState = await driver.executeScript("return document.readyState;");
          return readyState === "complete" || readyState === "interactive";
        },
        15000,
        `Page ${expectedUrl} did not recover after refresh.`
      );
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
  }

  throw lastError ?? new Error(`Overlay did not appear for ${expectedUrl}.`);
}

async function closeOverlayAndWait(driver) {
  await driver.executeScript(`
    document
      .querySelector('#lextrace-overlay-root')
      ?.shadowRoot
      ?.querySelector('.close-button')
      ?.click();
  `);
  await waitFor(
    async () => {
      const hidden = await driver.executeScript(`
        const host = document.querySelector('#lextrace-overlay-root');
        if (!(host instanceof HTMLElement)) {
          return true;
        }
        return window.getComputedStyle(host).display === 'none';
      `);
      return hidden === true;
    },
    10000,
    "Overlay did not close."
  );
}

async function navigateCurrentTabToUrl(driver, expectedUrl) {
  const normalizeUrl = (value) => value.replace(/\/+$/, "");
  await driver.executeScript("window.location.replace(arguments[0]);", expectedUrl);
  await waitFor(
    async () => {
      const currentUrl = await driver.getCurrentUrl();
      const readyState = await driver.executeScript("return document.readyState;");
      return (
        normalizeUrl(currentUrl) === normalizeUrl(expectedUrl) &&
        (readyState === "complete" || readyState === "interactive")
      );
    },
    30000,
    `The current Edge tab did not navigate to ${expectedUrl}.`
  );
}

async function captureScreenshot(driver, fileName) {
  const filePath = path.join(SCREENSHOT_DIR, fileName);
  const base64 = await driver.takeScreenshot();
  await fs.writeFile(filePath, base64, "base64");
  return filePath;
}

async function clickOpenTerminalFromPopup(driver, popupHandle) {
  await switchToHandle(driver, popupHandle);
  await driver.executeScript(`
    document.querySelector(".tab-button[data-tab='control']")?.click();
    document.querySelector('#open-terminal')?.click();
  `);
  await new Promise((resolve) => setTimeout(resolve, 300));
}

async function runOverlayTerminalCommand(driver, command) {
  return driver.executeAsyncScript(
    `
      const command = arguments[0];
      const done = arguments[arguments.length - 1];
      const root = document.querySelector('#lextrace-overlay-root')?.shadowRoot;
      const input = root?.querySelector('[data-role="terminal-input"]');
      const consoleTabButton = root?.querySelector(".overlay-tab-button[data-tab='console']");
      const form = root?.querySelector('[data-role="terminal-form"]');
      if (!(input instanceof HTMLInputElement)) {
        done({
          ok: false,
          error: 'Overlay terminal input is unavailable.'
        });
        return;
      }

      if (consoleTabButton instanceof HTMLButtonElement) {
        consoleTabButton.click();
      }

      input.focus();
      input.value = command;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      if (!(form instanceof HTMLFormElement)) {
        done({
          ok: false,
          error: 'Overlay terminal form is unavailable.'
        });
        return;
      }

      form.requestSubmit();
      setTimeout(() => {
        const terminalEntries = [...root.querySelectorAll('.activity-entry.activity-terminal')];
        const flattened = terminalEntries.map((entry) => entry.textContent?.trim() ?? '').filter(Boolean);
        done({
          ok: true,
          lastTerminalResult: flattened.at(-1) ?? '',
          recentTerminalEntries: flattened.slice(-6)
        });
      }, 1200);
    `,
    command
  );
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
          statusText: fieldMap.status ?? '',
          originalText: fieldMap.original ?? '',
          displayedText: fieldMap.displayed ?? '',
          replacementText: fieldMap.replacement ?? '',
          contextText: fieldMap.context ?? ''
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
    const items = [...document.querySelectorAll('[data-lextrace-text-highlight-box="true"]')].map((element) => ({
      bindingId: element.getAttribute('data-lextrace-text-binding-id'),
      debugState: element.getAttribute('data-lextrace-text-debug'),
      tagName: element.tagName.toLowerCase(),
      text: '',
      rect: {
        left: Math.round(element.getBoundingClientRect().left),
        top: Math.round(element.getBoundingClientRect().top),
        width: Math.round(element.getBoundingClientRect().width),
        height: Math.round(element.getBoundingClientRect().height)
      }
    }));
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

async function waitForHighlights(driver, minimumCount, message) {
  await waitFor(async () => {
    const snapshot = await getHighlightSnapshot(driver);
    return snapshot.count >= minimumCount;
  }, 15000, message);
}

async function waitForNoHighlights(driver, message) {
  await waitFor(async () => {
    const snapshot = await getHighlightSnapshot(driver);
    return snapshot.count === 0;
  }, 15000, message);
}

async function waitForTextsEntryCount(driver, minimumCount, message) {
  await waitFor(async () => {
    const snapshot = await getTextsTabSnapshot(driver);
    return snapshot.entryCount >= minimumCount;
  }, 15000, message);
}

async function waitForPageText(driver, selector, expectedText) {
  await waitFor(
    async () => (await readVisibleText(driver, selector)) === expectedText,
    15000,
    `Element ${selector} did not become "${expectedText}".`
  );
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

async function readStoredTextPageMap(driver, popupHandle, pageKey) {
  const previousHandle = await driver.getWindowHandle();
  await switchToHandle(driver, popupHandle);
  const pageMap = await driver.executeAsyncScript(
    `
      const pageKey = arguments[0];
      const done = arguments[arguments.length - 1];
      chrome.storage.local.get(['lextrace.page.textMaps'], (items) => {
        const envelope = items['lextrace.page.textMaps'] ?? null;
        done(envelope?.pages?.[pageKey] ?? null);
      });
    `,
    pageKey
  );
  await switchToHandle(driver, previousHandle);
  return pageMap;
}

async function injectDynamicProofBlock(driver, options = {}) {
  const headingText = typeof options.headingText === "string" && options.headingText.trim().length > 0
    ? options.headingText.trim()
    : `Incremental block heading ${Date.now()}`;
  const paragraphText = typeof options.paragraphText === "string" && options.paragraphText.trim().length > 0
    ? options.paragraphText.trim()
    : `Incremental live paragraph ${Date.now()}`;
  const deadline = Date.now() + 15000;
  let lastState = null;
  while (Date.now() < deadline) {
    lastState = await driver.executeScript(`
      return {
        readyState: document.readyState,
        hasHost: !!document.querySelector('#dynamic-host'),
        href: window.location.href,
        title: document.title,
        bodySnippet: (document.body?.innerText ?? '').slice(0, 220)
      };
    `);
    if (
      lastState?.hasHost === true &&
      (lastState.readyState === "complete" || lastState.readyState === "interactive")
    ) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  if (!(lastState?.hasHost === true)) {
    throw new Error(`The weird proof page did not expose #dynamic-host before dynamic insertion. State: ${JSON.stringify(lastState)}`);
  }
  await driver.executeScript(`
    const host = document.querySelector('#dynamic-host');
    if (!(host instanceof HTMLElement)) {
      throw new Error('Dynamic host is unavailable on the proof page.');
    }
    const block = document.createElement('section');
    block.className = 'panel lextrace-incremental-proof';
    block.innerHTML = '<h3 class="dynamic-proof-heading"></h3><p class="dynamic-proof-copy"></p>';
    const heading = block.querySelector('.dynamic-proof-heading');
    const paragraph = block.querySelector('.dynamic-proof-copy');
    if (heading instanceof HTMLElement) {
      heading.textContent = arguments[0];
    }
    if (paragraph instanceof HTMLElement) {
      paragraph.textContent = arguments[1];
    }
    host.appendChild(block);
  `, headingText, paragraphText);
}

async function triggerInlineEditor(driver, selector) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const alreadyPresent = await driver.executeScript(`
      return document.querySelector('.lextrace-inline-text-editor') instanceof HTMLElement;
    `);
    if (alreadyPresent === true) {
      return;
    }

    await driver.executeScript(
      `
        const element = document.querySelector(arguments[0]);
        if (!(element instanceof HTMLElement)) {
          throw new Error('Inline edit target is unavailable for ' + arguments[0]);
        }
        element.dispatchEvent(new MouseEvent('dblclick', {
          bubbles: true,
          cancelable: true,
          view: window
        }));
      `,
      selector
    );

    try {
      await waitFor(
        async () => {
          const present = await driver.executeScript(`
            return document.querySelector('.lextrace-inline-text-editor') instanceof HTMLElement;
          `);
          return present === true;
        },
        2500,
        "Inline editor did not appear."
      );
      return;
    } catch (error) {
      if (attempt === 2) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
}

async function dismissInlineEditor(driver) {
  await driver.executeScript(`
    const editor = document.querySelector('.lextrace-inline-text-editor');
    if (editor instanceof HTMLElement) {
      editor.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true
      }));
    }
  `);
  await waitFor(
    async () => {
      const present = await driver.executeScript(`
        return document.querySelector('.lextrace-inline-text-editor') instanceof HTMLElement;
      `);
      return present === false;
    },
    10000,
    "Inline editor did not close."
  );
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

async function getInlineEditorAnchorSnapshot(driver, selector) {
  return driver.executeScript(
    `
      const buildRectSnapshot = (rect) => ({
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      });
      const buildTargetTextRect = (element) => {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        let current = walker.nextNode();
        const rects = [];
        while (current) {
          if (current instanceof Text && (current.textContent ?? '').trim().length > 0) {
            const range = document.createRange();
            range.selectNodeContents(current);
            rects.push(...[...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0));
            range.detach?.();
          }
          current = walker.nextNode();
        }
        if (rects.length === 0) {
          return element.getBoundingClientRect();
        }
        let left = rects[0].left;
        let top = rects[0].top;
        let right = rects[0].right;
        let bottom = rects[0].bottom;
        rects.slice(1).forEach((rect) => {
          left = Math.min(left, rect.left);
          top = Math.min(top, rect.top);
          right = Math.max(right, rect.right);
          bottom = Math.max(bottom, rect.bottom);
        });
        return {
          left,
          top,
          width: Math.max(0, right - left),
          height: Math.max(0, bottom - top)
        };
      };
      const buildEditorRect = (editor) => {
        if (editor instanceof HTMLTextAreaElement) {
          return editor.getBoundingClientRect();
        }

        const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
        let current = walker.nextNode();
        const rects = [];
        while (current) {
          if (current instanceof Text && (current.textContent ?? '').trim().length > 0) {
            const range = document.createRange();
            range.selectNodeContents(current);
            rects.push(...[...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0));
            range.detach?.();
          }
          current = walker.nextNode();
        }
        if (rects.length === 0) {
          return editor.getBoundingClientRect();
        }
        let left = rects[0].left;
        let top = rects[0].top;
        let right = rects[0].right;
        let bottom = rects[0].bottom;
        rects.slice(1).forEach((rect) => {
          left = Math.min(left, rect.left);
          top = Math.min(top, rect.top);
          right = Math.max(right, rect.right);
          bottom = Math.max(bottom, rect.bottom);
        });
        return {
          left,
          top,
          width: Math.max(0, right - left),
          height: Math.max(0, bottom - top)
        };
      };
      const target = document.querySelector(arguments[0]);
      const editor = document.querySelector('.lextrace-inline-text-editor');
      if (!(target instanceof HTMLElement)) {
        return {
          editorPresent: false,
          targetPresent: false
        };
      }
      const targetRect = buildTargetTextRect(target);
      if (!(editor instanceof HTMLElement)) {
        return {
          editorPresent: false,
          targetPresent: true,
          targetRect: buildRectSnapshot(targetRect)
        };
      }
      const editorRect = buildEditorRect(editor);
      return {
        editorPresent: true,
        targetPresent: true,
        deltaLeft: Math.round(editorRect.left - targetRect.left),
        deltaTop: Math.round(editorRect.top - targetRect.top),
        deltaWidth: Math.round(editorRect.width - targetRect.width),
        deltaHeight: Math.round(editorRect.height - targetRect.height),
        targetRect: buildRectSnapshot(targetRect),
        editorRect: buildRectSnapshot(editorRect)
      };
    `,
    selector
  );
}

async function waitForDownloadedJsonFile(downloadDir) {
  let downloadedFileName = null;
  await waitFor(async () => {
    const entries = await fs.readdir(downloadDir).catch(() => []);
    const jsonFiles = entries.filter((entry) => entry.toLowerCase().endsWith(".json"));
    const partialFiles = entries.filter((entry) => entry.toLowerCase().endsWith(".crdownload"));
    if (partialFiles.length > 0 || jsonFiles.length === 0) {
      return false;
    }
    downloadedFileName = jsonFiles.sort().at(-1) ?? null;
    return downloadedFileName !== null;
  }, 15000, "JSON download file did not appear in the Edge download directory.");

  return {
    fileName: downloadedFileName,
    filePath: path.join(downloadDir, downloadedFileName)
  };
}

async function installDownloadProbe(driver) {
  await driver.executeScript(`
    if (window.__lextraceTextDownloadProbeInstalled === true) {
      return;
    }

    window.__lextraceTextDownloadProbeInstalled = true;
    window.__lextraceTextDownload = null;

    const originalCreateObjectURL = URL.createObjectURL.bind(URL);
    URL.createObjectURL = function createObjectURLWithProbe(blob) {
      const objectUrl = originalCreateObjectURL(blob);
      if (blob && typeof blob.text === 'function' && String(blob.type ?? '').includes('application/json')) {
        blob.text().then((text) => {
          const current = window.__lextraceTextDownload ?? {};
          window.__lextraceTextDownload = {
            ...current,
            href: objectUrl,
            text
          };
        });
      }
      return objectUrl;
    };

    const originalAnchorClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function clickWithProbe() {
      if (this.download) {
        const current = window.__lextraceTextDownload ?? {};
        window.__lextraceTextDownload = {
          ...current,
          download: this.download,
          href: this.href
        };
      }
      return originalAnchorClick.apply(this, arguments);
    };
  `);
}

async function waitForDownloadProbe(driver) {
  await waitFor(async () => {
    const probe = await driver.executeScript(`return window.__lextraceTextDownload ?? null;`);
    return typeof probe?.download === "string" && typeof probe?.text === "string";
  }, 10000, "JSON download probe did not capture the text-map payload.");

  return driver.executeScript(`return window.__lextraceTextDownload;`);
}

async function startProofServer() {
  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");

    if (requestUrl.pathname === "/pixel.png") {
      const pixel = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9W5xpo8AAAAASUVORK5CYII=",
        "base64"
      );
      response.writeHead(200, {
        "Content-Type": "image/png",
        "Content-Length": pixel.byteLength
      });
      response.end(pixel);
      return;
    }

    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8"
    });
    response.end(buildProofPage(requestUrl.pathname));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to determine the proof server address.");
  }

  const origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    makeUrl: (pathname) => new URL(pathname, origin).toString(),
    close: async () => {
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  };
}

function buildProofPage(pathname) {
  if (pathname === "/duplicate-chaos") {
    return `<!doctype html>
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <title>LexTrace Duplicate Chaos</title>
          <style>
            body { font-family: Segoe UI, sans-serif; margin: 24px; }
            .card { border: 1px solid #444; padding: 12px; margin-bottom: 12px; }
          </style>
        </head>
        <body>
          <main>
            <div class="card"><h1>Repeat me</h1><p>Repeat me</p><span>Repeat me</span></div>
            <div class="card"><p><span><strong>Repeat me</strong></span></p></div>
            <div class="card"><button>Repeat me</button><a href="#dup">Repeat me</a></div>
          </main>
        </body>
      </html>`;
  }

  if (pathname === "/scroll-lab") {
    return `<!doctype html>
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <title>LexTrace Scroll Lab</title>
          <style>
            body { font-family: Segoe UI, sans-serif; margin: 0; line-height: 1.45; }
            .spacer { height: 900px; background: linear-gradient(180deg, #f3f3f3 0%, #ffffff 100%); }
            .panel { width: min(820px, calc(100vw - 48px)); margin: 0 auto; border: 1px solid #444; padding: 20px; background: #fff; }
            #scroll-target { font-size: 24px; font-weight: 600; }
          </style>
        </head>
        <body>
          <div class="spacer"></div>
          <section class="panel">
            <p>Scroll tracking prelude</p>
            <p id="scroll-target">Scroll anchored editable text</p>
            <p>Scroll tracking epilogue</p>
          </section>
          <div class="spacer"></div>
        </body>
      </html>`;
  }

  if (pathname === "/dense-grid") {
    const chips = Array.from({ length: 260 }, (_, index) =>
      `<span class="chip">Dense visible ${String(index + 1).padStart(3, "0")}</span>`
    ).join("");
    return `<!doctype html>
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <title>LexTrace Dense Grid</title>
          <style>
            body { font-family: Segoe UI, sans-serif; margin: 16px; }
            .grid {
              display: flex;
              flex-wrap: wrap;
              gap: 6px;
              align-items: flex-start;
              max-width: 1520px;
            }
            .chip {
              display: inline-block;
              padding: 2px 5px;
              font-size: 10px;
              line-height: 1.1;
              border: 1px solid #999;
              background: #fff;
              white-space: nowrap;
            }
          </style>
        </head>
        <body>
          <main>
            <div class="grid">${chips}</div>
          </main>
        </body>
      </html>`;
  }

  return `<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>LexTrace Weird DOM</title>
        <style>
          body { font-family: Segoe UI, sans-serif; margin: 24px; line-height: 1.45; }
          main { display: grid; gap: 16px; }
          .grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); }
          .panel { border: 1px solid #444; padding: 12px; }
          .contents-shell { display: contents; }
          [hidden] { display: none !important; }
        </style>
        <script>
          window.addEventListener('load', () => {
            setTimeout(() => {
              const host = document.querySelector('#dynamic-host');
              if (host) {
                host.innerHTML = '<section class="panel"><h3 id="dynamic-heading">Delayed bootstrap heading</h3><p>Delayed bootstrap paragraph</p></section>';
              }
            }, 1400);
          });
        </script>
      </head>
      <body>
        <main id="proof-root">
          <section class="panel">
            <h1 id="main-title">Alpha title</h1>
            <p id="lead-copy">Alpha paragraph for replacement</p>
            <p>Repeat me</p>
            <div><span>Repeat me</span><strong>Nested broken text block</strong></div>
          </section>
          <section class="grid">
            <div class="panel">
              <button data-testid="cta">Press button text</button>
              <button id="nested-cta"><span><strong>Nested CTA label</strong></span></button>
              <button id="aria-only" aria-label="Aria only action"><span aria-hidden="true">⚙</span></button>
              <a href="#anchor">Anchor label text</a>
              <label for="field-one">Visible label text</label>
              <div id="tooltip-carrier" title="Tooltip title text">Hover title host</div>
            </div>
            <div class="panel">
              <input id="field-one" value="Field original value" placeholder="Field original placeholder" />
              <textarea id="memo-one" placeholder="Textarea original placeholder">Textarea original value</textarea>
              <img src="/pixel.png" alt="Image original alt" />
              <figure>
                <img src="/pixel.png" alt="Figure image alt" />
                <figcaption>Figure caption text</figcaption>
              </figure>
            </div>
            <div class="panel">
              <table>
                <caption>Table caption text</caption>
                <tr><th>Head cell text</th><td>Cell text body</td></tr>
              </table>
              <div class="contents-shell"><span id="contents-visible">Display contents visible text</span></div>
              <select id="topic-select">
                <option>Option alpha</option>
                <option>Option beta</option>
              </select>
            </div>
          </section>
          <section class="panel">
            <p hidden>Hidden text should not be scanned</p>
            <div id="noise-host" hidden><span>Noise mutation hidden text</span></div>
            <div id="dynamic-host"></div>
          </section>
        </main>
      </body>
    </html>`;
}

main().catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
  try {
    await writeJson(REPORT_PATH, {
      executedAt: new Date().toISOString(),
      failed: true,
      error: error instanceof Error ? error.message : String(error)
    });
  } catch {
    // Ignore secondary report-write failures.
  }
});
