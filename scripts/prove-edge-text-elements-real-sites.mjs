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
  openBrowserTab,
  openConfigTab,
  pruneBrowserTabs,
  setPopupRuntimeHandle,
  setSelectValue,
  switchToHandle,
  waitFor
} from "./lib/edge-ai-harness.mjs";

const REPORT_PATH = path.join(paths.artifacts, "test-results", "edge-text-elements-real-sites-report.json");
const SCREENSHOT_DIR = path.join(paths.artifacts, "test-results", "edge-text-elements-real-sites-visuals");

const REAL_SITES = [
  {
    key: "youtube",
    url: "https://www.youtube.com/"
  },
  {
    key: "twitch",
    url: "https://www.twitch.tv/directory"
  },
  {
    key: "fimfiction",
    url: "https://www.fimfiction.net/"
  }
];

async function main() {
  const extensionMetadata = await ensureExtensionKeyMetadata();
  const popupUrl = `chrome-extension://${extensionMetadata.extensionId}/popup.html`;
  await fs.rm(SCREENSHOT_DIR, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(SCREENSHOT_DIR, { recursive: true });

  const { driver, userDataDir } = await launchEdgeWithExtension();
  const report = {
    executedAt: new Date().toISOString(),
    popupUrl,
    screenshotDir: SCREENSHOT_DIR,
    sites: []
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
    popupHandle = await openBrowserTab(driver, popupUrl);
    await pruneBrowserTabs(driver, [mainHandle, popupHandle]);
    setPopupRuntimeHandle(popupHandle);
    await ensurePopupReady(driver);
    await enableTextDebugConfig(driver);

    for (const site of REAL_SITES) {
      const siteResult = {
        key: site.key,
        url: site.url
      };
      try {
        await switchToHandle(driver, mainHandle);
        await navigateToSite(driver, site.url);

        await new Promise((resolve) => setTimeout(resolve, 5000));
        await openOverlayAndWait(driver, popupHandle, mainHandle, site.url);
        const scanResult = await runOverlayTerminalCommand(driver, "text.scan");
        siteResult.scanResult = scanResult.lastTerminalResult ?? "";
        const textsSnapshot = await getTextsTabSnapshot(driver);
        const highlightSnapshot = await getHighlightSnapshot(driver);
        const pageKey = await driver.executeScript(`
          return window.location.origin + window.location.pathname;
        `);
        const storedPageMap = await readStoredTextPageMap(driver, popupHandle, pageKey);
        const suspiciousBoxes = buildSuspiciousBoxReport(textsSnapshot.entries, highlightSnapshot, storedPageMap?.bindings ?? []);
        siteResult.entryCount = textsSnapshot.entryCount;
        siteResult.highlightCount = highlightSnapshot.count;
        siteResult.suspiciousBoxes = suspiciousBoxes;
        siteResult.screenshotPath = await captureScreenshot(driver, `${site.key}.png`);

        if (site.key === "youtube") {
          const deepScroll = await runDeepScrollProof(driver, popupHandle, pageKey, textsSnapshot.entryCount);
          siteResult.deepScroll = deepScroll;
          siteResult.deepScrollScreenshotPath = await captureScreenshot(driver, `${site.key}-deep-scroll.png`);
          if (!deepScroll.retainedHighlights) {
            throw new Error("YouTube deep-scroll proof lost all highlight boxes on at least one step.");
          }
          if (!deepScroll.expandedOrRetainedEntries) {
            throw new Error("YouTube deep-scroll proof did not retain or expand text bindings.");
          }
        }

        const inlineProbe = await probeInlineEditorAgainstLargestBox(driver, suspiciousBoxes);
        siteResult.inlineProbe = inlineProbe;
      } catch (error) {
        siteResult.error = error instanceof Error ? error.message : String(error);
      }

      report.sites.push(siteResult);
    }

    await writeJson(REPORT_PATH, report);
    console.log(`Real-site text geometry proof saved to ${REPORT_PATH}`);
  } finally {
    setPopupRuntimeHandle(null);
    await driver.quit().catch(() => {});
    if (userDataDir) {
      await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

async function enableTextDebugConfig(driver) {
  await openConfigTab(driver);
  await setSelectValueWithRetry(driver, "debug.textElements.highlightEnabled", "true");
  await setSelectValueWithRetry(driver, "debug.textElements.inlineEditingEnabled", "true");
  await setSelectValueWithRetry(driver, "debug.textElements.displayMode", "effective");
  await setSelectValueWithRetry(driver, "debug.textElements.autoScanMode", "incremental");
}

async function setSelectValueWithRetry(driver, configPath, value) {
  await waitFor(
    async () => {
      const present = await driver.executeScript(
        `return !!document.querySelector("button[data-config-path='" + arguments[0] + "']");`,
        configPath
      );
      return present === true;
    },
    10000,
    `Popup config control did not appear for ${configPath}.`
  );

  let lastError = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await setSelectValue(driver, configPath, value);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  throw lastError ?? new Error(`Failed to set popup select ${configPath}.`);
}

async function openOverlayAndWait(driver, popupHandle, mainHandle, expectedUrl) {
  await switchToHandle(driver, mainHandle);
  await waitForPageReady(driver, expectedUrl, 30000);

  await clickOpenTerminalFromPopup(driver, popupHandle);
  await switchToHandle(driver, mainHandle);
  await waitForOverlay(driver);
}

async function navigateToSite(driver, url) {
  try {
    await driver.get(url);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isRendererTimeout =
      message.includes("Timed out receiving message from renderer") ||
      message.includes("timeout: Timed out receiving message from renderer");
    if (!isRendererTimeout) {
      throw error;
    }
  }

  await waitForPageReady(driver, url, 45000);
}

async function runDeepScrollProof(driver, popupHandle, pageKey, initialEntryCount) {
  const samples = [];
  for (let step = 0; step < 6; step += 1) {
    await driver.executeScript(`
      window.scrollBy({
        top: Math.max(480, Math.floor(window.innerHeight * 0.9)),
        behavior: 'auto'
      });
    `);
    await new Promise((resolve) => setTimeout(resolve, 1800));
    const textsSnapshot = await getTextsTabSnapshot(driver);
    const highlightSnapshot = await getHighlightSnapshot(driver);
    const storedPageMap = await readStoredTextPageMap(driver, popupHandle, pageKey);
    samples.push({
      step: step + 1,
      entryCount: textsSnapshot.entryCount,
      highlightCount: highlightSnapshot.count,
      storedBindingCount: storedPageMap?.bindings?.length ?? null
    });
  }

  const highlightCounts = samples.map((sample) => sample.highlightCount);
  const entryCounts = samples.map((sample) => sample.entryCount);
  return {
    initialEntryCount,
    samples,
    minHighlightCount: Math.min(...highlightCounts),
    maxEntryCount: Math.max(initialEntryCount, ...entryCounts),
    retainedHighlights: highlightCounts.every((count) => count > 0),
    expandedOrRetainedEntries: Math.max(initialEntryCount, ...entryCounts) >= initialEntryCount
  };
}

async function waitForOverlay(driver) {
  await waitFor(
    async () => {
      const visible = await driver.executeScript(`
        const host = document.querySelector('#lextrace-overlay-root');
        if (!(host instanceof HTMLElement)) {
          return false;
        }
        return window.getComputedStyle(host).display !== 'none';
      `);
      return visible === true;
    },
    15000,
    "Overlay did not appear."
  );
}

async function waitForPageReady(driver, expectedUrl, timeoutMs) {
  await waitFor(
    async () => {
      const status = await driver.executeScript(`
        return {
          href: window.location.href,
          readyState: document.readyState,
          hasBody: document.body instanceof HTMLBodyElement,
          bodyTextLength: (document.body?.innerText ?? '').trim().length
        };
      `);
      return typeof status?.href === "string" &&
        status.href.length > 0 &&
        status.href !== "about:blank" &&
        status.readyState !== "loading" &&
        status.hasBody === true &&
        status.bodyTextLength >= 0;
    },
    timeoutMs,
    `Page ${expectedUrl} did not become ready.`
  );
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
      if (!(input instanceof HTMLInputElement) || !(form instanceof HTMLFormElement)) {
        done({ ok: false, error: 'Overlay terminal is unavailable.' });
        return;
      }

      if (consoleTabButton instanceof HTMLButtonElement) {
        consoleTabButton.click();
      }

      input.focus();
      input.value = command;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      form.requestSubmit();
      setTimeout(() => {
        const terminalEntries = [...root.querySelectorAll('.activity-entry.activity-terminal')];
        const flattened = terminalEntries.map((entry) => entry.textContent?.trim() ?? '').filter(Boolean);
        done({
          ok: true,
          lastTerminalResult: flattened.at(-1) ?? '',
          recentTerminalEntries: flattened.slice(-6)
        });
      }, 1500);
    `,
    command
  );
}

async function getTextsTabSnapshot(driver) {
  return driver.executeScript(`
    const root = document.querySelector('#lextrace-overlay-root')?.shadowRoot;
    root?.querySelector(".overlay-tab-button[data-tab='texts']")?.click();
    const entries = [...(root?.querySelectorAll('.text-binding-entry') ?? [])].map((entry) => {
      const fields = [...entry.querySelectorAll('.text-binding-field .text-binding-value')].map((field) => field.textContent ?? '');
      return {
        bindingId: entry.getAttribute('data-binding-id') ?? '',
        category: entry.getAttribute('data-binding-category') ?? '',
        changed: entry.classList.contains('is-changed'),
        originalText: fields[0] ?? '',
        displayedText: fields[1] ?? '',
        replacementText: fields[2] ?? '',
        contextText: fields[3] ?? ''
      };
    });
    return {
      entryCount: entries.length,
      entries
    };
  `);
}

async function getHighlightSnapshot(driver) {
  return driver.executeScript(`
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
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
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height
        },
        viewportWidth,
        viewportHeight
      };
    });
    return {
      count: items.length + nativeRangeCount,
      overlayBoxCount: items.length,
      nativeRangeCount,
      items
    };
  `);
}

function buildSuspiciousBoxReport(entries, highlightSnapshot, bindings) {
  const textByBindingId = new Map(entries.map((entry) => [entry.bindingId, entry.originalText]));
  const bindingById = new Map(bindings.map((binding) => [binding.bindingId, binding]));
  const suspicious = highlightSnapshot.items
    .map((item) => ({
      bindingId: item.bindingId,
      debugState: item.debugState,
      text: textByBindingId.get(item.bindingId) ?? "",
      category: bindingById.get(item.bindingId)?.category ?? null,
      attributeName: bindingById.get(item.bindingId)?.attributeName ?? null,
      selector: bindingById.get(item.bindingId)?.context?.selectorPreview ??
        bindingById.get(item.bindingId)?.locator?.preferredSelector ??
        bindingById.get(item.bindingId)?.locator?.elementSelector ??
        null,
      rect: item.rect,
      widthRatio: item.viewportWidth > 0 ? item.rect.width / item.viewportWidth : 0
    }))
    .filter((item) => {
      const textLength = item.text.trim().length;
      return item.widthRatio >= 0.7 && textLength > 0 && textLength <= 120 && item.rect.height <= 120;
    })
    .sort((left, right) => right.rect.width - left.rect.width);

  return suspicious.slice(0, 12);
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

async function probeInlineEditorAgainstLargestBox(driver, suspiciousBoxes) {
  const probeTarget = suspiciousBoxes[0] ?? null;
  if (!probeTarget) {
    return null;
  }

  await driver.executeScript(
    `
      const bindingId = arguments[0];
      const box = document.querySelector('[data-lextrace-text-highlight-box="true"][data-lextrace-text-binding-id="' + CSS.escape(bindingId) + '"]');
      if (!(box instanceof HTMLElement)) {
        return;
      }
      const rect = box.getBoundingClientRect();
      const x = rect.left + Math.max(2, Math.min(rect.width - 2, rect.width / 2));
      const y = rect.top + Math.max(2, Math.min(rect.height - 2, rect.height / 2));
      const target = document.elementFromPoint(x, y);
      if (!(target instanceof Element)) {
        return;
      }
      target.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        button: 2,
        buttons: 2,
        clientX: x,
        clientY: y,
        view: window
      }));
    `,
    probeTarget.bindingId
  );

  await waitFor(
    async () => {
      const present = await driver.executeScript(`
        return document.querySelector('.lextrace-inline-text-editor') instanceof HTMLTextAreaElement;
      `);
      return present === true;
    },
    5000,
    "Inline editor did not appear for the suspicious binding."
  );

  return driver.executeScript(
    `
      const bindingId = arguments[0];
      const box = document.querySelector('[data-lextrace-text-highlight-box="true"][data-lextrace-text-binding-id="' + CSS.escape(bindingId) + '"]');
      const editor = document.querySelector('.lextrace-inline-text-editor');
      if (!(box instanceof HTMLElement) || !(editor instanceof HTMLTextAreaElement)) {
        return null;
      }
      const boxRect = box.getBoundingClientRect();
      const editorRect = editor.getBoundingClientRect();
      return {
        bindingId,
        deltaLeft: Math.round(editorRect.left - boxRect.left),
        deltaTop: Math.round(editorRect.top - boxRect.top),
        deltaWidth: Math.round(editorRect.width - boxRect.width),
        deltaHeight: Math.round(editorRect.height - boxRect.height),
        boxRect: {
          left: Math.round(boxRect.left),
          top: Math.round(boxRect.top),
          width: Math.round(boxRect.width),
          height: Math.round(boxRect.height)
        },
        editorRect: {
          left: Math.round(editorRect.left),
          top: Math.round(editorRect.top),
          width: Math.round(editorRect.width),
          height: Math.round(editorRect.height)
        }
      };
    `,
    probeTarget.bindingId
  );
}

async function captureScreenshot(driver, fileName) {
  const filePath = path.join(SCREENSHOT_DIR, fileName);
  const base64 = await driver.takeScreenshot();
  await fs.writeFile(filePath, base64, "base64");
  return filePath;
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
    // ignore
  }
});
