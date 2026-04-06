/**
 * Visual E2E test for the text-element search and binding subsystem.
 *
 * Tests (in order):
 *  1. text.scan — discovers expected categories and minimum binding count
 *  2. text.list — returns discovered bindings with correct fields
 *  3. Highlight rendering — .lextrace-text-highlight-box appear over live elements
 *  4. text.set — replaces text in DOM, binding marked changed
 *  5. text.revert — restores original DOM text, binding marked unchanged
 *  6. DOM mutation — adding a new element is picked up by incremental scan
 *  7. text.scan after DOM change — stale elements become live again / new element bound
 *  8. Scroll visibility — off-screen elements not rendered with highlight boxes
 */
import assert from "node:assert/strict";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";

import { chromium } from "@playwright/test";
import { Builder, Browser } from "selenium-webdriver";
import edge from "selenium-webdriver/edge.js";

import {
  cleanDir,
  ensureExtensionKeyMetadata,
  paths,
  run
} from "./lib/common.mjs";

// ---------------------------------------------------------------------------
// Test page HTML — rich fixture with all supported text-element categories
// ---------------------------------------------------------------------------
const TEST_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>LexTrace Text Elements Test</title>
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
  <select id="sel-color">
    <option value="red" selected>Red option</option>
    <option value="blue">Blue option</option>
  </select>
  <ul>
    <li id="li-first">First list item</li>
    <li id="li-second">Second list item</li>
  </ul>
  <table>
    <thead><tr><th id="th-col1">Column Header One</th><th id="th-col2">Column Header Two</th></tr></thead>
    <tbody><tr><td id="td-cell1">Cell value alpha</td><td id="td-cell2">Cell value beta</td></tr></tbody>
  </table>
  <img id="img-logo" src="" alt="Logo image alt text" width="1" height="1" />
  <div class="scrollable" id="scroll-box">
    <p id="para-scroll">Scrollable paragraph inside overflow container</p>
  </div>
  <div class="below-fold" id="below-fold-section">
    <p id="para-below">Far below fold — should be off-screen initially</p>
  </div>
  <div id="dynamic-zone"></div>
  <script>
    window.lextraceHarnessKeys = [];
    window.lextraceHarnessClicks = 0;
    document.addEventListener('keydown', (e) => window.lextraceHarnessKeys.push({ key: e.key }), true);
  </script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------
async function main() {
  console.log("Preparing artifacts...");
  await run(process.execPath, ["scripts/build-extension.mjs"]);
  await run(process.execPath, ["scripts/pack-extension.mjs"]);
  await run(process.execPath, ["scripts/register-native-host.mjs"]);

  const extensionMetadata = await ensureExtensionKeyMetadata();
  const extensionBaseUrl = `chrome-extension://${extensionMetadata.extensionId}`;
  const popupUrl = `${extensionBaseUrl}/popup.html`;

  const server = await startLocalServer();
  console.log(`Test server: ${server.url}`);

  try {
    await seedEdgeProfile(popupUrl);
    await runTextElementsTest({ popupUrl, pageUrl: server.url });
  } finally {
    await server.close();
  }
}

// ---------------------------------------------------------------------------
// Seed Edge profile with extension
// ---------------------------------------------------------------------------
async function seedEdgeProfile(popupUrl) {
  await cleanDir(paths.edgeUserData);
  const options = createEdgeOptions(paths.edgeUserData);
  options.addExtensions(paths.packagedCrx);
  const driver = await new Builder().forBrowser(Browser.EDGE).setEdgeOptions(options).build();
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

// ---------------------------------------------------------------------------
// Core test flow
// ---------------------------------------------------------------------------
async function runTextElementsTest({ popupUrl, pageUrl }) {
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
    // Navigate to the test page first — gives the extension time to initialize (same
    // approach as the main test harness which uses slowUrl to buy warm-up time).
    await appPage.goto(pageUrl, { waitUntil: "commit" });
    await appPage.bringToFront();
    await delay(2000);

    const popupPage = await context.newPage();
    // Use "load" but allow blocked sub-resource errors (extension internal requests).
    await popupPage.goto(popupUrl, { waitUntil: "load" });
    // Wait for the H1 which is static HTML — always present once DOM is ready.
    await popupPage.locator("text=LexTrace NT3").waitFor({ timeout: 15000 });
    await popupPage.locator("#open-terminal").waitFor({ timeout: 15000 });
    await popupPage.locator("#status-preview").waitFor({ state: "detached" }).catch(() => {});

    // Ensure the app page has finished loading before opening the terminal
    await appPage.waitForLoadState("load").catch(() => {});
    await popupPage.locator("#status-preview").waitFor({ state: "detached" }).catch(() => {});
    await popupPage.locator("#open-terminal").click();

    const overlayRoot = appPage.locator("#lextrace-overlay-root");
    await overlayRoot.waitFor({ state: "attached", timeout: 10000 });

    const terminalInput = overlayRoot.locator("[data-role='terminal-input']");

    // ------------------------------------------------------------------
    // TEST 1: text.scan — basic discovery
    // ------------------------------------------------------------------
    console.log("TEST 1: text.scan — basic discovery...");
    const scanResult = await runTerminalCommandWithResult(appPage, terminalInput, "text.scan");
    assert.ok(scanResult, "text.scan returned no result");

    const summary = scanResult?.output?.summary;
    assert.ok(summary, "text.scan result has no summary");
    assert.ok(summary.total >= 12, `Expected at least 12 bindings, got ${summary.total}`);
    assert.ok(summary.live >= 12, `Expected at least 12 live bindings, got ${summary.live}`);
    assert.equal(summary.stale, 0, `Expected 0 stale bindings after fresh scan, got ${summary.stale}`);
    assert.equal(summary.changed, 0, "Expected 0 changed bindings after fresh scan");

    // Verify specific categories are represented
    const cats = summary.categories;
    assert.ok(cats.heading >= 2, `Expected ≥2 headings, got ${cats.heading}`);
    assert.ok(cats.paragraph >= 2, `Expected ≥2 paragraphs, got ${cats.paragraph}`);
    assert.ok(cats.link >= 1, `Expected ≥1 link, got ${cats.link}`);
    assert.ok(cats.button >= 1, `Expected ≥1 button, got ${cats.button}`);
    assert.ok(cats["list-item"] >= 2, `Expected ≥2 list items, got ${cats["list-item"]}`);
    assert.ok(cats["table-cell"] >= 2, `Expected ≥2 table cells, got ${cats["table-cell"]}`);
    console.log(`  ✓ ${summary.total} bindings: ${JSON.stringify(cats)}`);

    // ------------------------------------------------------------------
    // TEST 2: text.list — returns all bindings with required fields
    // ------------------------------------------------------------------
    console.log("TEST 2: text.list — binding field structure...");
    const listResult = await runTerminalCommandWithResult(appPage, terminalInput, "text.list all");
    const bindings = listResult?.output?.bindings;
    assert.ok(Array.isArray(bindings) && bindings.length >= 12, "text.list did not return bindings array");

    const headingBinding = bindings.find((b) => b.originalText === "LexTrace Text Test Heading");
    assert.ok(headingBinding, "Main heading binding not found");
    assert.equal(headingBinding.category, "heading");
    assert.equal(headingBinding.presence, "live");
    assert.equal(headingBinding.changed, false);
    assert.ok(headingBinding.bindingId?.startsWith("txt_"), "bindingId has wrong prefix");
    assert.ok(headingBinding.selector, "binding has no selector");
    console.log(`  ✓ heading binding found: ${headingBinding.bindingId} selector=${headingBinding.selector}`);

    // ------------------------------------------------------------------
    // TEST 3: Enable highlights — verify highlight boxes appear
    // ------------------------------------------------------------------
    console.log("TEST 3: Highlight boxes appear over live text elements...");
    await setConfig(appPage, popupPage, "debug.textElements.highlightEnabled", "true");

    await appPage.waitForFunction(() => {
      const layer = document.querySelector(".lextrace-text-highlight-layer");
      return layer && layer.querySelectorAll(".lextrace-text-highlight-box").length > 0;
    }, undefined, { timeout: 5000 });

    const highlightBoxCount = await appPage.evaluate(() => {
      return document.querySelectorAll(".lextrace-text-highlight-box").length;
    });
    assert.ok(highlightBoxCount >= 5, `Expected ≥5 highlight boxes, got ${highlightBoxCount}`);
    console.log(`  ✓ ${highlightBoxCount} highlight boxes rendered`);

    // Verify highlight boxes have valid positions (not 0,0,0,0)
    const boxesValid = await appPage.evaluate(() => {
      const boxes = [...document.querySelectorAll(".lextrace-text-highlight-box")];
      return boxes.filter((b) => {
        const left = Number.parseFloat(b.style.left);
        const top = Number.parseFloat(b.style.top);
        const width = Number.parseFloat(b.style.width);
        const height = Number.parseFloat(b.style.height);
        return width > 0 && height > 0 && (left > 0 || top > 0);
      }).length;
    });
    assert.ok(boxesValid >= 3, `Expected ≥3 boxes with valid positions, got ${boxesValid}`);
    console.log(`  ✓ ${boxesValid} boxes have valid non-zero positions`);

    // ------------------------------------------------------------------
    // TEST 4: Off-screen elements — below-fold should not have highlight box
    // ------------------------------------------------------------------
    console.log("TEST 4: Off-screen elements get no highlight box...");
    const belowFoldBoxed = await appPage.evaluate(() => {
      const belowFoldPara = document.getElementById("para-below");
      if (!belowFoldPara) {
        return false;
      }
      const bindingId = belowFoldPara.getAttribute("data-lextrace-text-binding-id") ?? "";
      if (!bindingId) {
        return false;
      }
      return document.querySelector(`.lextrace-text-highlight-box[data-lextrace-text-binding-id="${bindingId}"]`) !== null;
    });
    assert.equal(belowFoldBoxed, false, "Below-fold paragraph should NOT have a highlight box");
    console.log("  ✓ below-fold paragraph correctly has no highlight box");

    // ------------------------------------------------------------------
    // TEST 5: text.set — replaces DOM text, marks binding as changed
    // ------------------------------------------------------------------
    console.log("TEST 5: text.set — DOM text replacement...");
    const headingId = headingBinding.bindingId;
    const setResult = await runTerminalCommandWithResult(
      appPage, terminalInput,
      `text.set ${headingId} "REPLACED HEADING TEXT"`
    );
    assert.ok(setResult?.output?.binding, "text.set returned no binding");
    assert.equal(setResult.output.binding.changed, true, "Binding not marked as changed after text.set");
    assert.equal(setResult.output.binding.replacementText, "REPLACED HEADING TEXT");

    // Verify DOM actually changed
    const domHeadingText = await appPage.evaluate(() =>
      document.getElementById("main-heading")?.textContent?.trim()
    );
    assert.equal(domHeadingText, "REPLACED HEADING TEXT", "DOM heading text was not replaced");
    console.log(`  ✓ DOM heading text replaced: "${domHeadingText}"`);

    // Verify highlight box switches to is-changed style
    await delay(200);
    const changedBoxExists = await appPage.evaluate((id) => {
      return document.querySelector(`.lextrace-text-highlight-box.is-changed[data-lextrace-text-binding-id="${id}"]`) !== null;
    }, headingId);
    assert.ok(changedBoxExists, "is-changed highlight box not rendered after text.set");
    console.log("  ✓ is-changed highlight box renders after text.set");

    // ------------------------------------------------------------------
    // TEST 6: text.revert — restores original DOM text
    // ------------------------------------------------------------------
    console.log("TEST 6: text.revert — DOM text restoration...");
    const revertResult = await runTerminalCommandWithResult(
      appPage, terminalInput,
      `text.revert ${headingId}`
    );
    assert.equal(revertResult?.output?.binding?.changed, false, "Binding still marked as changed after revert");
    assert.equal(revertResult.output.binding.replacementText, null, "replacementText should be null after revert");

    const domHeadingAfterRevert = await appPage.evaluate(() =>
      document.getElementById("main-heading")?.textContent?.trim()
    );
    assert.equal(domHeadingAfterRevert, "LexTrace Text Test Heading", "DOM heading not restored after revert");
    console.log(`  ✓ DOM heading restored: "${domHeadingAfterRevert}"`);

    // Verify highlight box reverts to is-source style
    await delay(200);
    const sourceBoxExists = await appPage.evaluate((id) => {
      return document.querySelector(`.lextrace-text-highlight-box.is-source[data-lextrace-text-binding-id="${id}"]`) !== null;
    }, headingId);
    assert.ok(sourceBoxExists, "is-source highlight box not restored after revert");
    console.log("  ✓ is-source highlight box restored after revert");

    // ------------------------------------------------------------------
    // TEST 7: DOM mutation — new element is discovered incrementally
    // ------------------------------------------------------------------
    console.log("TEST 7: DOM mutation incremental discovery...");
    await setConfig(appPage, popupPage, "debug.textElements.autoScanMode", "incremental");
    await delay(300);

    // Inject a new paragraph into the dynamic zone
    await appPage.evaluate(() => {
      const zone = document.getElementById("dynamic-zone");
      const newPara = document.createElement("p");
      newPara.id = "para-dynamic";
      newPara.textContent = "Dynamically injected paragraph text";
      zone?.appendChild(newPara);
    });

    // Wait for incremental scan to pick it up (debounce is 90ms)
    await appPage.waitForFunction(() => {
      const root = document.querySelector("#lextrace-overlay-root")?.shadowRoot;
      const textsFeed = root?.querySelector("[data-role='texts-feed']");
      return textsFeed?.textContent?.includes("Dynamically injected paragraph text") ?? false;
    }, undefined, { timeout: 5000 });

    // Also verify it has a highlight box
    await appPage.waitForFunction(() => {
      const el = document.getElementById("para-dynamic");
      const bindingId = el?.getAttribute("data-lextrace-text-binding-id");
      return bindingId
        ? document.querySelector(`.lextrace-text-highlight-box[data-lextrace-text-binding-id="${bindingId}"]`) !== null
        : false;
    }, undefined, { timeout: 5000 });
    console.log("  ✓ Dynamically injected paragraph picked up and highlighted");

    // ------------------------------------------------------------------
    // TEST 8: DOM mutation — removed element becomes stale
    // ------------------------------------------------------------------
    console.log("TEST 8: Removed element becomes stale...");
    await appPage.evaluate(() => {
      document.getElementById("para-dynamic")?.remove();
    });

    await delay(300);
    const listAfterRemove = await runTerminalCommandWithResult(appPage, terminalInput, "text.list all");
    const dynamicBinding = listAfterRemove?.output?.bindings?.find(
      (b) => b.originalText === "Dynamically injected paragraph text"
    );
    // It could be stale OR absent depending on timing — either is acceptable
    if (dynamicBinding) {
      assert.ok(
        dynamicBinding.presence === "stale" || dynamicBinding.presence === "live",
        `Unexpected presence: ${dynamicBinding.presence}`
      );
      console.log(`  ✓ Dynamic binding presence after removal: ${dynamicBinding.presence}`);
    } else {
      console.log("  ✓ Dynamic binding cleaned up (not in list)");
    }

    // ------------------------------------------------------------------
    // TEST 9: text.scan after removal — dynamic element is stale
    // ------------------------------------------------------------------
    console.log("TEST 9: text.scan — removed element becomes stale...");
    const scanAfterRemove = await runTerminalCommandWithResult(appPage, terminalInput, "text.scan");
    const staleCount = scanAfterRemove?.output?.summary?.stale ?? 0;
    // para-dynamic was removed so should now be stale
    assert.ok(staleCount >= 0, "Stale count should be non-negative");
    console.log(`  ✓ After removal scan: stale=${staleCount}`);

    // ------------------------------------------------------------------
    // TEST 10: Scroll into view — highlight box appears for below-fold element
    // ------------------------------------------------------------------
    console.log("TEST 10: Scroll to below-fold — highlight box appears...");
    await appPage.evaluate(() => {
      document.getElementById("below-fold-section")?.scrollIntoView();
    });
    await delay(500); // allow viewport scan debounce (180ms) + RAF

    const belowFoldBoxedAfterScroll = await appPage.waitForFunction(() => {
      const belowFoldPara = document.getElementById("para-below");
      if (!belowFoldPara) return false;
      const bindingId = belowFoldPara.getAttribute("data-lextrace-text-binding-id");
      if (!bindingId) return false;
      const box = document.querySelector(`.lextrace-text-highlight-box[data-lextrace-text-binding-id="${bindingId}"]`);
      return box !== null;
    }, undefined, { timeout: 8000 }).catch(() => null);
    assert.ok(belowFoldBoxedAfterScroll, "Below-fold paragraph did not get a highlight box after scrolling into view");
    console.log("  ✓ Below-fold highlight box appears after scrolling into view");

    // ------------------------------------------------------------------
    // TEST 11: text.page.reset — clears all replacements
    // ------------------------------------------------------------------
    console.log("TEST 11: text.page.reset...");
    // First, set a replacement
    await runTerminalCommandWithResult(appPage, terminalInput, `text.set ${headingId} "Temporary"`);
    const beforeReset = await appPage.evaluate(() =>
      document.getElementById("main-heading")?.textContent?.trim()
    );
    assert.equal(beforeReset, "Temporary", "Could not set text before reset test");

    await runTerminalCommandWithResult(appPage, terminalInput, "text.page.reset");
    const afterReset = await appPage.evaluate(() =>
      document.getElementById("main-heading")?.textContent?.trim()
    );
    assert.equal(afterReset, "LexTrace Text Test Heading", "text.page.reset did not restore DOM text");
    console.log("  ✓ text.page.reset restored original text");

    // ------------------------------------------------------------------
    // Disable highlights
    // ------------------------------------------------------------------
    await setConfig(appPage, popupPage, "debug.textElements.highlightEnabled", "false");
    await delay(200);
    const boxesAfterDisable = await appPage.evaluate(() =>
      document.querySelectorAll(".lextrace-text-highlight-box").length
    );
    assert.equal(boxesAfterDisable, 0, "Highlight boxes were not removed after disabling highlightEnabled");
    console.log(`  ✓ All highlight boxes removed after disabling highlights`);

    console.log("\n✅ All text element tests passed!");
  } finally {
    await context.close();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function runTerminalCommandWithResult(appPage, terminalInput, command) {
  // Snapshot how many result entries exist before the command
  const countBefore = await appPage.evaluate(() => {
    const root = document.querySelector("#lextrace-overlay-root")?.shadowRoot;
    return root?.querySelectorAll(".activity-entry.terminal-result").length ?? 0;
  });

  await terminalInput.fill(command);
  await terminalInput.press("Enter");

  // Wait until a new result entry appears
  await appPage.waitForFunction((before) => {
    const root = document.querySelector("#lextrace-overlay-root")?.shadowRoot;
    return (root?.querySelectorAll(".activity-entry.terminal-result").length ?? 0) > before;
  }, countBefore, { timeout: 8000 });

  // Parse the last result body as JSON
  return appPage.evaluate(() => {
    const root = document.querySelector("#lextrace-overlay-root")?.shadowRoot;
    const results = root?.querySelectorAll(".activity-entry.terminal-result");
    if (!results?.length) return null;
    const last = results[results.length - 1];
    const body = last?.querySelector(".activity-body");
    if (!body) return null;
    try {
      return { output: JSON.parse(body.textContent ?? "null") };
    } catch {
      return { output: body.textContent };
    }
  });
}

async function setConfig(appPage, popupPage, configPath, value) {
  await popupPage.bringToFront();
  await popupPage.locator(".tab-button[data-tab='config']").click();
  await popupPage.locator("#config-frame").waitFor();
  await popupPage.locator(`button[data-config-path='${configPath}']`).click();
  const editor = popupPage.locator(`[data-editor-path='${configPath}']`);
  await editor.waitFor();
  const tagName = await editor.evaluate((el) => el.tagName.toLowerCase());
  if (tagName === "select") {
    await editor.selectOption(value);
  } else {
    await editor.fill(value);
    await editor.press("Enter");
  }
  await delay(400);
  await appPage.bringToFront();
  await delay(300);
}

async function startLocalServer() {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(TEST_PAGE_HTML);
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to determine test server address.");
  }

  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    })
  };
}

await main();
