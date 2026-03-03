import { MESSAGE, VIEW_MODE } from "../shared/constants.js";
import { classifyBlocks } from "./dom-classifier.js";
import { scanTextBlocks } from "./dom-indexer.js";
import { DomApplier } from "./dom-applier.js";

const domApplier = new DomApplier();
let latestBlocks = [];

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  Promise.resolve()
    .then(async () => {
      switch (message?.type) {
        case MESSAGE.UI_PING:
          return {
            ready: true,
            href: location.href
          };
        case MESSAGE.CONTENT_SCAN:
          return handleScan(message);
        case MESSAGE.CONTENT_APPLY_BATCH:
          return handleApplyBatch(message);
        case MESSAGE.CONTENT_SWITCH_VIEW:
          return handleSwitchView(message);
        case MESSAGE.CONTENT_CLEAR:
          return handleClear();
        default:
          return null;
      }
    })
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));

  return true;
});

function handleScan(message) {
  const rawBlocks = scanTextBlocks();
  const blocks = classifyBlocks(rawBlocks).sort((a, b) => a.order - b.order);
  latestBlocks = blocks;
  domApplier.prime(blocks);

  chrome.runtime.sendMessage({
    type: "event.emit",
    event: {
      level: "info",
      category: "dom.scan",
      name: "content_scanned",
      pageSessionId: message.pageSessionId,
      tabId: message.tabId,
      data: {
        count: blocks.length
      }
    }
  });

  const categoryCounts = {};
  for (const block of blocks) {
    categoryCounts[block.category] = (categoryCounts[block.category] || 0) + 1;
  }

  chrome.runtime.sendMessage({
    type: "event.emit",
    event: {
      level: "info",
      category: "dom.classify",
      name: "content_classified",
      pageSessionId: message.pageSessionId,
      tabId: message.tabId,
      data: {
        count: blocks.length,
        categoryCounts
      }
    }
  });

  return {
    blocks
  };
}

function handleApplyBatch(message) {
  const applied = domApplier.applyBatch(message.payload);
  const stats = domApplier.stats();

  chrome.runtime.sendMessage({
    type: "event.emit",
    event: {
      level: "info",
      category: "dom.apply",
      name: "batch_applied_to_dom",
      pageSessionId: message.pageSessionId,
      tabId: message.tabId,
      batchId: message.payload.batchId,
      data: {
        applied,
        translated: stats.translated,
        total: stats.total
      }
    }
  });

  return {
    applied,
    stats
  };
}

function handleSwitchView(message) {
  const mode = Object.values(VIEW_MODE).includes(message.mode) ? message.mode : VIEW_MODE.ORIGINAL;
  domApplier.switchView(mode);
  return { mode };
}

function handleClear() {
  domApplier.clearAll();
  latestBlocks = [];
  return { cleared: true };
}

window.addEventListener("beforeunload", () => {
  domApplier.clearAll();
});
