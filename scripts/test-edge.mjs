import assert from "node:assert/strict";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";

import { chromium } from "@playwright/test";
import { Builder, Browser } from "selenium-webdriver";
import edge from "selenium-webdriver/edge.js";

import {
  cleanDir,
  ensureExtensionKeyMetadata,
  fileExists,
  getNativeHostExePath,
  paths,
  readJson,
  run
} from "./lib/common.mjs";

async function main() {
  await prepareArtifacts();

  const extensionMetadata = await ensureExtensionKeyMetadata();
  const extensionBaseUrl = `chrome-extension://${extensionMetadata.extensionId}`;
  const popupUrl = `${extensionBaseUrl}/popup.html`;

  const server = await startLocalServer();

  try {
    try {
      await seedEdgeProfile(popupUrl);
      await runPlaywrightFlow({
        popupUrl,
        pageUrl: server.url,
        slowUrl: server.slowUrl
      });
    } catch (error) {
      console.warn(`Playwright harness failed, switching to EdgeDriver fallback: ${error.message}`);
      await runSeleniumFlow({
        popupUrl,
        pageUrl: server.url,
        slowUrl: server.slowUrl
      });
    }
  } finally {
    await server.close();
  }
}

async function prepareArtifacts() {
  await run(process.execPath, ["scripts/build-extension.mjs"]);
  await run(process.execPath, ["scripts/build-native-host.mjs"]);
  await run(process.execPath, ["scripts/pack-extension.mjs"]);
  await run(process.execPath, ["scripts/register-native-host.mjs"]);

  assert.equal(await fileExists(paths.packagedCrx), true, "Packed CRX is missing.");
  assert.equal(await fileExists(getNativeHostExePath()), true, "Native host executable is missing.");
}

async function seedEdgeProfile(popupUrl) {
  await cleanDir(paths.edgeUserData);

  const options = createEdgeOptions(paths.edgeUserData);
  options.addExtensions(paths.packagedCrx);

  const driver = await new Builder()
    .forBrowser(Browser.EDGE)
    .setEdgeOptions(options)
    .build();

  try {
    await driver.get("about:blank");
    await delay(1500);
    await driver.get(popupUrl);
    await delay(1500);
  } finally {
    await driver.quit();
  }

  await delay(2000);
}

async function runPlaywrightFlow({ popupUrl, pageUrl, slowUrl }) {
  const context = await chromium.launchPersistentContext(paths.edgeUserData, {
    channel: "msedge",
    headless: false,
    args: [
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-search-engine-choice-screen",
      "--disable-features=msEdgeAccountConsistency"
    ]
  });

  try {
    const pages = context.pages();
    const appPage = pages[0] ?? (await context.newPage());
    await appPage.goto(slowUrl, { waitUntil: "commit" });
    await appPage.bringToFront();

    const popupPage = await context.newPage();
    await popupPage.goto(popupUrl, { waitUntil: "load" });

    await popupPage.locator("text=LexTrace NT3").waitFor();
    await popupPage.locator("#status-preview").waitFor({ state: "detached" }).catch(() => {});

    await popupPage.locator("#open-terminal").click();
    await expectTextInLocator(popupPage.locator("#terminal-state"), "opened on tab");
    await appPage.locator("#lextrace-overlay-root").waitFor({ state: "attached", timeout: 10000 });

    await appPage.goto("about:blank", { waitUntil: "load" });
    await popupPage.locator("#open-terminal").click();
    await expectTextInLocator(popupPage.locator("#terminal-state"), "regular http(s) page");

    await appPage.goto(pageUrl, { waitUntil: "load" });
    await popupPage.locator(".tab-button[data-tab='config']").click();
    await popupPage.locator("#config-preview").waitFor({ state: "detached" }).catch(() => {});
    await popupPage.locator("#config-frame").waitFor();
    await popupPage.locator("#config-viewport").waitFor();
    await popupPage.locator("#config-viewer .json-line").first().waitFor();
    assert.equal(await popupPage.locator("#config-preview").count(), 0, "Old config preview is still present.");
    const configViewportMetrics = await popupPage.locator("#config-viewport").evaluate((element) => ({
      overflowY: window.getComputedStyle(element).overflowY,
      noHorizontalScroll: element.scrollWidth <= element.clientWidth + 1
    }));
    assert.equal(configViewportMetrics.overflowY, "auto", "Config viewport must own vertical scrolling.");
    assert.equal(configViewportMetrics.noHorizontalScroll, true, "Config viewport should not show horizontal scroll.");

    await popupPage.locator("button[data-config-path='logging.level']").click();
    await popupPage.locator("[data-editor-path='logging.level']").selectOption("warn");
    await popupPage.locator("[data-editor-path='logging.level']").blur();
    await popupPage.waitForFunction(() => {
      const button = document.querySelector("button[data-config-path='logging.level']");
      return button?.textContent?.trim() === "warn";
    });

    await popupPage.locator("button[data-config-path='runtime.commandTimeoutMs']").click();
    await popupPage.locator("[data-editor-path='runtime.commandTimeoutMs']").fill("2500");
    await popupPage.locator("[data-editor-path='runtime.commandTimeoutMs']").press("Enter");
    await popupPage.waitForFunction(() => {
      const button = document.querySelector("button[data-config-path='runtime.commandTimeoutMs']");
      return button?.textContent?.trim() === "2500";
    });

    await popupPage.locator("button[data-config-path='runtime.commandTimeoutMs']").click();
    await popupPage.locator("[data-editor-path='runtime.commandTimeoutMs']").fill("broken");
    await popupPage.locator("[data-editor-path='runtime.commandTimeoutMs']").press("Enter");
    await expectTextInLocator(popupPage.locator("#terminal-state"), "integer");
    await popupPage.waitForFunction(() => {
      const button = document.querySelector("button[data-config-path='runtime.commandTimeoutMs']");
      return button?.textContent?.trim() === "2500";
    });

    await popupPage.locator("button[data-config-path='ui.overlay.visible']").click();
    await popupPage.locator("[data-editor-path='ui.overlay.visible']").selectOption("true");
    await popupPage.waitForFunction(() => {
      const button = document.querySelector("button[data-config-path='ui.overlay.visible']");
      const activeTab = document.querySelector(".tab-button.is-active")?.getAttribute("data-tab");
      return button?.textContent?.trim() === "true" && activeTab === "config";
    });
    await appPage.waitForFunction(() => {
      const overlayRoot = document.querySelector("#lextrace-overlay-root");
      return overlayRoot?.style.display === "block";
    });

    await popupPage.locator("button[data-config-path='ui.overlay.visible']").click();
    await popupPage.locator("[data-editor-path='ui.overlay.visible']").selectOption("false");
    await popupPage.waitForFunction(() => {
      const button = document.querySelector("button[data-config-path='ui.overlay.visible']");
      const activeTab = document.querySelector(".tab-button.is-active")?.getAttribute("data-tab");
      return button?.textContent?.trim() === "false" && activeTab === "config";
    });
    await appPage.waitForFunction(() => {
      const overlayRoot = document.querySelector("#lextrace-overlay-root");
      return overlayRoot?.style.display === "none";
    });

    const originalHostName = await popupPage.locator("button[data-config-path='runtime.nativeHostName']").textContent();
    await popupPage.locator("button[data-config-path='runtime.nativeHostName']").click();
    await popupPage.locator("[data-editor-path='runtime.nativeHostName']").fill("com.lextrace.changed");
    await popupPage.locator("[data-editor-path='runtime.nativeHostName']").press("Escape");
    await popupPage.waitForFunction((expected) => {
      const button = document.querySelector("button[data-config-path='runtime.nativeHostName']");
      return button?.textContent?.trim() === expected;
    }, originalHostName?.trim() ?? "");

    await popupPage.locator(".tab-button[data-tab='control']").click();
    await popupPage.locator("#open-terminal").click();

    const overlayRoot = appPage.locator("#lextrace-overlay-root");
    await overlayRoot.waitFor({ state: "attached", timeout: 10000 });
    await overlayRoot.locator("text=LexTrace Terminal").waitFor({ timeout: 10000 });
    const activityFeed = overlayRoot.locator("[data-role='activity-feed']");
    await activityFeed.waitFor();
    assert.equal(await overlayRoot.locator(".tab-strip").count(), 0, "Overlay tab strip should be removed.");

    await overlayRoot.locator(".close-button").click();
    await popupPage.locator("#open-terminal").click();
    await overlayRoot.locator("text=LexTrace Terminal").waitFor({ timeout: 10000 });

    const terminalInput = overlayRoot.locator("[data-role='terminal-input']");
    await terminalInput.fill("work");
    await overlayRoot.locator(".terminal-suggestion-item").first().waitFor();
    await terminalInput.press("Tab");
    assert.equal(await terminalInput.inputValue(), "worker.start", "Terminal autocomplete did not apply the selected suggestion.");
    await terminalInput.fill("");
    const initialOverlayPosition = await readPlaywrightOverlayPosition(overlayRoot);
    const playwrightDragDelta = getOverlayDragDelta(initialOverlayPosition);
    assert.ok(
      playwrightDragDelta.deltaX !== 0 || playwrightDragDelta.deltaY !== 0,
      "Overlay had no draggable room inside the viewport."
    );
    await dragPlaywrightOverlay(overlayRoot, playwrightDragDelta.deltaX, playwrightDragDelta.deltaY);
    const draggedOverlayPosition = await readPlaywrightOverlayPosition(overlayRoot);
    assert.ok(
      draggedOverlayPosition.left !== initialOverlayPosition.left ||
        draggedOverlayPosition.top !== initialOverlayPosition.top,
      "Overlay position did not change after drag."
    );

    const pageKeyCountBeforeTyping = await appPage.evaluate(() => (window.lextraceHarnessKeys ?? []).length);
    await terminalInput.focus();
    await appPage.keyboard.type("abc");
    await delay(300);
    const pageKeyCountAfterTyping = await appPage.evaluate(() => (window.lextraceHarnessKeys ?? []).length);
    const terminalValue = await terminalInput.inputValue();
    assert.equal(pageKeyCountAfterTyping, pageKeyCountBeforeTyping, "Page received keyboard input while terminal was focused.");
    assert.equal(terminalValue, "abc", "Terminal input did not retain typed text.");
    await terminalInput.fill("");

    await delay(35000);
    const idleDisconnectCount = await overlayRoot.locator("text=Runtime stream disconnected. Retrying…").count();
    assert.equal(idleDisconnectCount, 0, "Overlay runtime stream disconnected during idle period.");

    await runTerminalCommand(terminalInput, "worker.start");
    await runTerminalCommand(terminalInput, "task.demo.start {\"taskId\":\"demo-task\"}");

    await popupPage.waitForFunction(() => {
      const badge = document.querySelector("#status-badge");
      return badge?.textContent?.trim() === "running";
    });

    const initialBootId = (await popupPage.locator("#worker-boot").textContent())?.trim();
    assert.ok(initialBootId && initialBootId !== "-", "bootId was not populated");

    await delay(125000);

    const stableBootId = (await popupPage.locator("#worker-boot").textContent())?.trim();
    assert.equal(stableBootId, initialBootId, "bootId changed during >120s keepalive run");

    const logEntries = overlayRoot.locator(".activity-log");
    const terminalEntries = overlayRoot.locator(".activity-terminal");
    const allActivityEntries = overlayRoot.locator(".activity-entry");
    assert.ok((await logEntries.count()) >= 10, "Expected at least 10 runtime log entries.");
    assert.ok((await terminalEntries.count()) >= 4, "Expected terminal activity entries in the unified feed.");

    const noHorizontalScroll = await activityFeed.evaluate((element) => {
      return element.scrollWidth <= element.clientWidth + 1;
    });
    assert.equal(noHorizontalScroll, true, "Unified activity feed has horizontal scroll.");

    const collapsedCount = await allActivityEntries.evaluateAll((elements) => {
      return elements.filter((element) => element instanceof HTMLDetailsElement && element.open === false).length;
    });
    assert.equal(collapsedCount, await allActivityEntries.count(), "All terminal activity entries must be collapsed by default.");
    assert.equal(await overlayRoot.locator(".log-preview").count(), 0, "Collapsed log summary must not duplicate expanded content.");

    await runTerminalCommand(terminalInput, "test.host.crash");
    await popupPage.waitForFunction(() => {
      const badge = document.querySelector("#status-badge");
      return badge?.textContent?.trim() === "running";
    }, undefined, { timeout: 15000 });

    const recoveredTaskId = (await popupPage.locator("#worker-task").textContent())?.trim();
    assert.equal(recoveredTaskId, "demo-task", "Task id was not restored after host crash.");

    await runTerminalCommand(terminalInput, "worker.stop");
    await popupPage.waitForFunction(() => {
      const badge = document.querySelector("#status-badge");
      return badge?.textContent?.trim() === "offline";
    }, undefined, { timeout: 10000 });

    await runTerminalCommand(terminalInput, "clear");
    await appPage.waitForFunction(() => {
      const feed = document
        .querySelector("#lextrace-overlay-root")
        ?.shadowRoot
        ?.querySelector("[data-role='activity-feed']");
      return (feed?.textContent ?? "").trim().length === 0;
    });

    console.log("Edge e2e flow passed.");
  } finally {
    await context.close();
  }
}

async function runSeleniumFlow({ popupUrl, pageUrl, slowUrl }) {
  await cleanDir(paths.edgeProfile);

  const options = createEdgeOptions(paths.edgeProfile);
  options.addExtensions(paths.packagedCrx);

  const driver = await new Builder()
    .forBrowser(Browser.EDGE)
    .setEdgeOptions(options)
    .build();

  try {
    await driver.get(pageUrl);
    const appHandle = await driver.getWindowHandle();

    await driver.switchTo().newWindow("tab");
    const popupHandle = await driver.getWindowHandle();
    await driver.get(popupUrl);

    const popupTitle = await driver.executeScript("return document.querySelector('h1')?.textContent ?? null;");
    assert.equal(popupTitle, "LexTrace NT3", "Popup shell did not render.");

    await driver.switchTo().window(popupHandle);
    const slowTabId = await createSeleniumExtensionTab(driver, slowUrl);
    await waitFor(async () => {
      const tabInfo = await readSeleniumTabInfo(driver, slowTabId);
      return (
        typeof tabInfo?.url === "string" && tabInfo.url.includes("/slow")
      ) || (
        typeof tabInfo?.pendingUrl === "string" && tabInfo.pendingUrl.includes("/slow")
      );
    }, 10000, "Slow tab did not expose slowUrl state.");
    await driver.get(`${popupUrl}?targetTabId=${slowTabId}&targetUrl=${encodeURIComponent(slowUrl)}`);
    await driver.executeScript("document.querySelector('#open-terminal')?.click();");
    try {
      await waitFor(async () => {
        const message = await driver.executeScript("return document.querySelector('#terminal-state')?.textContent ?? null;");
        return typeof message === "string" && message.toLowerCase().includes("opened on tab");
      }, 10000, "Popup did not open terminal on slow current page.");
    } catch (error) {
      const slowDebug = await driver.executeScript(`
        return {
          terminalState: document.querySelector('#terminal-state')?.textContent ?? null,
          badge: document.querySelector('#status-badge')?.textContent ?? null,
          location: window.location.href
        };
      `);
      throw new Error(`${error.message}\nSlow debug: ${JSON.stringify(slowDebug, null, 2)}`);
    }
    await removeSeleniumTab(driver, slowTabId);

    const unsupportedTabId = await createSeleniumExtensionTab(driver, "about:blank");
    await waitFor(async () => {
      const tabInfo = await readSeleniumTabInfo(driver, unsupportedTabId);
      return (
        typeof tabInfo?.url === "string" && tabInfo.url === "about:blank"
      ) || (
        typeof tabInfo?.pendingUrl === "string" && tabInfo.pendingUrl === "about:blank"
      );
    }, 10000, "Unsupported tab did not expose about:blank state.");
    await driver.get(`${popupUrl}?targetTabId=${unsupportedTabId}&targetUrl=${encodeURIComponent("about:blank")}`);
    await driver.executeScript("document.querySelector('#open-terminal')?.click();");
    await waitFor(async () => {
      const message = await driver.executeScript("return document.querySelector('#terminal-state')?.textContent ?? null;");
      return typeof message === "string" && message.toLowerCase().includes("regular http(s) page");
    }, 10000, "Popup did not report unsupported tab.");
    await removeSeleniumTab(driver, unsupportedTabId);

    await driver.switchTo().window(appHandle);
    await driver.get(pageUrl);

    await driver.switchTo().window(popupHandle);
    await driver.get(popupUrl);
    await driver.executeScript("document.querySelector(\".tab-button[data-tab='config']\")?.click();");
    const configViewerPresent = await driver.executeScript(`
      return {
        legacy: !!document.querySelector('#config-preview'),
        frame: !!document.querySelector('#config-frame'),
        viewport: !!document.querySelector('#config-viewport'),
        lines: document.querySelectorAll('#config-viewer .json-line').length,
        overflowY: (() => {
          const viewport = document.querySelector('#config-viewport');
          return viewport ? getComputedStyle(viewport).overflowY : null;
        })(),
        noHorizontalScroll: (() => {
          const viewport = document.querySelector('#config-viewport');
          return viewport ? viewport.scrollWidth <= viewport.clientWidth + 1 : false;
        })()
      };
    `);
    assert.equal(configViewerPresent.legacy, false, "Old config preview should be removed.");
    assert.equal(configViewerPresent.frame, true, "Config frame is missing.");
    assert.equal(configViewerPresent.viewport, true, "Config viewport is missing.");
    assert.ok(configViewerPresent.lines > 0, "Config JSON viewer did not render.");
    assert.equal(configViewerPresent.overflowY, "auto", "Config viewport must own vertical scrolling.");
    assert.equal(configViewerPresent.noHorizontalScroll, true, "Config viewport should not scroll horizontally.");

    await setSeleniumJsonSelectValue(driver, "logging.level", "warn");
    await waitFor(async () => {
      const value = await readSeleniumJsonValue(driver, "logging.level");
      return value === "warn";
    }, 10000, "Enum dropdown edit did not commit.");

    await setSeleniumJsonInputValue(driver, "runtime.commandTimeoutMs", "2500", "enter");
    await waitFor(async () => {
      const value = await readSeleniumJsonValue(driver, "runtime.commandTimeoutMs");
      return value === "2500";
    }, 10000, "Numeric inline edit did not commit.");

    await setSeleniumJsonInputValue(driver, "runtime.commandTimeoutMs", "broken", "enter");
    await waitFor(async () => {
      const message = await driver.executeScript("return document.querySelector('#terminal-state')?.textContent ?? null;");
      return typeof message === "string" && message.toLowerCase().includes("integer");
    }, 10000, "Invalid numeric edit did not report an error.");
    assert.equal(await readSeleniumJsonValue(driver, "runtime.commandTimeoutMs"), "2500");

    await setSeleniumJsonSelectValue(driver, "ui.overlay.visible", "true");
    await waitFor(async () => {
      const state = await driver.executeScript(`
        return {
          value: document.querySelector("button[data-config-path='ui.overlay.visible']")?.textContent?.trim() ?? null,
          activeTab: document.querySelector(".tab-button.is-active")?.getAttribute("data-tab") ?? null
        };
      `);
      return state?.value === "true" && state?.activeTab === "config";
    }, 10000, "Visible=true did not persist or switched popup tab.");
    await driver.switchTo().window(appHandle);
    await waitFor(async () => {
      const display = await driver.executeScript(`
        return document.querySelector('#lextrace-overlay-root')?.style?.display ?? null;
      `);
      return display === "block";
    }, 10000, "Visible=true did not open overlay.");
    await driver.switchTo().window(popupHandle);

    await setSeleniumJsonSelectValue(driver, "ui.overlay.visible", "false");
    await waitFor(async () => {
      const state = await driver.executeScript(`
        return {
          value: document.querySelector("button[data-config-path='ui.overlay.visible']")?.textContent?.trim() ?? null,
          activeTab: document.querySelector(".tab-button.is-active")?.getAttribute("data-tab") ?? null
        };
      `);
      return state?.value === "false" && state?.activeTab === "config";
    }, 10000, "Visible=false did not persist or switched popup tab.");
    await driver.switchTo().window(appHandle);
    await waitFor(async () => {
      const display = await driver.executeScript(`
        return document.querySelector('#lextrace-overlay-root')?.style?.display ?? null;
      `);
      return display === "none";
    }, 10000, "Visible=false did not close overlay.");
    await driver.switchTo().window(popupHandle);

    const originalHostName = await readSeleniumJsonValue(driver, "runtime.nativeHostName");
    await setSeleniumJsonInputValue(driver, "runtime.nativeHostName", "com.lextrace.changed", "escape");
    assert.equal(await readSeleniumJsonValue(driver, "runtime.nativeHostName"), originalHostName);

    await driver.executeScript("document.querySelector(\".tab-button[data-tab='control']\")?.click();");
    await driver.executeScript("document.querySelector('#open-terminal')?.click();");

    await driver.switchTo().window(appHandle);
    await waitFor(async () => {
      const title = await driver.executeScript(`
        return document.querySelector('#lextrace-overlay-root')?.shadowRoot?.querySelector('.panel-header h1')?.textContent ?? null;
      `);
      return title === "LexTrace Terminal";
    }, 10000, "Overlay terminal did not appear on page.");

    await driver.executeScript(`
      document
        .querySelector('#lextrace-overlay-root')
        ?.shadowRoot
        ?.querySelector('.close-button')
        ?.click();
    `);
    await delay(500);
    await driver.switchTo().window(popupHandle);
    await driver.executeScript("document.querySelector('#open-terminal')?.click();");
    await driver.switchTo().window(appHandle);
    await waitFor(async () => {
      const title = await driver.executeScript(`
        return document.querySelector('#lextrace-overlay-root')?.shadowRoot?.querySelector('.panel-header h1')?.textContent ?? null;
      `);
      return title === "LexTrace Terminal";
    }, 10000, "Overlay terminal did not reopen after Close.");

    await driver.executeScript(`
      const root = document.querySelector('#lextrace-overlay-root')?.shadowRoot;
      const input = root?.querySelector('[data-role="terminal-input"]');
      if (!(input instanceof HTMLInputElement)) {
        throw new Error('Terminal input is unavailable.');
      }
      input.focus();
      input.value = 'work';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    `);
    await waitFor(async () => {
      const suggestionCount = await driver.executeScript(`
        return document
          .querySelector('#lextrace-overlay-root')
          ?.shadowRoot
          ?.querySelectorAll('.terminal-suggestion-item')
          ?.length ?? 0;
      `);
      return suggestionCount > 0;
    }, 10000, "Terminal autocomplete suggestions did not appear.");
    await driver.actions().sendKeys("\uE004").perform();
    await waitFor(async () => {
      const inputValue = await driver.executeScript(`
        return document
          .querySelector('#lextrace-overlay-root')
          ?.shadowRoot
          ?.querySelector('[data-role="terminal-input"]')
          ?.value ?? null;
      `);
      return inputValue === 'worker.start';
    }, 10000, "Terminal autocomplete did not apply the selected suggestion.");
    await driver.executeScript(`
      const input = document
        .querySelector('#lextrace-overlay-root')
        ?.shadowRoot
        ?.querySelector('[data-role="terminal-input"]');
      if (input instanceof HTMLInputElement) {
        input.value = '';
      }
    `);

    const initialOverlayPosition = await readSeleniumOverlayPosition(driver);
    const seleniumDragDelta = getOverlayDragDelta(initialOverlayPosition);
    assert.ok(
      seleniumDragDelta.deltaX !== 0 || seleniumDragDelta.deltaY !== 0,
      "Overlay had no draggable room inside the viewport."
    );
    await dragSeleniumOverlay(driver, seleniumDragDelta.deltaX, seleniumDragDelta.deltaY);
    const draggedOverlayPosition = await readSeleniumOverlayPosition(driver);
    assert.ok(
      draggedOverlayPosition.left !== initialOverlayPosition.left ||
        draggedOverlayPosition.top !== initialOverlayPosition.top,
      "Overlay position did not change after drag."
    );

    const pageKeyCountBeforeTyping = await driver.executeScript("return (window.lextraceHarnessKeys ?? []).length;");
    await driver.executeScript(`
      document
        .querySelector('#lextrace-overlay-root')
        ?.shadowRoot
        ?.querySelector('[data-role="terminal-input"]')
        ?.focus();
    `);
    await driver.actions().sendKeys("abc").perform();
    await delay(300);
    const pageKeyCountAfterTyping = await driver.executeScript("return (window.lextraceHarnessKeys ?? []).length;");
    const terminalValue = await driver.executeScript(`
      return document
        .querySelector('#lextrace-overlay-root')
        ?.shadowRoot
        ?.querySelector('[data-role="terminal-input"]')
        ?.value ?? null;
    `);
    assert.equal(pageKeyCountAfterTyping, pageKeyCountBeforeTyping, "Page received keyboard input while terminal was focused.");
    assert.equal(terminalValue, "abc", "Terminal input did not retain typed text.");
    await driver.executeScript(`
      const input = document
        .querySelector('#lextrace-overlay-root')
        ?.shadowRoot
        ?.querySelector('[data-role="terminal-input"]');
      if (input instanceof HTMLInputElement) {
        input.value = "";
      }
    `);

    await delay(35000);
    const idleDisconnectCount = await driver.executeScript(`
      return document
        .querySelector('#lextrace-overlay-root')
        ?.shadowRoot
        ?.textContent
        ?.includes('Runtime stream disconnected. Retrying…') ?? false;
    `);
    assert.equal(idleDisconnectCount, false, "Overlay runtime stream disconnected during idle period.");

    await runSeleniumTerminalCommand(driver, "worker.start");
    await runSeleniumTerminalCommand(driver, "task.demo.start {\"taskId\":\"demo-task\"}");

    await driver.switchTo().window(popupHandle);
    try {
      await waitFor(async () => {
        const badgeText = await driver.executeScript("return document.querySelector('#status-badge')?.textContent?.trim() ?? null;");
        return badgeText === "running";
      }, 10000, "Worker did not enter running state.");
    } catch (error) {
      const popupDebug = await driver.executeScript(`
        return {
          badge: document.querySelector('#status-badge')?.textContent ?? null,
          terminalState: document.querySelector('#terminal-state')?.textContent ?? null
        };
      `);
      await driver.switchTo().window(appHandle);
      const overlayDebug = await driver.executeScript(`
        const root = document.querySelector('#lextrace-overlay-root')?.shadowRoot;
        return {
          activityText: root?.querySelector('[data-role="activity-feed"]')?.textContent ?? null,
          statusRow: root?.querySelector('[data-role="status-row"]')?.textContent ?? null
        };
      `);

      throw new Error(
        `${error.message}\nPopup debug: ${JSON.stringify(popupDebug, null, 2)}\nOverlay debug: ${JSON.stringify(overlayDebug, null, 2)}`
      );
    }

    const initialBootId = await driver.executeScript("return document.querySelector('#worker-boot')?.textContent?.trim() ?? null;");
    assert.ok(initialBootId && initialBootId !== "-", "bootId was not populated in popup.");

    await delay(125000);

    const stableBootId = await driver.executeScript("return document.querySelector('#worker-boot')?.textContent?.trim() ?? null;");
    assert.equal(stableBootId, initialBootId, "bootId changed during >120s Edge keepalive run.");

    await driver.switchTo().window(appHandle);

    const logMetrics = await driver.executeScript(`
      const root = document.querySelector('#lextrace-overlay-root')?.shadowRoot;
      const feed = root?.querySelector('[data-role="activity-feed"]');
      const logEntries = [...(root?.querySelectorAll('.activity-log') ?? [])];
      const terminalEntries = [...(root?.querySelectorAll('.activity-terminal') ?? [])];
      const allActivityEntries = [...(root?.querySelectorAll('.activity-entry') ?? [])];
      return {
        tabStripPresent: !!root?.querySelector('.tab-strip'),
        logCount: logEntries.length,
        terminalCount: terminalEntries.length,
        activityCount: allActivityEntries.length,
        logPreviewCount: root?.querySelectorAll('.log-preview').length ?? 0,
        noHorizontalScroll: feed ? feed.scrollWidth <= feed.clientWidth + 1 : false,
        collapsedCount: allActivityEntries.filter((entry) => entry instanceof HTMLDetailsElement && entry.open === false).length
      };
    `);

    assert.equal(logMetrics.tabStripPresent, false, "Overlay tab strip should be removed.");
    assert.ok(logMetrics.logCount >= 10, "Expected at least 10 detailed log entries.");
    assert.ok(logMetrics.terminalCount >= 4, "Expected terminal activity entries in unified feed.");
    assert.equal(logMetrics.logPreviewCount, 0, "Collapsed log summary must not duplicate expanded content.");
    assert.equal(logMetrics.noHorizontalScroll, true, "Unified activity feed has horizontal scroll.");
    assert.equal(logMetrics.collapsedCount, logMetrics.activityCount, "All terminal activity entries must be collapsed by default.");
    await runSeleniumTerminalCommand(driver, "test.host.crash");

    await driver.switchTo().window(popupHandle);
    await waitFor(async () => {
      const badgeText = await driver.executeScript("return document.querySelector('#status-badge')?.textContent?.trim() ?? null;");
      const taskText = await driver.executeScript("return document.querySelector('#worker-task')?.textContent?.trim() ?? null;");
      return badgeText === "running" && taskText === "demo-task";
    }, 15000, "Host did not recover after crash.");

    await driver.switchTo().window(appHandle);
    await runSeleniumTerminalCommand(driver, "worker.stop");

    await driver.switchTo().window(popupHandle);
    await waitFor(async () => {
      const badgeText = await driver.executeScript("return document.querySelector('#status-badge')?.textContent?.trim() ?? null;");
      return badgeText === "offline";
    }, 10000, "Worker did not stop cleanly.");

    await driver.switchTo().window(appHandle);
    await runSeleniumTerminalCommand(driver, "clear");
    await waitFor(async () => {
      const feedText = await driver.executeScript(`
        return document
          .querySelector('#lextrace-overlay-root')
          ?.shadowRoot
          ?.querySelector('[data-role="activity-feed"]')
          ?.textContent ?? '';
      `);
      return feedText.trim().length === 0;
    }, 10000, "Clear command did not fully empty the unified feed.");

    console.log("Edge e2e flow passed via EdgeDriver fallback.");
  } finally {
    await driver.quit();
  }
}

async function runTerminalCommand(inputLocator, command) {
  await inputLocator.fill(command);
  await inputLocator.press("Enter");
  await delay(500);
}

async function readPlaywrightOverlayPosition(overlayRoot) {
  return overlayRoot.evaluate((root) => {
    const panel = root.shadowRoot?.querySelector(".panel-shell");
    if (!(panel instanceof HTMLElement)) {
      throw new Error("Overlay panel is unavailable.");
    }

    return {
      left: Number.parseInt(panel.style.left || "0", 10),
      top: Number.parseInt(panel.style.top || "0", 10),
      maxLeft: Math.max(0, window.innerWidth - panel.offsetWidth),
      maxTop: Math.max(0, window.innerHeight - panel.offsetHeight)
    };
  });
}

async function dragPlaywrightOverlay(overlayRoot, deltaX, deltaY) {
  await overlayRoot.evaluate((root, [dx, dy]) => {
    const header = root.shadowRoot?.querySelector(".panel-header");
    if (!(header instanceof HTMLElement)) {
      throw new Error("Overlay header is unavailable.");
    }

    const rect = header.getBoundingClientRect();
    const originX = rect.left + 24;
    const originY = rect.top + 16;
    header.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, button: 0, clientX: originX, clientY: originY }));
    header.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1, buttons: 1, clientX: originX + dx, clientY: originY + dy }));
    header.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, button: 0, clientX: originX + dx, clientY: originY + dy }));
  }, [deltaX, deltaY]);
  await delay(300);
}

async function expectTextInLocator(locator, expectedText) {
  await locator.waitFor();
  await locator.page().waitForFunction(
    ([selector, expected]) => {
      const element = document.querySelector(selector);
      return typeof element?.textContent === "string" && element.textContent.toLowerCase().includes(expected);
    },
    [await locator.evaluate((element) => {
      if (!element.id) {
        throw new Error("Locator target must have an id for text assertion.");
      }
      return `#${element.id}`;
    }), expectedText.toLowerCase()]
  );
}

async function runSeleniumTerminalCommand(driver, command) {
  await driver.executeScript(
    `
      const root = document.querySelector('#lextrace-overlay-root')?.shadowRoot;
      const input = root?.querySelector('[data-role="terminal-input"]');
      const form = root?.querySelector('[data-role="terminal-form"]');
      if (!input || !form) {
        throw new Error('Terminal input is unavailable.');
      }
      input.value = arguments[0];
      input.dispatchEvent(new Event('input', { bubbles: true }));
      form.requestSubmit();
    `,
    command
  );
  await delay(800);
}

async function readSeleniumOverlayPosition(driver) {
  return driver.executeScript(`
    const panel = document.querySelector('#lextrace-overlay-root')?.shadowRoot?.querySelector('.panel-shell');
    if (!(panel instanceof HTMLElement)) {
      throw new Error('Overlay panel is unavailable.');
    }
    return {
      left: Number.parseInt(panel.style.left || '0', 10),
      top: Number.parseInt(panel.style.top || '0', 10),
      maxLeft: Math.max(0, window.innerWidth - panel.offsetWidth),
      maxTop: Math.max(0, window.innerHeight - panel.offsetHeight)
    };
  `);
}

function getOverlayDragDelta(position) {
  const canMoveLeft = position.left >= 48;
  const canMoveRight = position.maxLeft - position.left >= 48;
  const canMoveUp = position.top >= 32;
  const canMoveDown = position.maxTop - position.top >= 32;

  return {
    deltaX: canMoveRight ? 48 : canMoveLeft ? -48 : 0,
    deltaY: canMoveDown ? 32 : canMoveUp ? -32 : 0
  };
}

async function dragSeleniumOverlay(driver, deltaX, deltaY) {
  await driver.executeScript(
    `
      const header = document.querySelector('#lextrace-overlay-root')?.shadowRoot?.querySelector('.panel-header');
      if (!(header instanceof HTMLElement)) {
        throw new Error('Overlay header is unavailable.');
      }
      const rect = header.getBoundingClientRect();
      const originX = rect.left + 24;
      const originY = rect.top + 16;
      header.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, button: 0, clientX: originX, clientY: originY }));
      header.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, buttons: 1, clientX: originX + arguments[0], clientY: originY + arguments[1] }));
      header.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, button: 0, clientX: originX + arguments[0], clientY: originY + arguments[1] }));
    `,
    deltaX,
    deltaY
  );
  await delay(300);
}

async function readSeleniumJsonValue(driver, path) {
  return driver.executeScript(
    `
      return document.querySelector("button[data-config-path='" + arguments[0] + "']")?.textContent?.trim() ?? null;
    `,
    path
  );
}

async function createSeleniumExtensionTab(driver, url) {
  return driver.executeAsyncScript(
    `
      const done = arguments[arguments.length - 1];
      chrome.tabs.create({ url: arguments[0], active: true }, (tab) => done(tab?.id ?? null));
    `,
    url
  );
}

async function removeSeleniumTab(driver, tabId) {
  if (typeof tabId !== "number") {
    return;
  }

  await driver.executeAsyncScript(
    `
      const done = arguments[arguments.length - 1];
      chrome.tabs.remove(arguments[0], () => done(true));
    `,
    tabId
  );
}

async function readSeleniumTabInfo(driver, tabId) {
  if (typeof tabId !== "number") {
    return null;
  }

  return driver.executeAsyncScript(
    `
      const done = arguments[arguments.length - 1];
      chrome.tabs.get(arguments[0], (tab) => {
        done(tab ? { url: tab.url ?? null, pendingUrl: tab.pendingUrl ?? null } : null);
      });
    `,
    tabId
  );
}

async function setSeleniumJsonSelectValue(driver, path, value) {
  await driver.executeScript(
    `
      const button = document.querySelector("button[data-config-path='" + arguments[0] + "']");
      button?.click();
      const select = document.querySelector("[data-editor-path='" + arguments[0] + "']");
      if (!(select instanceof HTMLSelectElement)) {
        throw new Error("Select editor is unavailable for " + arguments[0]);
      }
      select.value = arguments[1];
      select.dispatchEvent(new Event('change', { bubbles: true }));
      select.blur();
    `,
    path,
    value
  );
  await delay(500);
}

async function setSeleniumJsonInputValue(driver, path, value, mode) {
  await driver.executeScript(
    `
      const button = document.querySelector("button[data-config-path='" + arguments[0] + "']");
      button?.click();
      const input = document.querySelector("[data-editor-path='" + arguments[0] + "']");
      if (!(input instanceof HTMLInputElement)) {
        throw new Error("Input editor is unavailable for " + arguments[0]);
      }
      input.value = arguments[1];
      input.dispatchEvent(new Event('input', { bubbles: true }));
      if (arguments[2] === 'enter') {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      } else if (arguments[2] === 'escape') {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      } else {
        input.blur();
      }
    `,
    path,
    value,
    mode
  );
  await delay(500);
}

function createEdgeOptions(userDataDir) {
  const options = new edge.Options();
  options.addArguments(
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-search-engine-choice-screen",
    "--disable-features=msEdgeAccountConsistency"
  );
  return options;
}

async function waitFor(predicate, timeoutMs, message) {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    if (await predicate()) {
      return;
    }

    await delay(500);
  }

  throw new Error(message);
}

async function startLocalServer() {
  const server = http.createServer(async (request, response) => {
    if (request.url?.startsWith("/slow")) {
      await delay(3000);
    }

    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(`<!doctype html>
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <title>LexTrace Edge Harness</title>
        </head>
        <body>
          <main>
            <h1>LexTrace Edge Harness</h1>
            <p>Overlay target page for MV3 terminal tests.</p>
          </main>
          <script>
            window.lextraceHarnessKeys = [];
            window.lextraceHarnessClicks = 0;
            document.addEventListener('keydown', (event) => {
              window.lextraceHarnessKeys.push({ key: event.key, phase: 'capture' });
            }, true);
            document.addEventListener('keydown', (event) => {
              window.lextraceHarnessKeys.push({ key: event.key, phase: 'bubble' });
            });
            document.addEventListener('click', () => {
              window.lextraceHarnessClicks += 1;
            }, true);
          </script>
        </body>
      </html>`);
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to determine test server address.");
  }

  return {
    url: `http://127.0.0.1:${address.port}/`,
    slowUrl: `http://127.0.0.1:${address.port}/slow`,
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

await main();
