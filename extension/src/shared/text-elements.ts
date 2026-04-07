import { z } from "zod";

export const TEXT_MAP_SCHEMA_VERSION = 1 as const;

export const TextDisplayModeSchema = z.enum(["effective", "original"]);
export type TextDisplayMode = z.infer<typeof TextDisplayModeSchema>;

export const TextElementCategorySchema = z.enum([
  "heading",
  "paragraph",
  "link",
  "button",
  "label",
  "list-item",
  "input-value",
  "input-placeholder",
  "textarea-value",
  "textarea-placeholder",
  "image-alt",
  "caption",
  "table-cell",
  "option",
  "generic"
]);
export type TextElementCategory = z.infer<typeof TextElementCategorySchema>;

export const TextBindingPresenceSchema = z.enum(["live", "stale"]);
export type TextBindingPresence = z.infer<typeof TextBindingPresenceSchema>;

export const TextBindingLocatorSchema = z.object({
  preferredSelector: z.string().nullable(),
  ancestorSelector: z.string().nullable(),
  elementSelector: z.string().nullable(),
  nodeIndex: z.number().int().min(0).nullable(),
  tagName: z.string(),
  attributeName: z.string().nullable(),
  classNames: z.array(z.string()),
  stableAttributes: z.record(z.string(), z.string())
});
export type TextBindingLocator = z.infer<typeof TextBindingLocatorSchema>;

export const TextBindingContextSchema = z.object({
  pageTitle: z.string().nullable(),
  selectorPreview: z.string().nullable(),
  ancestorText: z.string().nullable()
});
export type TextBindingContext = z.infer<typeof TextBindingContextSchema>;

export const TextBindingRecordSchema = z.object({
  bindingId: z.string().min(1),
  category: TextElementCategorySchema,
  presence: TextBindingPresenceSchema,
  staleSince: z.string().nullable(),
  originalText: z.string(),
  originalNormalized: z.string(),
  replacementText: z.string().nullable(),
  autoBlanked: z.boolean().optional(),
  effectiveText: z.string(),
  currentText: z.string(),
  tagName: z.string(),
  attributeName: z.string().nullable(),
  locator: TextBindingLocatorSchema,
  context: TextBindingContextSchema,
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
  lastMatchedAt: z.string(),
  matchStrategy: z.string().nullable(),
  changed: z.boolean()
});
export type TextBindingRecord = z.infer<typeof TextBindingRecordSchema>;

export const TextScanCandidateSchema = z.object({
  category: TextElementCategorySchema,
  text: z.string(),
  normalizedText: z.string(),
  tagName: z.string(),
  attributeName: z.string().nullable(),
  locator: TextBindingLocatorSchema,
  context: TextBindingContextSchema
});
export type TextScanCandidate = z.infer<typeof TextScanCandidateSchema>;

export const TextPageMapSchema = z.object({
  schemaVersion: z.literal(TEXT_MAP_SCHEMA_VERSION),
  pageKey: z.string().min(1),
  pageUrl: z.string().min(1),
  pageTitle: z.string().nullable(),
  displayMode: TextDisplayModeSchema,
  lastScanAt: z.string().nullable(),
  updatedAt: z.string(),
  bindings: z.array(TextBindingRecordSchema)
});
export type TextPageMap = z.infer<typeof TextPageMapSchema>;

export const TextStorageEnvelopeSchema = z.object({
  schemaVersion: z.literal(TEXT_MAP_SCHEMA_VERSION),
  pages: z.record(z.string(), TextPageMapSchema)
});
export type TextStorageEnvelope = z.infer<typeof TextStorageEnvelopeSchema>;

export type TextMapSummary = {
  total: number;
  live: number;
  stale: number;
  changed: number;
  unchanged: number;
  categories: Record<TextElementCategory, number>;
};

export type MatchResult = {
  score: number;
  strategy: string | null;
};

export type TextEditorGeometry = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type TextRectSnapshot = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type ControlTextLayoutRectInput = {
  elementRect: TextRectSnapshot;
  borderLeft: number;
  borderTop: number;
  borderRight: number;
  borderBottom: number;
  paddingLeft: number;
  paddingTop: number;
  paddingRight: number;
  paddingBottom: number;
  lineHeight: number;
  lineWidths: readonly number[];
  multiline?: boolean;
  textAlign?: "left" | "center" | "right";
  scrollLeft?: number;
  scrollTop?: number;
};

export type TextBindingCandidateMatch = {
  bindingId: string;
  candidateIndex: number;
  strategy: string | null;
};

export function normalizeTextForBinding(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function sanitizeReplacementText(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

export function resolveDisplayedBindingText(
  binding: Pick<TextBindingRecord, "originalText" | "replacementText">,
  mode: TextDisplayMode
): string {
  if (mode === "original") {
    return binding.originalText;
  }

  return binding.replacementText ?? binding.originalText;
}

export function isTextBindingAttributeVisuallyRenderable(attributeName: string | null | undefined): boolean {
  const normalized = attributeName?.trim().toLowerCase() ?? null;
  return normalized === null || normalized === "value" || normalized === "placeholder";
}

export function categorizeTextElement(options: {
  tagName: string;
  role?: string | null;
  attributeName?: string | null;
}): TextElementCategory {
  const tagName = options.tagName.trim().toLowerCase();
  const role = options.role?.trim().toLowerCase() ?? "";
  const attributeName = options.attributeName?.trim().toLowerCase() ?? null;

  if (attributeName === "alt") {
    return "image-alt";
  }

  if (attributeName === "placeholder") {
    if (tagName === "textarea") {
      return "textarea-placeholder";
    }
    return "input-placeholder";
  }

  if (attributeName === "value") {
    if (tagName === "select") {
      return "option";
    }
    if (tagName === "textarea") {
      return "textarea-value";
    }
    return "input-value";
  }

  if (/^h[1-6]$/.test(tagName) || role === "heading") {
    return "heading";
  }

  if (tagName === "p") {
    return "paragraph";
  }

  if (tagName === "a" || role === "link") {
    return "link";
  }

  if (tagName === "button" || role === "button") {
    return "button";
  }

  if (tagName === "label") {
    return "label";
  }

  if (tagName === "li") {
    return "list-item";
  }

  if (tagName === "caption" || tagName === "figcaption") {
    return "caption";
  }

  if (tagName === "td" || tagName === "th") {
    return "table-cell";
  }

  if (tagName === "option") {
    return "option";
  }

  return "generic";
}

export function buildTextBindingId(input: {
  pageKey: string;
  category: TextElementCategory;
  normalizedText: string;
  preferredSelector?: string | null;
  elementSelector?: string | null;
  ancestorSelector?: string | null;
  tagName?: string | null;
  attributeName?: string | null;
  nodeIndex?: number | null;
  contextText?: string | null;
  stableAttributes?: Record<string, string> | null;
}): string {
  const stableAttributeSeed = Object.entries(input.stableAttributes ?? {})
    .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
    .map(([key, value]) => `${key}=${value}`)
    .join("|");
  const contextSeed = normalizeTextForBinding(input.contextText ?? "").slice(0, 180);
  const seed = [
    input.pageKey,
    input.category,
    input.tagName?.trim().toLowerCase() ?? "",
    input.normalizedText,
    input.preferredSelector ?? "",
    input.elementSelector ?? "",
    input.ancestorSelector ?? "",
    input.attributeName ?? "",
    input.nodeIndex ?? "",
    contextSeed,
    stableAttributeSeed
  ].join("\u001f");
  return `txt_${fnv1a(seed)}`;
}

export function createEmptyTextStorageEnvelope(): TextStorageEnvelope {
  return {
    schemaVersion: TEXT_MAP_SCHEMA_VERSION,
    pages: {}
  };
}

export function createEmptyTextPageMap(input: {
  pageKey: string;
  pageUrl: string;
  pageTitle?: string | null;
  displayMode?: TextDisplayMode;
  now?: string;
}): TextPageMap {
  const now = input.now ?? new Date().toISOString();
  return {
    schemaVersion: TEXT_MAP_SCHEMA_VERSION,
    pageKey: input.pageKey,
    pageUrl: input.pageUrl,
    pageTitle: input.pageTitle ?? null,
    displayMode: input.displayMode ?? "effective",
    lastScanAt: null,
    updatedAt: now,
    bindings: []
  };
}

export function buildTextMapSummary(pageMap: TextPageMap | null | undefined): TextMapSummary {
  const categories = Object.fromEntries(
    TextElementCategorySchema.options.map((category) => [category, 0])
  ) as Record<TextElementCategory, number>;
  const bindings = pageMap?.bindings ?? [];
  let live = 0;
  let changed = 0;
  for (const binding of bindings) {
    categories[binding.category] += 1;
    if (binding.presence === "live") {
      live += 1;
    }
    if (binding.changed) {
      changed += 1;
    }
  }

  return {
    total: bindings.length,
    live,
    stale: bindings.length - live,
    changed,
    unchanged: bindings.length - changed,
    categories
  };
}

export function areTextBindingsEquivalentForPersistence(
  left: Pick<
    TextBindingRecord,
    | "bindingId"
    | "category"
    | "presence"
    | "staleSince"
    | "originalText"
    | "originalNormalized"
    | "replacementText"
    | "autoBlanked"
    | "effectiveText"
    | "currentText"
    | "tagName"
    | "attributeName"
    | "locator"
    | "context"
    | "changed"
  >,
  right: Pick<
    TextBindingRecord,
    | "bindingId"
    | "category"
    | "presence"
    | "staleSince"
    | "originalText"
    | "originalNormalized"
    | "replacementText"
    | "autoBlanked"
    | "effectiveText"
    | "currentText"
    | "tagName"
    | "attributeName"
    | "locator"
    | "context"
    | "changed"
  >
): boolean {
  return (
    left.bindingId === right.bindingId &&
    left.category === right.category &&
    left.presence === right.presence &&
    left.staleSince === right.staleSince &&
    left.originalText === right.originalText &&
    left.originalNormalized === right.originalNormalized &&
    left.replacementText === right.replacementText &&
    left.autoBlanked === right.autoBlanked &&
    left.effectiveText === right.effectiveText &&
    left.currentText === right.currentText &&
    left.tagName === right.tagName &&
    left.attributeName === right.attributeName &&
    left.changed === right.changed &&
    areLocatorsEquivalent(left.locator, right.locator) &&
    areContextsEquivalent(left.context, right.context)
  );
}

function areLocatorsEquivalent(left: TextBindingLocator, right: TextBindingLocator): boolean {
  if (
    left.preferredSelector !== right.preferredSelector ||
    left.ancestorSelector !== right.ancestorSelector ||
    left.elementSelector !== right.elementSelector ||
    left.nodeIndex !== right.nodeIndex ||
    left.tagName !== right.tagName ||
    left.attributeName !== right.attributeName
  ) {
    return false;
  }

  const leftClasses = left.classNames;
  const rightClasses = right.classNames;
  if (leftClasses.length !== rightClasses.length) {
    return false;
  }
  for (let i = 0; i < leftClasses.length; i += 1) {
    if (leftClasses[i] !== rightClasses[i]) {
      return false;
    }
  }

  const leftAttrs = left.stableAttributes;
  const rightAttrs = right.stableAttributes;
  const leftKeys = Object.keys(leftAttrs);
  const rightKeys = Object.keys(rightAttrs);
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  for (const key of leftKeys) {
    if (leftAttrs[key] !== rightAttrs[key]) {
      return false;
    }
  }

  return true;
}

function areContextsEquivalent(left: TextBindingContext, right: TextBindingContext): boolean {
  return (
    left.pageTitle === right.pageTitle &&
    left.selectorPreview === right.selectorPreview &&
    left.ancestorText === right.ancestorText
  );
}

export function areTextBindingListsEquivalentForPersistence(
  left: readonly TextBindingRecord[],
  right: readonly TextBindingRecord[]
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((binding, index) => {
    const candidate = right[index];
    return candidate ? areTextBindingsEquivalentForPersistence(binding, candidate) : false;
  });
}

export function matchBindingToCandidate(
  binding: Pick<TextBindingRecord, "category" | "originalNormalized" | "tagName" | "attributeName" | "locator" | "context">,
  candidate: TextScanCandidate
): MatchResult {
  let score = 0;
  let strategy: string | null = null;

  if (
    binding.locator.preferredSelector &&
    candidate.locator.preferredSelector &&
    binding.locator.preferredSelector === candidate.locator.preferredSelector &&
    binding.attributeName === candidate.attributeName
  ) {
    score += 120;
    strategy = "preferred-selector";
  }

  if (
    binding.locator.elementSelector &&
    candidate.locator.elementSelector &&
    binding.locator.elementSelector === candidate.locator.elementSelector &&
    binding.locator.nodeIndex === candidate.locator.nodeIndex &&
    binding.attributeName === candidate.attributeName
  ) {
    score += 80;
    strategy ??= "element-selector";
  }

  if (
    binding.locator.ancestorSelector &&
    candidate.locator.ancestorSelector &&
    binding.locator.ancestorSelector === candidate.locator.ancestorSelector
  ) {
    score += 45;
    strategy ??= "ancestor-selector";
  }

  if (binding.originalNormalized === candidate.normalizedText) {
    score += 40;
    strategy ??= "text";
  }

  if (binding.category === candidate.category) {
    score += 18;
  }

  if (binding.tagName.toLowerCase() === candidate.tagName.toLowerCase()) {
    score += 12;
  }

  if ((binding.attributeName ?? null) === (candidate.attributeName ?? null)) {
    score += 8;
  }

  if (
    binding.context.selectorPreview &&
    candidate.context.selectorPreview &&
    binding.context.selectorPreview === candidate.context.selectorPreview
  ) {
    score += 12;
    strategy ??= "selector-preview";
  }

  if (
    binding.context.ancestorText &&
    candidate.context.ancestorText &&
    binding.context.ancestorText === candidate.context.ancestorText
  ) {
    score += 8;
  }

  return {
    score,
    strategy
  };
}

export function isReliableTextBindingMatch(
  binding: Pick<TextBindingRecord, "originalNormalized" | "attributeName" | "locator">,
  candidate: TextScanCandidate,
  result: MatchResult
): boolean {
  if (result.score < 40) {
    return false;
  }

  const hasPreferredSelectorMatch =
    Boolean(binding.locator.preferredSelector) &&
    binding.locator.preferredSelector === candidate.locator.preferredSelector &&
    (binding.attributeName ?? null) === (candidate.attributeName ?? null);
  const hasElementSelectorMatch =
    Boolean(binding.locator.elementSelector) &&
    binding.locator.elementSelector === candidate.locator.elementSelector &&
    binding.locator.nodeIndex === candidate.locator.nodeIndex &&
    (binding.attributeName ?? null) === (candidate.attributeName ?? null);
  const hasExactTextMatch = binding.originalNormalized === candidate.normalizedText;

  return hasPreferredSelectorMatch || hasElementSelectorMatch || hasExactTextMatch || result.score >= 90;
}

export function mergeTextPageMapWithCandidates(
  pageMap: TextPageMap,
  candidates: readonly TextScanCandidate[],
  options?: {
    pageTitle?: string | null;
    now?: string;
  }
): TextPageMap {
  const now = options?.now ?? new Date().toISOString();
  const remainingBindings = [...pageMap.bindings];
  const mergedBindings: TextBindingRecord[] = [];

  for (const candidate of candidates) {
    const bestMatch = findBestBindingMatch(remainingBindings, candidate);
    if (bestMatch) {
      remainingBindings.splice(bestMatch.index, 1);
      const matchedBinding = bestMatch.binding;
      const nextBinding: TextBindingRecord = {
        ...matchedBinding,
        category: candidate.category,
        presence: "live",
        staleSince: null,
        originalText: candidate.text,
        originalNormalized: candidate.normalizedText,
        effectiveText: resolveDisplayedBindingText(
          {
            originalText: candidate.text,
            replacementText: matchedBinding.replacementText
          },
          "effective"
        ),
        autoBlanked: matchedBinding.autoBlanked,
        currentText: candidate.text,
        tagName: candidate.tagName,
        attributeName: candidate.attributeName,
        locator: candidate.locator,
        context: candidate.context,
        lastSeenAt: now,
        lastMatchedAt: now,
        matchStrategy: bestMatch.result.strategy,
        changed: matchedBinding.replacementText !== null &&
          matchedBinding.replacementText !== candidate.text
      };
      mergedBindings.push(nextBinding);
      continue;
    }

    const bindingId = buildTextBindingId({
      pageKey: pageMap.pageKey,
      category: candidate.category,
      normalizedText: candidate.normalizedText,
      preferredSelector: candidate.locator.preferredSelector,
      elementSelector: candidate.locator.elementSelector,
      ancestorSelector: candidate.locator.ancestorSelector,
      tagName: candidate.tagName,
      attributeName: candidate.attributeName,
      nodeIndex: candidate.locator.nodeIndex,
      contextText: candidate.context.ancestorText,
      stableAttributes: candidate.locator.stableAttributes
    });

    mergedBindings.push({
      bindingId,
      category: candidate.category,
      presence: "live",
      staleSince: null,
      originalText: candidate.text,
      originalNormalized: candidate.normalizedText,
      replacementText: null,
      autoBlanked: false,
      effectiveText: candidate.text,
      currentText: candidate.text,
      tagName: candidate.tagName,
      attributeName: candidate.attributeName,
      locator: candidate.locator,
      context: candidate.context,
      firstSeenAt: now,
      lastSeenAt: now,
      lastMatchedAt: now,
      matchStrategy: "created",
      changed: false
    });
  }

  const staleBindings = remainingBindings
    .filter((binding) => binding.changed)
    .map((binding) => ({
      ...binding,
      presence: "stale" as const,
      staleSince: binding.staleSince ?? now
    }));

  return {
    ...pageMap,
    pageTitle: options?.pageTitle ?? pageMap.pageTitle,
    lastScanAt: now,
    updatedAt: now,
    bindings: [...mergedBindings, ...staleBindings]
  };
}

/**
 * Returns a stale copy of a binding. Preserves the earliest staleSince timestamp so
 * repeated staling calls are idempotent and don't advance the clock on each pass.
 */
export function buildStaleTextBinding(binding: TextBindingRecord, now: string): TextBindingRecord {
  return {
    ...binding,
    presence: "stale",
    staleSince: binding.staleSince ?? now
  };
}

/**
 * Computes the merged binding list after an incremental scan pass.
 *
 * Invariants enforced here:
 *  - Matched bindings receive their updated record from `updatedBindings`.
 *  - Retained bindings (e.g. inline-editor keeps them alive without a candidate) are left unchanged.
 *  - Unmatched affected live bindings transition to **stale** — never to deleted.
 *    This is the RC1 fix: soft-miss on first incremental failure prevents permanent loss of
 *    unchanged bindings that disappeared only due to transient DOM churn (animations,
 *    React/Polymer re-renders, temporarily invisible roots).
 *  - All other bindings (unaffected, already-stale) are kept as-is.
 *  - New bindings for unmatched candidates are appended at the end.
 *
 * The stale unchanged bindings that accumulate here are cleaned up by the next full
 * `mergeTextPageMapWithCandidates` pass (manual text.scan), which drops unchanged
 * stale bindings that don't match any candidate.
 */
export function resolveIncrementalBindingStates(
  currentBindings: readonly TextBindingRecord[],
  affectedBindingIds: ReadonlySet<string>,
  matchedBindingIds: ReadonlySet<string>,
  updatedBindings: ReadonlyMap<string, TextBindingRecord>,
  retainedBindingIds: ReadonlySet<string>,
  newBindings: readonly TextBindingRecord[],
  now: string
): TextBindingRecord[] {
  const next = currentBindings.map((binding) => {
    const updated = updatedBindings.get(binding.bindingId);
    if (updated) {
      return updated;
    }
    if (
      binding.presence === "live" &&
      affectedBindingIds.has(binding.bindingId) &&
      !matchedBindingIds.has(binding.bindingId) &&
      !retainedBindingIds.has(binding.bindingId)
    ) {
      return buildStaleTextBinding(binding, now);
    }
    return binding;
  });
  return newBindings.length > 0 ? [...next, ...newBindings] : next;
}

export function updateBindingReplacement(
  pageMap: TextPageMap,
  bindingId: string,
  replacementText: string | null,
  options?: {
    now?: string;
  }
): TextPageMap {
  const now = options?.now ?? new Date().toISOString();
  return {
    ...pageMap,
    updatedAt: now,
    bindings: pageMap.bindings.map((binding) => {
      if (binding.bindingId !== bindingId) {
        return binding;
      }

      const nextReplacement = replacementText === null ? null : sanitizeReplacementText(replacementText);
      return {
        ...binding,
        replacementText: nextReplacement,
        autoBlanked: false,
        effectiveText: resolveDisplayedBindingText(
          {
            originalText: binding.originalText,
            replacementText: nextReplacement
          },
          "effective"
        ),
        changed: nextReplacement !== null && nextReplacement !== binding.originalText,
        lastMatchedAt: now
      };
    })
  };
}

export function resetPageBindings(pageMap: TextPageMap, options?: { now?: string }): TextPageMap {
  const now = options?.now ?? new Date().toISOString();
  return {
    ...pageMap,
    updatedAt: now,
    bindings: pageMap.bindings.map((binding) => ({
      ...binding,
      replacementText: null,
      autoBlanked: false,
      effectiveText: binding.originalText,
      changed: false,
      lastMatchedAt: now
    }))
  };
}

function isLegacyAutoBlankLike(binding: Pick<TextBindingRecord, "replacementText" | "effectiveText" | "changed" | "originalText" | "autoBlanked">): boolean {
  return (
    binding.autoBlanked !== false &&
    binding.replacementText === "" &&
    binding.effectiveText === "" &&
    binding.changed &&
    binding.originalText.length > 0
  );
}

export function reconcileAutoBlankBindings(
  pageMap: TextPageMap,
  autoBlankEnabled: boolean,
  options?: {
    now?: string;
    includeStale?: boolean;
    touchMatchedAt?: boolean;
  }
): {
  pageMap: TextPageMap;
  didChange: boolean;
  blankedBindings: number;
  revertedBindings: number;
} {
  const now = options?.now ?? new Date().toISOString();
  const includeStale = options?.includeStale ?? false;
  const touchMatchedAt = options?.touchMatchedAt ?? false;
  let didChange = false;
  let blankedBindings = 0;
  let revertedBindings = 0;

  const nextBindings = pageMap.bindings.map((binding) => {
    const shouldProcess = includeStale || binding.presence === "live";
    if (!shouldProcess) {
      return binding;
    }

    if (autoBlankEnabled) {
      const nextChanged = binding.originalText !== "";
      const nextLastMatchedAt = touchMatchedAt ? now : binding.lastMatchedAt;
      const isAlreadyBlanked =
        binding.replacementText === "" &&
        binding.effectiveText === "" &&
        binding.changed === nextChanged;
      if (isAlreadyBlanked && binding.autoBlanked === false && binding.lastMatchedAt === nextLastMatchedAt) {
        blankedBindings += 1;
        return binding;
      }
      const nextBinding = {
        ...binding,
        replacementText: "",
        autoBlanked: true,
        effectiveText: "",
        changed: nextChanged,
        lastMatchedAt: nextLastMatchedAt
      };
      if (!areTextBindingsEquivalentForPersistence(binding, nextBinding) || binding.lastMatchedAt !== nextLastMatchedAt) {
        didChange = true;
      }
      if (nextBinding.replacementText === "") {
        blankedBindings += 1;
      }
      return nextBinding;
    }

    const isAutoBlanked = binding.autoBlanked === true || isLegacyAutoBlankLike(binding);
    if (!isAutoBlanked) {
      if (binding.replacementText === "") {
        blankedBindings += 1;
      }
      return binding;
    }

    const nextLastMatchedAt = touchMatchedAt ? now : binding.lastMatchedAt;
    const nextBinding = {
      ...binding,
      replacementText: null,
      autoBlanked: false,
      effectiveText: binding.originalText,
      changed: false,
      lastMatchedAt: nextLastMatchedAt
    };
    didChange = true;
    revertedBindings += 1;
    return nextBinding;
  });

  const nextPageMap = didChange
    ? {
        ...pageMap,
        updatedAt: now,
        bindings: nextBindings
      }
    : pageMap;

  if (!autoBlankEnabled) {
    blankedBindings = nextBindings.filter(
      (binding) => (includeStale || binding.presence === "live") && binding.replacementText === ""
    ).length;
  }

  return {
    pageMap: nextPageMap,
    didChange,
    blankedBindings,
    revertedBindings
  };
}

export function removeBindingFromPageMap(
  pageMap: TextPageMap,
  bindingId: string,
  options?: {
    now?: string;
  }
): TextPageMap {
  const now = options?.now ?? new Date().toISOString();
  return {
    ...pageMap,
    updatedAt: now,
    bindings: pageMap.bindings.filter((binding) => binding.bindingId !== bindingId)
  };
}

export function upsertPageMapInEnvelope(
  envelope: TextStorageEnvelope,
  pageMap: TextPageMap
): TextStorageEnvelope {
  return {
    ...envelope,
    pages: {
      ...envelope.pages,
      [pageMap.pageKey]: pageMap
    }
  };
}

export function removePageMapFromEnvelope(
  envelope: TextStorageEnvelope,
  pageKey: string
): TextStorageEnvelope {
  const nextPages = { ...envelope.pages };
  delete nextPages[pageKey];
  return {
    ...envelope,
    pages: nextPages
  };
}

export function formatTextMapExportFileName(pageKey: string | null | undefined, exportedAt: string): string {
  const timestamp = exportedAt.replace(/[:.]/g, "-");
  const pageSuffix = sanitizeFileNameSegment(pageKey ?? "page");
  return `lextrace-text-map-${pageSuffix}-${timestamp}.json`;
}

export function buildTextRectUnion(rects: readonly TextRectSnapshot[]): TextRectSnapshot | null {
  const visibleRects = rects.filter((rect) => rect.width > 0 && rect.height > 0);
  if (visibleRects.length === 0) {
    return null;
  }

  let left = visibleRects[0]!.left;
  let top = visibleRects[0]!.top;
  let right = visibleRects[0]!.left + visibleRects[0]!.width;
  let bottom = visibleRects[0]!.top + visibleRects[0]!.height;

  visibleRects.slice(1).forEach((rect) => {
    left = Math.min(left, rect.left);
    top = Math.min(top, rect.top);
    right = Math.max(right, rect.left + rect.width);
    bottom = Math.max(bottom, rect.top + rect.height);
  });

  return {
    left,
    top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top)
  };
}

export function buildControlTextLayoutRects(input: ControlTextLayoutRectInput): TextRectSnapshot[] {
  const contentWidth = Math.max(
    0,
    input.elementRect.width - input.borderLeft - input.borderRight - input.paddingLeft - input.paddingRight
  );
  const contentHeight = Math.max(
    0,
    input.elementRect.height - input.borderTop - input.borderBottom - input.paddingTop - input.paddingBottom
  );
  const availableWidth = Math.max(1, contentWidth);
  const lineHeight = Math.max(1, input.lineHeight);
  const baseLeft = input.elementRect.left + input.borderLeft + input.paddingLeft - (input.scrollLeft ?? 0);
  const baseTop = input.elementRect.top + input.borderTop + input.paddingTop - (input.scrollTop ?? 0);
  const isMultiline = input.multiline ?? false;
  const textAlign = input.textAlign ?? "left";

  const resolveAlignedLeft = (lineWidth: number): number => {
    if (textAlign === "center") {
      return baseLeft + Math.max(0, (availableWidth - lineWidth) / 2);
    }
    if (textAlign === "right") {
      return baseLeft + Math.max(0, availableWidth - lineWidth);
    }
    return baseLeft;
  };

  if (!isMultiline) {
    const width = Math.min(
      availableWidth,
      Math.max(1, input.lineWidths[0] ?? 0)
    );
    return [
      {
        left: resolveAlignedLeft(width),
        top: baseTop + Math.max(0, (contentHeight - lineHeight) / 2),
        width,
        height: Math.min(lineHeight, Math.max(1, contentHeight))
      }
    ];
  }

  return input.lineWidths
    .map((lineWidth, index) => {
      const width = Math.min(availableWidth, Math.max(1, lineWidth));
      return {
        left: resolveAlignedLeft(width),
        top: baseTop + index * lineHeight,
        width,
        height: lineHeight
      };
    })
    .filter((rect) => rect.top < input.elementRect.top + input.elementRect.height);
}

export function buildInlineTextEditorGeometry(input: {
  targetRect: {
    left: number;
    top: number;
    width: number;
    height: number;
  };
  scrollX: number;
  scrollY: number;
  viewportWidth: number;
  documentWidth: number;
  minWidth?: number;
  minHeight?: number;
  margin?: number;
}): TextEditorGeometry {
  const margin = input.margin ?? 0;
  const minWidth = input.minWidth ?? 1;
  const minHeight = input.minHeight ?? 1;
  const width = Math.max(minWidth, input.targetRect.width || 0);
  const height = Math.max(minHeight, input.targetRect.height || 0);
  const absoluteLeft = input.scrollX + input.targetRect.left;
  const absoluteTop = input.scrollY + input.targetRect.top;
  const maxLeft = Math.max(margin, Math.max(input.documentWidth, input.viewportWidth) - margin - width);

  return {
    left: clampNumber(absoluteLeft, margin, maxLeft),
    top: Math.max(margin, absoluteTop),
    width,
    height
  };
}

export function mapBindingsToCandidateIndices(
  bindings: readonly TextBindingRecord[],
  candidates: readonly TextScanCandidate[]
): TextBindingCandidateMatch[] {
  const usedCandidateIndices = new Set<number>();
  const matches: TextBindingCandidateMatch[] = [];

  const selectorIndex = new Map<string, number[]>();
  for (let i = 0; i < candidates.length; i += 1) {
    const sel = candidates[i]!.locator.preferredSelector;
    if (sel) {
      const key = `${sel}\u001f${candidates[i]!.attributeName ?? ""}`;
      const list = selectorIndex.get(key);
      if (list) {
        list.push(i);
      } else {
        selectorIndex.set(key, [i]);
      }
    }
  }

  for (const binding of bindings) {
    let bestCandidateIndex = -1;
    let bestResult: MatchResult | null = null;
    let bestStrategy: string | null = null;

    if (binding.locator.preferredSelector) {
      const key = `${binding.locator.preferredSelector}\u001f${binding.attributeName ?? ""}`;
      const indexed = selectorIndex.get(key);
      if (indexed) {
        for (const ci of indexed) {
          if (usedCandidateIndices.has(ci)) {
            continue;
          }
          const result = matchBindingToCandidate(binding, candidates[ci]!);
          if (!isReliableTextBindingMatch(binding, candidates[ci]!, result)) {
            continue;
          }
          if (!bestResult || result.score > bestResult.score) {
            bestResult = result;
            bestStrategy = result.strategy;
            bestCandidateIndex = ci;
          }
        }
      }
    }

    if (!bestResult) {
      for (let ci = 0; ci < candidates.length; ci += 1) {
        if (usedCandidateIndices.has(ci)) {
          continue;
        }
        const candidate = candidates[ci]!;
        const result = matchBindingToCandidate(binding, candidate);
        if (!isReliableTextBindingMatch(binding, candidate, result)) {
          continue;
        }
        if (!bestResult || result.score > bestResult.score) {
          bestResult = result;
          bestStrategy = result.strategy;
          bestCandidateIndex = ci;
        }
      }
    }

    if (bestCandidateIndex === -1 || !bestResult) {
      continue;
    }

    usedCandidateIndices.add(bestCandidateIndex);
    matches.push({
      bindingId: binding.bindingId,
      candidateIndex: bestCandidateIndex,
      strategy: bestStrategy
    });
  }

  return matches;
}

function findBestBindingMatch(
  bindings: readonly TextBindingRecord[],
  candidate: TextScanCandidate
): { index: number; binding: TextBindingRecord; result: MatchResult } | null {
  let bestIndex = -1;
  let bestBinding: TextBindingRecord | null = null;
  let bestResult: MatchResult | null = null;

  bindings.forEach((binding, index) => {
    const result = matchBindingToCandidate(binding, candidate);
    if (!isReliableTextBindingMatch(binding, candidate, result)) {
      return;
    }

    if (!bestResult || result.score > bestResult.score) {
      bestIndex = index;
      bestBinding = binding;
      bestResult = result;
    }
  });

  if (!bestBinding || !bestResult) {
    return null;
  }

  return {
    index: bestIndex,
    binding: bestBinding,
    result: bestResult
  };
}

function sanitizeFileNameSegment(value: string): string {
  const sanitized = value
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return sanitized.slice(0, 64) || "page";
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return (hash >>> 0).toString(16).padStart(8, "0");
}

function clampNumber(value: number, min: number, max: number): number {
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}
