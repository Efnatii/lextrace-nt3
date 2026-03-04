import { estimateTokens } from "./utils.js";

export class BatchWindowManager {
  constructor(settings) {
    this.prevBatchesCount = settings?.batchWindow?.prevBatchesCount ?? 3;
    this.compactAfter = settings?.batchWindow?.compactAfter ?? settings?.compaction?.thresholds?.startAfterBatch ?? 8;
    this.compactionTokenTarget = Math.max(32, Number(settings?.compaction?.thresholds?.tokenTarget) || 450);
    this.maxCompactions = 20;
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
    const previous = this.compacted[this.compacted.length - 1] || null;
    const sourceIndexes = previous
      ? unionIndexes(previous.sourceIndexes, outOfWindow.map((batch) => batch.index))
      : outOfWindow.map((batch) => batch.index);

    const candidateParts = [];
    if (previous?.text) {
      candidateParts.push(`PREV_COMPACTION:\n${previous.text}`);
    }

    const recentOverflow = outOfWindow.slice(-6);
    for (const batch of recentOverflow) {
      candidateParts.push(`${batch.batchId}: ${batch.summary || batch.joinedText || ""}`);
    }

    const candidateText = candidateParts.join("\n");
    const compactedText = clampTextByTokens(candidateText, this.compactionTokenTarget);
    const tokenEstimate = estimateTokens(compactedText);

    if (!compactedText.trim()) {
      return;
    }

    if (previous && previous.text === compactedText) {
      return;
    }

    this.compacted.push({
      sourceIndexes,
      text: compactedText,
      tokenEstimate
    });

    if (this.compacted.length > this.maxCompactions) {
      this.compacted.splice(0, this.compacted.length - this.maxCompactions);
    }
  }

  getCompactionContext() {
    return this.compacted.slice(-3);
  }
}

function clampTextByTokens(text, tokenTarget) {
  if (!text) {
    return "";
  }
  if (estimateTokens(text) <= tokenTarget) {
    return text;
  }

  const maxChars = tokenTarget * 4;
  return text.slice(-maxChars);
}

function unionIndexes(left, right) {
  const set = new Set([...(left || []), ...(right || [])]);
  return [...set].sort((a, b) => a - b);
}
