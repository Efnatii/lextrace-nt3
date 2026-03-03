import { buildBatchId, estimateTokens } from "./utils.js";

export function createBatches({ blocks, pageSessionId, settings }) {
  const target = settings?.batching?.batchTokenTarget ?? 1200;
  const maxBlocks = settings?.batching?.maxBlocksPerBatch ?? 24;
  const blockLimits = settings?.batching?.blockLimits || { minChars: 1, maxChars: 2800 };

  const filtered = blocks
    .filter((block) => block.text?.trim()?.length >= blockLimits.minChars)
    .map((block) => {
      const text = block.text.slice(0, blockLimits.maxChars);
      return {
        ...block,
        text,
        estimatedTokens: estimateTokens(text)
      };
    });

  const result = [];
  let current = [];
  let currentTokens = 0;

  for (const block of filtered) {
    const wouldExceedTokens = currentTokens + block.estimatedTokens > target;
    const wouldExceedCount = current.length >= maxBlocks;

    if (current.length > 0 && (wouldExceedTokens || wouldExceedCount)) {
      result.push(current);
      current = [];
      currentTokens = 0;
    }

    current.push(block);
    currentTokens += block.estimatedTokens;
  }

  if (current.length > 0) {
    result.push(current);
  }

  return result.map((items, index) => {
    const blockIds = items.map((item) => item.blockId);
    return {
      index,
      batchId: buildBatchId(pageSessionId, index, blockIds),
      blockIds,
      blocks: items,
      tokensEstimate: items.reduce((sum, item) => sum + item.estimatedTokens, 0)
    };
  });
}