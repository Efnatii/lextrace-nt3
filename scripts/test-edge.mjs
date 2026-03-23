import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";
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

const TERMINAL_OPENED_MESSAGES = ["opened on tab", "терминал открыт на вкладке"];
const TERMINAL_READY_MESSAGES = ["available on the current page", "терминал доступен на текущей странице."];
const TERMINAL_UNAVAILABLE_MESSAGES = ["regular http(s) page", "терминал недоступен: переключитесь на обычную http(s)-страницу."];
const INVALID_INTEGER_MESSAGES = ["integer", "целым числом"];
const OVERLAY_TITLES = ["LexTrace Terminal", "Терминал LexTrace"];
const WORKER_RUNNING_TEXTS = ["running", "в работе"];
const WORKER_STOPPED_TEXTS = ["stopped", "остановлен"];
const HAS_OPENAI_API_KEY = Boolean(process.env.OPENAI_API_KEY?.trim());

async function main() {
  const aiOnly = process.argv.includes("--ai-only");
  if (aiOnly && !HAS_OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required for --ai-only.");
  }

  if (!HAS_OPENAI_API_KEY) {
    console.warn("OPENAI_API_KEY is not set; skipping live AI checks.");
  }

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
        slowUrl: server.slowUrl,
        aiOnly
      });
    } catch (error) {
      console.warn(`Playwright harness failed, switching to EdgeDriver fallback: ${error.message}`);
      await runSeleniumFlow({
        popupUrl,
        pageUrl: server.url,
        slowUrl: server.slowUrl,
        aiOnly
      });
    }
  } finally {
    await server.close();
  }
}

async function prepareArtifacts() {
  await fs.rm(getNativeHostStatePath(), { force: true });
  await run(process.execPath, ["scripts/build-extension.mjs"]);
  await run(process.execPath, ["scripts/build-native-host.mjs"]);
  await run(process.execPath, ["scripts/pack-extension.mjs"]);
  await run(process.execPath, ["scripts/register-native-host.mjs"]);

  assert.equal(await fileExists(paths.packagedCrx), true, "Packed CRX is missing.");
  assert.equal(await fileExists(getNativeHostExePath()), true, "Native host executable is missing.");
}

function getNativeHostStatePath() {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) {
    throw new Error("LOCALAPPDATA is unavailable.");
  }

  return path.join(localAppData, "LexTraceNt3", "native-host-state.json");
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
    await expectTextInLocator(popupPage.locator("#terminal-state"), TERMINAL_OPENED_MESSAGES);
    await appPage.locator("#lextrace-overlay-root").waitFor({ state: "attached", timeout: 10000 });

    await appPage.goto("about:blank", { waitUntil: "load" });
    await popupPage.locator("#open-terminal").click();
    await expectTextInLocator(popupPage.locator("#terminal-state"), TERMINAL_UNAVAILABLE_MESSAGES);

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
    await expectTextInLocator(popupPage.locator("#terminal-state"), INVALID_INTEGER_MESSAGES);
    await popupPage.waitForFunction(() => {
      const button = document.querySelector("button[data-config-path='runtime.commandTimeoutMs']");
      return button?.textContent?.trim() === "2500";
    });

    if (HAS_OPENAI_API_KEY) {
      await setPlaywrightAllowedModel(popupPage, "gpt-5", "standard");
    await setPlaywrightModelPanelValue(popupPage, "ai.chat.model", "gpt-5", "standard");
    await popupPage.waitForFunction(() => {
      const button = document.querySelector("button[data-config-path='ai.chat.model']");
      const text = button?.textContent?.trim() ?? "";
      return text.includes("gpt-5") && text.includes("standard");
    });

    await setPlaywrightModalTextValue(
      popupPage,
      "ai.chat.instructions",
      "Всегда отвечай кратко.\nВозвращай только релевантный результат."
    );
    await popupPage.waitForFunction(() => {
      const button = document.querySelector("button[data-config-path='ai.chat.instructions']");
      return (button?.textContent ?? "").includes("Всегда отвечай кратко.");
    });

    await popupPage.locator("button[data-config-path='ai.chat.streamingEnabled']").click();
    await popupPage.locator("[data-editor-path='ai.chat.streamingEnabled']").selectOption("true");
      await popupPage.waitForFunction(() => {
      const button = document.querySelector("button[data-config-path='ai.chat.streamingEnabled']");
      return button?.textContent?.trim() === "true";
    });
    }

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
    await expectTextInLocator(overlayRoot.locator(".panel-header h1"), OVERLAY_TITLES);
    const activityFeed = overlayRoot.locator("[data-role='activity-feed']");
    await activityFeed.waitFor();
    assert.equal(await overlayRoot.locator(".overlay-tab-strip").count(), 1, "Overlay tab strip should be present.");

    await overlayRoot.locator(".close-button").click();
    await popupPage.locator("#open-terminal").click();
    await expectTextInLocator(overlayRoot.locator(".panel-header h1"), OVERLAY_TITLES);

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

    if (HAS_OPENAI_API_KEY) {
      await overlayRoot.locator(".overlay-tab-button[data-tab='chat']").click();
    const chatFeed = overlayRoot.locator("[data-role='chat-feed']");
    const chatInput = overlayRoot.locator("[data-role='chat-input']");
    await chatFeed.waitFor();
    await appPage.waitForFunction(() => {
      const root = document.querySelector("#lextrace-overlay-root")?.shadowRoot;
      const promptText = root
        ?.querySelector(".chat-entry.kind-system-prompt .chat-entry-content")
        ?.textContent ?? "";
      const hasStatusRow = !!root?.querySelector("[data-role='chat-status-row']");
      return promptText.length > 0 && hasStatusRow === true;
    });
    assert.equal(await overlayRoot.locator("[data-role='chat-status-row']").count(), 1, "Chat status row must render.");
    assert.equal(await overlayRoot.locator(".chat-entry.kind-system-prompt").count(), 1, "Chat transcript must render the system prompt block.");
    assert.equal(await overlayRoot.locator("[data-role='chat-send']").isHidden(), true, "Send button should be hidden on empty chat input.");

    await chatInput.fill("Reply with exact token EDGE_AI_OK and nothing else.");
    await appPage.waitForFunction(() => {
      const button = document.querySelector("#lextrace-overlay-root")
        ?.shadowRoot
        ?.querySelector("[data-role='chat-send']");
      return button instanceof HTMLButtonElement && button.hidden === false;
    });
    await chatInput.press("Enter");
    await appPage.waitForFunction(() => {
      const feed = document.querySelector("#lextrace-overlay-root")
        ?.shadowRoot
        ?.querySelector("[data-role='chat-feed']");
      return (feed?.textContent ?? "").includes("EDGE_AI_OK");
    }, undefined, { timeout: 90000 });
    await appPage.waitForFunction(() => {
      const root = document.querySelector("#lextrace-overlay-root")?.shadowRoot;
      return !!root?.querySelector(".chat-entry.kind-assistant.state-streaming, .chat-entry.kind-assistant.state-completed");
    }, undefined, { timeout: 30000 });

    const sharedPage = await context.newPage();
    await sharedPage.goto(`${pageUrl}?shared=1#copy`, { waitUntil: "load" });
    await sharedPage.bringToFront();
    await popupPage.bringToFront();
    await popupPage.locator("#open-terminal").click();
    const sharedOverlay = sharedPage.locator("#lextrace-overlay-root");
    await sharedOverlay.waitFor({ state: "attached", timeout: 10000 });
    await sharedOverlay.locator(".overlay-tab-button[data-tab='chat']").click();
    await sharedPage.waitForFunction(() => {
      const feed = document.querySelector("#lextrace-overlay-root")
        ?.shadowRoot
        ?.querySelector("[data-role='chat-feed']");
      return (feed?.textContent ?? "").includes("EDGE_AI_OK");
    }, undefined, { timeout: 30000 });

    await sendPlaywrightCodeChatRequest(
      popupPage,
      `${new URL(pageUrl).origin}/`,
      pageUrl,
      "Reply with exact token EDGE_CODE_OK and nothing else."
    );
      await popupPage.waitForFunction(async ([targetPageKey, targetPageUrl]) => {
      const response = await chrome.runtime.sendMessage({
        id: crypto.randomUUID(),
        version: 1,
        scope: "command",
        action: "ai.chat.status",
        source: "tests",
        target: "background",
        ts: new Date().toISOString(),
        payload: {
          pageKey: targetPageKey,
          pageUrl: targetPageUrl
        },
        correlationId: null
      });

      const text = JSON.stringify(response?.result?.session ?? {});
      return text.includes("EDGE_CODE_OK") && text.includes("\"origin\":\"code\"");
    }, [`${new URL(pageUrl).origin}/`, pageUrl], { timeout: 90000 });
    }

    await runTerminalCommand(terminalInput, "test.host.crash");
    await popupPage.waitForFunction(() => {
      const workerRunning = document.querySelector("#worker-running")?.textContent?.trim()?.toLowerCase() ?? "";
      return ["running", "в работе"].includes(workerRunning);
    }, undefined, { timeout: 15000 });

    const recoveredTaskId = (await popupPage.locator("#worker-task").textContent())?.trim();
    assert.equal(recoveredTaskId, "demo-task", "Task id was not restored after host crash.");

    await runTerminalCommand(terminalInput, "worker.stop");
    await popupPage.waitForFunction(() => {
      const workerRunning = document.querySelector("#worker-running")?.textContent?.trim()?.toLowerCase();
      const workerTask = document.querySelector("#worker-task")?.textContent?.trim();
      return ["stopped", "остановлен"].includes(workerRunning ?? "") && workerTask === "-";
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

async function runSeleniumFlow({ popupUrl, pageUrl, slowUrl, aiOnly = false }) {
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

    if (!aiOnly) {
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
          return textIncludesAny(message, TERMINAL_OPENED_MESSAGES) || textIncludesAny(message, TERMINAL_READY_MESSAGES);
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
        return textIncludesAny(message, TERMINAL_UNAVAILABLE_MESSAGES);
      }, 10000, "Popup did not report unsupported tab.");
      await removeSeleniumTab(driver, unsupportedTabId);
    }

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

    if (!aiOnly) {
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
        return textIncludesAny(message, INVALID_INTEGER_MESSAGES);
      }, 10000, "Invalid numeric edit did not report an error.");
      assert.equal(await readSeleniumJsonValue(driver, "runtime.commandTimeoutMs"), "2500");
    }

    if (HAS_OPENAI_API_KEY) {
      await setSeleniumAllowedModel(driver, "gpt-5", "standard");
    await setSeleniumModelPanelValue(driver, "ai.chat.model", "gpt-5", "standard");
    await waitFor(async () => {
      const value = await readSeleniumJsonValue(driver, "ai.chat.model");
      return typeof value === "string" && value.includes("gpt-5") && value.includes("standard");
    }, 10000, "AI model edit did not commit.");

    await setSeleniumModalTextValue(
      driver,
      "ai.chat.instructions",
      "Всегда отвечай кратко.\nВозвращай только релевантный результат."
    );
    await waitFor(async () => {
      const value = await readSeleniumJsonValue(driver, "ai.chat.instructions");
      return typeof value === "string" && value.includes("Всегда отвечай кратко.");
    }, 10000, "AI instructions edit did not commit.");

    await setSeleniumJsonSelectValue(driver, "ai.chat.streamingEnabled", "true");
      await waitFor(async () => {
      const value = await readSeleniumJsonValue(driver, "ai.chat.streamingEnabled");
      return value === "true";
    }, 10000, "AI streaming edit did not commit.");
    }

    if (!aiOnly) {
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
    }

    await driver.executeScript("document.querySelector(\".tab-button[data-tab='control']\")?.click();");
    await driver.executeScript("document.querySelector('#open-terminal')?.click();");

    await driver.switchTo().window(appHandle);
    await waitFor(async () => {
      const title = await driver.executeScript(`
        return document.querySelector('#lextrace-overlay-root')?.shadowRoot?.querySelector('.panel-header h1')?.textContent ?? null;
      `);
      return textIncludesAny(title, OVERLAY_TITLES);
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
      return textIncludesAny(title, OVERLAY_TITLES);
    }, 10000, "Overlay terminal did not reopen after Close.");

    const overlayStructure = await driver.executeScript(`
      const root = document.querySelector('#lextrace-overlay-root')?.shadowRoot;
      return {
        overlayTabs: root?.querySelectorAll('.overlay-tab-button')?.length ?? 0,
        chatStatus: !!root?.querySelector('[data-role="chat-status-row"]'),
        systemPrompt: !!root?.querySelector('.chat-entry.kind-system-prompt')
      };
    `);
    assert.equal(overlayStructure.overlayTabs, 2, "Overlay must expose Console and Chat tabs.");
    assert.equal(overlayStructure.chatStatus, true, "Chat status row must be present.");
    assert.equal(overlayStructure.systemPrompt, true, "Chat transcript must render the system prompt block.");

    if (!aiOnly) {
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
          const workerRunning = await driver.executeScript("return document.querySelector('#worker-running')?.textContent?.trim()?.toLowerCase() ?? null;");
          return WORKER_RUNNING_TEXTS.includes(workerRunning ?? "");
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
          tabStripPresent: !!root?.querySelector('.overlay-tab-strip'),
          logCount: logEntries.length,
          terminalCount: terminalEntries.length,
          activityCount: allActivityEntries.length,
          logPreviewCount: root?.querySelectorAll('.log-preview').length ?? 0,
          noHorizontalScroll: feed ? feed.scrollWidth <= feed.clientWidth + 1 : false,
          collapsedCount: allActivityEntries.filter((entry) => entry instanceof HTMLDetailsElement && entry.open === false).length
        };
      `);

      assert.equal(logMetrics.tabStripPresent, true, "Overlay tab strip should be present.");
      assert.ok(logMetrics.logCount >= 10, "Expected at least 10 detailed log entries.");
      assert.ok(logMetrics.terminalCount >= 4, "Expected terminal activity entries in unified feed.");
      assert.equal(logMetrics.logPreviewCount, 0, "Collapsed log summary must not duplicate expanded content.");
      assert.equal(logMetrics.noHorizontalScroll, true, "Unified activity feed has horizontal scroll.");
      assert.equal(logMetrics.collapsedCount, logMetrics.activityCount, "All terminal activity entries must be collapsed by default.");
    }

    if (HAS_OPENAI_API_KEY) {
      await driver.executeScript(`
      document
        .querySelector('#lextrace-overlay-root')
        ?.shadowRoot
        ?.querySelector('.overlay-tab-button[data-tab="chat"]')
        ?.click();
    `);
    await waitFor(async () => {
      const transcriptState = await driver.executeScript(`
        const root = document
          .querySelector('#lextrace-overlay-root')
          ?.shadowRoot;
        return {
          hasStatusRow: !!root?.querySelector('[data-role="chat-status-row"]'),
          promptText: root?.querySelector('.chat-entry.kind-system-prompt .chat-entry-content')?.textContent ?? null
        };
      `);
      return transcriptState && transcriptState.hasStatusRow === true && typeof transcriptState.promptText === "string";
    }, 15000, "Chat transcript and status row did not render.");

    await driver.executeScript(`
      const root = document.querySelector('#lextrace-overlay-root')?.shadowRoot;
      const input = root?.querySelector('[data-role="chat-input"]');
      if (!(input instanceof HTMLInputElement)) {
        throw new Error('Chat input is unavailable.');
      }
      input.focus();
      input.value = 'Reply with exact token EDGE_AI_OK and nothing else.';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    `);
    await waitFor(async () => {
      const hidden = await driver.executeScript(`
        const button = document
          .querySelector('#lextrace-overlay-root')
          ?.shadowRoot
          ?.querySelector('[data-role="chat-send"]');
        return button instanceof HTMLButtonElement ? button.hidden : null;
      `);
      return hidden === false;
    }, 10000, "Chat send button did not become available.");
    await driver.actions().sendKeys("\uE007").perform();
    await waitFor(async () => {
      const chatText = await driver.executeScript(`
        return document
          .querySelector('#lextrace-overlay-root')
          ?.shadowRoot
          ?.querySelector('[data-role="chat-feed"]')
          ?.textContent ?? null;
      `);
      return typeof chatText === "string" && chatText.includes("EDGE_AI_OK");
    }, 90000, "Live AI response did not appear in chat.");

    await driver.switchTo().window(popupHandle);
    const sharedTabId = await createSeleniumExtensionTab(driver, `${pageUrl}?shared=1#copy`);
    await waitFor(async () => {
      const tabInfo = await readSeleniumTabInfo(driver, sharedTabId);
      return typeof tabInfo?.url === "string" && tabInfo.url.includes("?shared=1");
    }, 10000, "Shared same-page tab did not open.");
    await driver.get(`${popupUrl}?targetTabId=${sharedTabId}&targetUrl=${encodeURIComponent(`${pageUrl}?shared=1#copy`)}`);
    await driver.executeScript("document.querySelector('#open-terminal')?.click();");
    await driver.switchTo().window(appHandle);
    await waitFor(async () => {
      const feedText = await driver.executeScript(`
        return document
          .querySelector('#lextrace-overlay-root')
          ?.shadowRoot
          ?.querySelector('[data-role="chat-feed"]')
          ?.textContent ?? null;
      `);
      return typeof feedText === "string" && feedText.includes("EDGE_AI_OK");
    }, 30000, "Shared page did not reuse the same AI chat session.");
    await driver.switchTo().window(popupHandle);
    await removeSeleniumTab(driver, sharedTabId);

    await driver.switchTo().window(popupHandle);
    await sendSeleniumCodeChatRequest(
      driver,
      `${new URL(pageUrl).origin}/`,
      pageUrl,
      "Reply with exact token EDGE_CODE_OK and nothing else."
    );
    await waitFor(async () => {
      const sessionText = await driver.executeAsyncScript(
        `
          const done = arguments[arguments.length - 1];
          chrome.runtime.sendMessage({
            id: crypto.randomUUID(),
            version: 1,
            scope: 'command',
            action: 'ai.chat.status',
            source: 'tests',
            target: 'background',
            ts: new Date().toISOString(),
            payload: {
              pageKey: arguments[0],
              pageUrl: arguments[1]
            },
            correlationId: null
          }, (response) => done(JSON.stringify(response?.result?.session ?? {})));
        `,
        `${new URL(pageUrl).origin}/`,
        pageUrl
      );
      return typeof sessionText === "string" && sessionText.includes("EDGE_CODE_OK") && sessionText.includes("\"origin\":\"code\"");
    }, 90000, "Code-origin AI request did not complete in the page session.");
    await driver.switchTo().window(appHandle);
    await driver.executeScript(`
      document
        .querySelector('#lextrace-overlay-root')
        ?.shadowRoot
        ?.querySelector('.overlay-tab-button[data-tab="chat"]')
        ?.click();
    `);
      await waitFor(async () => {
      const feedText = await driver.executeScript(`
        return document
          .querySelector('#lextrace-overlay-root')
          ?.shadowRoot
          ?.querySelector('[data-role="chat-feed"]')
          ?.textContent ?? null;
      `);
      return typeof feedText === "string" && feedText.includes("CODE");
    }, 30000, "Code-origin marker did not appear in shared page chat.");
    }

    if (!aiOnly) {
      await runSeleniumTerminalCommand(driver, "test.host.crash");

      await driver.switchTo().window(popupHandle);
      await waitFor(async () => {
        const workerRunning = await driver.executeScript("return document.querySelector('#worker-running')?.textContent?.trim()?.toLowerCase() ?? null;");
        const taskText = await driver.executeScript("return document.querySelector('#worker-task')?.textContent?.trim() ?? null;");
        return WORKER_RUNNING_TEXTS.includes(workerRunning ?? "") && taskText === "demo-task";
      }, 15000, "Host did not recover after crash.");

      await driver.switchTo().window(appHandle);
      await runSeleniumTerminalCommand(driver, "worker.stop");

      await driver.switchTo().window(popupHandle);
      await waitFor(async () => {
        const state = await driver.executeScript(`
          return {
            workerRunning: document.querySelector('#worker-running')?.textContent?.trim()?.toLowerCase() ?? null,
            workerTask: document.querySelector('#worker-task')?.textContent?.trim() ?? null
          };
        `);
        return WORKER_STOPPED_TEXTS.includes(state?.workerRunning ?? "") && state?.workerTask === "-";
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
    }

    console.log(aiOnly ? "Edge AI e2e flow passed via EdgeDriver fallback." : "Edge e2e flow passed via EdgeDriver fallback.");
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

function textIncludesAny(text, expectedTexts) {
  if (typeof text !== "string") {
    return false;
  }

  const normalizedText = text.toLowerCase();
  return expectedTexts.some((candidate) => normalizedText.includes(candidate.toLowerCase()));
}

async function expectTextInLocator(locator, expectedTexts) {
  const candidates = Array.isArray(expectedTexts) ? expectedTexts : [expectedTexts];
  await locator.waitFor();
  await locator.page().waitForFunction(
    ([selector, values]) => {
      const element = document.querySelector(selector);
      if (typeof element?.textContent !== "string") {
        return false;
      }

      const normalizedText = element.textContent.toLowerCase();
      return values.some((candidate) => normalizedText.includes(candidate));
    },
    [await locator.evaluate((element) => {
      if (!element.id) {
        throw new Error("Locator target must have an id for text assertion.");
      }
      return `#${element.id}`;
    }), candidates.map((candidate) => candidate.toLowerCase())]
  );
}

async function setPlaywrightAllowedModel(page, modelId, tier) {
  await page.locator("button[data-config-path='ai.allowedModels']").click();
  await page.waitForFunction(([targetModelId, targetTier]) => {
    const sections = [...document.querySelectorAll(".popup-modal-root .json-model-section")];
    const section = sections.find(
      (element) => element.querySelector(".json-model-section-title")?.textContent?.trim() === targetTier
    );
    return [...(section?.querySelectorAll(".json-model-option") ?? [])].some(
      (element) => element.querySelector(".json-model-name")?.textContent?.trim() === targetModelId
    );
  }, [modelId, tier]);
  await page.evaluate(([targetModelId, targetTier]) => {
    const sections = [...document.querySelectorAll(".popup-modal-root .json-model-section")];
    const section = sections.find(
      (element) => element.querySelector(".json-model-section-title")?.textContent?.trim() === targetTier
    );
    const option = [...(section?.querySelectorAll(".json-model-option") ?? [])].find(
      (element) => element.querySelector(".json-model-name")?.textContent?.trim() === targetModelId
    );
    const checkbox = option?.querySelector(".json-model-checkbox");
    if (!(checkbox instanceof HTMLInputElement)) {
      throw new Error(`Allowed model checkbox ${targetTier}/${targetModelId} is unavailable.`);
    }

    if (!checkbox.checked) {
      checkbox.click();
    }
  }, [modelId, tier]);
  await page.waitForFunction((targetModelId) => {
    const button = document.querySelector("button[data-config-path='ai.allowedModels']");
    return (button?.textContent ?? "").includes(targetModelId);
  }, modelId);
}

async function setPlaywrightModelPanelValue(page, path, modelId, tier) {
  await page.locator(`button[data-config-path='${path}']`).click();
  await page.waitForFunction(([targetPath, targetModelId, targetTier]) => {
    const panel = document.querySelector(".popup-modal-root .json-model-panel.is-single-select");
    const sections = [...(panel?.querySelectorAll(".json-model-section") ?? [])];
    const section = sections.find(
      (element) => element.querySelector(".json-model-section-title")?.textContent?.trim() === targetTier
    );
    return [...(section?.querySelectorAll(".json-model-option.is-single-select") ?? [])].some(
      (element) => element.querySelector(".json-model-name")?.textContent?.trim() === targetModelId
    );
  }, [path, modelId, tier]);
  await page.evaluate(([targetPath, targetModelId, targetTier]) => {
    const panel = document.querySelector(".popup-modal-root .json-model-panel.is-single-select");
    if (!panel) {
      throw new Error(`Model panel for ${targetPath} is unavailable.`);
    }

    const sections = [...panel.querySelectorAll(".json-model-section")];
    const section = sections.find(
      (element) => element.querySelector(".json-model-section-title")?.textContent?.trim() === targetTier
    );
    const option = [...(section?.querySelectorAll(".json-model-option.is-single-select") ?? [])].find(
      (element) => element.querySelector(".json-model-name")?.textContent?.trim() === targetModelId
    );
    if (!(option instanceof HTMLButtonElement)) {
      throw new Error(`Model option ${targetTier}/${targetModelId} is unavailable for ${targetPath}.`);
    }

    option.click();
  }, [path, modelId, tier]);
  await page.waitForFunction(([targetPath, targetModelId, targetTier]) => {
    const button = document.querySelector(`button[data-config-path='${targetPath}']`);
    const text = button?.textContent?.trim() ?? "";
    return text.includes(targetModelId) && text.includes(targetTier);
  }, [path, modelId, tier]);
}

async function setPlaywrightModalTextValue(page, path, value) {
  await page.locator(`button[data-config-path='${path}']`).click();
  await page.locator(".popup-modal-textarea").fill(value);
  await page.locator(".popup-modal-button.is-primary").click();
}

async function sendPlaywrightCodeChatRequest(page, pageKey, pageUrl, text) {
  await page.evaluate(
    async ([targetPageKey, targetPageUrl, requestText]) => {
      const response = await chrome.runtime.sendMessage({
        id: crypto.randomUUID(),
        version: 1,
        scope: "command",
        action: "ai.chat.send",
        source: "tests",
        target: "background",
        ts: new Date().toISOString(),
        payload: {
          pageKey: targetPageKey,
          pageUrl: targetPageUrl,
          origin: "code",
          text: requestText
        },
        correlationId: null
      });

      if (!response?.ok) {
        throw new Error(response?.error?.message ?? "ai.chat.send failed");
      }
    },
    [pageKey, pageUrl, text]
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

async function setSeleniumAllowedModel(driver, modelId, tier) {
  await waitFor(async () => {
    return driver.executeScript(
      `
        const button = document.querySelector("button[data-config-path='ai.allowedModels']");
        const panel = document.querySelector('.popup-modal-root .json-model-panel');
        if (!(panel instanceof HTMLElement)) {
          button?.click();
        }
        const sections = [...document.querySelectorAll('.popup-modal-root .json-model-section')];
        const section = sections.find((element) => element.querySelector('.json-model-section-title')?.textContent?.trim() === arguments[1]);
        return [...(section?.querySelectorAll('.json-model-option') ?? [])].some(
          (element) => element.querySelector('.json-model-name')?.textContent?.trim() === arguments[0]
        );
      `,
      modelId,
      tier
    );
  }, 20000, `Allowed model checkbox ${tier}/${modelId} did not load.`);
  await driver.executeScript(
    `
      const button = document.querySelector("button[data-config-path='ai.allowedModels']");
      const panel = document.querySelector('.popup-modal-root .json-model-panel');
      if (!(panel instanceof HTMLElement)) {
        button?.click();
      }
      const sections = [...document.querySelectorAll('.popup-modal-root .json-model-section')];
      const section = sections.find((element) => element.querySelector('.json-model-section-title')?.textContent?.trim() === arguments[1]);
      const option = [...(section?.querySelectorAll('.json-model-option') ?? [])].find(
        (element) => element.querySelector('.json-model-name')?.textContent?.trim() === arguments[0]
      );
      const checkbox = option?.querySelector('.json-model-checkbox');
      if (!(checkbox instanceof HTMLInputElement)) {
        throw new Error('Allowed model checkbox is unavailable for ' + arguments[1] + '/' + arguments[0]);
      }
      if (!checkbox.checked) {
        checkbox.click();
      }
    `,
    modelId,
    tier
  );
  await delay(500);
}

async function setSeleniumModelPanelValue(driver, path, modelId, tier) {
  await waitFor(async () => {
    return driver.executeScript(
      `
        const button = document.querySelector("button[data-config-path='" + arguments[0] + "']");
        let panel = document.querySelector('.popup-modal-root .json-model-panel.is-single-select');
        if (!(panel instanceof HTMLElement)) {
          button?.click();
          panel = document.querySelector('.popup-modal-root .json-model-panel.is-single-select');
        }
        const sections = [...(panel?.querySelectorAll('.json-model-section') ?? [])];
        const section = sections.find((element) => element.querySelector('.json-model-section-title')?.textContent?.trim() === arguments[2]);
        return [...(section?.querySelectorAll('.json-model-option.is-single-select') ?? [])].some(
          (element) => element.querySelector('.json-model-name')?.textContent?.trim() === arguments[1]
        );
      `,
      path,
      modelId,
      tier
    );
  }, 20000, `Model option ${tier}/${modelId} did not load for ${path}.`);
  await driver.executeScript(
    `
      const button = document.querySelector("button[data-config-path='" + arguments[0] + "']");
      let panel = document.querySelector('.popup-modal-root .json-model-panel.is-single-select');
      if (!(panel instanceof HTMLElement)) {
        button?.click();
        panel = document.querySelector('.popup-modal-root .json-model-panel.is-single-select');
      }
      if (!(panel instanceof HTMLElement)) {
        throw new Error('Model panel is unavailable for ' + arguments[0]);
      }
      const sections = [...panel.querySelectorAll('.json-model-section')];
      const section = sections.find((element) => element.querySelector('.json-model-section-title')?.textContent?.trim() === arguments[2]);
      const option = [...(section?.querySelectorAll('.json-model-option.is-single-select') ?? [])].find(
        (element) => element.querySelector('.json-model-name')?.textContent?.trim() === arguments[1]
      );
      if (!(option instanceof HTMLButtonElement)) {
        throw new Error('Model option is unavailable for ' + arguments[2] + '/' + arguments[1]);
      }
      option.click();
    `,
    path,
    modelId,
    tier
  );
  await delay(500);
}

async function setSeleniumModalTextValue(driver, path, value) {
  await driver.executeScript(
    `
      const button = document.querySelector("button[data-config-path='" + arguments[0] + "']");
      button?.click();
      const textarea = document.querySelector('.popup-modal-textarea');
      if (!(textarea instanceof HTMLTextAreaElement)) {
        throw new Error('Modal textarea is unavailable for ' + arguments[0]);
      }
      textarea.value = arguments[1];
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      const saveButton = document.querySelector('.popup-modal-button.is-primary');
      if (!(saveButton instanceof HTMLButtonElement)) {
        throw new Error('Modal save button is unavailable.');
      }
      saveButton.click();
    `,
    path,
    value
  );
  await delay(500);
}

async function sendSeleniumCodeChatRequest(driver, pageKey, pageUrl, text) {
  const response = await driver.executeAsyncScript(
    `
      const done = arguments[arguments.length - 1];
      chrome.runtime.sendMessage({
        id: crypto.randomUUID(),
        version: 1,
        scope: 'command',
        action: 'ai.chat.send',
        source: 'tests',
        target: 'background',
        ts: new Date().toISOString(),
        payload: {
          pageKey: arguments[0],
          pageUrl: arguments[1],
          origin: 'code',
          text: arguments[2]
        },
        correlationId: null
      }, done);
    `,
    pageKey,
    pageUrl,
    text
  );

  if (!response?.ok) {
    throw new Error(response?.error?.message ?? "ai.chat.send failed");
  }
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
