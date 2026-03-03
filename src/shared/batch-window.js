import { estimateTokens } from "./utils.js";

export class BatchWindowManager {
  constructor(settings) {
    this.prevBatchesCount = settings?.batchWindow?.prevBatchesCount ?? 3;
    this.compactAfter = settings?.batchWindow?.compactAfter ?? 8;
    this.compacted = [];
  }

  buildWindow(translatedBatches, index) {
    const start = Math.max(0, index - this.prevBatchesCount);
    return translatedBatches.slice(start, index);
  }

  pushCompactionIfNeeded(translatedBatches, index) {
    if (index < this.compactAfter) {
      return;
    }
    const overflowCount = index - this.prevBatchesCount;
    if (overflowCount <= 0) {
      return;
    }

    const outOfWindow = translatedBatches.slice(0, overflowCount);
    const text = outOfWindow
      .slice(-4)
      .map((batch) => `${batch.batchId}: ${batch.summary || batch.joinedText || ""}`)
      .join("\n");

    const compactedText = text.slice(0, 1600);
    this.compacted.push({
      sourceIndexes: outOfWindow.map((batch) => batch.index),
      text: compactedText,
      tokenEstimate: estimateTokens(compactedText)
    });

    if (this.compacted.length > 20) {
      this.compacted.splice(0, this.compacted.length - 20);
    }
  }

  getCompactionContext() {
    return this.compacted.slice(-3);
  }
}