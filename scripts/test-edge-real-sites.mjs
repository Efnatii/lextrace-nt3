/**
 * Visual real-site E2E test — LexTrace text binding subsystem.
 * 12 real websites, deep scroll with a screenshot at every step.
 * The overlay is CLOSED before taking page screenshots so highlights
 * (native CSS ::highlight + physical boxes) are fully visible.
 *
 * Run:  node scripts/test-edge-real-sites.mjs
 * Out:  artifacts/screenshots/real-sites/{siteId}/N-*.png
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { Builder, Browser } from "selenium-webdriver";
import edge from "selenium-webdriver/edge.js";

import {
  cleanDir,
  ensureExtensionKeyMetadata,
  paths,
  run
} from "./lib/common.mjs";

// ---------------------------------------------------------------------------
// Site definitions
// ---------------------------------------------------------------------------
const SITES = [
  {
    id: "youtube",
    name: "YouTube Search",
    // Search results always show videos without sign-in
    url: "https://www.youtube.com/results?search_query=programming+tutorial",
    dynamic: true,
    loadWait: 7000,
    scrollSteps: 10,
    scrollPx: 1100,
    scrollWait: 3000
  },
  {
    id: "twitch",
    name: "Twitch Directory",
    url: "https://www.twitch.tv/directory",
    dynamic: true,
    loadWait: 7000,
    scrollSteps: 10,
    scrollPx: 1100,
    scrollWait: 3000
  },
  {
    id: "github",
    name: "GitHub Explore",
    url: "https://github.com/explore",
    dynamic: false,
    loadWait: 3000,
    scrollSteps: 8,
    scrollPx: 1000,
    scrollWait: 800
  },
  {
    id: "wikipedia",
    name: "Wikipedia — JavaScript",
    url: "https://en.wikipedia.org/wiki/JavaScript",
    dynamic: false,
    loadWait: 3000,
    scrollSteps: 10,
    scrollPx: 1100,
    scrollWait: 600
  },
  {
    id: "devto",
    name: "DEV Community",
    // dev.to — developer articles, infinite scroll, no bot blocking
    url: "https://dev.to/",
    dynamic: true,
    loadWait: 4000,
    scrollSteps: 10,
    scrollPx: 1100,
    scrollWait: 3000
  },
  {
    id: "hackernews",
    name: "Hacker News",
    url: "https://news.ycombinator.com/",
    dynamic: false,
    loadWait: 2000,
    scrollSteps: 7,
    scrollPx: 900,
    scrollWait: 500
  },
  {
    id: "stackoverflow",
    name: "Stack Overflow Questions",
    url: "https://stackoverflow.com/questions",
    dynamic: false,
    loadWait: 3500,
    scrollSteps: 8,
    scrollPx: 1000,
    scrollWait: 700
  },
  {
    id: "bbc",
    name: "BBC News",
    url: "https://www.bbc.com/news",
    dynamic: false,
    loadWait: 4000,
    scrollSteps: 8,
    scrollPx: 1000,
    scrollWait: 700
  },
  {
    id: "mdn",
    name: "MDN — Web APIs",
    url: "https://developer.mozilla.org/en-US/docs/Web/API",
    dynamic: false,
    loadWait: 3500,
    scrollSteps: 8,
    scrollPx: 1000,
    scrollWait: 600
  },
  {
    id: "amazon",
    name: "Amazon Search",
    url: "https://www.amazon.com/s?k=programming+books",
    dynamic: false,
    loadWait: 5000,
    scrollSteps: 8,
    scrollPx: 1000,
    scrollWait: 800
  },
  {
    id: "x",
    name: "X (Twitter) Explore",
    url: "https://x.com/explore",
    dynamic: true,
    loadWait: 6000,
    scrollSteps: 8,
    scrollPx: 1100,
    scrollWait: 3000
  },
  {
    id: "linkedin",
    name: "LinkedIn Jobs",
    url: "https://www.linkedin.com/jobs/",
    dynamic: false,
    loadWait: 5000,
    scrollSteps: 8,
    scrollPx: 1000,
    scrollWait: 1000
  }
];

const OVERLAY_TITLES = ["LexTrace Terminal", "Терминал LexTrace"];

// ---------------------------------------------------------------------------
// Main  — supports --only youtube,twitch  to re-run specific sites
// ---------------------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);

  // --only youtube,twitch
  const onlyArg = args.find((a) => a.startsWith("--only="))
    ?? (args.includes("--only") ? args[args.indexOf("--only") + 1] : null);
  const onlyIds = onlyArg ? onlyArg.replace("--only=", "").split(",").map((s) => s.trim()) : null;
  const sitesToRun = onlyIds ? SITES.filter((s) => onlyIds.includes(s.id)) : SITES;

  // --real-profile  — use the real Edge user profile (needs Edge closed first!)
  const useRealProfile = args.includes("--real-profile");
  const realProfileDir = process.env.LOCALAPPDATA
    ? `${process.env.LOCALAPPDATA}\\Microsoft\\Edge\\User Data`
    : null;
  if (useRealProfile && !realProfileDir) {
    console.error("Cannot determine real Edge profile path (LOCALAPPDATA not set)");
    process.exit(1);
  }

  console.log("=== LexTrace Real-Sites Visual Test (deep scroll) ===\n");
  if (onlyIds) console.log(`Running only: ${sitesToRun.map((s) => s.name).join(", ")}\n`);
  if (useRealProfile) console.log(`Using real Edge profile: ${realProfileDir}\n`);

  await buildArtifacts();

  const metadata = await ensureExtensionKeyMetadata();
  const popupUrl = `chrome-extension://${metadata.extensionId}/popup.html`;
  console.log(`Extension ID: ${metadata.extensionId}`);

  if (useRealProfile) {
    console.log("Skipping profile seed (real profile mode)\n");
  } else {
    console.log("Seeding Edge profile...");
    await seedEdgeProfile(popupUrl);
  }

  const profileDir = useRealProfile ? realProfileDir : paths.edgeProfile;

  const screenshotsDir = path.join(paths.artifacts, "screenshots", "real-sites");
  await fs.mkdir(screenshotsDir, { recursive: true });
  console.log(`Screenshots → ${screenshotsDir}\n`);

  const results = await runAllSiteTests(popupUrl, screenshotsDir, sitesToRun, profileDir, useRealProfile);

  printSummary(results);
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------
async function buildArtifacts() {
  console.log("Building extension...");
  await run(process.execPath, ["scripts/build-extension.mjs"]);
  await run(process.execPath, ["scripts/pack-extension.mjs"]);
  await run(process.execPath, ["scripts/register-native-host.mjs"]);
  console.log();
}

// ---------------------------------------------------------------------------
// Seed profile
// ---------------------------------------------------------------------------
async function seedEdgeProfile(popupUrl) {
  await cleanDir(paths.edgeProfile);
  const options = createEdgeOptions(paths.edgeProfile);
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

// ---------------------------------------------------------------------------
// Run all sites
// ---------------------------------------------------------------------------
async function runAllSiteTests(popupUrl, screenshotsDir, sitesToRun = SITES, profileDir = paths.edgeProfile, realProfile = false) {
  const options = createEdgeOptions(profileDir);
  if (!realProfile) options.addExtensions(paths.packagedCrx);
  const driver = await new Builder().forBrowser(Browser.EDGE).setEdgeOptions(options).build();
  await driver.manage().window().maximize();

  const results = [];
  try {
    await driver.get("about:blank");
    const appHandle = await driver.getWindowHandle();

    await driver.switchTo().newWindow("tab");
    const popupHandle = await driver.getWindowHandle();
    await driver.get(popupUrl);
    await delay(1000);

    for (const site of sitesToRun) {
      const siteDir = path.join(screenshotsDir, site.id);
      await fs.mkdir(siteDir, { recursive: true });
      const result = await testSite(driver, appHandle, popupHandle, popupUrl, site, siteDir);
      results.push(result);
    }
  } finally {
    await driver.quit();
  }
  return results;
}

// ---------------------------------------------------------------------------
// Test one site
// ---------------------------------------------------------------------------
async function testSite(driver, appHandle, popupHandle, popupUrl, site, siteDir) {
  console.log(`\n${"─".repeat(64)}`);
  console.log(`  ${site.name}`);
  console.log(`  ${site.url}`);
  console.log(`${"─".repeat(64)}`);

  const result = {
    name: site.name,
    url: site.url,
    scanBindings: 0,
    finalBindings: 0,
    highlights: null,
    screenshots: [],
    error: null
  };

  let shotIdx = 0;
  const shot = async (label) => {
    shotIdx++;
    const p = path.join(siteDir, `${String(shotIdx).padStart(2, "0")}-${label}.png`);
    await saveScreenshot(driver, p);
    result.screenshots.push(path.basename(p));
    console.log(`    📸 ${path.basename(p)}`);
    return p;
  };

  try {
    // ── Navigate ──────────────────────────────────────────────────────────
    await driver.switchTo().window(appHandle);
    await driver.get(site.url);
    console.log(`  Loading (${site.loadWait}ms)...`);
    await delay(site.loadWait);

    // Screenshot 1 — raw page, no overlay
    await shot("page-raw");

    // ── Open overlay ───────────────────────────────────────────────────────
    await openTerminal(driver, appHandle, popupHandle, popupUrl);

    // Screenshot 2 — overlay open, before scan
    await shot("overlay-open");

    // ── text.scan ─────────────────────────────────────────────────────────
    console.log("  Running text.scan...");
    const scanResult = await runTerminalCmd(driver, "text.scan", 20000);
    const summary = scanResult?.summary ?? {};
    result.scanBindings = summary.total ?? 0;
    console.log(`  Scan: ${result.scanBindings} bindings — ${formatCats(summary.categories ?? {})}`);

    // Screenshot 3 — scan results visible in terminal
    await shot("scan-results");

    // ── Enable highlights ─────────────────────────────────────────────────
    await setConfig(driver, appHandle, popupHandle, popupUrl, "debug.textElements.highlightEnabled", "true");

    // Enable incremental auto-scan for dynamic sites
    if (site.dynamic) {
      await setConfig(driver, appHandle, popupHandle, popupUrl, "debug.textElements.autoScanMode", "incremental");
    }

    // Wait for native CSS highlights / boxes to render
    await waitForBool(async () => {
      const s = await getHighlightStats(driver);
      return s.nativeSource > 0 || s.physBoxes > 0;
    }, 5000);

    const hs = await getHighlightStats(driver);
    result.highlights = hs;
    console.log(`  Highlights: ${hs.nativeSource} native ranges + ${hs.physBoxes} physical boxes`);

    // Screenshot 4 — highlights with terminal still open
    await shot("highlights-overlay");

    // ── CLOSE overlay — show clean page with highlights ───────────────────
    await closeOverlay(driver);
    await delay(400);

    // Screenshot 5 — clean page with native CSS highlights visible
    await shot("highlights-clean");

    // ── Deep scroll — screenshot at every step ────────────────────────────
    // Dismiss any modal/popup that could block scrolling
    // 1. Real Selenium Escape keypress (more reliable than dispatchEvent)
    await driver.actions().sendKeys("\uE00C").perform();
    await delay(300);
    // 2. Fallback: click the modal's own close button (X) if still visible
    await driver.executeScript(`
      const closeSelectors = [
        '[role="dialog"] button', '[class*="modal"] button[aria-label]',
        '[class*="Modal"] button', 'button[aria-label*="ose"]',
        '[class*="close-button"]', '[class*="CloseButton"]', '[data-close]'
      ];
      for (const sel of closeSelectors) {
        for (const btn of document.querySelectorAll(sel)) {
          const rect = btn.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) { btn.click(); break; }
        }
      }
    `);
    await delay(400);

    console.log(`  Scrolling ${site.scrollSteps} steps × ${site.scrollPx}px ...`);
    for (let i = 1; i <= site.scrollSteps; i++) {
      // scrollBy fires scroll events (triggers IntersectionObserver / lazy loading)
      const dbg = await driver.executeScript(`
        const amount = arguments[0];
        function findScrollTarget() {
          const vw = window.innerWidth;
          const vh = window.innerHeight;
          const candidates = Array.from(document.querySelectorAll('*')).filter(el => {
            if (el === document.body || el === document.documentElement) return false;
            const s = window.getComputedStyle(el);
            const ov = s.overflowY;
            if (ov !== 'auto' && ov !== 'scroll') return false;
            if (el.scrollHeight <= el.clientHeight + 100) return false;
            const rect = el.getBoundingClientRect();
            if (rect.width < vw * 0.4) return false;
            if (rect.height < vh * 0.4) return false;
            return true;
          });
          if (candidates.length === 0) return null;
          return candidates.reduce((best, el) =>
            (el.scrollHeight - el.clientHeight) > (best.scrollHeight - best.clientHeight) ? el : best
          );
        }
        const target = findScrollTarget();
        if (target) {
          const before = target.scrollTop;
          target.scrollBy(0, amount);
          return {
            via: target.tagName.toLowerCase() + (target.id ? '#' + target.id : ''),
            before,
            after: target.scrollTop,
            scrollHeight: target.scrollHeight
          };
        } else {
          const before = window.scrollY;
          window.scrollBy(0, amount);
          return {
            via: 'window',
            before,
            after: window.scrollY,
            scrollHeight: document.documentElement.scrollHeight
          };
        }
      `, site.scrollPx);
      // Native highlight count = proxy for how many live bindings auto-scan found so far
      const hlCount = await driver.executeScript(
        `return CSS?.highlights?.get('lextrace-text-source')?.size ?? 0;`
      );
      console.log(`    step ${i}: ${dbg.via}  ${dbg.before}→${dbg.after}px  (scrollHeight: ${dbg.scrollHeight})  hl:${hlCount}`);
      await delay(site.scrollWait);
      await shot(`scroll-${i}`);
    }

    // ── Re-open overlay and re-scan to catch new elements ─────────────────
    await openTerminal(driver, appHandle, popupHandle, popupUrl);
    await delay(500);

    const rescanResult = await runTerminalCmd(driver, "text.scan", 20000);
    const rescanSummary = rescanResult?.summary ?? {};
    result.finalBindings = rescanSummary.total ?? result.scanBindings;
    const added = result.finalBindings - result.scanBindings;
    const staleCount = rescanSummary.stale ?? 0;
    console.log(`  Re-scan: ${result.finalBindings} bindings (${added >= 0 ? "+" : ""}${added} vs initial) | stale: ${staleCount}${staleCount === 0 ? " ✓" : " (only 0 expected if nothing edited)"}`);

    // Re-enable highlights so newly discovered elements are also highlighted
    await setConfig(driver, appHandle, popupHandle, popupUrl, "debug.textElements.highlightEnabled", "true");
    await delay(600);

    // Screenshot: re-scan results
    await shot("rescan-results");

    // Close overlay and screenshot final state with all highlights
    await closeOverlay(driver);
    await delay(400);
    await driver.executeScript(`
      const vw = window.innerWidth, vh = window.innerHeight;
      const allScrollable = Array.from(document.querySelectorAll('*')).filter(el => {
        if (el === document.body || el === document.documentElement) return false;
        const s = window.getComputedStyle(el);
        const ov = s.overflowY;
        if (ov !== 'auto' && ov !== 'scroll') return false;
        if (el.scrollHeight <= el.clientHeight + 100) return false;
        const rect = el.getBoundingClientRect();
        return rect.width >= vw * 0.4 && rect.height >= vh * 0.4;
      });
      if (allScrollable.length) {
        allScrollable.reduce((b, el) =>
          (el.scrollHeight - el.clientHeight) > (b.scrollHeight - b.clientHeight) ? el : b
        ).scrollTop = 0;
      }
      window.scrollTo(0, 0);
      document.documentElement.scrollTop = 0;
    `);
    await delay(600);
    await shot("final-top");

    console.log("  PASSED ✓");
  } catch (err) {
    result.error = err.message;
    console.error(`  FAILED ✗  ${err.message}`);
    try { await shot("ERROR"); } catch { /* ignore */ }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Open terminal helper
// ---------------------------------------------------------------------------
async function openTerminal(driver, appHandle, popupHandle, popupUrl) {
  await driver.switchTo().window(popupHandle);
  await driver.get(popupUrl);
  await delay(400);
  await driver.executeScript(`document.querySelector(".tab-button[data-tab='control']")?.click();`);
  await delay(300);
  await driver.executeScript(`document.querySelector('#open-terminal')?.click();`);
  await delay(400);
  await driver.switchTo().window(appHandle);

  const ok = await waitForBool(async () => {
    const title = await driver.executeScript(`
      return document.querySelector('#lextrace-overlay-root')?.shadowRoot
        ?.querySelector('.panel-header h1')?.textContent ?? null;
    `);
    return title != null && OVERLAY_TITLES.some((t) => title.includes(t));
  }, 10000);

  if (!ok) throw new Error("Overlay did not open within 10s");
}

// ---------------------------------------------------------------------------
// Close overlay (click Закрыть button inside shadow DOM)
// ---------------------------------------------------------------------------
async function closeOverlay(driver) {
  await driver.executeScript(`
    document.querySelector('#lextrace-overlay-root')
      ?.shadowRoot?.querySelector('[data-close="true"]')?.click();
  `);
  await delay(300);
}

// ---------------------------------------------------------------------------
// Run terminal command and parse JSON result
// ---------------------------------------------------------------------------
async function runTerminalCmd(driver, command, timeoutMs = 15000) {
  const countBefore = await driver.executeScript(`
    return document.querySelector('#lextrace-overlay-root')?.shadowRoot
      ?.querySelectorAll('.activity-entry.terminal-result').length ?? 0;
  `);

  await driver.executeScript(
    `
      const root = document.querySelector('#lextrace-overlay-root')?.shadowRoot;
      const input = root?.querySelector('[data-role="terminal-input"]');
      const form  = root?.querySelector('[data-role="terminal-form"]');
      if (!input || !form) throw new Error('Terminal unavailable');
      input.value = arguments[0];
      input.dispatchEvent(new Event('input', { bubbles: true }));
      form.requestSubmit();
    `,
    command
  );

  const ok = await waitForBool(async () => {
    const count = await driver.executeScript(`
      return document.querySelector('#lextrace-overlay-root')?.shadowRoot
        ?.querySelectorAll('.activity-entry.terminal-result').length ?? 0;
    `);
    return count > countBefore;
  }, timeoutMs);

  if (!ok) return null;

  return driver.executeScript(`
    const root = document.querySelector('#lextrace-overlay-root')?.shadowRoot;
    const entries = root?.querySelectorAll('.activity-entry.terminal-result');
    const body = entries?.[entries.length - 1]?.querySelector('.activity-body');
    try { return JSON.parse(body?.textContent ?? 'null'); } catch { return null; }
  `);
}

// ---------------------------------------------------------------------------
// Config setter via popup (navigate popup fresh each time)
// ---------------------------------------------------------------------------
async function setConfig(driver, appHandle, popupHandle, popupUrl, configPath, value) {
  await driver.switchTo().window(popupHandle);
  await driver.get(popupUrl);
  await delay(350);
  await driver.executeScript(`document.querySelector(".tab-button[data-tab='config']")?.click();`);
  await delay(450);
  await driver.executeScript(`document.querySelector("button[data-config-path='${configPath}']")?.click();`);
  await delay(200);
  await driver.executeScript(
    `
      const editor = document.querySelector("[data-editor-path='${configPath}']");
      if (!editor) return;
      if (editor.tagName === 'SELECT') {
        editor.value = arguments[0];
        editor.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        editor.value = arguments[0];
        editor.dispatchEvent(new Event('input', { bubbles: true }));
        editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      }
    `,
    value
  );
  await delay(400);
  await driver.switchTo().window(appHandle);
  await delay(300);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function getHighlightStats(driver) {
  return driver.executeScript(`
    return {
      nativeSource:  (typeof CSS !== "undefined" && "highlights" in CSS)
                       ? (CSS.highlights.get("lextrace-text-source")?.size ?? 0) : 0,
      nativeChanged: (typeof CSS !== "undefined" && "highlights" in CSS)
                       ? (CSS.highlights.get("lextrace-text-changed")?.size ?? 0) : 0,
      physBoxes:     document.querySelectorAll('.lextrace-text-highlight-box').length
    };
  `);
}

async function saveScreenshot(driver, filePath) {
  const data = await driver.takeScreenshot();
  await fs.writeFile(filePath, data, "base64");
}

async function waitForBool(predicate, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return true;
    await delay(500);
  }
  return false;
}

function formatCats(cats) {
  return Object.entries(cats)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `${k}:${v}`)
    .join("  ");
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
// Summary
// ---------------------------------------------------------------------------
function printSummary(results) {
  const passed = results.filter((r) => !r.error).length;
  const total  = results.length;
  const shots  = results.reduce((s, r) => s + r.screenshots.length, 0);

  console.log(`\n${"═".repeat(64)}`);
  console.log("  SUMMARY");
  console.log(`${"═".repeat(64)}`);
  console.log(`  Sites: ${total}  Passed: ${passed}  Failed: ${total - passed}  Screenshots: ${shots}`);
  console.log();
  console.log(`  ${"Site".padEnd(22)} ${"Init".padEnd(6)} ${"Final".padEnd(6)} ${"Diff".padEnd(6)} ${"NativeHL".padEnd(10)} Status`);
  console.log(`  ${"─".repeat(60)}`);
  for (const r of results) {
    const diff  = r.finalBindings - r.scanBindings;
    const diffS = diff > 0 ? `+${diff}` : diff < 0 ? String(diff) : "—";
    const nat   = r.highlights?.nativeSource ?? "?";
    const status = r.error ? `✗ ${r.error.slice(0, 30)}` : "✓";
    console.log(
      `  ${r.name.padEnd(22)} ${String(r.scanBindings).padEnd(6)} ${String(r.finalBindings).padEnd(6)} ${diffS.padEnd(6)} ${String(nat).padEnd(10)} ${status}`
    );
  }
  console.log();
  if (results.some((r) => r.error)) process.exitCode = 1;
}

main().catch((err) => { console.error(err); process.exit(1); });
