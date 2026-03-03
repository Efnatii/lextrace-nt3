import { resolveAnchor } from "./dom-indexer.js";
import { VIEW_MODE } from "../shared/constants.js";

export class DomApplier {
  constructor() {
    this.registry = new Map();
    this.viewMode = VIEW_MODE.ORIGINAL;
  }

  prime(blocks) {
    for (const block of blocks) {
      const node = resolveAnchor(block.anchor);
      if (!node) {
        continue;
      }
      if (!this.registry.has(block.blockId)) {
        this.registry.set(block.blockId, {
          blockId: block.blockId,
          anchor: block.anchor,
          node,
          originalText: node.nodeValue,
          translatedText: null
        });
      }
    }
  }

  applyBatch(batch) {
    let applied = 0;
    for (const row of batch.translations || []) {
      const entry = this.registry.get(row.blockId);
      if (!entry) {
        continue;
      }
      entry.translatedText = row.translatedText;
      this.applyViewForEntry(entry, this.viewMode, row.warnings || []);
      applied += 1;
    }
    return applied;
  }

  switchView(mode) {
    this.viewMode = mode;
    for (const entry of this.registry.values()) {
      this.applyViewForEntry(entry, mode, []);
    }
  }

  clearAll() {
    for (const entry of this.registry.values()) {
      if (entry.node?.isConnected) {
        entry.node.nodeValue = entry.originalText;
      }
      const element = entry.node?.parentElement;
      if (element) {
        element.classList.remove("neuro-translate-diff");
      }
    }
    this.registry.clear();
    this.viewMode = VIEW_MODE.ORIGINAL;
  }

  hasTranslations() {
    for (const entry of this.registry.values()) {
      if (entry.translatedText) {
        return true;
      }
    }
    return false;
  }

  stats() {
    let translated = 0;
    for (const entry of this.registry.values()) {
      if (entry.translatedText) {
        translated += 1;
      }
    }
    return {
      total: this.registry.size,
      translated
    };
  }

  ensureNode(entry) {
    if (entry.node?.isConnected) {
      return entry.node;
    }
    const node = resolveAnchor(entry.anchor);
    if (!node) {
      return null;
    }
    entry.node = node;
    return node;
  }

  applyViewForEntry(entry, mode) {
    const node = this.ensureNode(entry);
    if (!node) {
      return;
    }
    const original = entry.originalText;
    const translated = entry.translatedText;

    if (!translated || mode === VIEW_MODE.ORIGINAL) {
      node.nodeValue = original;
      node.parentElement?.classList.remove("neuro-translate-diff");
      return;
    }

    if (mode === VIEW_MODE.TRANSLATION) {
      node.nodeValue = translated;
      node.parentElement?.classList.remove("neuro-translate-diff");
      return;
    }

    node.nodeValue = `${translated}  |  ${original}`;
    node.parentElement?.classList.add("neuro-translate-diff");
  }
}
