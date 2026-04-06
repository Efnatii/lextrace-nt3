import assert from "node:assert/strict";
import path from "node:path";
import { promises as fs } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { Button, Origin } from "selenium-webdriver/lib/input.js";

import { ensureExtensionKeyMetadata, paths, writeJson } from "./lib/common.mjs";
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

const URL =
  "https://www.youtube.com/results?search_query=programming&sp=EgIQAQ%253D%253D&hl=en&gl=US&persist_hl=1&persist_gl=1";
const OUT = path.join(paths.artifacts, "test-results", "edge-text-elements-youtube-autoblank-short");
const REPORT = path.join(paths.artifacts, "test-results", "edge-text-elements-youtube-autoblank-short-report.json");
const HOST_ID = "lextrace-youtube-short-proof-host";

async function main() {
  const reuseArtifacts = process.argv.includes("--reuse-artifacts");
  const runPreflight = process.argv.includes("--run-preflight");

  await prepareEdgeAiArtifacts({ reuseArtifacts, runPreflight });
  await fs.rm(OUT, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(OUT, { recursive: true });

  const extensionMetadata = await ensureExtensionKeyMetadata();
  const popupUrl = `chrome-extension://${extensionMetadata.extensionId}/popup.html`;
  const session = await launchEdgeWithExtension();
  let popupHandle = null;
  let mainHandle = null;

  const report = {
    executedAt: new Date().toISOString(),
    popupUrl,
    outputRoot: OUT,
    reportPath: REPORT,
    initial: null,
    afterScan: null,
    afterMutation: null,
    afterDisable: null,
    afterDisableMutation: null,
    summary: null,
    error: null
  };

  try {
    const { driver } = session;
    await driver.manage().setTimeouts({ script: 300000, pageLoad: 300000, implicit: 0 });
    await driver.manage().window().setRect({ width: 1680, height: 1200, x: 24, y: 24 });

    await driver.get("about:blank");
    mainHandle = await driver.getWindowHandle();
    popupHandle = await openBrowserTab(driver, popupUrl);
    await pruneBrowserTabs(driver, [mainHandle, popupHandle]);
    setPopupRuntimeHandle(popupHandle);
    await ensurePopupReady(driver);
    await patchConfig(driver, {
      debug: {
        textElements: {
          highlightEnabled: true,
          inlineEditingEnabled: true,
          displayMode: "effective",
          autoScanMode: "incremental",
          autoBlankOnScan: true,
          deferredMutationRetryEnabled: true,
          deferredMutationRetryDelayMs: 180
        }
      }
    });

    await switchToHandle(driver, mainHandle);
    await navigate(driver, URL);
    const proof = await injectProof(driver);
    const pageKey = normalizePageKey(await driver.getCurrentUrl());

    report.initial = await captureStage(driver, {
      label: "00-initial",
      popupHandle,
      pageKey,
      proof,
      captureMap: false,
      probeFrom: null
    });
    await writeJson(REPORT, report);

    const scan = await runTerminalCommand(driver, "text.scan", 120000);
    assert.equal(scan.ok, true, `text.scan failed: ${scan.error ?? "unknown error"}`);
    await waitForMap(driver, popupHandle, pageKey, 3);
    report.afterScanMapSettle = await waitForMapBestEffort(driver, popupHandle, pageKey, 3);
    await waitForProofBlank(driver, proof, false);

    report.afterScan = await captureStage(driver, {
      label: "01-after-scan",
      popupHandle,
      pageKey,
      proof,
      captureMap: true,
      probeFrom: report.initial.proof
    });
    await writeJson(REPORT, report);

    assert.equal(report.afterScan.proof.heading.text, "", "Heading was not blanked.");
    assert.equal(report.afterScan.proof.paragraph.text, "", "Paragraph was not blanked.");
    assert.ok(report.afterScan.proof.heading.bindingId, "Heading lost binding id.");
    assert.ok(report.afterScan.proof.paragraph.bindingId, "Paragraph lost binding id.");
    assert.equal(report.afterScan.probes.heading?.opened, true, "Heading inline editor did not open at original coordinates.");
    assert.equal(report.afterScan.probes.paragraph?.opened, true, "Paragraph inline editor did not open at original coordinates.");
    assert.equal(report.afterScan.probes.heading?.stableAfterDraftDelay, true, "Heading inline editor closed immediately after draft input.");
    assert.equal(report.afterScan.probes.paragraph?.stableAfterDraftDelay, true, "Paragraph inline editor closed immediately after draft input.");

    await appendMutation(driver, proof);
    await waitForProofBlank(driver, proof, true);

    report.afterMutation = await captureStage(driver, {
      label: "02-after-mutation",
      popupHandle,
      pageKey,
      proof,
      captureMap: true,
      probeFrom: report.initial.proof
    });
    await writeJson(REPORT, report);

    assert.equal(report.afterMutation.proof.mutation?.text, "", "Mutation line was not blanked.");
    assert.ok(report.afterMutation.proof.mutation?.bindingId, "Mutation line lost binding id.");
    assert.equal(report.afterMutation.probes.mutation?.opened, true, "Mutation inline editor did not open.");
    assert.equal(report.afterMutation.probes.mutation?.stableAfterDraftDelay, true, "Mutation inline editor closed immediately after draft input.");

    await patchConfig(driver, {
      debug: {
        textElements: {
          autoBlankOnScan: false
        }
      }
    });
    await waitForMap(driver, popupHandle, pageKey, 3);
    report.afterDisableMapSettle = await waitForMapBestEffort(driver, popupHandle, pageKey, 3);
    await switchToHandle(driver, mainHandle);
    report.afterDisable = await captureStage(driver, {
      label: "03-after-disable",
      popupHandle,
      pageKey,
      proof,
      captureMap: true,
      probeFrom: report.initial.proof,
      captureProbes: false
    });
    await writeJson(REPORT, report);

    await waitForProofRestored(driver, proof, true);

    assert.equal(
      report.afterDisable.proof.heading.text,
      `LexTrace proof heading ${proof.token}`,
      "Heading did not restore after disabling autoBlankOnScan."
    );
    assert.equal(
      report.afterDisable.proof.paragraph.text,
      `LexTrace proof paragraph ${proof.token}`,
      "Paragraph did not restore after disabling autoBlankOnScan."
    );
    assert.equal(
      report.afterDisable.proof.mutation?.text,
      proof.mutationText,
      "Mutation line did not restore after disabling autoBlankOnScan."
    );

    await appendPostDisableMutation(driver, proof);
    await waitForProofVisible(driver, proof.postDisable, proof.postDisableText);
    await waitForMap(driver, popupHandle, pageKey, 4);

    report.afterDisableMutation = await captureStage(driver, {
      label: "04-after-disable-mutation",
      popupHandle,
      pageKey,
      proof,
      captureMap: true,
      probeFrom: report.afterDisable.proof
    });
    await writeJson(REPORT, report);

    assert.equal(
      report.afterDisableMutation.proof.postDisable?.text,
      proof.postDisableText,
      "New text node stayed blank after disabling autoBlankOnScan."
    );
    assert.ok(
      report.afterDisableMutation.proof.postDisable?.bindingId,
      "New text node was not picked up by incremental scan after disabling autoBlankOnScan."
    );

    report.summary = {
      pageKey,
      bindingCountAfterScan: report.afterScan.pageMap?.bindingCount ?? 0,
      blankedAfterScan: report.afterScan.pageMap?.blankedBindingCount ?? 0,
      bindingCountAfterMutation: report.afterMutation.pageMap?.bindingCount ?? 0,
      blankedAfterMutation: report.afterMutation.pageMap?.blankedBindingCount ?? 0,
      bindingCountAfterDisable: report.afterDisable.pageMap?.bindingCount ?? 0,
      blankedAfterDisable: report.afterDisable.pageMap?.blankedBindingCount ?? 0,
      bindingCountAfterDisableMutation: report.afterDisableMutation.pageMap?.bindingCount ?? 0,
      blankedAfterDisableMutation: report.afterDisableMutation.pageMap?.blankedBindingCount ?? 0,
      highlightCountAfterScan: report.afterScan.highlight.count,
      highlightCountAfterMutation: report.afterMutation.highlight.count,
      highlightCountAfterDisable: report.afterDisable.highlight.count,
      highlightCountAfterDisableMutation: report.afterDisableMutation.highlight.count,
      decoratedAfterScan: report.afterScan.presentation.bindingAttrCount,
      decoratedAfterMutation: report.afterMutation.presentation.bindingAttrCount,
      decoratedAfterDisable: report.afterDisable.presentation.bindingAttrCount,
      decoratedAfterDisableMutation: report.afterDisableMutation.presentation.bindingAttrCount,
      collapsedDecoratedAfterScan: report.afterScan.presentation.collapsedDecoratedCount,
      collapsedDecoratedAfterMutation: report.afterMutation.presentation.collapsedDecoratedCount,
      collapsedDecoratedAfterDisable: report.afterDisable.presentation.collapsedDecoratedCount,
      collapsedDecoratedAfterDisableMutation: report.afterDisableMutation.presentation.collapsedDecoratedCount
    };
    await writeJson(REPORT, report);
    console.log(`YouTube autoBlank short proof saved to ${REPORT}`);
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    try { await saveShot(session.driver, path.join(OUT, "99-error.png")); } catch {}
    try { await saveHtml(session.driver, path.join(OUT, "99-error.html")); } catch {}
    await writeJson(REPORT, report);
    throw error;
  } finally {
    setPopupRuntimeHandle(null);
    await session.driver.quit().catch(() => {});
    if (session.userDataDir) {
      await fs.rm(session.userDataDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

async function captureStage(driver, { label, popupHandle, pageKey, proof, captureMap, probeFrom, captureProbes = true }) {
  await dismissYouTubeInterference(driver);
  const stage = {
    currentUrl: await driver.getCurrentUrl(),
    proof: await readProof(driver, proof),
    presentation: await readPresentation(driver),
    highlight: await readHighlight(driver),
    runtimeLogsPath: path.join(OUT, `${label}-runtime-logs.json`),
    pageHtmlPath: path.join(OUT, `${label}.html`),
    screenshotPath: path.join(OUT, `${label}.png`),
    pageMapPath: captureMap ? path.join(OUT, `${label}-text-map.json`) : null,
    probes: {}
  };
  await saveShot(driver, stage.screenshotPath);
  await saveHtml(driver, stage.pageHtmlPath);
  await writeJson(stage.runtimeLogsPath, await readLogs(driver, 120));
  if (captureMap) {
    const pageMap = await readStoredMap(driver, popupHandle, pageKey);
    stage.pageMap = {
      bindingCount: pageMap?.bindings?.length ?? 0,
      blankedBindingCount: (pageMap?.bindings ?? []).filter(
        (binding) => binding.presence === "live" && binding.replacementText === ""
      ).length
    };
    await writeJson(stage.pageMapPath, pageMap);
  }
  if (captureProbes && probeFrom && (probeFrom.heading?.rect || stage.proof.heading?.bindingId)) {
    stage.probes.heading = await probeEditor(driver, {
      bindingId: stage.proof.heading?.bindingId ?? probeFrom?.heading?.bindingId ?? null,
      rect: stage.proof.heading?.rect ?? probeFrom?.heading?.rect ?? null,
      selector: proof.heading
    });
  }
  if (captureProbes && probeFrom && (probeFrom.paragraph?.rect || stage.proof.paragraph?.bindingId)) {
    stage.probes.paragraph = await probeEditor(driver, {
      bindingId: stage.proof.paragraph?.bindingId ?? probeFrom?.paragraph?.bindingId ?? null,
      rect: stage.proof.paragraph?.rect ?? probeFrom?.paragraph?.rect ?? null,
      selector: proof.paragraph
    });
  }
  if (captureProbes && (stage.proof.mutation?.rect || stage.proof.mutation?.bindingId)) {
    stage.probes.mutation = await probeEditor(driver, {
      bindingId: stage.proof.mutation?.bindingId ?? null,
      rect: stage.proof.mutation?.rect ?? null,
      selector: proof.mutation
    });
  }
  return stage;
}

async function navigate(driver, url) {
  try { await driver.get(url); } catch {}
  await waitFor(async () => {
    const state = await driver.executeScript(`
      return {
        href: location.href,
        readyState: document.readyState,
        hasBody: document.body instanceof HTMLBodyElement,
        bodyTextLength: document.body?.innerText?.length ?? 0,
        height: document.documentElement.scrollHeight
      };
    `);
    return state.href !== "about:blank" && state.readyState !== "loading" && state.hasBody === true && state.bodyTextLength > 0;
  }, 90000, `Page ${url} did not become ready.`);
  await dismissYouTubeInterference(driver);
  await delay(5000);
  let last = "";
  let stableSince = 0;
  try {
    await waitFor(async () => {
      const state = await driver.executeScript(`
        return [
          location.href,
          document.title,
          document.readyState,
          document.body?.innerText?.length ?? 0,
          document.documentElement.scrollHeight
        ].join("::");
      `);
      const now = Date.now();
      if (state !== last) {
        last = state;
        stableSince = now;
        return false;
      }
      return now - stableSince >= 1400;
    }, 12000, `Page ${url} did not settle.`);
  } catch {
    await delay(1500);
  }
}

async function runTerminalCommand(driver, command, timeoutMs) {
  await ensureOverlayOpen(driver);
  const before = (await readOverlayEntries(driver)).length;
  const startedAt = new Date().toISOString();
  await driver.executeScript(`
    const root = document.querySelector('#lextrace-overlay-root')?.shadowRoot;
    root?.querySelector(".overlay-tab-button[data-tab='console']")?.click();
    const input = root?.querySelector('[data-role="terminal-input"]');
    const form = root?.querySelector('[data-role="terminal-form"]');
    if (!(input instanceof HTMLInputElement) || !(form instanceof HTMLFormElement)) {
      throw new Error('Overlay terminal unavailable.');
    }
    input.focus();
    input.value = arguments[0];
    input.dispatchEvent(new Event('input', { bubbles: true }));
    form.requestSubmit();
  `, command);
  let completion = null;
  await waitFor(async () => {
    const entries = await readOverlayEntries(driver);
    const last = entries.at(-1);
    if (entries.length >= before + 2 && last && last.kind !== "command") return true;
    completion = await findOverlayCommandLog(driver, startedAt, command);
    return Boolean(completion);
  }, timeoutMs, `Command ${command} did not finish.`);
  const entries = await readOverlayEntries(driver);
  const last = entries.at(-1) ?? null;
  await hideOverlay(driver);
  if (last && last.kind !== "command") {
    return { ok: last.kind !== "error", error: last.kind === "error" ? last.text : null };
  }
  return {
    ok: completion?.event === "overlay.command",
    error:
      completion?.event === "overlay.command.failed"
        ? completion?.details?.message ?? completion?.summary ?? "Unknown overlay command failure."
        : null
  };
}

async function ensureOverlayOpen(driver) {
  const prev = await driver.getWindowHandle();
  const url = await driver.getCurrentUrl();
  const tabId = await waitForTabIdByUrl(driver, url);
  await sendCommand(driver, "overlay.open", { tabId, expectedUrl: url });
  await switchToHandle(driver, prev);
  await waitFor(async () => {
    const visible = await driver.executeScript(`
      const host = document.querySelector('#lextrace-overlay-root');
      return host instanceof HTMLElement && getComputedStyle(host).display !== 'none';
    `);
    return visible === true;
  }, 15000, "Overlay did not become visible.");
}

async function hideOverlay(driver) {
  await driver.executeScript(`
    document.querySelector('#lextrace-overlay-root')?.shadowRoot?.querySelector('[data-close="true"]')?.click();
  `);
  await waitFor(async () => {
    const hidden = await driver.executeScript(`
      const host = document.querySelector('#lextrace-overlay-root');
      return !(host instanceof HTMLElement) || getComputedStyle(host).display === 'none';
    `);
    return hidden === true;
  }, 10000, "Overlay did not hide.");
}

async function readOverlayEntries(driver) {
  return driver.executeScript(`
    const root = document.querySelector('#lextrace-overlay-root')?.shadowRoot;
    return [...(root?.querySelectorAll('.activity-entry.activity-terminal') ?? [])]
      .map((entry) => {
        const kindClass = [...entry.classList].find((value) => value.startsWith('terminal-')) ?? '';
        return {
          kind: kindClass.replace('terminal-', '') || 'system',
          text: entry.querySelector('.activity-body')?.textContent?.trim() ?? ''
        };
      })
      .filter((entry) => entry.text);
  `);
}

async function findOverlayCommandLog(driver, startedAt, command) {
  const logs = await readLogs(driver, 80);
  const startedAtMs = Date.parse(startedAt);
  return [...logs].reverse().find((entry) => {
    const ts = Date.parse(String(entry?.ts ?? ""));
    if (!Number.isFinite(ts) || ts < startedAtMs) return false;
    if (entry?.event === "overlay.command" || entry?.event === "overlay.command.failed") {
      return entry?.details?.raw === command;
    }
    return false;
  }) ?? null;
}

async function readLogs(driver, limit) {
  const prev = await driver.getWindowHandle();
  const result = await sendCommand(driver, "log.list", { limit });
  await switchToHandle(driver, prev);
  return Array.isArray(result?.logs) ? result.logs : [];
}

async function readStoredMap(driver, popupHandle, pageKey) {
  const prev = await driver.getWindowHandle();
  await switchToHandle(driver, popupHandle);
  const envelope = await driver.executeAsyncScript(`
    const done = arguments[arguments.length - 1];
    chrome.storage.local.get(['lextrace.page.textMaps'], (items) => done(items['lextrace.page.textMaps'] ?? null));
  `);
  await switchToHandle(driver, prev);
  const pages = envelope?.pages && typeof envelope.pages === "object" ? envelope.pages : {};
  if (pages[pageKey]) return pages[pageKey];
  return Object.values(pages).find((page) => {
    try { return normalizePageKey(page?.pageUrl ?? "") === pageKey; } catch { return false; }
  }) ?? null;
}

async function waitForMap(driver, popupHandle, pageKey, minBindings) {
  await waitFor(async () => (await readStoredMap(driver, popupHandle, pageKey))?.bindings?.length >= minBindings, 90000, "Stored map did not appear.");
}

async function waitForMapStable(driver, popupHandle, pageKey, minBindings) {
  let last = "";
  let stableSince = 0;
  await waitFor(async () => {
    const map = await readStoredMap(driver, popupHandle, pageKey);
    if ((map?.bindings?.length ?? 0) < minBindings) {
      last = "";
      stableSince = 0;
      return false;
    }
    const sig = [map.updatedAt ?? "", map.lastScanAt ?? "", map.bindings.length].join("::");
    const now = Date.now();
    if (sig !== last) {
      last = sig;
      stableSince = now;
      return false;
    }
    return now - stableSince >= 1000;
  }, 90000, "Stored map did not settle.");
}

async function waitForMapBestEffort(driver, popupHandle, pageKey, minBindings) {
  try {
    await waitForMapStable(driver, popupHandle, pageKey, minBindings);
    const map = await readStoredMap(driver, popupHandle, pageKey);
    return {
      status: "settled",
      bindingCount: map?.bindings?.length ?? 0,
      updatedAt: map?.updatedAt ?? null,
      lastScanAt: map?.lastScanAt ?? null
    };
  } catch (error) {
    await delay(1500);
    const map = await readStoredMap(driver, popupHandle, pageKey);
    return {
      status: "noisy",
      error: error instanceof Error ? error.message : String(error),
      bindingCount: map?.bindings?.length ?? 0,
      updatedAt: map?.updatedAt ?? null,
      lastScanAt: map?.lastScanAt ?? null
    };
  }
}

async function injectProof(driver) {
  const token = `youtube-short-${Date.now()}`;
  const proof = {
    token,
    host: `#${HOST_ID} [data-lextrace-proof-token="${token}"]`,
    heading: `#${HOST_ID} [data-lextrace-proof-token="${token}"] [data-lextrace-proof-role="heading"]`,
    paragraph: `#${HOST_ID} [data-lextrace-proof-token="${token}"] [data-lextrace-proof-role="paragraph"]`,
    mutation: `#${HOST_ID} [data-lextrace-proof-token="${token}"] [data-lextrace-proof-role="mutation"]`,
    mutationText: `LexTrace proof mutation ${token}`,
    postDisable: `#${HOST_ID} [data-lextrace-proof-token="${token}"] [data-lextrace-proof-role="post-disable"]`,
    postDisableText: `LexTrace proof post-disable ${token}`
  };
  await driver.executeScript(`
    const token = arguments[0];
    let host = document.getElementById(arguments[1]);
    if (!(host instanceof HTMLElement)) {
      host = document.createElement('div');
      host.id = arguments[1];
      (document.body ?? document.documentElement).prepend(host);
    }
    const block = document.createElement('section');
    block.setAttribute('data-lextrace-proof-token', token);
    Object.assign(block.style, {
      position: 'relative',
      zIndex: '2147483000',
      margin: '16px',
      padding: '18px',
      border: '2px dashed #d97706',
      background: '#fff7d6',
      color: '#111111',
      font: '16px/1.45 Segoe UI, Arial, sans-serif',
      boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
      maxWidth: '720px'
    });
    const heading = document.createElement('h2');
    heading.setAttribute('data-lextrace-proof-role', 'heading');
    heading.style.margin = '0 0 8px';
    heading.textContent = 'LexTrace proof heading ' + token;
    const paragraph = document.createElement('p');
    paragraph.setAttribute('data-lextrace-proof-role', 'paragraph');
    paragraph.style.margin = '0';
    paragraph.textContent = 'LexTrace proof paragraph ' + token;
    block.append(heading, paragraph);
    host.prepend(block);
  `, token, HOST_ID);
  return proof;
}

async function appendMutation(driver, proof) {
  await driver.executeScript(`
    const block = document.querySelector(arguments[0]);
    if (!(block instanceof HTMLElement)) throw new Error('Proof block unavailable.');
    let node = block.querySelector('[data-lextrace-proof-role="mutation"]');
    if (!(node instanceof HTMLElement)) {
      node = document.createElement('p');
      node.setAttribute('data-lextrace-proof-role', 'mutation');
      node.style.margin = '8px 0 0';
      block.append(node);
    }
    node.textContent = arguments[1];
  `, proof.host, proof.mutationText);
}

async function appendPostDisableMutation(driver, proof) {
  await driver.executeScript(`
    const block = document.querySelector(arguments[0]);
    if (!(block instanceof HTMLElement)) throw new Error('Proof block unavailable.');
    let node = block.querySelector('[data-lextrace-proof-role="post-disable"]');
    if (!(node instanceof HTMLElement)) {
      node = document.createElement('p');
      node.setAttribute('data-lextrace-proof-role', 'post-disable');
      node.style.margin = '8px 0 0';
      block.append(node);
    }
    node.textContent = arguments[1];
  `, proof.host, proof.postDisableText);
}

async function readProof(driver, proof) {
  return driver.executeScript(`
    function read(selector) {
      const el = document.querySelector(selector);
      const rect = el instanceof HTMLElement ? el.getBoundingClientRect() : null;
      return {
        present: el instanceof HTMLElement,
        text: el instanceof HTMLElement ? (el.innerText ?? el.textContent ?? '').replace(/\\s+/g, ' ').trim() : null,
        bindingId: el instanceof HTMLElement ? el.getAttribute('data-lextrace-text-binding-id') : null,
        editable: el instanceof HTMLElement ? el.getAttribute('data-lextrace-text-editable') : null,
        rect: rect ? {
          left: Math.round(rect.left),
          top: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        } : null
      };
    }
    return { heading: read(arguments[0]), paragraph: read(arguments[1]), mutation: read(arguments[2]), postDisable: read(arguments[3]) };
  `, proof.heading, proof.paragraph, proof.mutation, proof.postDisable);
}

async function waitForProofBlank(driver, proof, includeMutation) {
  await waitFor(async () => {
    const state = await readProof(driver, proof);
    const required = includeMutation ? [state.heading, state.paragraph, state.mutation] : [state.heading, state.paragraph];
    return required.every((item) => item?.present && item?.bindingId && item?.text === "");
  }, 20000, `Proof block did not auto-blank. includeMutation=${includeMutation}`);
}

async function waitForProofRestored(driver, proof, includeMutation) {
  await waitFor(async () => {
    const state = await readProof(driver, proof);
    const required = includeMutation ? [state.heading, state.paragraph, state.mutation] : [state.heading, state.paragraph];
    return (
      required.every((item) => item?.present && item?.bindingId) &&
      state.heading?.text === `LexTrace proof heading ${proof.token}` &&
      state.paragraph?.text === `LexTrace proof paragraph ${proof.token}` &&
      (!includeMutation || state.mutation?.text === proof.mutationText)
    );
  }, 30000, `Proof block did not restore after disabling autoBlankOnScan. includeMutation=${includeMutation}`);
}

async function waitForProofVisible(driver, selector, expectedText) {
  await waitFor(async () => {
    const state = await driver.executeScript(`
      const el = document.querySelector(arguments[0]);
      return {
        present: el instanceof HTMLElement,
        text: el instanceof HTMLElement ? (el.innerText ?? el.textContent ?? '').replace(/\\s+/g, ' ').trim() : null,
        bindingId: el instanceof HTMLElement ? el.getAttribute('data-lextrace-text-binding-id') : null
      };
    `, selector);
    return state.present === true && state.bindingId && state.text === expectedText;
  }, 30000, `Visible proof node ${selector} did not appear with expected text.`);
}

async function readPresentation(driver) {
  return driver.executeScript(`
    function rectCount(el) {
      return el instanceof HTMLElement ? [...el.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0).length : 0;
    }
    const decorated = [...document.querySelectorAll('[data-lextrace-text-binding-id]')];
    return {
      bindingAttrCount: decorated.length,
      editableCount: document.querySelectorAll('[data-lextrace-text-editable="true"]').length,
      collapsedDecoratedCount: decorated.filter((el) => rectCount(el) === 0).length,
      overlayBoxCount: document.querySelectorAll('[data-lextrace-text-highlight-box="true"]').length
    };
  `);
}

async function readHighlight(driver) {
  return driver.executeScript(`
    const registry = typeof CSS !== 'undefined' && 'highlights' in CSS ? CSS.highlights : null;
    const nativeRangeCount =
      Number(registry?.get?.('lextrace-text-source')?.size ?? 0) +
      Number(registry?.get?.('lextrace-text-changed')?.size ?? 0);
    const overlayBoxCount = document.querySelectorAll('[data-lextrace-text-highlight-box="true"]').length;
    const elementHighlightCount = document.querySelectorAll('[data-lextrace-text-binding-id][data-lextrace-text-debug]').length;
    return { count: overlayBoxCount + nativeRangeCount + elementHighlightCount, overlayBoxCount, nativeRangeCount, elementHighlightCount };
  `);
}

async function resolveProbeRect(driver, bindingId, fallbackRect, selector = null) {
  return driver.executeScript(`
    const bindingId = arguments[0];
    const fallbackRect = arguments[1];
    const selector = arguments[2];
    const readRect = (element) => {
      if (!(element instanceof HTMLElement)) return null;
      const rect = element.getBoundingClientRect();
      if (!(rect.width > 0 && rect.height > 0)) return null;
      return {
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      };
    };
    const highlightRect =
      typeof bindingId === 'string' && bindingId.length > 0
        ? readRect(document.querySelector('[data-lextrace-text-highlight-box="true"][data-lextrace-text-binding-id="' + CSS.escape(bindingId) + '"]'))
        : null;
    if (highlightRect) {
      return highlightRect;
    }
    const decoratedRect =
      typeof bindingId === 'string' && bindingId.length > 0
        ? readRect(document.querySelector('[data-lextrace-text-binding-id="' + CSS.escape(bindingId) + '"]'))
        : null;
    if (decoratedRect) {
      return decoratedRect;
    }
    const selectorRect =
      typeof selector === 'string' && selector.length > 0
        ? readRect(document.querySelector(selector))
        : null;
    if (selectorRect) {
      return selectorRect;
    }
    if (fallbackRect && fallbackRect.width > 0 && fallbackRect.height > 0) {
      return fallbackRect;
    }
    return fallbackRect ?? null;
  `, bindingId, fallbackRect, selector);
}

async function probeEditor(driver, probe) {
  const resolvedRect = await resolveProbeRect(driver, probe.bindingId ?? null, probe.rect ?? null, probe.selector ?? null);
  if (!resolvedRect) {
    return {
      clientX: null,
      clientY: null,
      draftText: null,
      stableAfterDraftDelay: false,
      opened: false,
      mode: null,
      tagName: null
    };
  }
  const clientX = Math.max(0, Math.floor(resolvedRect.left + Math.max(1, resolvedRect.width) / 2));
  const clientY = Math.max(0, Math.floor(resolvedRect.top + Math.max(1, resolvedRect.height) / 2));
  const draftText = `draft-${Date.now()}`;
  try {
    await driver.actions({ async: true })
      .move({ x: clientX, y: clientY, origin: Origin.VIEWPORT, duration: 80 })
      .press(Button.RIGHT)
      .release(Button.RIGHT)
      .perform();
  } catch {
    await driver.executeScript(`
      const bindingId = arguments[2];
      const selector = arguments[3];
      const bindingTarget =
        typeof bindingId === 'string' && bindingId.length > 0
          ? document.querySelector('[data-lextrace-text-binding-id="' + CSS.escape(bindingId) + '"]')
          : null;
      const selectorTarget =
        typeof selector === 'string' && selector.length > 0
          ? document.querySelector(selector)
          : null;
      const target = bindingTarget ?? selectorTarget;
      (target ?? (document.body ?? document.documentElement)).dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        button: 2,
        buttons: 2,
        clientX: arguments[0],
        clientY: arguments[1],
        view: window
      }));
    `, clientX, clientY, probe.bindingId ?? null, probe.selector ?? null);
  }
  let state = null;
  try {
    await waitFor(async () => {
      const open = await driver.executeScript(`return document.querySelector('.lextrace-inline-text-editor') instanceof HTMLElement;`);
      return open === true;
    }, 5000, `Inline editor did not open at (${clientX}, ${clientY}).`);
  } catch (error) {
    const diagnostics = await driver.executeScript(`
      const bindingId = arguments[0];
      const selector = arguments[3];
      const bindingTarget =
        typeof bindingId === 'string' && bindingId.length > 0
          ? document.querySelector('[data-lextrace-text-binding-id="' + CSS.escape(bindingId) + '"]')
          : null;
      const selectorTarget =
        typeof selector === 'string' && selector.length > 0
          ? document.querySelector(selector)
          : null;
      const target = bindingTarget ?? selectorTarget;
      const event = new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        button: 2,
        buttons: 2,
        clientX: arguments[1],
        clientY: arguments[2],
        view: window
      });
      const dispatchResult = target instanceof HTMLElement ? target.dispatchEvent(event) : null;
      const editor = document.querySelector('.lextrace-inline-text-editor');
      return {
        bindingId,
        targetTag: target instanceof HTMLElement ? target.tagName.toLowerCase() : null,
        targetEditable: target instanceof HTMLElement ? target.getAttribute('data-lextrace-text-editable') : null,
        targetDebug: target instanceof HTMLElement ? target.getAttribute('data-lextrace-text-debug') : null,
        targetText: target instanceof HTMLElement ? (target.innerText ?? target.textContent ?? '') : null,
        childNodes: target instanceof HTMLElement ? target.childNodes.length : null,
        firstChildType: target?.firstChild?.nodeType ?? null,
        firstChildText: target?.firstChild?.textContent ?? null,
        dispatchResult,
        defaultPrevented: event.defaultPrevented,
        hasEditor: editor instanceof HTMLElement,
        editorTag: editor instanceof HTMLElement ? editor.tagName.toLowerCase() : null,
        editorMode: editor instanceof HTMLElement ? editor.getAttribute('data-lextrace-inline-mode') ?? 'overlay' : null,
        activeTag: document.activeElement?.tagName?.toLowerCase() ?? null
      };
    `, probe.bindingId ?? null, clientX, clientY, probe.selector ?? null);
    if (!diagnostics?.hasEditor) {
      throw new Error(`${error instanceof Error ? error.message : String(error)} diagnostics=${JSON.stringify(diagnostics)}`);
    }
    state = {
      opened: true,
      mode: diagnostics.editorMode ?? null,
      tagName: diagnostics.editorTag ?? diagnostics.activeTag ?? null
    };
  }
  if (!state) {
    state = await driver.executeScript(`
      const editor = document.querySelector('.lextrace-inline-text-editor');
      return {
        opened: editor instanceof HTMLElement,
        mode: editor instanceof HTMLElement ? editor.getAttribute('data-lextrace-inline-mode') ?? 'overlay' : null,
        tagName: editor instanceof HTMLElement ? editor.tagName.toLowerCase() : null
      };
    `);
  }
  await driver.executeScript(`
    const editor = document.querySelector('.lextrace-inline-text-editor');
    if (editor instanceof HTMLTextAreaElement) {
      editor.value = arguments[0];
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    if (editor instanceof HTMLElement) {
      editor.textContent = arguments[0];
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      selection?.removeAllRanges();
      selection?.addRange(range);
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, data: arguments[0], inputType: 'insertText' }));
    }
  `, draftText);
  await delay(700);
  const draftState = await driver.executeScript(`
    const editor = document.querySelector('.lextrace-inline-text-editor');
    return {
      present: editor instanceof HTMLElement,
      text:
        editor instanceof HTMLTextAreaElement
          ? editor.value
          : editor instanceof HTMLElement
            ? (editor.textContent ?? '')
            : null
    };
  `);
  await driver.executeScript(`
    const editor = document.querySelector('.lextrace-inline-text-editor');
    if (editor instanceof HTMLElement) {
      editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      editor.blur();
    }
  `);
  await waitFor(async () => {
    const open = await driver.executeScript(`return document.querySelector('.lextrace-inline-text-editor') instanceof HTMLElement;`);
    return open === false;
  }, 5000, "Inline editor did not close.");
  return {
    clientX,
    clientY,
    draftText,
    stableAfterDraftDelay: draftState.present === true && draftState.text === draftText,
    ...state
  };
}

async function dismissYouTubeInterference(driver) {
  await driver.actions().sendKeys("\uE00C").perform().catch(() => {});
  await delay(250);
  await driver.executeScript(`
    const labels = ['reject all', 'accept all', 'i agree', 'not now', 'no thanks', 'dismiss', 'close', 'skip', 'continue without signing in', 'stay signed out'];
    const visible = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || '1') > 0;
    };
    const text = (el) => (el.innerText ?? el.textContent ?? el.getAttribute('aria-label') ?? el.getAttribute('title') ?? '').replace(/\\s+/g, ' ').trim().toLowerCase();
    for (const el of document.querySelectorAll('button,[role="button"],tp-yt-paper-button,yt-button-shape button,form[action*="consent"] button')) {
      if (!(el instanceof HTMLElement) || !visible(el)) continue;
      const label = text(el);
      if (labels.some((candidate) => label.includes(candidate))) el.click();
    }
  `);
  await delay(500);
}

async function saveHtml(driver, filePath) {
  const html = await driver.getPageSource().catch(() => driver.executeScript(`return document.documentElement.outerHTML;`));
  await fs.writeFile(filePath, html, "utf8");
}

async function saveShot(driver, filePath) {
  await fs.writeFile(filePath, await driver.takeScreenshot(), "base64");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
