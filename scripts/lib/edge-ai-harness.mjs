import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { Builder, Browser } from "selenium-webdriver";
import edge from "selenium-webdriver/edge.js";

import {
  ensureExtensionKeyMetadata,
  fileExists,
  getNativeHostExePath,
  paths,
  run
} from "./common.mjs";

export const COMMANDS = {
  overlayOpen: "overlay.open",
  configGet: "config.get",
  configPatch: "config.patch",
  configReset: "config.reset",
  aiModelsCatalog: "ai.models.catalog",
  aiChatStatus: "ai.chat.status",
  aiChatSend: "ai.chat.send",
  aiChatResume: "ai.chat.resume",
  aiChatReset: "ai.chat.reset",
  aiChatList: "ai.chat.list"
};

export const OPENAI_API_KEY_ENV_VAR_NAME = "OPENAI_API_KEY";
export const TEMP_MANAGED_API_KEY = "sk-test-edge-managed-key";
export const INVALID_MANAGED_API_KEY = "sk-test-edge-invalid-key";
export const AI_UI_PATHS = [
  "ai.openAiApiKey",
  "ai.allowedModels",
  "ai.chat.model",
  "ai.chat.streamingEnabled",
  "ai.chat.instructions",
  "ai.chat.structuredOutput.name",
  "ai.chat.structuredOutput.description",
  "ai.chat.structuredOutput.schema",
  "ai.chat.structuredOutput.strict",
  "ai.compaction.enabled",
  "ai.compaction.streamingEnabled",
  "ai.compaction.modelOverride",
  "ai.compaction.instructions",
  "ai.compaction.triggerPromptTokens",
  "ai.compaction.preserveRecentTurns",
  "ai.compaction.maxPassesPerPage",
  "ai.promptCaching.routing",
  "ai.promptCaching.retention",
  "ai.retries.maxRetries",
  "ai.retries.baseDelayMs",
  "ai.retries.maxDelayMs",
  "ai.queueRetries.maxRetries",
  "ai.queueRetries.baseDelayMs",
  "ai.queueRetries.maxDelayMs",
  "ai.rateLimits.reserveOutputTokens",
  "ai.rateLimits.maxQueuedPerPage",
  "ai.rateLimits.maxQueuedGlobal"
];

export const BASE_CHAT_INSTRUCTIONS = "Reply tersely and follow the requested token exactly.";
export const BASE_COMPACTION_INSTRUCTIONS = "Compress prior completed turns into the smallest faithful reusable context.";
export const STRUCTURED_NAME = "edge_structured_reply";
export const STRUCTURED_DESCRIPTION = "Return a compact JSON object with token and variant.";
export const STRUCTURED_SCHEMA = JSON.stringify(
  {
    type: "object",
    properties: {
      token: { type: "string" },
      variant: { type: "string" }
    },
    required: ["token", "variant"],
    additionalProperties: false
  },
  null,
  2
);

let popupRuntimeHandle = null;

export class SkipCaseError extends Error {
  constructor(reason, details) {
    super(reason);
    this.name = "SkipCaseError";
    this.reason = reason;
    this.details = details;
  }
}

export function skipCase(reason, details) {
  throw new SkipCaseError(reason, details);
}

export function setPopupRuntimeHandle(handle) {
  popupRuntimeHandle = handle;
}

export async function prepareEdgeAiArtifacts({ runPreflight = false, reuseArtifacts = false } = {}) {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const nodeCommand = process.execPath;
  await fs.rm(getNativeHostStatePath(), { force: true });

  if (!reuseArtifacts) {
    if (runPreflight) {
      await runNpmScript(npmCommand, "typecheck");
      await runNpmScript(npmCommand, "test:unit");
      await runNpmScript(npmCommand, "build");
      await runNpmScript(npmCommand, "pack");
      await runNpmScript(npmCommand, "register:native-host");
    } else {
      await run(nodeCommand, ["scripts/build-extension.mjs"]);
      await run(nodeCommand, ["scripts/build-native-host.mjs"]);
      await run(nodeCommand, ["scripts/pack-extension.mjs"]);
      await run(nodeCommand, ["scripts/register-native-host.mjs"]);
    }
  }

  assert.equal(await fileExists(paths.packagedCrx), true, "Packed CRX is missing.");
  assert.equal(await fileExists(getNativeHostExePath()), true, "Native host executable is missing.");
}

async function runNpmScript(npmCommand, scriptName) {
  if (process.platform === "win32") {
    const shell = process.env.ComSpec ?? "cmd.exe";
    await run(shell, ["/d", "/s", "/c", `${npmCommand} run ${scriptName}`]);
    return;
  }

  await run(npmCommand, ["run", scriptName]);
}

export async function startAiHarnessSession({ prepareArtifacts = false, runPreflight = false } = {}) {
  if (prepareArtifacts) {
    await prepareEdgeAiArtifacts({ runPreflight });
  }

  const extensionMetadata = await ensureExtensionKeyMetadata();
  const extensionBaseUrl = `chrome-extension://${extensionMetadata.extensionId}`;
  const popupUrl = `${extensionBaseUrl}/popup.html`;
  const server = await startLocalServer();
  const { driver, userDataDir } = await launchEdgeWithExtension();

  await driver.manage().setTimeouts({
    script: 120000,
    pageLoad: 120000,
    implicit: 0
  });

  await driver.get(server.makeUrl("/overlay-user"));
  const mainHandle = await driver.getWindowHandle();
  const popupHandle = await openBrowserTab(driver, popupUrl);
  setPopupRuntimeHandle(popupHandle);
  await ensurePopupReady(driver);

  return {
    driver,
    server,
    userDataDir,
    popupHandle,
    mainHandle,
    popupUrl,
    extensionId: extensionMetadata.extensionId
  };
}

export async function closeAiHarnessSession(session) {
  if (!session) {
    return;
  }

  setPopupRuntimeHandle(null);

  if (session.driver) {
    await session.driver.quit().catch(() => {});
  }

  if (session.server) {
    await session.server.close().catch(() => {});
  }

  if (session.userDataDir) {
    await fs.rm(session.userDataDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function launchEdgeWithExtension(options = {}) {
  await fs.mkdir(paths.tmp, { recursive: true });
  const userDataDir = await fs.mkdtemp(path.join(paths.tmp, "edge-user-data-"));
  const edgeOptions = createEdgeOptions(userDataDir, options);
  edgeOptions.addExtensions(paths.packagedCrx);

  const driver = await new Builder()
    .forBrowser(Browser.EDGE)
    .setEdgeOptions(edgeOptions)
    .build();

  return {
    driver,
    userDataDir
  };
}

export function createEdgeOptions(userDataDir, settings = {}) {
  const options = new edge.Options();
  options.addArguments(
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-search-engine-choice-screen",
    "--disable-features=msEdgeAccountConsistency"
  );
  if (settings?.userPreferences && typeof settings.userPreferences === "object") {
    options.setUserPreferences(settings.userPreferences);
  }
  return options;
}

export async function openBrowserTab(driver, url) {
  await driver.switchTo().newWindow("tab");
  const handle = await driver.getWindowHandle();
  await driver.get(url);
  return handle;
}

export async function switchToHandle(driver, handle) {
  await driver.switchTo().window(handle);
}

export async function pruneBrowserTabs(driver, keepHandles = []) {
  const keepSet = new Set(keepHandles.filter((handle) => typeof handle === "string" && handle.length > 0));
  const handles = await driver.getAllWindowHandles();

  for (const handle of handles) {
    if (keepSet.has(handle)) {
      continue;
    }

    try {
      await driver.switchTo().window(handle);
      await driver.close();
    } catch {
      // Best-effort cleanup for stray Edge tabs.
    }
  }

  const preferredHandle = keepHandles.find((handle) => keepSet.has(handle));
  if (preferredHandle) {
    await switchToHandle(driver, preferredHandle).catch(() => {});
  }
}

export async function ensurePopupContext(driver) {
  if (popupRuntimeHandle) {
    await switchToHandle(driver, popupRuntimeHandle);
  }
}

export async function ensurePopupReady(driver) {
  await ensurePopupContext(driver);
  await waitFor(async () => {
    const state = await driver.executeScript(`
      return {
        readyState: document.readyState,
        badge: document.querySelector('#status-badge')?.textContent ?? null,
        configTab: !!document.querySelector(".tab-button[data-tab='config']")
      };
    `);
    return state.readyState === "complete" && state.badge !== null && state.configTab === true;
  }, 20000, "Popup did not finish loading.");
}

export async function openConfigTab(driver) {
  await ensurePopupContext(driver);
  await driver.executeScript(`
    document.querySelector(".tab-button[data-tab='config']")?.click();
  `);
  await waitFor(async () => {
    const activeTab = await driver.executeScript(`
      return document.querySelector('.tab-button.is-active')?.getAttribute('data-tab') ?? null;
    `);
    return activeTab === "config";
  }, 10000, "Popup did not switch to the config tab.");
}

export async function getPopupAiConfigPaths(driver) {
  await ensurePopupContext(driver);
  const actualPaths = await driver.executeScript(`
    return [...document.querySelectorAll("button[data-config-path^='ai.']")]
      .map((button) => button.getAttribute('data-config-path'))
      .filter((value) => typeof value === 'string')
      .sort();
  `);
  return Array.isArray(actualPaths) ? actualPaths : [];
}

export async function readButtonText(driver, configPath) {
  await ensurePopupContext(driver);
  return driver.executeScript(
    `
      return document.querySelector("button[data-config-path='" + arguments[0] + "']")?.textContent?.trim() ?? "";
    `,
    configPath
  );
}

export async function readPopupControlState(driver) {
  await ensurePopupContext(driver);
  const state = await driver.executeScript(`
    const element = document.querySelector('#terminal-state');
    return {
      text: element?.textContent?.trim() ?? '',
      tone: element?.getAttribute('data-state') ?? ''
    };
  `);
  return {
    text: typeof state?.text === "string" ? state.text : "",
    tone: typeof state?.tone === "string" ? state.tone : ""
  };
}

export async function setSelectValue(driver, configPath, value) {
  await ensurePopupContext(driver);
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
    configPath,
    value
  );
  await delay(300);
}

export async function setInlineValue(driver, configPath, value) {
  await ensurePopupContext(driver);
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
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      input.blur();
    `,
    configPath,
    value
  );
  await delay(300);
}

export async function setModalTextValue(driver, configPath, value) {
  await ensurePopupContext(driver);
  await driver.executeScript(
    `
      const button = document.querySelector("button[data-config-path='" + arguments[0] + "']");
      if (!(button instanceof HTMLButtonElement)) {
        throw new Error("Config button is unavailable for " + arguments[0]);
      }
      button.click();
    `,
    configPath
  );
  await waitFor(async () => {
    const ready = await driver.executeScript(`
      return document.querySelector('.popup-modal-textarea') instanceof HTMLTextAreaElement &&
        document.querySelector('.popup-modal-button.is-primary') instanceof HTMLButtonElement;
    `);
    return ready === true;
  }, 10000, `Modal editor did not open for ${configPath}.`);

  await driver.executeScript(
    `
      const textarea = document.querySelector('.popup-modal-textarea');
      if (!(textarea instanceof HTMLTextAreaElement)) {
        throw new Error("Modal textarea is unavailable for " + arguments[0]);
      }
      textarea.value = arguments[1];
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      const saveButton = document.querySelector('.popup-modal-button.is-primary');
      if (!(saveButton instanceof HTMLButtonElement)) {
        throw new Error("Modal save button is unavailable for " + arguments[0]);
      }
      saveButton.click();
    `,
    configPath,
    value
  );
  await delay(500);
}

export async function openConfigPanel(driver, configPath) {
  await ensurePopupContext(driver);
  await driver.executeScript(
    `
      const button = document.querySelector("button[data-config-path='" + arguments[0] + "']");
      if (!(button instanceof HTMLButtonElement)) {
        throw new Error("Config button is unavailable for " + arguments[0]);
      }
      button.click();
    `,
    configPath
  );
  await waitFor(async () => {
    const visible = await driver.executeScript(`
      return document.querySelector('#popup-modal-root') instanceof HTMLElement &&
        document.querySelector('#popup-modal-root')?.hidden === false;
    `);
    return visible === true;
  }, 10000, `Config panel did not open for ${configPath}.`);
}

export async function closePopupModal(driver) {
  await ensurePopupContext(driver);
  await driver.executeScript(`
    document.querySelector('.popup-modal-button')?.click();
  `);
  await waitFor(async () => {
    const hidden = await driver.executeScript(`
      const root = document.querySelector('#popup-modal-root');
      return !(root instanceof HTMLElement) || root.hidden === true;
    `);
    return hidden === true;
  }, 10000, "Popup modal did not close.");
}

export async function readOpenModelPanelMessages(driver) {
  await ensurePopupContext(driver);
  const messages = await driver.executeScript(`
    return [...document.querySelectorAll('.popup-modal-root .json-model-empty')]
      .map((element) => element.textContent?.trim() ?? '')
      .filter((value) => value.length > 0);
  `);
  return Array.isArray(messages) ? messages : [];
}

export async function setAllowedModel(driver, modelId, tier) {
  await ensurePopupContext(driver);
  await waitFor(async () => {
    return driver.executeScript(
      `
        const tierAliases = {
          standard: ['standard', 'стандарт'],
          flex: ['flex'],
          priority: ['priority', 'приоритет']
        };
        const expectedTitles = tierAliases[String(arguments[1] ?? '').toLowerCase()] ?? [String(arguments[1] ?? '').toLowerCase()];
        const button = document.querySelector("button[data-config-path='ai.allowedModels']");
        const panel = document.querySelector('.popup-modal-root .json-model-panel');
        if (!(panel instanceof HTMLElement)) {
          button?.click();
        }
        const sections = [...document.querySelectorAll('.popup-modal-root .json-model-section')];
        const section = sections.find((element) => expectedTitles.includes((element.querySelector('.json-model-section-title')?.textContent?.trim() ?? '').toLowerCase()));
        return [...(section?.querySelectorAll('.json-model-option') ?? [])].some(
          (element) => element.querySelector('.json-model-name')?.textContent?.trim() === arguments[0]
        );
      `,
      modelId,
      tier
    );
  }, 30000, `Allowed model checkbox ${tier}/${modelId} did not load.`);

  await driver.executeScript(
    `
      const tierAliases = {
        standard: ['standard', 'стандарт'],
        flex: ['flex'],
        priority: ['priority', 'приоритет']
      };
      const expectedTitles = tierAliases[String(arguments[1] ?? '').toLowerCase()] ?? [String(arguments[1] ?? '').toLowerCase()];
      const sections = [...document.querySelectorAll('.popup-modal-root .json-model-section')];
      const section = sections.find((element) => expectedTitles.includes((element.querySelector('.json-model-section-title')?.textContent?.trim() ?? '').toLowerCase()));
      const option = [...(section?.querySelectorAll('.json-model-option') ?? [])].find(
        (element) => element.querySelector('.json-model-name')?.textContent?.trim() === arguments[0]
      );
      const checkbox = option?.querySelector('.json-model-checkbox');
      if (!(checkbox instanceof HTMLInputElement)) {
        throw new Error("Allowed model checkbox is unavailable for " + arguments[1] + "/" + arguments[0]);
      }
      if (!checkbox.checked) {
        checkbox.click();
      }
    `,
    modelId,
    tier
  );
  await driver.executeScript(`
    document.querySelector("button[data-config-path='ai.allowedModels']")?.click();
  `);
  await delay(500);
}

export async function setModelPanelValue(driver, configPath, modelId, tier) {
  await ensurePopupContext(driver);
  await waitFor(async () => {
    return driver.executeScript(
      `
        const tierAliases = {
          standard: ['standard', 'стандарт'],
          flex: ['flex'],
          priority: ['priority', 'приоритет']
        };
        const expectedTitles = tierAliases[String(arguments[2] ?? '').toLowerCase()] ?? [String(arguments[2] ?? '').toLowerCase()];
        const button = document.querySelector("button[data-config-path='" + arguments[0] + "']");
        let panel = document.querySelector('.popup-modal-root .json-model-panel.is-single-select');
        if (!(panel instanceof HTMLElement)) {
          button?.click();
          panel = document.querySelector('.popup-modal-root .json-model-panel.is-single-select');
        }
        const sections = [...(panel?.querySelectorAll('.json-model-section') ?? [])];
        const section = sections.find((element) => expectedTitles.includes((element.querySelector('.json-model-section-title')?.textContent?.trim() ?? '').toLowerCase()));
        return [...(section?.querySelectorAll('.json-model-option.is-single-select') ?? [])].some(
          (element) => element.querySelector('.json-model-name')?.textContent?.trim() === arguments[1]
        );
      `,
      configPath,
      modelId,
      tier
    );
  }, 30000, `Model option ${tier}/${modelId} did not load for ${configPath}.`);

  await driver.executeScript(
    `
      const tierAliases = {
        standard: ['standard', 'стандарт'],
        flex: ['flex'],
        priority: ['priority', 'приоритет']
      };
      const expectedTitles = tierAliases[String(arguments[2] ?? '').toLowerCase()] ?? [String(arguments[2] ?? '').toLowerCase()];
      const panel = document.querySelector('.popup-modal-root .json-model-panel.is-single-select');
      if (!(panel instanceof HTMLElement)) {
        throw new Error("Model panel is unavailable for " + arguments[0]);
      }
      const sections = [...panel.querySelectorAll('.json-model-section')];
      const section = sections.find((element) => expectedTitles.includes((element.querySelector('.json-model-section-title')?.textContent?.trim() ?? '').toLowerCase()));
      const option = [...(section?.querySelectorAll('.json-model-option.is-single-select') ?? [])].find(
        (element) => element.querySelector('.json-model-name')?.textContent?.trim() === arguments[1]
      );
      if (!(option instanceof HTMLButtonElement)) {
        throw new Error("Model option is unavailable for " + arguments[2] + "/" + arguments[1] + " in " + arguments[0]);
      }
      option.click();
    `,
    configPath,
    modelId,
    tier
  );
  await delay(500);
}

export async function getRuntimeSnapshot(driver) {
  return sendCommand(driver, COMMANDS.configGet, {});
}

export async function patchConfig(driver, patch) {
  await patchConfigForScope(driver, "local", patch);
}

export async function patchConfigExpectingError(driver, patch) {
  return sendCommandExpectingError(driver, COMMANDS.configPatch, {
    scope: "local",
    patch
  });
}

export async function patchConfigForScope(driver, scope, patch) {
  await sendCommand(driver, COMMANDS.configPatch, {
    scope,
    patch
  });
  await delay(300);
}

export async function resetConfigScope(driver, scope) {
  await sendCommand(driver, COMMANDS.configReset, {
    scope
  });
  await delay(300);
}

export async function sendCommand(driver, action, payload) {
  const response = await sendRawCommand(driver, action, payload);
  if (!response?.ok) {
    const error = new Error(response?.error?.message ?? `${action} failed.`);
    Object.assign(error, {
      code: response?.error?.code ?? null,
      details: response?.error?.details ?? null
    });
    throw error;
  }
  return response.result;
}

export async function sendCommandExpectingError(driver, action, payload) {
  const response = await sendRawCommand(driver, action, payload);
  assert.equal(response?.ok, false, `${action} unexpectedly succeeded.`);
  return {
    code: response?.error?.code ?? "unknown",
    message: response?.error?.message ?? "Unknown error",
    details: response?.error?.details ?? null
  };
}

export async function sendRawCommand(driver, action, payload) {
  await ensurePopupContext(driver);
  return driver.executeAsyncScript(
    `
      const done = arguments[arguments.length - 1];
      chrome.runtime.sendMessage({
        id: crypto.randomUUID(),
        version: 1,
        scope: 'command',
        action: arguments[0],
        source: 'tests',
        target: 'background',
        ts: new Date().toISOString(),
        payload: arguments[1] ?? {},
        correlationId: null
      }, (response) => done(response));
    `,
    action,
    payload
  );
}

export async function getAiStatus(driver, pageUrl) {
  const pageKey = normalizePageKey(pageUrl);
  const result = await sendCommand(driver, COMMANDS.aiChatStatus, {
    pageKey,
    pageUrl
  });
  return result.session;
}

export async function waitForSession(driver, pageKey, pageUrl, predicate, timeoutMs = 120000) {
  let latestSession = null;
  await waitFor(async () => {
    latestSession = await getAiStatus(driver, pageUrl);
    return predicate(latestSession);
  }, timeoutMs, `AI session ${pageKey} did not reach the expected state.`);
  return latestSession;
}

export async function waitForOverlay(driver) {
  await waitFor(async () => {
    const present = await driver.executeScript(`
      return !!document.querySelector('#lextrace-overlay-root')?.shadowRoot?.querySelector('.panel-shell');
    `);
    return present === true;
  }, 15000, "Overlay did not appear on the Edge page.");
}

export async function selectOverlayTab(driver, tab) {
  await driver.executeScript(
    `
      document
        .querySelector('#lextrace-overlay-root')
        ?.shadowRoot
        ?.querySelector(".overlay-tab-button[data-tab='" + arguments[0] + "']")
        ?.click();
    `,
    tab
  );
  await delay(300);
}

export async function sendOverlayChat(driver, text) {
  await driver.executeScript(
    `
      const root = document.querySelector('#lextrace-overlay-root')?.shadowRoot;
      const input = root?.querySelector('[data-role="chat-input"]');
      const sendButton = root?.querySelector('[data-role="chat-send"]');
      if (!(input instanceof HTMLInputElement)) {
        throw new Error("Overlay chat input is unavailable.");
      }
      if (!(sendButton instanceof HTMLButtonElement)) {
        throw new Error("Overlay chat send button is unavailable.");
      }
      input.focus();
      input.value = arguments[0];
      input.dispatchEvent(new Event('input', { bubbles: true }));
      sendButton.click();
    `,
    text
  );
}

export async function getOverlayChatFeedText(driver) {
  const text = await driver.executeScript(`
    return document
      .querySelector('#lextrace-overlay-root')
      ?.shadowRoot
      ?.querySelector('[data-role="chat-feed"]')
      ?.textContent ?? '';
  `);
  return typeof text === "string" ? text : "";
}

export async function getOverlayChatStatusText(driver) {
  const text = await driver.executeScript(`
    return document
      .querySelector('#lextrace-overlay-root')
      ?.shadowRoot
      ?.querySelector('[data-role="chat-status-row"]')
      ?.textContent ?? '';
  `);
  return typeof text === "string" ? text : "";
}

export async function getOverlayChatStatusSnapshot(driver) {
  return driver.executeScript(`
    const root = document.querySelector('#lextrace-overlay-root')?.shadowRoot;
    const row = root?.querySelector('[data-role="chat-status-row"]');
    const chips = [...(row?.querySelectorAll('.status-chip') ?? [])].map((chip) => ({
      key: chip.getAttribute('data-status-key'),
      text: chip.textContent?.trim() ?? '',
      tooltip: chip.getAttribute('data-tooltip'),
      hiddenByCss: getComputedStyle(chip).display === 'none' || getComputedStyle(chip).visibility === 'hidden'
    }));
    return {
      rootFound: !!root,
      rowFound: row instanceof HTMLElement,
      chipCount: chips.length,
      chipKeys: chips.map((chip) => chip.key),
      chips
    };
  `);
}

export async function clickOverlayChatReset(driver) {
  await driver.executeScript(`
    const root = document.querySelector('#lextrace-overlay-root')?.shadowRoot;
    const button = root?.querySelector('[data-role="chat-reset"]');
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error("Overlay chat reset button is unavailable.");
    }
    button.click();
  `);
}

export async function importOverlayChatQueue(driver, queuePayload, fileName = "queue.json") {
  const jsonText = typeof queuePayload === "string" ? queuePayload : JSON.stringify(queuePayload);
  await driver.executeScript(
    `
      const root = document.querySelector('#lextrace-overlay-root')?.shadowRoot;
      const input = root?.querySelector('[data-role="chat-queue-file"]');
      if (!(input instanceof HTMLInputElement)) {
        throw new Error("Overlay chat queue file input is unavailable.");
      }
      const transfer = new DataTransfer();
      transfer.items.add(new File([arguments[0]], arguments[1], { type: 'application/json' }));
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    `,
    jsonText,
    fileName
  );
}

export async function getTabIdByUrl(driver, targetUrl) {
  await ensurePopupContext(driver);
  const targetPageKey = normalizePageKey(targetUrl);
  return driver.executeAsyncScript(
    function lookupTabId(expectedUrl, expectedPageKey, done) {
      function normalizeCandidatePageKey(rawUrl) {
        try {
          const url = new URL(rawUrl);
          if (url.protocol !== "http:" && url.protocol !== "https:") {
            return null;
          }

          const normalizedPath = !url.pathname || url.pathname === "/"
            ? "/"
            : url.pathname.replace(/\/{2,}/g, "/").replace(/\/$/, "") || "/";
          const normalizedPort =
            (url.protocol === "http:" && url.port === "80") ||
            (url.protocol === "https:" && url.port === "443") ||
            url.port === ""
              ? ""
              : `:${url.port}`;
          return `${url.protocol}//${url.hostname.toLowerCase()}${normalizedPort}${normalizedPath}`;
        } catch (error) {
          return null;
        }
      }

      chrome.tabs.query({}, (tabs) => {
        const found = tabs.find((tab) =>
          tab.url === expectedUrl ||
          tab.pendingUrl === expectedUrl ||
          normalizeCandidatePageKey(tab.url) === expectedPageKey ||
          normalizeCandidatePageKey(tab.pendingUrl) === expectedPageKey
        );
        done(found && typeof found.id === "number" ? found.id : null);
      });
    },
    targetUrl,
    targetPageKey
  );
}

export async function waitForTabIdByUrl(driver, targetUrl) {
  let tabId = null;
  await waitFor(async () => {
    tabId = await getTabIdByUrl(driver, targetUrl);
    return typeof tabId === "number";
  }, 15000, `Edge tab for ${targetUrl} was not discovered.`);
  return tabId;
}

export async function resetAllSessions(driver) {
  const listResult = await sendCommand(driver, COMMANDS.aiChatList, {});
  if (!Array.isArray(listResult.sessions)) {
    return;
  }

  for (const session of listResult.sessions) {
    if (typeof session?.pageKey !== "string" || session.pageKey.length === 0) {
      continue;
    }

    try {
      await sendCommand(driver, COMMANDS.aiChatReset, {
        pageKey: session.pageKey
      });
    } catch {
      // Best-effort cleanup.
    }
  }
}

export async function waitForAllSessionsIdle(driver, timeoutMs = 30000) {
  let latestSessions = [];
  await waitFor(async () => {
    const listResult = await sendCommand(driver, COMMANDS.aiChatList, {});
    latestSessions = Array.isArray(listResult.sessions) ? listResult.sessions : [];
    return latestSessions.every((session) => {
      const status = session?.status ?? {};
      const queueCount = status.queueCount ?? session?.queuedCount ?? 0;
      return (
        status.requestState === "idle" &&
        status.activeRequestId == null &&
        status.openaiResponseId == null &&
        queueCount === 0
      );
    });
  }, timeoutMs, "AI sessions did not settle back to idle.");
  return latestSessions;
}

export function findLatestAssistantMessage(sessionState, predicate = null, options = {}) {
  const allowedStates = new Set(options.states ?? ["completed"]);
  return [...(sessionState?.messages ?? [])]
    .reverse()
    .find((message) =>
      message?.origin === "assistant" &&
      allowedStates.has(message.state) &&
      (predicate ? predicate(message) : true)
    ) ?? null;
}

export function sessionHasAssistantText(sessionState, text, options = {}) {
  return Boolean(
    findLatestAssistantMessage(
      sessionState,
      (message) => typeof message.text === "string" && message.text.includes(text),
      options
    )
  );
}

export function sessionHasAssistantJson(sessionState, predicate, options = {}) {
  return Boolean(
    findLatestAssistantMessage(
      sessionState,
      (message) => {
        try {
          return predicate(JSON.parse(message.text), message);
        } catch {
          return false;
        }
      },
      options
    )
  );
}

export function buildBaselineAiPatch(selectedModel) {
  return {
    ai: {
      openAiApiKey: null,
      allowedModels: [selectedModel],
      chat: {
        model: selectedModel,
        streamingEnabled: true,
        instructions: BASE_CHAT_INSTRUCTIONS,
        structuredOutput: {
          name: STRUCTURED_NAME,
          description: STRUCTURED_DESCRIPTION,
          schema: "",
          strict: true
        }
      },
      compaction: {
        enabled: true,
        streamingEnabled: true,
        modelOverride: selectedModel,
        instructions: BASE_COMPACTION_INSTRUCTIONS,
        triggerPromptTokens: 64,
        preserveRecentTurns: 1,
        maxPassesPerPage: 2
      },
      promptCaching: {
        routing: "stable_session_prefix",
        retention: "in_memory"
      },
      retries: {
        maxRetries: 3,
        baseDelayMs: 1000,
        maxDelayMs: 30000
      },
      queueRetries: {
        maxRetries: 3,
        baseDelayMs: 1000,
        maxDelayMs: 30000
      },
      rateLimits: {
        reserveOutputTokens: 512,
        maxQueuedPerPage: 2,
        maxQueuedGlobal: 3
      }
    }
  };
}

export async function restoreBaselineAiConfig(
  driver,
  selectedModel,
  originalUserApiKey,
  { verifyApiKeyPresent = true } = {}
) {
  if (!selectedModel) {
    throw new Error("Cannot restore baseline AI config without a selected model.");
  }

  await resetConfigScope(driver, "session");

  await patchConfigForScope(driver, "local", {
    ai: {
      openAiApiKey: originalUserApiKey ?? null
    }
  });

  await patchConfigForScope(driver, "local", buildBaselineAiPatch(selectedModel));
  await resetAllSessions(driver);
  await waitForAllSessionsIdle(driver);

  if (!verifyApiKeyPresent) {
    return;
  }

  const session = await waitForSession(
    driver,
    normalizePageKey("http://127.0.0.1/status-probe"),
    "http://127.0.0.1/status-probe",
    (candidate) => candidate.status.apiKeyPresent === true && candidate.status.model?.model === selectedModel.model,
    30000
  );
  assert.equal(session.status.apiKeyPresent, true, "Baseline AI config restore did not recover the API key.");
}

export function chooseModelFromCatalog(models) {
  const preferredIds = ["gpt-5", "gpt-5-mini", "gpt-4.1", "gpt-4.1-mini"];
  for (const modelId of preferredIds) {
    const match = models.find((item) => item?.id === modelId && getAvailableTiers(item).includes("standard"));
    if (match) {
      return {
        model: match.id,
        tier: "standard"
      };
    }
  }

  for (const item of models) {
    const tiers = getAvailableTiers(item);
    if (tiers.length > 0) {
      return {
        model: item.id,
        tier: tiers[0]
      };
    }
  }

  return null;
}

export function chooseAlternateModelFromCatalog(models, selectedModel) {
  if (!selectedModel) {
    return null;
  }

  const preferredIds = ["gpt-5-mini", "gpt-4.1", "gpt-4.1-mini", "gpt-5"];
  for (const modelId of preferredIds) {
    const match = models.find((item) => item?.id === modelId && item.id !== selectedModel.model);
    if (!match) {
      continue;
    }

    const tiers = getAvailableTiers(match);
    if (tiers.length > 0) {
      return {
        model: match.id,
        tier: tiers.includes("standard") ? "standard" : tiers[0]
      };
    }
  }

  const selectedEntry = models.find((item) => item?.id === selectedModel.model);
  if (selectedEntry) {
    const alternateTier = getAvailableTiers(selectedEntry).find((tier) => tier !== selectedModel.tier);
    if (alternateTier) {
      return {
        model: selectedEntry.id,
        tier: alternateTier
      };
    }
  }

  for (const item of models) {
    const tiers = getAvailableTiers(item);
    for (const tier of tiers) {
      if (item.id !== selectedModel.model || tier !== selectedModel.tier) {
        return {
          model: item.id,
          tier
        };
      }
    }
  }

  return null;
}

export function getAvailableTiers(item) {
  const tiers = [];
  for (const tier of ["standard", "flex", "priority"]) {
    const pricing = item?.pricing?.[tier];
    if (!pricing) {
      continue;
    }

    if (
      pricing.pricingModelId !== null ||
      pricing.inputUsdPer1M !== null ||
      pricing.outputUsdPer1M !== null ||
      pricing.summaryUsdPer1M !== null
    ) {
      tiers.push(tier);
    }
  }
  return tiers;
}

export function normalizePageKey(rawUrl) {
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported page URL for AI test: ${rawUrl}`);
  }

  const normalizedPath = !url.pathname || url.pathname === "/"
    ? "/"
    : url.pathname.replace(/\/{2,}/g, "/").replace(/\/$/, "") || "/";
  const normalizedPort =
    (url.protocol === "http:" && url.port === "80") ||
    (url.protocol === "https:" && url.port === "443") ||
    url.port === ""
      ? ""
      : `:${url.port}`;

  return `${url.protocol}//${url.hostname.toLowerCase()}${normalizedPort}${normalizedPath}`;
}

export async function readNativeHostState() {
  const statePath = getNativeHostStatePath();
  try {
    return JSON.parse(await fs.readFile(statePath, "utf8"));
  } catch {
    return null;
  }
}

export function getNativeHostStatePath() {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) {
    throw new Error("LOCALAPPDATA is unavailable.");
  }

  return path.join(localAppData, "LexTraceNt3", "native-host-state.json");
}

export function getUserEnvironmentVariable(name) {
  const result = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::UTF8; $value = [Environment]::GetEnvironmentVariable($env:TARGET_ENV_NAME, 'User'); if ($null -ne $value) { [Console]::Write($value) }"
    ],
    {
      encoding: "utf8",
      windowsHide: true,
      env: {
        ...process.env,
        TARGET_ENV_NAME: name
      }
    }
  );

  if (result.status !== 0) {
    throw new Error(`Failed to read user environment variable ${name}: ${result.stderr || result.stdout}`.trim());
  }

  const value = result.stdout ?? "";
  return value.length > 0 ? value : null;
}

export async function getUserEnvironmentVariableAsync(name) {
  return getUserEnvironmentVariable(name);
}

export async function startLocalServer() {
  const server = http.createServer(async (request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(`<!doctype html>
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <title>LexTrace Edge AI Harness</title>
        </head>
        <body>
          <main>
            <h1>LexTrace Edge AI Harness</h1>
            <p>Current path: ${request.url ?? "/"}</p>
          </main>
        </body>
      </html>`);
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to determine the local test server address.");
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

export async function waitFor(predicate, timeoutMs, message) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await delay(500);
  }

  throw new Error(message);
}

export function readValueAtPath(source, dottedPath) {
  return dottedPath.split(".").reduce((current, key) => current?.[key], source);
}

export function redactSensitiveValue(value, parentKey = "") {
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveValue(item, parentKey));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        key === "openAiApiKey" || parentKey === "openAiApiKey"
          ? item === null || item === ""
            ? item
            : "[redacted]"
          : redactSensitiveValue(item, key)
      ])
    );
  }

  return value;
}
