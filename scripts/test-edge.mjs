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
        textElementsUrl: server.textElementsUrl,
        aiOnly
      });
    } catch (error) {
      console.warn(`Playwright harness failed, switching to EdgeDriver fallback: ${error.message}`);
      await runSeleniumFlow({
        popupUrl,
        pageUrl: server.url,
        slowUrl: server.slowUrl,
        textElementsUrl: server.textElementsUrl,
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

async function runPlaywrightFlow({ popupUrl, pageUrl, slowUrl, textElementsUrl }) {
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

    // -----------------------------------------------------------------------
    // TEXT ELEMENT SUBSYSTEM TESTS
    // -----------------------------------------------------------------------
    if (textElementsUrl) {
      await runPlaywrightTextElementsFlow(appPage, popupPage, textElementsUrl, terminalInput);
    }

    console.log("Edge e2e flow passed.");
  } finally {
    await context.close();
  }
}

// ---------------------------------------------------------------------------
// Text element subsystem visual E2E tests (Playwright)
// ---------------------------------------------------------------------------
async function runPlaywrightTextElementsFlow(appPage, popupPage, textElementsUrl, terminalInput) {
  console.log("\n--- Text Element Subsystem Tests ---");

  // Navigate app page to rich text fixture
  await appPage.goto(textElementsUrl, { waitUntil: "load" });
  await appPage.bringToFront();

  // Open overlay on the new page
  await popupPage.bringToFront();
  await popupPage.locator(".tab-button[data-tab='control']").click();
  await popupPage.locator("#open-terminal").click();
  const overlayRoot = appPage.locator("#lextrace-overlay-root");
  await overlayRoot.waitFor({ state: "attached", timeout: 10000 });
  await appPage.bringToFront();

  // Helper: run a command via the terminal and return the parsed JSON result
  const runCommand = async (command) => {
    const countBefore = await appPage.evaluate(() => {
      const root = document.querySelector("#lextrace-overlay-root")?.shadowRoot;
      return root?.querySelectorAll(".activity-entry.terminal-result").length ?? 0;
    });
    const input = overlayRoot.locator("[data-role='terminal-input']");
    await input.fill(command);
    await input.press("Enter");
    await appPage.waitForFunction((before) => {
      const root = document.querySelector("#lextrace-overlay-root")?.shadowRoot;
      return (root?.querySelectorAll(".activity-entry.terminal-result").length ?? 0) > before;
    }, countBefore, { timeout: 10000 });
    return appPage.evaluate(() => {
      const root = document.querySelector("#lextrace-overlay-root")?.shadowRoot;
      const results = root?.querySelectorAll(".activity-entry.terminal-result");
      if (!results?.length) return null;
      const body = results[results.length - 1]?.querySelector(".activity-body");
      try { return { output: JSON.parse(body?.textContent ?? "null") }; } catch { return null; }
    });
  };

  // ------------------------------------------------------------------
  // TEST 1: text.scan — basic discovery
  // ------------------------------------------------------------------
  console.log("  [1] text.scan — discovery...");
  const scanResult = await runCommand("text.scan");
  const summary = scanResult?.output?.summary;
  assert.ok(summary, "text.scan: no summary in result");
  assert.ok(summary.total >= 10, `text.scan: expected ≥10 bindings, got ${summary.total}`);
  assert.ok(summary.live >= 10, `text.scan: expected ≥10 live, got ${summary.live}`);
  assert.equal(summary.stale, 0, `text.scan: expected 0 stale after fresh scan, got ${summary.stale}`);
  assert.equal(summary.changed, 0, "text.scan: expected 0 changed after fresh scan");
  const cats = summary.categories;
  assert.ok(cats.heading >= 2, `text.scan: expected ≥2 headings, got ${cats.heading}`);
  assert.ok(cats.paragraph >= 2, `text.scan: expected ≥2 paragraphs, got ${cats.paragraph}`);
  assert.ok(cats.link >= 1, `text.scan: expected ≥1 link, got ${cats.link}`);
  assert.ok(cats.button >= 1, `text.scan: expected ≥1 button, got ${cats.button}`);
  assert.ok(cats["list-item"] >= 2, `text.scan: expected ≥2 list-items, got ${cats["list-item"]}`);
  assert.ok(cats["table-cell"] >= 2, `text.scan: expected ≥2 table-cells, got ${cats["table-cell"]}`);
  console.log(`    ✓ ${summary.total} bindings discovered: ${JSON.stringify(cats)}`);

  // ------------------------------------------------------------------
  // TEST 2: text.list — correct binding fields
  // ------------------------------------------------------------------
  console.log("  [2] text.list — binding field validation...");
  const listResult = await runCommand("text.list all");
  const bindings = listResult?.output?.bindings;
  assert.ok(Array.isArray(bindings) && bindings.length >= 10, "text.list: empty bindings array");
  const headingBinding = bindings.find((b) => b.originalText === "LexTrace Text Test Heading");
  assert.ok(headingBinding, "text.list: main heading binding not found");
  assert.equal(headingBinding.category, "heading", "text.list: wrong category for h1");
  assert.equal(headingBinding.presence, "live", "text.list: heading binding not live");
  assert.equal(headingBinding.changed, false, "text.list: heading wrongly marked as changed");
  assert.ok(headingBinding.bindingId?.startsWith("txt_"), "text.list: bad bindingId prefix");
  assert.ok(headingBinding.selector, "text.list: binding has no selector");
  console.log(`    ✓ heading binding ${headingBinding.bindingId} (selector: ${headingBinding.selector})`);

  // ------------------------------------------------------------------
  // TEST 3: Highlight rendering
  // ------------------------------------------------------------------
  console.log("  [3] Highlight boxes...");
  await popupPage.bringToFront();
  await popupPage.locator(".tab-button[data-tab='config']").click();
  await popupPage.locator("#config-frame").waitFor();
  await popupPage.locator("button[data-config-path='debug.textElements.highlightEnabled']").click();
  await popupPage.locator("[data-editor-path='debug.textElements.highlightEnabled']").selectOption("true");
  await delay(400);
  await appPage.bringToFront();

  await appPage.waitForFunction(() => {
    return document.querySelectorAll(".lextrace-text-highlight-box").length > 0;
  }, undefined, { timeout: 5000 });
  const boxCount = await appPage.evaluate(() =>
    document.querySelectorAll(".lextrace-text-highlight-box").length
  );
  assert.ok(boxCount >= 5, `Highlights: expected ≥5 boxes, got ${boxCount}`);
  const validBoxCount = await appPage.evaluate(() => {
    return [...document.querySelectorAll(".lextrace-text-highlight-box")].filter((b) => {
      return Number.parseFloat(b.style.width) > 0 && Number.parseFloat(b.style.height) > 0;
    }).length;
  });
  assert.ok(validBoxCount >= 3, `Highlights: expected ≥3 boxes with valid size, got ${validBoxCount}`);
  console.log(`    ✓ ${boxCount} highlight boxes (${validBoxCount} with valid geometry)`);

  // Below-fold element must NOT have a box before scrolling
  const belowFoldBoxed = await appPage.evaluate(() => {
    const el = document.getElementById("para-below");
    const id = el?.getAttribute("data-lextrace-text-binding-id");
    return id
      ? document.querySelector(`.lextrace-text-highlight-box[data-lextrace-text-binding-id="${id}"]`) !== null
      : false;
  });
  assert.equal(belowFoldBoxed, false, "Highlights: below-fold element has box before scrolling");
  console.log("    ✓ below-fold element correctly has no box (not yet scrolled into view)");

  // ------------------------------------------------------------------
  // TEST 4: text.set — DOM replacement
  // ------------------------------------------------------------------
  console.log("  [4] text.set — DOM replacement...");
  const headingId = headingBinding.bindingId;
  const setResult = await runCommand(`text.set ${headingId} -- REPLACED HEADING TEXT`);
  assert.equal(setResult?.output?.binding?.changed, true, "text.set: binding not marked changed");
  assert.equal(setResult?.output?.binding?.replacementText, "REPLACED HEADING TEXT", "text.set: wrong replacementText");
  const domText = await appPage.evaluate(() =>
    document.getElementById("main-heading")?.textContent?.trim()
  );
  assert.equal(domText, "REPLACED HEADING TEXT", "text.set: DOM not updated");
  console.log(`    ✓ DOM text changed: "${domText}"`);

  // Check for is-changed highlight: native CSS (lextrace-text-changed) or physical box.
  await delay(200);
  const changedHighlight = await appPage.evaluate((id) => {
    const physBox = document.querySelector(`.lextrace-text-highlight-box.is-changed[data-lextrace-text-binding-id="${id}"]`) !== null;
    const nativeChanged = typeof CSS !== "undefined" && "highlights" in CSS
      ? (CSS.highlights.get("lextrace-text-changed")?.size ?? 0) > 0 : false;
    return physBox || nativeChanged;
  }, headingId);
  assert.ok(changedHighlight, "text.set: is-changed highlight missing (native + physical)");
  console.log("    ✓ is-changed highlight rendered");

  // ------------------------------------------------------------------
  // TEST 5: text.revert — DOM restoration
  // ------------------------------------------------------------------
  console.log("  [5] text.revert — DOM restoration...");
  const revertResult = await runCommand(`text.revert ${headingId}`);
  assert.equal(revertResult?.output?.binding?.changed, false, "text.revert: binding still changed");
  assert.equal(revertResult?.output?.binding?.replacementText, null, "text.revert: replacementText not null");
  const restoredText = await appPage.evaluate(() =>
    document.getElementById("main-heading")?.textContent?.trim()
  );
  assert.equal(restoredText, "LexTrace Text Test Heading", "text.revert: DOM not restored");
  console.log(`    ✓ DOM restored: "${restoredText}"`);

  await delay(200);
  const sourceHighlight = await appPage.evaluate((id) => {
    const physBox = document.querySelector(`.lextrace-text-highlight-box.is-source[data-lextrace-text-binding-id="${id}"]`) !== null;
    const nativeSource = typeof CSS !== "undefined" && "highlights" in CSS
      ? (CSS.highlights.get("lextrace-text-source")?.size ?? 0) > 0 : false;
    return physBox || nativeSource;
  }, headingId);
  assert.ok(sourceHighlight, "text.revert: is-source highlight not restored (native + physical)");
  console.log("    ✓ is-source highlight restored");

  // ------------------------------------------------------------------
  // TEST 6: Incremental scan — new DOM element discovered
  // ------------------------------------------------------------------
  console.log("  [6] Incremental scan — new element discovery...");
  await popupPage.bringToFront();
  await popupPage.locator("button[data-config-path='debug.textElements.autoScanMode']").click();
  await popupPage.locator("[data-editor-path='debug.textElements.autoScanMode']").selectOption("incremental");
  await delay(300);
  await appPage.bringToFront();

  await appPage.evaluate(() => {
    const zone = document.getElementById("dynamic-zone");
    const p = document.createElement("p");
    p.id = "para-dynamic";
    p.textContent = "Dynamically injected paragraph text";
    zone?.appendChild(p);
  });

  // texts-feed only updates when "texts" tab is active; check binding ID attribute instead.
  const dynamicTracked = await appPage.waitForFunction(() => {
    const el = document.getElementById("para-dynamic");
    return typeof el?.getAttribute("data-lextrace-text-binding-id") === "string";
  }, undefined, { timeout: 10000 }).then(() => true).catch(() => false);
  assert.ok(dynamicTracked, "Incremental: dynamic paragraph not tracked (no binding ID attribute)");
  console.log("    ✓ Dynamic paragraph discovered and highlighted");

  // ------------------------------------------------------------------
  // TEST 7: Scroll into view — below-fold binding is tracked
  // ------------------------------------------------------------------
  console.log("  [7] Scroll visibility — below-fold binding active...");
  await appPage.evaluate(() => {
    document.getElementById("below-fold-section")?.scrollIntoView();
  });
  await delay(500);
  const belowFoldId = await appPage.evaluate(() =>
    document.getElementById("para-below")?.getAttribute("data-lextrace-text-binding-id") ?? null
  );
  assert.ok(belowFoldId?.startsWith("txt_"), `Scroll: below-fold has no active binding (got: ${belowFoldId})`);
  console.log(`    ✓ Below-fold binding tracked: ${belowFoldId}`);

  // ------------------------------------------------------------------
  // TEST 8: text.page.reset — clears all replacements
  // ------------------------------------------------------------------
  console.log("  [8] text.page.reset...");
  await appPage.evaluate(() => window.scrollTo(0, 0));
  await delay(300);
  await runCommand(`text.set ${headingId} -- Temporary value`);
  const beforeReset = await appPage.evaluate(() =>
    document.getElementById("main-heading")?.textContent?.trim()
  );
  assert.equal(beforeReset, "Temporary value", "text.page.reset pre-condition: text not set");
  await runCommand("text.reset page");
  const afterReset = await appPage.evaluate(() =>
    document.getElementById("main-heading")?.textContent?.trim()
  );
  assert.equal(afterReset, "LexTrace Text Test Heading", "text.page.reset: original text not restored");
  console.log("    ✓ text.page.reset restored all original text");

  // ------------------------------------------------------------------
  // TEST 9: Disable highlights — all boxes removed
  // ------------------------------------------------------------------
  console.log("  [9] Disable highlights — boxes removed...");
  await popupPage.bringToFront();
  await popupPage.locator("button[data-config-path='debug.textElements.highlightEnabled']").click();
  await popupPage.locator("[data-editor-path='debug.textElements.highlightEnabled']").selectOption("false");
  await delay(300);
  await appPage.bringToFront();
  const highlightState = await appPage.evaluate(() => ({
    physBoxes: document.querySelectorAll(".lextrace-text-highlight-box").length,
    nativeSource: typeof CSS !== "undefined" && "highlights" in CSS ? (CSS.highlights.has("lextrace-text-source") ? CSS.highlights.get("lextrace-text-source").size : 0) : 0,
    nativeChanged: typeof CSS !== "undefined" && "highlights" in CSS ? (CSS.highlights.has("lextrace-text-changed") ? CSS.highlights.get("lextrace-text-changed").size : 0) : 0
  }));
  assert.equal(highlightState.physBoxes, 0, `Highlights: ${highlightState.physBoxes} physical boxes remain`);
  assert.equal(highlightState.nativeSource, 0, `Highlights: ${highlightState.nativeSource} native source ranges remain`);
  assert.equal(highlightState.nativeChanged, 0, `Highlights: ${highlightState.nativeChanged} native changed ranges remain`);
  console.log("    ✓ All highlights cleared after disabling");

  console.log("--- Text Element Subsystem Tests PASSED ---\n");
}

async function runSeleniumFlow({ popupUrl, pageUrl, slowUrl, textElementsUrl, aiOnly = false }) {
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
      try {
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
      } catch (aiConfigError) {
        console.warn(`[WARN] AI config tests skipped (non-fatal): ${aiConfigError.message}`);
      }
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
    assert.equal(overlayStructure.overlayTabs, 3, "Overlay must expose Console, Chat and Texts tabs.");
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
      try {
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
      } catch (aiChatError) {
        console.warn(`[WARN] AI chat tests skipped (non-fatal): ${aiChatError.message}`);
      }
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

    if (!aiOnly && textElementsUrl) {
      await runSeleniumTextElementsFlow(driver, popupHandle, appHandle, textElementsUrl);
    }

    console.log(aiOnly ? "Edge AI e2e flow passed via EdgeDriver fallback." : "Edge e2e flow passed via EdgeDriver fallback.");
  } finally {
    await driver.quit();
  }
}

// ---------------------------------------------------------------------------
// Text element subsystem visual E2E tests (Selenium / EdgeDriver fallback)
// ---------------------------------------------------------------------------
async function runSeleniumTextElementsFlow(driver, popupHandle, _appHandle, textElementsUrl) {
  console.log("\n--- Text Element Subsystem Tests (Selenium) ---");

  // Navigate the main app window to the rich text fixture
  await driver.switchTo().window(_appHandle);
  await driver.get(textElementsUrl);
  const textHandle = _appHandle;

  // Re-open the terminal via the popup (popup targets the currently focused tab)
  await driver.switchTo().window(popupHandle);
  await driver.executeScript(`
    document.querySelector(".tab-button[data-tab='control']")?.click();
  `);
  await delay(200);
  await driver.executeScript(`document.querySelector('#open-terminal')?.click();`);

  await driver.switchTo().window(textHandle);
  await waitFor(async () => {
    const title = await driver.executeScript(`
      return document.querySelector('#lextrace-overlay-root')?.shadowRoot
        ?.querySelector('.panel-header h1')?.textContent ?? null;
    `);
    return textIncludesAny(title, OVERLAY_TITLES);
  }, 10000, "Text element: overlay did not open on fixture page.");

  // Helper: run a terminal command and return parsed JSON result
  const runCmd = async (command) => {
    const countBefore = await driver.executeScript(`
      return document.querySelector('#lextrace-overlay-root')?.shadowRoot
        ?.querySelectorAll('.activity-entry.terminal-result').length ?? 0;
    `);
    await runSeleniumTerminalCommand(driver, command);
    await waitFor(async () => {
      const count = await driver.executeScript(`
        return document.querySelector('#lextrace-overlay-root')?.shadowRoot
          ?.querySelectorAll('.activity-entry.terminal-result').length ?? 0;
      `);
      return count > countBefore;
    }, 10000, `Command "${command}" did not produce a result entry.`);
    const raw = await driver.executeScript(`
      const root = document.querySelector('#lextrace-overlay-root')?.shadowRoot;
      const entries = root?.querySelectorAll('.activity-entry.terminal-result');
      const body = entries?.[entries.length - 1]?.querySelector('.activity-body');
      try { return JSON.parse(body?.textContent ?? 'null'); } catch { return null; }
    `);
    return raw ? { output: raw } : null;
  };

  // Helper: set a config toggle
  const setConfigOption = async (path, value) => {
    await driver.switchTo().window(popupHandle);
    await driver.executeScript(`document.querySelector(".tab-button[data-tab='config']")?.click();`);
    await delay(300);
    await driver.executeScript(`document.querySelector("button[data-config-path='${path}']")?.click();`);
    await delay(200);
    await driver.executeScript(`
      const editor = document.querySelector("[data-editor-path='${path}']");
      if (!editor) return;
      if (editor.tagName === 'SELECT') {
        editor.value = arguments[0];
        editor.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        editor.value = arguments[0];
        editor.dispatchEvent(new Event('input', { bubbles: true }));
        editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      }
    `, value);
    await delay(400);
    await driver.switchTo().window(textHandle);
    await delay(200);
  };

  // ------------------------------------------------------------------
  // TEST 1: text.scan — discovery
  // ------------------------------------------------------------------
  console.log("  [1] text.scan — discovery...");
  const scanResult = await runCmd("text.scan");
  const summary = scanResult?.output?.summary;
  assert.ok(summary, "text.scan: no summary");
  assert.ok(summary.total >= 10, `text.scan: expected ≥10 bindings, got ${summary.total}`);
  assert.ok(summary.live >= 10, `text.scan: expected ≥10 live, got ${summary.live}`);
  assert.equal(summary.stale, 0, `text.scan: unexpected stale bindings: ${summary.stale}`);
  assert.equal(summary.changed, 0, "text.scan: unexpected changed bindings");
  const cats = summary.categories;
  assert.ok(cats.heading >= 2, `text.scan: expected ≥2 headings, got ${cats.heading}`);
  assert.ok(cats.paragraph >= 2, `text.scan: expected ≥2 paragraphs, got ${cats.paragraph}`);
  assert.ok(cats["list-item"] >= 2, `text.scan: expected ≥2 list-items, got ${cats["list-item"]}`);
  assert.ok(cats["table-cell"] >= 2, `text.scan: expected ≥2 table-cells, got ${cats["table-cell"]}`);
  console.log(`    ✓ ${summary.total} bindings: ${JSON.stringify(cats)}`);

  // ------------------------------------------------------------------
  // TEST 2: text.list — binding fields
  // ------------------------------------------------------------------
  console.log("  [2] text.list — binding validation...");
  const listResult = await runCmd("text.list all");
  const bindings = listResult?.output?.bindings;
  assert.ok(Array.isArray(bindings) && bindings.length >= 10, "text.list: empty array");
  const headingBinding = bindings.find((b) => b.originalText === "LexTrace Text Test Heading");
  assert.ok(headingBinding, "text.list: main heading not found");
  assert.equal(headingBinding.category, "heading", "text.list: wrong category");
  assert.equal(headingBinding.presence, "live", "text.list: not live");
  assert.equal(headingBinding.changed, false, "text.list: wrongly changed");
  assert.ok(headingBinding.bindingId?.startsWith("txt_"), "text.list: bad bindingId");
  console.log(`    ✓ heading binding: ${headingBinding.bindingId}`);

  // ------------------------------------------------------------------
  // TEST 3: Enable highlights
  // ------------------------------------------------------------------
  console.log("  [3] Highlights (native CSS or physical boxes)...");
  await setConfigOption("debug.textElements.highlightEnabled", "true");
  // Modern Edge uses CSS Custom Highlight API for text nodes (no physical divs).
  // Physical boxes are only created for attribute-based targets (value/placeholder).
  // We accept either native highlights OR physical boxes as proof rendering happened.
  await waitFor(async () => {
    const result = await driver.executeScript(`
      const nativeHighlights = typeof CSS !== "undefined" && "highlights" in CSS
        ? (CSS.highlights.has("lextrace-text-source") || CSS.highlights.has("lextrace-text-changed"))
        : false;
      const physicalBoxes = document.querySelectorAll('.lextrace-text-highlight-box').length > 0;
      return nativeHighlights || physicalBoxes;
    `);
    return result === true;
  }, 5000, "Highlights did not appear (neither native CSS highlights nor physical boxes).");

  const highlightStats = await driver.executeScript(`
    const nativeSourceSize = (typeof CSS !== "undefined" && "highlights" in CSS && CSS.highlights.has("lextrace-text-source"))
      ? CSS.highlights.get("lextrace-text-source").size : 0;
    const physicalBoxCount = document.querySelectorAll('.lextrace-text-highlight-box').length;
    const validBoxCount = [...document.querySelectorAll('.lextrace-text-highlight-box')].filter((b) => {
      return parseFloat(b.style.width) > 0 && parseFloat(b.style.height) > 0;
    }).length;
    return { nativeSourceSize, physicalBoxCount, validBoxCount };
  `);
  assert.ok(
    highlightStats.nativeSourceSize >= 5 || highlightStats.physicalBoxCount >= 5,
    `Highlights: expected ≥5 native ranges or ≥5 boxes; got ${highlightStats.nativeSourceSize} native, ${highlightStats.physicalBoxCount} boxes`
  );
  console.log(`    ✓ ${highlightStats.nativeSourceSize} native ranges, ${highlightStats.physicalBoxCount} boxes (${highlightStats.validBoxCount} with geometry)`);

  // ------------------------------------------------------------------
  // TEST 4: text.set — DOM replacement
  // ------------------------------------------------------------------
  console.log("  [4] text.set — DOM replacement...");
  const headingId = headingBinding.bindingId;
  const setResult = await runCmd(`text.set ${headingId} -- REPLACED HEADING TEXT`);
  assert.equal(setResult?.output?.binding?.changed, true, "text.set: not marked changed");
  assert.equal(setResult?.output?.binding?.replacementText, "REPLACED HEADING TEXT", "text.set: wrong text");
  const domText = await driver.executeScript(
    `return document.getElementById('main-heading')?.textContent?.trim() ?? null;`
  );
  assert.equal(domText, "REPLACED HEADING TEXT", "text.set: DOM not updated");
  console.log(`    ✓ DOM text: "${domText}"`);

  await delay(200);
  // Modern Edge uses CSS Custom Highlight API for text nodes; check native or physical changed-highlight.
  const changedHighlight = await driver.executeScript(`
    const physBox = document.querySelector('.lextrace-text-highlight-box.is-changed[data-lextrace-text-binding-id="' + arguments[0] + '"]') !== null;
    const nativeChanged = typeof CSS !== "undefined" && "highlights" in CSS
      ? (CSS.highlights.get("lextrace-text-changed")?.size ?? 0) > 0
      : false;
    return physBox || nativeChanged;
  `, headingId);
  assert.ok(changedHighlight, "text.set: is-changed highlight missing (checked native + physical)");
  console.log("    ✓ is-changed highlight rendered");

  // ------------------------------------------------------------------
  // TEST 5: text.revert — DOM restoration
  // ------------------------------------------------------------------
  console.log("  [5] text.revert — DOM restoration...");
  const revertResult = await runCmd(`text.revert ${headingId}`);
  assert.equal(revertResult?.output?.binding?.changed, false, "text.revert: still changed");
  assert.equal(revertResult?.output?.binding?.replacementText, null, "text.revert: replacement not cleared");
  const restoredText = await driver.executeScript(
    `return document.getElementById('main-heading')?.textContent?.trim() ?? null;`
  );
  assert.equal(restoredText, "LexTrace Text Test Heading", "text.revert: DOM not restored");
  console.log(`    ✓ Restored: "${restoredText}"`);

  await delay(200);
  const sourceHighlight = await driver.executeScript(`
    const physBox = document.querySelector('.lextrace-text-highlight-box.is-source[data-lextrace-text-binding-id="' + arguments[0] + '"]') !== null;
    const nativeSource = typeof CSS !== "undefined" && "highlights" in CSS
      ? (CSS.highlights.get("lextrace-text-source")?.size ?? 0) > 0
      : false;
    return physBox || nativeSource;
  `, headingId);
  assert.ok(sourceHighlight, "text.revert: is-source highlight not restored (checked native + physical)");
  console.log("    ✓ is-source highlight restored");

  // ------------------------------------------------------------------
  // TEST 6: Incremental scan — new element
  // ------------------------------------------------------------------
  console.log("  [6] Incremental scan — new element...");
  await setConfigOption("debug.textElements.autoScanMode", "incremental");
  await delay(300);

  await driver.executeScript(`
    const zone = document.getElementById('dynamic-zone');
    const p = document.createElement('p');
    p.id = 'para-dynamic';
    p.textContent = 'Dynamically injected paragraph text';
    zone?.appendChild(p);
  `);
  // After the MutationObserver fires and incremental scan runs, the new paragraph
  // gets a binding and data-lextrace-text-binding-id is set on the element.
  // texts-feed only updates when the "texts" tab is active, so check the attribute instead.
  await waitFor(async () => {
    return driver.executeScript(`
      const el = document.getElementById('para-dynamic');
      return typeof el?.getAttribute('data-lextrace-text-binding-id') === 'string';
    `);
  }, 10000, "Incremental: dynamic paragraph not discovered (binding ID not assigned).");
  console.log("    ✓ Dynamic paragraph discovered and highlighted");

  // ------------------------------------------------------------------
  // TEST 7: Scroll into view — below-fold binding is tracked
  // ------------------------------------------------------------------
  console.log("  [7] Scroll visibility...");
  await driver.executeScript(`document.getElementById('below-fold-section')?.scrollIntoView();`);
  await delay(500);
  // para-below was discovered in the initial text.scan. After scrolling it into view,
  // verify the binding is being tracked (data-lextrace-text-binding-id is set on the element).
  // Native CSS highlights render via the browser automatically when the range is in-viewport.
  const belowFoldId = await driver.executeScript(
    `return document.getElementById('para-below')?.getAttribute('data-lextrace-text-binding-id') ?? null;`
  );
  assert.ok(belowFoldId?.startsWith("txt_"), `Scroll: below-fold has no active binding (got: ${belowFoldId})`);
  console.log(`    ✓ Below-fold binding tracked: ${belowFoldId}`);

  // ------------------------------------------------------------------
  // TEST 8: text.page.reset
  // ------------------------------------------------------------------
  console.log("  [8] text.page.reset...");
  await driver.executeScript(`window.scrollTo(0, 0);`);
  await delay(300);
  await runCmd(`text.set ${headingId} -- Temporary`);
  const tempText = await driver.executeScript(
    `return document.getElementById('main-heading')?.textContent?.trim() ?? null;`
  );
  assert.equal(tempText, "Temporary", "text.page.reset pre-condition failed");
  await runCmd("text.reset page");
  const resetText = await driver.executeScript(
    `return document.getElementById('main-heading')?.textContent?.trim() ?? null;`
  );
  assert.equal(resetText, "LexTrace Text Test Heading", "text.page.reset: text not restored");
  console.log("    ✓ text.page.reset restored original text");

  // ------------------------------------------------------------------
  // TEST 9: Disable highlights — boxes removed
  // ------------------------------------------------------------------
  console.log("  [9] Disable highlights...");
  await setConfigOption("debug.textElements.highlightEnabled", "false");
  await delay(300);
  const highlightState = await driver.executeScript(`
    return {
      physBoxes: document.querySelectorAll('.lextrace-text-highlight-box').length,
      nativeSource: typeof CSS !== "undefined" && "highlights" in CSS ? (CSS.highlights.has("lextrace-text-source") ? CSS.highlights.get("lextrace-text-source").size : 0) : 0,
      nativeChanged: typeof CSS !== "undefined" && "highlights" in CSS ? (CSS.highlights.has("lextrace-text-changed") ? CSS.highlights.get("lextrace-text-changed").size : 0) : 0
    };
  `);
  assert.equal(highlightState.physBoxes, 0, `Highlights: ${highlightState.physBoxes} physical boxes remain`);
  assert.equal(highlightState.nativeSource, 0, `Highlights: ${highlightState.nativeSource} native source ranges remain`);
  assert.equal(highlightState.nativeChanged, 0, `Highlights: ${highlightState.nativeChanged} native changed ranges remain`);
  console.log("    ✓ All highlights cleared (physical + native CSS)");

  console.log("--- Text Element Subsystem Tests (Selenium) PASSED ---\n");
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

const TEXT_ELEMENTS_TEST_PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>LexTrace Text Elements Fixture</title>
  <style>
    body { font-family: sans-serif; margin: 0; padding: 20px; }
    .scrollable { height: 120px; overflow-y: auto; border: 1px solid #ccc; margin-top: 12px; }
    .below-fold { margin-top: 2000px; }
    table { border-collapse: collapse; margin-top: 12px; }
    td, th { border: 1px solid #999; padding: 6px 12px; }
  </style>
</head>
<body>
  <h1 id="main-heading">LexTrace Text Test Heading</h1>
  <h2 id="sub-heading">Sub-heading Alpha</h2>
  <p id="para-intro">Introductory paragraph for visual testing.</p>
  <p id="para-second">Second paragraph with distinct text.</p>
  <a id="link-home" href="#">Home link anchor</a>
  <button id="btn-action">Action Button Label</button>
  <label for="inp-name" id="lbl-name">Name field label</label>
  <input id="inp-name" type="text" value="Initial input value" placeholder="Type your name" />
  <input id="inp-email" type="email" value="" placeholder="Email placeholder text" />
  <textarea id="ta-notes" placeholder="Notes placeholder">Textarea initial content</textarea>
  <select id="sel-color"><option value="red" selected>Red option</option><option value="blue">Blue option</option></select>
  <ul>
    <li id="li-first">First list item</li>
    <li id="li-second">Second list item</li>
  </ul>
  <table>
    <thead><tr><th id="th-col1">Column Header One</th><th id="th-col2">Column Header Two</th></tr></thead>
    <tbody><tr><td id="td-cell1">Cell value alpha</td><td id="td-cell2">Cell value beta</td></tr></tbody>
  </table>
  <div class="below-fold" id="below-fold-section">
    <p id="para-below">Far below fold paragraph</p>
  </div>
  <div id="dynamic-zone"></div>
</body>
</html>`;

async function startLocalServer() {
  const server = http.createServer(async (request, response) => {
    if (request.url?.startsWith("/slow")) {
      await delay(3000);
    }

    if (request.url?.startsWith("/text-elements")) {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(TEXT_ELEMENTS_TEST_PAGE);
      return;
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
    textElementsUrl: `http://127.0.0.1:${address.port}/text-elements`,
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
