import { EVENT_STREAM_PORT, MESSAGE } from "../shared/constants.js";
import { EventLogStore } from "../shared/event-log-store.js";
import { SettingsStore } from "../shared/settings-store.js";
import { TabStateStore } from "../shared/tab-state-store.js";
import { OffscreenClient } from "./offscreen-client.js";
import { PipelineOrchestrator } from "./pipeline-orchestrator.js";

const settingsStore = new SettingsStore();
const tabStateStore = new TabStateStore();
const eventLogStore = new EventLogStore();
const offscreenClient = new OffscreenClient();

const ports = new Set();

const orchestrator = new PipelineOrchestrator({
  settingsStore,
  tabStateStore,
  eventLogStore,
  offscreenClient,
  onStateChanged: ({ tabId, state }) => {
    for (const port of ports) {
      try {
        port.postMessage({
          type: "stream.state",
          tabId,
          state
        });
      } catch {
        // Port can disconnect asynchronously.
      }
    }
  }
});

bootstrap().catch((error) => {
  console.error("bootstrap_failed", error);
});

async function bootstrap() {
  await orchestrator.init();
  await orchestrator.resumePending();
}

chrome.runtime.onInstalled.addListener(async () => {
  await orchestrator.init();
});

chrome.runtime.onStartup.addListener(async () => {
  await orchestrator.init();
  await orchestrator.resumePending();
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== EVENT_STREAM_PORT) {
    return;
  }
  ports.add(port);

  port.onMessage.addListener(async (message) => {
    if (message?.type === "stream.subscribe" && Number.isInteger(message.tabId)) {
      const state = await orchestrator.getUiState(message.tabId);
      port.postMessage({ type: "stream.state", tabId: message.tabId, state });
    }
  });

  port.onDisconnect.addListener(() => {
    ports.delete(port);
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === MESSAGE.OFFSCREEN_EXECUTE || message?.type === MESSAGE.OFFSCREEN_CANCEL) {
    return false;
  }
  Promise.resolve(orchestrator.handleMessage(message, sender))
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
  return true;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  orchestrator.handleAlarm(alarm).catch((error) => {
    orchestrator.appendEvent({
      level: "error",
      category: "error",
      name: "alarm_handler_failed",
      error: {
        message: error?.message || String(error),
        stack: error?.stack
      }
    });
  });
});
