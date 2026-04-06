import {
  AiChatCompactResultSchema,
  AiModelCatalogResultSchema,
  AiChatPageSessionSchema,
  buildAiChatTranscriptItems,
  buildAiChatStatusFragments,
  createDefaultAiStatus,
  formatAiEventKindLabel,
  formatAiMessageOriginLabel,
  getAiMessageDisplayText,
  isScrollPinnedToBottom,
  normalizeAllowedModelRules,
  type AiAllowedModelRule,
  type AiChatMessage,
  type AiChatPageSession,
  type AiChatTranscriptItem,
  type AiModelCatalogItem,
  type AiServiceTier,
  type AiStreamMessage
} from "../shared/ai";
import { isAiModelTierAvailable } from "../shared/ai-model-catalog";
import { parseAiQueueImportJson } from "../shared/ai-queue-import";
import { COMMANDS, STORAGE_KEYS } from "../shared/constants";
import { connectRuntimeStream, formatUserFacingCommandError, recordLog, sendCommand } from "../shared/client";
import {
  buildConfigPatchFromPath,
  getEditableConfigField,
  getEditableConfigPaths,
  omitSensitiveConfigData,
  parseConfigFieldDraft,
  readConfigValue
} from "../shared/config-fields";
import {
  defaultConfig,
  ExtensionConfigSchema,
  type ExtensionConfig,
  type ExtensionConfigPatch,
  type OverlayTab,
  type PopupTab,
  type TextAutoScanMode
} from "../shared/config";
import { LogEntrySchema, serializeLogDetails, type LogEntry } from "../shared/logging";
import {
  buildChatLogExportPayload,
  buildConsoleLogExportPayload,
  formatLogExportFileName
} from "../shared/log-export";
import {
  buildOverlayActivityFeed,
  type OverlayConsoleEntry,
  type OverlayConsoleEntryKind
} from "../shared/overlay-feed";
import {
  clampOverlayGeometryToViewport,
  getCenteredOverlayPosition,
  resizeOverlayGeometry,
  type OverlayGeometry,
  type OverlayResizeHandle,
  type OverlayViewport
} from "../shared/overlay";
import {
  createErrorResponse,
  createOkResponse,
  validateEnvelope,
  type ExtensionStreamMessage,
  type RuntimeStreamMessage
} from "../shared/protocol";
import { normalizePageKey, shortenPageKey } from "../shared/page";
import { parseRuntimeWorkerStatus, type WorkerStatus } from "../shared/runtime-state";
import {
  areTextBindingListsEquivalentForPersistence,
  areTextBindingsEquivalentForPersistence,
  buildControlTextLayoutRects,
  buildTextBindingId,
  buildTextMapSummary,
  buildTextRectUnion,
  categorizeTextElement,
  createEmptyTextPageMap,
  createEmptyTextStorageEnvelope,
  formatTextMapExportFileName,
  mapBindingsToCandidateIndices,
  isReliableTextBindingMatch,
  matchBindingToCandidate,
  mergeTextPageMapWithCandidates,
  normalizeTextForBinding,
  isTextBindingAttributeVisuallyRenderable,
  removeBindingFromPageMap,
  removePageMapFromEnvelope,
  reconcileAutoBlankBindings,
  resetPageBindings,
  resolveDisplayedBindingText,
  sanitizeReplacementText,
  TextStorageEnvelopeSchema,
  updateBindingReplacement,
  upsertPageMapInEnvelope,
  type TextBindingRecord,
  type TextDisplayMode,
  type TextPageMap,
  type TextRectSnapshot,
  type TextScanCandidate,
  type TextStorageEnvelope
} from "../shared/text-elements";
import {
  buildStatusChipDescriptors,
  type StatusChipDescriptor,
  type StatusChipIcon
} from "../shared/status-chips";
import {
  getTerminalHelpLines,
  getTerminalSuggestions,
  parseTerminalCommand,
  type ParsedTerminalCommand,
  type TerminalCatalogOptions
} from "../shared/terminal";
import type { TerminalChatTarget, TerminalOverlayTarget } from "../shared/terminal-alias";

type RuntimeSnapshot = {
  config: ExtensionConfig;
  status: WorkerStatus;
  logs: LogEntry[];
};

type RuntimeSnapshotResponse = {
  config: ExtensionConfig;
  workerStatus: WorkerStatus;
  logs: LogEntry[];
};

type TerminalExecutionResult = {
  output: unknown;
  logDetails?: unknown;
  postAction?:
    | {
        type: "close-overlay";
      }
    | {
        type: "switch-overlay-tab";
        tab: OverlayTab;
      };
};

const SVG_NS = "http://www.w3.org/2000/svg";
const OVERLAY_MIN_WIDTH = 480;
const OVERLAY_MIN_HEIGHT = 320;
const RESIZE_HANDLE_CURSOR: Record<OverlayResizeHandle, string> = {
  n: "ns-resize",
  s: "ns-resize",
  e: "ew-resize",
  w: "ew-resize",
  ne: "nesw-resize",
  sw: "nesw-resize",
  nw: "nwse-resize",
  se: "nwse-resize"
};
const STATUS_DOWNLOAD_ICON: StatusChipIcon = {
  viewBox: "0 0 16 16",
  paths: [
    { d: "M8 3.25v6.5" },
    { d: "m5.5 7.75 2.5 2.5 2.5-2.5" },
    { d: "M3.5 11.75h9" }
  ]
};

function createStatusChipIcon(icon: StatusChipIcon): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", icon.viewBox);
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");

  for (const pathDefinition of icon.paths) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", pathDefinition.d);
    if (pathDefinition.fill) {
      path.setAttribute("fill", pathDefinition.fill);
    }
    if (pathDefinition.stroke) {
      path.setAttribute("stroke", pathDefinition.stroke);
    }
    svg.append(path);
  }

  return svg;
}

function createStatusChip(descriptor: StatusChipDescriptor): HTMLSpanElement {
  const chip = document.createElement("span");
  chip.className = "status-chip";
  chip.dataset.statusKey = descriptor.key;
  if (descriptor.width !== "default") {
    chip.classList.add(`status-chip--${descriptor.width}`);
  }

  const tooltip = `${descriptor.tooltipLabel}: ${descriptor.fullValue}`;
  chip.tabIndex = 0;
  chip.setAttribute("data-tooltip", tooltip);
  chip.setAttribute("aria-label", tooltip);

  const icon = document.createElement("span");
  icon.className = "status-chip-icon";
  icon.append(createStatusChipIcon(descriptor.icon));

  const value = document.createElement("span");
  value.className = "status-chip-value";
  value.textContent = descriptor.value;

  chip.append(icon, value);
  return chip;
}

function createStatusActionButton(options: {
  tooltip: string;
  icon?: StatusChipIcon;
  dataRole?: string;
  disabled?: boolean;
  onClick: () => void;
}): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "status-action";
  button.tabIndex = 0;
  button.disabled = options.disabled ?? false;
  button.setAttribute("data-tooltip", options.tooltip);
  button.setAttribute("aria-label", options.tooltip);
  if (options.dataRole) {
    button.dataset.role = options.dataRole;
  }

  button.append(createStatusChipIcon(options.icon ?? STATUS_DOWNLOAD_ICON));
  button.addEventListener("click", options.onClick);
  return button;
}

function createStatusRowShell(
  descriptors: readonly StatusChipDescriptor[],
  actions: readonly HTMLButtonElement[] = []
): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const chipList = document.createElement("div");
  chipList.className = "status-chip-list";
  chipList.append(...descriptors.map((descriptor) => createStatusChip(descriptor)));
  fragment.append(chipList);

  if (actions.length > 0) {
    const actionList = document.createElement("div");
    actionList.className = "status-row-actions";
    actionList.append(...actions);
    fragment.append(actionList);
  }

  return fragment;
}

function getStatusDescriptorSignature(descriptors: readonly StatusChipDescriptor[]): string {
  return descriptors
    .map((descriptor) =>
      [descriptor.key, descriptor.value, descriptor.fullValue, descriptor.tooltipLabel, descriptor.width].join("\u001f")
    )
    .join("\u001e");
}

type TextRuntimeTarget = {
  bindingId: string | null;
  element: HTMLElement;
  highlightElement: HTMLElement;
  styleElement: HTMLElement;
  attributeName: string | null;
  textNode: Text | null;
  lastKnownClientRects: TextRectSnapshot[];
  readCurrentText: () => string;
  applyRenderedText: (value: string) => void;
  getOriginalText: () => string;
  getLiveClientRects: () => TextRectSnapshot[];
  getClientRects: () => TextRectSnapshot[];
  getBoundingClientRect: () => TextRectSnapshot | null;
};

type TextHighlightHandle = Highlight;

type LiveTextCandidate = {
  candidate: TextScanCandidate;
  target: TextRuntimeTarget;
};

const TEXT_SCAN_ICON: StatusChipIcon = {
  viewBox: "0 0 16 16",
  paths: [
    { d: "M13 13 10.5 10.5" },
    { d: "M7.25 11.5a4.25 4.25 0 1 1 0-8.5 4.25 4.25 0 0 1 0 8.5Z" }
  ]
};

const TEXT_RESET_ICON: StatusChipIcon = {
  viewBox: "0 0 16 16",
  paths: [
    { d: "M5 3.75H2.5v2.5" },
    { d: "M2.75 6.25A5.25 5.25 0 1 0 4.5 3.9" }
  ]
};

const TEXT_EDIT_ICON: StatusChipIcon = {
  viewBox: "0 0 16 16",
  paths: [
    { d: "M3 11.75 3.5 9.25 9.75 3 12.5 5.75 6.25 12 3 11.75Z" },
    { d: "M8.75 4 11.5 6.75" }
  ]
};

const TEXT_DELETE_ICON: StatusChipIcon = {
  viewBox: "0 0 16 16",
  paths: [
    { d: "M3.25 4.5h9.5" },
    { d: "M6 4.5V3.25h4v1.25" },
    { d: "M4.5 4.5 5 13h6l.5-8.5" },
    { d: "M6.5 6.5v4.5" },
    { d: "M9.5 6.5v4.5" }
  ]
};

const TEXT_DOWNLOAD_ICON = STATUS_DOWNLOAD_ICON;
const TEXT_SOURCE_HIGHLIGHT_NAME = "lextrace-text-source";
const TEXT_CHANGED_HIGHLIGHT_NAME = "lextrace-text-changed";
const TEXT_BINDING_SELECTOR_MAX_DEPTH = 12;
const TEXT_OBSERVER_SUPPRESSION_WINDOW_MS = 320;
const TEXT_INCREMENTAL_SCAN_DELAY_MS = 90;
const TEXT_DEFERRED_MUTATION_RETRY_MAX_ATTEMPTS = 2;
const TEXT_HOST_TAG_NAMES = new Set([
  "a",
  "button",
  "caption",
  "figcaption",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "label",
  "legend",
  "li",
  "option",
  "p",
  "summary",
  "td",
  "th"
]);
const TEXT_INLINE_WRAPPER_TAG_NAMES = new Set([
  "abbr",
  "b",
  "cite",
  "code",
  "em",
  "i",
  "kbd",
  "mark",
  "s",
  "small",
  "span",
  "strong",
  "sub",
  "sup",
  "time",
  "u"
]);
const TEXT_HOST_PROMOTION_CONTAINER_TAG_NAMES = new Set([
  "div",
  "span"
]);

function createToolIconButton(options: {
  tooltip: string;
  icon: StatusChipIcon;
  dataRole: string;
  disabled?: boolean;
  onClick: () => void;
}): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "tool-icon";
  button.dataset.role = options.dataRole;
  button.disabled = options.disabled ?? false;
  button.setAttribute("data-tooltip", options.tooltip);
  button.setAttribute("aria-label", options.tooltip);
  button.append(createStatusChipIcon(options.icon));
  button.addEventListener("click", options.onClick);
  return button;
}

function truncateTextPreview(value: string, maxLength = 180): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }

  return `${trimmed.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function isTextDebugSkippableElement(element: Element): boolean {
  if (
    element instanceof HTMLElement &&
    element.closest("[data-lextrace-text-debug-skip='true']")
  ) {
    return true;
  }

  const tagName = element.tagName.toLowerCase();
  return (
    tagName === "script" ||
    tagName === "style" ||
    tagName === "noscript" ||
    tagName === "template" ||
    tagName === "iframe" ||
    tagName === "svg"
  );
}

function isTextDebugPotentiallyVisibleElement(element: HTMLElement): boolean {
  if (!element.isConnected) {
    return false;
  }

  if (element.hidden) {
    return false;
  }

  if (element.closest("[hidden]")) {
    return false;
  }

  const style = window.getComputedStyle(element);
  if (
    style.display === "none" ||
    style.visibility === "hidden" ||
    style.visibility === "collapse" ||
    style.contentVisibility === "hidden" ||
    Number.parseFloat(style.opacity || "1") <= 0.01
  ) {
    return false;
  }

  return true;
}

function isTextDebugVisibleElement(element: HTMLElement): boolean {
  if (!isTextDebugPotentiallyVisibleElement(element)) {
    return false;
  }

  if (typeof element.checkVisibility === "function") {
    try {
      return element.checkVisibility({
        checkOpacity: true,
        checkVisibilityCSS: true,
        contentVisibilityAuto: true
      });
    } catch {
      // Unsupported option set — fall through to the conservative visibility checks above.
    }
  }

  return true;
}

function getTextDebugStableAttributeEntries(element: Element): Array<[string, string]> {
  const stableAttributeNames = ["id", "data-testid", "data-test", "data-qa", "name", "role", "aria-label"];
  return stableAttributeNames
    .map((name) => [name, element.getAttribute(name)] as const)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim().length > 0);
}

function getTextDebugStableAttributes(element: Element): Record<string, string> {
  return Object.fromEntries(getTextDebugStableAttributeEntries(element));
}

function isUniqueTextSelector(element: Element, selector: string): boolean {
  const rootNode = element.getRootNode();
  const queryRoot =
    rootNode instanceof Document || rootNode instanceof ShadowRoot
      ? rootNode
      : element.ownerDocument;
  if (!queryRoot) {
    return false;
  }

  try {
    return queryRoot.querySelectorAll(selector).length === 1;
  } catch {
    return false;
  }
}

function buildPreferredTextSelector(element: Element): string | null {
  if (element.id) {
    const idSelector = `#${CSS.escape(element.id)}`;
    if (isUniqueTextSelector(element, idSelector)) {
      return idSelector;
    }
  }

  for (const stableAttribute of getTextDebugStableAttributeEntries(element)) {
    const selector = `${element.tagName.toLowerCase()}[${stableAttribute[0]}="${CSS.escape(stableAttribute[1])}"]`;
    if (isUniqueTextSelector(element, selector)) {
      return selector;
    }
  }

  return null;
}

function buildElementSelectorPath(element: Element, maxDepth = TEXT_BINDING_SELECTOR_MAX_DEPTH): string | null {
  const segments: string[] = [];
  let current: Element | null = element;

  while (current && current instanceof HTMLElement && segments.length < maxDepth) {
    const preferredSelector = buildPreferredTextSelector(current);
    if (preferredSelector) {
      segments.unshift(preferredSelector);
      return segments.join(" > ");
    }

    const tagName = current.tagName.toLowerCase();
    const parentElement: HTMLElement | null = current.parentElement;
    if (!parentElement) {
      segments.unshift(tagName);
      return segments.join(" > ");
    }

    const siblings = Array.from(parentElement.children).filter(
      (candidate: Element) => candidate.tagName.toLowerCase() === tagName
    );
    const siblingIndex = siblings.indexOf(current) + 1;
    const segment = siblings.length > 1 ? `${tagName}:nth-of-type(${siblingIndex})` : tagName;
    segments.unshift(segment);
    current = parentElement;
  }

  return segments.length > 0 ? segments.join(" > ") : null;
}

function buildAncestorSelector(element: HTMLElement): string | null {
  let current = element.parentElement;
  while (current) {
    const preferredSelector = buildPreferredTextSelector(current);
    if (preferredSelector) {
      return preferredSelector;
    }
    current = current.parentElement;
  }

  return buildElementSelectorPath(element.parentElement ?? element, TEXT_BINDING_SELECTOR_MAX_DEPTH);
}

function isSemanticTextHostElement(element: HTMLElement): boolean {
  const tagName = element.tagName.toLowerCase();
  const role = element.getAttribute("role")?.trim().toLowerCase() ?? "";
  return TEXT_HOST_TAG_NAMES.has(tagName) || role === "button" || role === "heading" || role === "link";
}

function isCustomElementTagName(tagName: string): boolean {
  return tagName.includes("-");
}

function shouldPromoteTextHostToParent(current: HTMLElement, parent: HTMLElement): boolean {
  if (isSemanticTextHostElement(parent)) {
    return true;
  }

  if (isSemanticTextHostElement(current)) {
    return false;
  }

  const currentText = normalizeTextForBinding(current.textContent ?? "");
  const parentText = normalizeTextForBinding(parent.textContent ?? "");
  if (!currentText || currentText !== parentText) {
    return false;
  }

  const parentRole = parent.getAttribute("role")?.trim().toLowerCase() ?? "";
  if (parentRole === "text") {
    return true;
  }

  const parentTagName = parent.tagName.toLowerCase();
  if (isCustomElementTagName(parentTagName)) {
    return true;
  }

  if (window.getComputedStyle(parent).display === "contents") {
    return true;
  }

  const currentTagName = current.tagName.toLowerCase();
  if (!TEXT_INLINE_WRAPPER_TAG_NAMES.has(currentTagName)) {
    return false;
  }

  return (
    TEXT_INLINE_WRAPPER_TAG_NAMES.has(parentTagName) ||
    (TEXT_HOST_PROMOTION_CONTAINER_TAG_NAMES.has(parentTagName) && parent.children.length <= 2)
  );
}

function resolveTextBindingHostElement(element: HTMLElement): HTMLElement {
  let current = element;
  let parent = current.parentElement;
  while (parent) {
    if (!shouldPromoteTextHostToParent(current, parent)) {
      break;
    }

    current = parent;
    parent = current.parentElement;
  }

  return current;
}

function resolveTextHighlightElement(element: HTMLElement): HTMLElement {
  let current = element;
  while (current.parentElement) {
    const rect = current.getBoundingClientRect();
    const style = window.getComputedStyle(current);
    const hasVisibleBox = rect.width >= 2 || rect.height >= 2;
    if (hasVisibleBox && style.display !== "contents") {
      return current;
    }

    current = current.parentElement;
  }

  return current;
}

function snapshotClientRect(rect: Pick<DOMRectReadOnly, "left" | "top" | "width" | "height">): TextRectSnapshot {
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height
  };
}

function isRenderableTextRect(rect: TextRectSnapshot | null | undefined): rect is TextRectSnapshot {
  return Boolean(rect && rect.width > 0 && rect.height > 0);
}

function isViewportRenderableTextRect(rect: TextRectSnapshot, margin = 32): boolean {
  return (
    rect.left + rect.width >= -margin &&
    rect.top + rect.height >= -margin &&
    rect.left <= window.innerWidth + margin &&
    rect.top <= window.innerHeight + margin
  );
}

function getRenderableElementClientRects(element: HTMLElement): TextRectSnapshot[] {
  return Array.from(element.getClientRects())
    .map((rect) => snapshotClientRect(rect))
    .filter((rect) => isRenderableTextRect(rect));
}

function getRenderableTextNodeClientRects(textNode: Text): TextRectSnapshot[] {
  if (!textNode.isConnected) {
    return [];
  }

  const range = document.createRange();
  range.selectNodeContents(textNode);
  const clientRects = Array.from(range.getClientRects())
    .map((rect) => snapshotClientRect(rect))
    .filter((rect) => isRenderableTextRect(rect));
  if (clientRects.length > 0) {
    return clientRects;
  }

  const boundingRect = snapshotClientRect(range.getBoundingClientRect());
  return isRenderableTextRect(boundingRect) ? [boundingRect] : [];
}

function isRuntimeTargetVisuallyRenderable(target: TextRuntimeTarget): boolean {
  return isTextBindingAttributeVisuallyRenderable(target.attributeName);
}

function supportsNativeTextHighlights(): boolean {
  return typeof Highlight !== "undefined" && typeof CSS !== "undefined" && "highlights" in CSS;
}

function canUseNativeTextPresentation(target: TextRuntimeTarget | null | undefined): boolean {
  return Boolean(target?.textNode && target.attributeName === null && supportsNativeTextHighlights());
}

function parseCssPixelValue(value: string | null | undefined): number {
  if (!value) {
    return 0;
  }

  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

let textMeasureCanvasContext: CanvasRenderingContext2D | null = null;

function getTextMeasureCanvasContext(): CanvasRenderingContext2D | null {
  if (textMeasureCanvasContext) {
    return textMeasureCanvasContext;
  }

  const canvas = document.createElement("canvas");
  textMeasureCanvasContext = canvas.getContext("2d");
  return textMeasureCanvasContext;
}

function measureRenderedTextWidth(text: string, style: CSSStyleDeclaration): number {
  if (!text) {
    return 0;
  }

  const context = getTextMeasureCanvasContext();
  if (!context) {
    return Math.max(1, text.length * 8);
  }

  context.font = style.font || `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  const metrics = context.measureText(text);
  const letterSpacing = parseCssPixelValue(style.letterSpacing);
  return metrics.width + Math.max(0, text.length - 1) * Math.max(0, letterSpacing);
}

function mapTextAlignForControl(value: string): "left" | "center" | "right" {
  const normalized = value.trim().toLowerCase();
  if (normalized === "center") {
    return "center";
  }
  if (normalized === "right" || normalized === "end") {
    return "right";
  }
  return "left";
}

function measureFormControlTextRects(
  element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  attributeName: string,
  text: string
): TextRectSnapshot[] {
  const controlRect = element.getBoundingClientRect();
  if (!isRenderableTextRect(snapshotClientRect(controlRect))) {
    return [];
  }

  if (attributeName === "placeholder" && element.value.length > 0) {
    return [];
  }

  if (attributeName === "value" && element.value.length === 0) {
    return [];
  }

  const style = window.getComputedStyle(element);
  const fontSize = parseCssPixelValue(style.fontSize) || 13;
  const lineHeight = parseCssPixelValue(style.lineHeight) || Math.round(fontSize * 1.2);
  const lines = (element instanceof HTMLTextAreaElement ? text : text.replace(/\r?\n/g, " "))
    .split(/\r?\n/)
    .map((line) => line.length > 0 ? line : " ");
  const lineWidths = lines.map((line) => measureRenderedTextWidth(line, style));

  return buildControlTextLayoutRects({
    elementRect: snapshotClientRect(controlRect),
    borderLeft: parseCssPixelValue(style.borderLeftWidth),
    borderTop: parseCssPixelValue(style.borderTopWidth),
    borderRight: parseCssPixelValue(style.borderRightWidth),
    borderBottom: parseCssPixelValue(style.borderBottomWidth),
    paddingLeft: parseCssPixelValue(style.paddingLeft),
    paddingTop: parseCssPixelValue(style.paddingTop),
    paddingRight: parseCssPixelValue(style.paddingRight),
    paddingBottom: parseCssPixelValue(style.paddingBottom),
    lineHeight,
    lineWidths,
    multiline: element instanceof HTMLTextAreaElement,
    textAlign: mapTextAlignForControl(style.textAlign),
    scrollLeft: element.scrollLeft,
    scrollTop: element.scrollTop
  }).filter((rect) => isRenderableTextRect(rect));
}

function getElementTextNodeIndexWithinHost(
  hostElement: HTMLElement,
  node: Text,
  options?: {
    originalTextLookup?: (candidate: Text) => string | null | undefined;
  }
): number {
  const walker = document.createTreeWalker(hostElement, NodeFilter.SHOW_TEXT);
  let index = 0;
  let currentNode = walker.nextNode();
  while (currentNode) {
    if (currentNode instanceof Text) {
      const parentElement = currentNode.parentElement;
      const candidateText =
        options?.originalTextLookup?.(currentNode) ??
        currentNode.textContent ??
        "";
      if (
        parentElement &&
        !isTextDebugSkippableElement(parentElement) &&
        isTextDebugPotentiallyVisibleElement(parentElement) &&
        normalizeTextForBinding(candidateText).length > 0
      ) {
        if (currentNode === node) {
          return index;
        }
        index += 1;
      }
    }
    currentNode = walker.nextNode();
  }

  return index;
}

class OverlayTerminalController {
  private host: HTMLDivElement | null = null;
  private shadowRoot: ShadowRoot | null = null;
  private streamPort: chrome.runtime.Port | null = null;
  private reconnectTimer: number | null = null;
  private streamKeepAliveTimer: number | null = null;
  private panelHeader: HTMLElement | null = null;
  private tabButtons: HTMLButtonElement[] = [];
  private consolePanel: HTMLElement | null = null;
  private chatPanel: HTMLElement | null = null;
  private textsPanel: HTMLElement | null = null;
  private consoleStatusRow: HTMLElement | null = null;
  private chatStatusRow: HTMLElement | null = null;
  private textsStatusRow: HTMLElement | null = null;
  private consoleToolRow: HTMLElement | null = null;
  private chatToolRow: HTMLElement | null = null;
  private textsToolRow: HTMLElement | null = null;
  private chatFeed: HTMLElement | null = null;
  private textsFeed: HTMLElement | null = null;
  private chatInput: HTMLInputElement | null = null;
  private chatForm: HTMLFormElement | null = null;
  private chatQueueFileInput: HTMLInputElement | null = null;
  private chatImportQueueButton: HTMLButtonElement | null = null;
  private chatSendButton: HTMLButtonElement | null = null;
  private chatResumeButton: HTMLButtonElement | null = null;
  private chatResetButton: HTMLButtonElement | null = null;

  private activityFeed: HTMLElement | null = null;
  private terminalSuggestionList: HTMLElement | null = null;
  private terminalInput: HTMLInputElement | null = null;
  private panelWindow: HTMLElement | null = null;
  private currentConfig: ExtensionConfig | null = null;
  private currentStatus: WorkerStatus | null = null;
  private aiSession: AiChatPageSession | null = null;
  private textStorageEnvelope: TextStorageEnvelope = createEmptyTextStorageEnvelope();
  private textPageMap: TextPageMap | null = null;
  private textPageMapPersisted = false;
  private readonly textTargetMap = new Map<string, TextRuntimeTarget>();
  private readonly textNodeOriginalMap = new WeakMap<Text, string>();
  private readonly textAttributeOriginalMap = new WeakMap<Element, Map<string, string>>();
  private readonly highlightedTextElements = new Set<HTMLElement>();
  private readonly textHighlightRanges = new Map<string, Range>();
  private readonly textHighlightRangeKinds = new Map<string, "source" | "changed">();
  private readonly suppressedTextAutoScanPageKeys = new Set<string>();
  private readonly textTrackedPageKeys = new Set<string>();
  private textDebugStyleElement: HTMLStyleElement | null = null;
  private textSourceHighlightHandle: TextHighlightHandle | null = null;
  private textChangedHighlightHandle: TextHighlightHandle | null = null;
  private textStatusSignature = "";
  private textToolSignature = "";
  private textFeedSignature = "";
  private textScanPromise: Promise<TextPageMap | null> | null = null;
  private textScanTimer: number | null = null;
  private textViewportScanTimer: number | null = null;
  private readonly pendingTextMutationRoots = new Set<HTMLElement>();
  private readonly pendingSuppressedTextMutationRoots = new Set<HTMLElement>();
  private readonly pendingDeferredTextMutationRetryRoots = new Set<HTMLElement>();
  private readonly deferredTextMutationRetryAttempts = new Map<HTMLElement, number>();
  private textMutationObserver: MutationObserver | null = null;
  private textObserverSuppressionDepth = 0;
  private textObserverSuppressedUntil = 0;
  private textObserverSuppressionFlushTimer: number | null = null;
  private textDeferredMutationRetryTimer: number | null = null;
  private textStateHydrated = false;
  private inlineTextEditor:
    | {
        bindingId: string;
        editor: HTMLElement;
        target: TextRuntimeTarget;
        readValue: () => string;
        restoreTextNode?: Text;
        cleanup: () => void;
      }
    | null = null;
  private runtimeLogs: LogEntry[] = [];
  private consoleEntries: OverlayConsoleEntry[] = [];
  private runtimeLogSequences = new Map<string, number>();
  private activityOpenState = new Map<string, boolean>();
  private visibleActivitySequenceFloor = 0;
  private currentSuggestions: string[] = [];
  private selectedSuggestionIndex = -1;
  private nextActivitySequence = 0;
  private activeTab: OverlayTab = "console";
  private chatQueueImportInProgress = false;
  private readonly pageViewId = crypto.randomUUID();
  private visible = false;
  private consoleStatusSignature = "";
  private chatStatusSignature = "";
  private documentCursorRestoreValue: string | null = null;
  private pendingOverlayGeometry: OverlayGeometry | null = null;
  private resizeState:
    | {
        pointerId: number;
        direction: OverlayResizeHandle;
        originX: number;
        originY: number;
        startGeometry: OverlayGeometry;
        moved: boolean;
      }
    | null = null;
  private dragState:
    | {
        pointerId: number;
        originX: number;
        originY: number;
        startLeft: number;
        startTop: number;
        moved: boolean;
      }
    | null = null;

  constructor() {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      void this.handleMessage(message)
        .then((response) => sendResponse(response))
        .catch((error) => {
          sendResponse(
            createErrorResponse(
              crypto.randomUUID(),
              "content_error",
              error instanceof Error ? error.message : String(error)
            )
          );
        });
      return true;
    });

    window.addEventListener("keydown", this.handleCapturedKeyboardEvent, true);
    window.addEventListener("keyup", this.handleCapturedKeyboardEvent, true);
    window.addEventListener("keypress", this.handleCapturedKeyboardEvent, true);
    document.addEventListener("contextmenu", this.handleDocumentTextContextMenu, true);
    chrome.storage.onChanged.addListener(this.handleStorageChanged);
    void this.bootstrapContentState();
  }

  async handleMessage(message: unknown) {
    const envelope = validateEnvelope(message);

    if (envelope.action === COMMANDS.overlayProbe) {
      return createOkResponse(envelope.id, {
        ready: true,
        visible: this.visible
      });
    }

    if (envelope.action === COMMANDS.overlayOpen) {
      await this.open();
      return createOkResponse(envelope.id, { opened: true });
    }

    if (envelope.action === COMMANDS.overlayClose) {
      await this.close(false);
      return createOkResponse(envelope.id, { closed: true });
    }

    return createErrorResponse(
      envelope.id,
      "unsupported_action",
      `Неподдерживаемое действие контент-скрипта: ${envelope.action}`
    );
  }

  async open(): Promise<void> {
    this.ensureDom();
    this.visible = true;
    this.host?.style.setProperty("display", "block");
    this.pushConsole("system", "Оверлейный терминал открыт. Введите help, чтобы увидеть команды.");
    await this.patchOverlaySessionConfig({
      visible: true
    });
    await this.ensureStream();
    await this.loadSnapshot();
    const shouldCenterOnOpen = this.shouldCenterPanelOnOpen();
    await this.loadAiSnapshot();
    await this.ensureTextElementsHydrated({
      reason: "overlay-open",
      logSummary: false
    });
    if (shouldCenterOnOpen) {
      const centeredGeometry = this.centerPanelInViewport();
      if (centeredGeometry) {
        await this.patchOverlayLocalConfig({
          left: centeredGeometry.left,
          top: centeredGeometry.top
        });
      }
    } else {
      await this.clampPanelIntoViewport();
    }
    this.focusPreferredOverlayElement();
    await recordLog("content", "overlay.open", "Оверлейный терминал открыт.");
  }

  async close(recordClose = true): Promise<void> {
    this.visible = false;
    this.resizeState = null;
    this.panelWindow?.classList.remove("is-resizing");
    this.setDocumentCursor(null);
    this.host?.style.setProperty("display", "none");
    this.disconnectStream();
    await this.patchOverlaySessionConfig({
      visible: false
    });
    this.updateTextObservationState();
    if (recordClose) {
      await recordLog("content", "overlay.close", "Оверлейный терминал закрыт.");
    }
  }

  private ensureDom(): void {
    if (this.host) {
      return;
    }

    this.host = document.createElement("div");
    this.host.id = "lextrace-overlay-root";
    this.host.style.position = "fixed";
    this.host.style.inset = "0";
    this.host.style.zIndex = "2147483647";
    this.host.style.pointerEvents = "none";
    this.host.style.display = "none";

    this.shadowRoot = this.host.attachShadow({
      mode: "open"
    });

    const style = document.createElement("style");
    style.textContent = overlayStyles;

    const wrapper = document.createElement("div");
    wrapper.className = "overlay-window";
    wrapper.innerHTML = `
      <div class="panel-shell">
        <header class="panel-header">
          <div>
            <p class="panel-kicker">Оверлей страницы</p>
            <h1>Терминал LexTrace</h1>
          </div>
          <button type="button" class="close-button" data-close="true">Закрыть</button>
        </header>
        <nav class="overlay-tab-strip" data-role="overlay-tabs">
          <button type="button" class="overlay-tab-button is-active" data-tab="console">Консоль</button>
          <button type="button" class="overlay-tab-button" data-tab="chat">Чат</button>
          <button type="button" class="overlay-tab-button" data-tab="texts">Тексты</button>
        </nav>
        <div class="tab-surface is-active" data-panel="console">
          <div class="status-row" data-role="console-status-row"></div>
          <div class="tool-row" data-role="console-tool-row"></div>
          <section class="panel-body console-body">
            <div class="activity-feed" data-role="activity-feed"></div>
            <form class="terminal-form" data-role="terminal-form">
              <span class="prompt-label">NT3&gt;</span>
              <div class="terminal-input-shell">
                <div class="terminal-suggestion-list is-hidden" data-role="terminal-suggestions"></div>
                <input class="terminal-input" data-role="terminal-input" spellcheck="false" autocomplete="off" />
              </div>
            </form>
          </section>
        </div>
        <div class="tab-surface chat-surface" data-panel="chat">
          <div class="status-row" data-role="chat-status-row"></div>
          <section class="panel-body chat-body">
            <div class="chat-feed" data-role="chat-feed"></div>
            <form class="chat-form" data-role="chat-form">
              <span class="prompt-label">AI&gt;</span>
              <div class="chat-input-shell">
                <input class="chat-input" data-role="chat-input" spellcheck="false" autocomplete="off" />
              </div>
              <input
                type="file"
                class="chat-queue-file-input"
                data-role="chat-queue-file"
                accept=".json,application/json"
              />
              <div class="tool-row chat-tool-row" data-role="chat-tool-row">
                <button
                  type="button"
                  class="tool-icon"
                  data-role="chat-import-queue"
                  data-tooltip="Загрузить очередь JSON"
                  aria-label="Загрузить очередь JSON"
                >
                  <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                    <path d="M8 3.25v6.5" />
                    <path d="m5.5 7.75 2.5 2.5 2.5-2.5" />
                    <path d="M3.5 11.75h9" />
                  </svg>
                </button>
                <button
                  type="button"
                  class="tool-icon"
                  data-role="chat-send"
                  data-tooltip="Отправить"
                  aria-label="Отправить"
                >
                  <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                    <path d="M2.5 8h9" />
                    <path d="m8.75 4.25 3.75 3.75-3.75 3.75" />
                  </svg>
                </button>
                <button
                  type="button"
                  class="tool-icon"
                  data-role="chat-resume"
                  data-tooltip="Продолжить"
                  aria-label="Продолжить"
                >
                  <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                    <path d="M5.25 3.5v9l6-4.5-6-4.5Z" fill="currentColor" stroke="none" />
                  </svg>
                </button>
                <button
                  type="button"
                  class="tool-icon"
                  data-role="chat-reset"
                  data-tooltip="Сбросить"
                  aria-label="Сбросить"
                >
                  <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                    <path d="M5 3.75H2.5v2.5" />
                    <path d="M2.75 6.25A5.25 5.25 0 1 0 4.5 3.9" />
                  </svg>
                </button>
              </div>
            </form>
          </section>
        </div>
        <div class="tab-surface texts-surface" data-panel="texts">
          <div class="status-row" data-role="texts-status-row"></div>
          <div class="tool-row" data-role="texts-tool-row"></div>
          <section class="panel-body texts-body">
            <div class="texts-feed" data-role="texts-feed"></div>
          </section>
        </div>
        <div class="overlay-resize-handle overlay-resize-handle--n" data-resize-handle="n" aria-hidden="true"></div>
        <div class="overlay-resize-handle overlay-resize-handle--s" data-resize-handle="s" aria-hidden="true"></div>
        <div class="overlay-resize-handle overlay-resize-handle--e" data-resize-handle="e" aria-hidden="true"></div>
        <div class="overlay-resize-handle overlay-resize-handle--w" data-resize-handle="w" aria-hidden="true"></div>
        <div class="overlay-resize-handle overlay-resize-handle--ne" data-resize-handle="ne" aria-hidden="true"></div>
        <div class="overlay-resize-handle overlay-resize-handle--nw" data-resize-handle="nw" aria-hidden="true"></div>
        <div class="overlay-resize-handle overlay-resize-handle--se" data-resize-handle="se" aria-hidden="true"></div>
        <div class="overlay-resize-handle overlay-resize-handle--sw" data-resize-handle="sw" aria-hidden="true"></div>
      </div>
    `;

    this.shadowRoot.append(style, wrapper);
    document.documentElement.appendChild(this.host);

    this.panelWindow = wrapper.querySelector<HTMLElement>(".panel-shell");
    this.panelHeader = wrapper.querySelector<HTMLElement>(".panel-header");
    this.consolePanel = wrapper.querySelector<HTMLElement>("[data-panel='console']");
    this.chatPanel = wrapper.querySelector<HTMLElement>("[data-panel='chat']");
    this.textsPanel = wrapper.querySelector<HTMLElement>("[data-panel='texts']");
    this.consoleStatusRow = wrapper.querySelector<HTMLElement>("[data-role='console-status-row']");
    this.chatStatusRow = wrapper.querySelector<HTMLElement>("[data-role='chat-status-row']");
    this.textsStatusRow = wrapper.querySelector<HTMLElement>("[data-role='texts-status-row']");
    this.consoleToolRow = wrapper.querySelector<HTMLElement>("[data-role='console-tool-row']");
    this.chatToolRow = wrapper.querySelector<HTMLElement>("[data-role='chat-tool-row']");
    this.textsToolRow = wrapper.querySelector<HTMLElement>("[data-role='texts-tool-row']");
    this.activityFeed = wrapper.querySelector<HTMLElement>("[data-role='activity-feed']");
    this.chatFeed = wrapper.querySelector<HTMLElement>("[data-role='chat-feed']");
    this.textsFeed = wrapper.querySelector<HTMLElement>("[data-role='texts-feed']");
    this.terminalSuggestionList = wrapper.querySelector<HTMLElement>("[data-role='terminal-suggestions']");
    this.terminalInput = wrapper.querySelector<HTMLInputElement>("[data-role='terminal-input']");
    this.chatInput = wrapper.querySelector<HTMLInputElement>("[data-role='chat-input']");
    this.chatForm = wrapper.querySelector<HTMLFormElement>("[data-role='chat-form']");
    this.chatQueueFileInput = wrapper.querySelector<HTMLInputElement>("[data-role='chat-queue-file']");
    this.chatImportQueueButton = wrapper.querySelector<HTMLButtonElement>("[data-role='chat-import-queue']");
    this.chatSendButton = wrapper.querySelector<HTMLButtonElement>("[data-role='chat-send']");
    this.chatResumeButton = wrapper.querySelector<HTMLButtonElement>("[data-role='chat-resume']");
    this.chatResetButton = wrapper.querySelector<HTMLButtonElement>("[data-role='chat-reset']");
    this.tabButtons = Array.from(wrapper.querySelectorAll<HTMLButtonElement>(".overlay-tab-button"));
    Array.from(wrapper.querySelectorAll<HTMLElement>("[data-resize-handle]")).forEach((handle) => {
      const direction = handle.dataset.resizeHandle as OverlayResizeHandle | undefined;
      if (!direction) {
        return;
      }

      handle.addEventListener("pointerdown", (event) => {
        this.beginResize(event, direction, handle);
      });
      handle.addEventListener("pointermove", (event) => {
        this.updateResize(event);
      });
      handle.addEventListener("pointerup", (event) => {
        void this.endResize(event, handle);
      });
      handle.addEventListener("pointercancel", (event) => {
        void this.endResize(event, handle);
      });
    });

    if (this.panelWindow) {
      this.panelWindow.tabIndex = 0;
      this.panelWindow.addEventListener("pointerdown", (event) => {
        if (!this.isInteractiveElement(event.target)) {
          this.panelWindow?.focus();
        }
      });
      for (const eventName of [
        "pointerdown",
        "pointermove",
        "pointerup",
        "pointercancel",
        "mousedown",
        "mousemove",
        "mouseup",
        "click",
        "dblclick"
      ]) {
        this.panelWindow.addEventListener(eventName, this.handleOverlayPointerEvent);
      }
      this.panelWindow.addEventListener("contextmenu", this.handleOverlayPointerEvent);
      this.panelWindow.addEventListener("wheel", this.handleOverlayWheelEvent, {
        passive: false
      });
    }

    this.panelHeader?.addEventListener("pointerdown", (event) => {
      this.beginDrag(event);
    });
    this.panelHeader?.addEventListener("pointermove", (event) => {
      this.updateDrag(event);
    });
    this.panelHeader?.addEventListener("pointerup", (event) => {
      void this.endDrag(event);
    });
    this.panelHeader?.addEventListener("pointercancel", (event) => {
      void this.endDrag(event);
    });

    wrapper.querySelector<HTMLButtonElement>("[data-close='true']")?.addEventListener("click", () => {
      void this.close();
    });

    wrapper.querySelector<HTMLFormElement>("[data-role='terminal-form']")?.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.executeCommand();
    });
    this.chatForm?.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.sendChatMessage();
    });
    this.chatSendButton?.addEventListener("click", () => {
      void this.sendChatMessage();
    });
    this.chatImportQueueButton?.addEventListener("click", () => {
      this.openChatQueueImportPicker();
    });
    this.chatQueueFileInput?.addEventListener("change", () => {
      void this.handleChatQueueFileSelection();
    });
    this.chatResumeButton?.addEventListener("click", () => {
      void this.resumeChat();
    });
    this.chatResetButton?.addEventListener("click", () => {
      void this.resetChat();
    });
    this.tabButtons.forEach((button) => {
      button.addEventListener("click", () => {
        this.setActiveTab((button.dataset.tab as OverlayTab | undefined) ?? "console", true, true);
      });
    });

    this.terminalInput?.addEventListener("focus", () => {
      this.refreshTerminalSuggestions();
    });
    this.terminalInput?.addEventListener("blur", () => {
      window.setTimeout(() => {
        if (this.shadowRoot?.activeElement !== this.terminalInput) {
          this.closeTerminalSuggestions();
        }
      }, 0);
    });
    this.terminalInput?.addEventListener("input", () => {
      this.refreshTerminalSuggestions();
    });
    this.chatInput?.addEventListener("input", () => {
      this.renderChatToolRow();
    });
  }

  private async ensureStream(): Promise<void> {
    if (this.streamPort) {
      this.subscribeCurrentPageToStream();
      return;
    }

    this.streamPort = connectRuntimeStream((message) => {
      void this.handleStreamMessage(message as ExtensionStreamMessage & Record<string, unknown>).catch((error) => {
        void recordLog("content", "overlay.stream.invalid", "Некорректное stream-сообщение проигнорировано.", {
          error
        }, "warn");
      });
    });
    this.subscribeCurrentPageToStream();
    this.startStreamKeepAlive();

    this.streamPort.onDisconnect.addListener(() => {
      this.streamPort = null;
      this.stopStreamKeepAlive();
      if (!this.visible) {
        return;
      }
      this.pushConsole("error", "Поток среды выполнения отключён. Повторное подключение…");
      if (this.reconnectTimer) {
        window.clearTimeout(this.reconnectTimer);
      }
      this.reconnectTimer = window.setTimeout(() => {
        void this.ensureStream();
      }, 1000);
    });
  }

  private disconnectStream(): void {
    if (this.reconnectTimer) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopStreamKeepAlive();
    this.streamPort?.disconnect();
    this.streamPort = null;
  }

  private startStreamKeepAlive(): void {
    if (this.streamKeepAliveTimer !== null) {
      return;
    }

    this.streamKeepAliveTimer = window.setInterval(() => {
      try {
        this.streamPort?.postMessage({
          type: "keepalive"
        });
      } catch {
        // Reconnect logic is driven by port.onDisconnect.
      }
    }, 15000);
  }

  private stopStreamKeepAlive(): void {
    if (this.streamKeepAliveTimer === null) {
      return;
    }

    window.clearInterval(this.streamKeepAliveTimer);
    this.streamKeepAliveTimer = null;
  }

  private async loadSnapshot(): Promise<void> {
    const snapshot = await sendCommand<{
      config: ExtensionConfig;
      workerStatus: WorkerStatus;
      logs: LogEntry[];
    }>(COMMANDS.configGet, "overlay", "background");

    this.applySnapshot({
      config: ExtensionConfigSchema.parse(snapshot.config),
      status: parseRuntimeWorkerStatus(snapshot),
      logs: snapshot.logs.map((entry) => LogEntrySchema.parse(entry))
    });
  }

  private async loadAiSnapshot(): Promise<void> {
    const pageContext = this.getCurrentPageContext();
    if (!pageContext) {
      this.aiSession = null;
      this.render();
      return;
    }

    try {
      const snapshot = await sendCommand<{ session: AiChatPageSession }>(
        COMMANDS.aiChatStatus,
        "overlay",
        "background",
        {
          pageKey: pageContext.pageKey,
          pageUrl: pageContext.pageUrl
        }
      );
      this.aiSession = AiChatPageSessionSchema.parse(snapshot.session);
      this.render();
    } catch (error) {
      const message = formatUserFacingCommandError(error, "Не удалось загрузить состояние AI-чата.");
      this.aiSession = {
        pageKey: pageContext.pageKey,
        pageUrlSample: pageContext.pageUrl,
        attachedViewIds: [],
        state: "error",
        activeRequestId: null,
        openaiResponseId: null,
        lastSequenceNumber: null,
        queuedCount: 0,
        recoverable: false,
        lastCheckpointAt: null,
        lastError: message,
        messages: [],
        queue: [],
        status: {
          ...createDefaultAiStatus(pageContext.pageKey, pageContext.pageUrl, false),
          requestState: "error",
          lastError: message
        }
      };
      this.render();
    }
  }

  private async handleStreamMessage(message: ExtensionStreamMessage & Record<string, unknown>): Promise<void> {
    if (message.stream === "ai") {
      await this.handleAiStreamMessage(message as AiStreamMessage);
      return;
    }

    if (message.event === "runtime.snapshot") {
      this.applySnapshot({
        config: ExtensionConfigSchema.parse(message.config),
        status: parseRuntimeWorkerStatus(message),
        logs: Array.isArray(message.logs)
          ? message.logs.map((entry) => LogEntrySchema.parse(entry))
          : this.runtimeLogs
      });
      return;
    }

    if (message.event === "runtime.status") {
      this.currentStatus = parseRuntimeWorkerStatus(message);
      this.renderConsoleStatus();
      return;
    }

    if (message.event === "runtime.config" && message.config) {
      this.currentConfig = this.reconcileIncomingOverlayGeometry(ExtensionConfigSchema.parse(message.config));
      this.applyGeometry(this.currentConfig);
      this.render();
      void this.ensureTextElementsHydrated({
        reason: "runtime-config",
        logSummary: false
      });
      return;
    }

    if (message.event === "runtime.log" && message.logEntry) {
      const entry = LogEntrySchema.parse(message.logEntry);
      this.setRuntimeLogs([...this.runtimeLogs.slice(-399), entry]);
      this.renderActivityFeed();
    }
  }

  private async handleAiStreamMessage(message: AiStreamMessage): Promise<void> {
    const currentPageContext = this.getCurrentPageContext();
    if (!currentPageContext || message.pageKey !== currentPageContext.pageKey) {
      return;
    }

    const shouldReloadTranscriptFromSnapshot =
      message.event === "ai.chat.snapshot" ||
      message.event === "ai.chat.completed" ||
      message.event === "ai.chat.error" ||
      message.event === "ai.chat.compaction.started" ||
      message.event === "ai.chat.compaction.completed";

    if (message.session) {
      this.aiSession = AiChatPageSessionSchema.parse(message.session);
      this.renderChat();
      return;
    }

    if (this.aiSession && message.status) {
      this.aiSession = {
        ...this.aiSession,
        status: message.status,
        state: message.status.requestState,
        activeRequestId: message.status.activeRequestId,
        openaiResponseId: message.status.openaiResponseId,
        lastSequenceNumber: message.status.lastSequenceNumber,
        queuedCount: message.status.queueCount,
        recoverable: message.status.recoverable,
        lastError: message.status.lastError
      };
      if (shouldReloadTranscriptFromSnapshot) {
        await this.loadAiSnapshot();
        return;
      }
      this.renderChatStatus();
      this.renderChatToolRow();
      return;
    }

    await this.loadAiSnapshot();
  }

  private applySnapshot(snapshot: RuntimeSnapshot): void {
    this.currentConfig = this.reconcileIncomingOverlayGeometry(snapshot.config);
    this.currentStatus = snapshot.status;
    this.setRuntimeLogs(snapshot.logs);
    this.applyGeometry(this.currentConfig);
    this.render(true);
    this.updateTextObservationState();
  }

  private render(forceActivityScroll = false): void {
    if (this.currentConfig) {
      this.activeTab = this.currentConfig.ui.overlay.activeTab;
    }
    this.renderConsoleStatus();
    this.renderConsoleToolRow();
    this.renderActivityFeed(forceActivityScroll);
    this.renderChat();
    this.renderTexts();
    this.setActiveTab(this.activeTab, false);
  }

  private renderConsoleStatus(): void {
    if (!this.consoleStatusRow || !this.currentStatus) {
      this.consoleStatusSignature = "";
      return;
    }

    const descriptors = buildStatusChipDescriptors("console", [
      {
        key: "состояние",
        value: this.currentStatus.running ? "в работе" : "остановлен"
      },
      {
        key: "хост",
        value: this.currentStatus.hostConnected ? "подключён" : "отключён"
      },
      {
        key: "запуск",
        value: this.currentStatus.bootId.slice(0, 8),
        fullValue: this.currentStatus.bootId
      },
      {
        key: "сессия",
        value: this.currentStatus.sessionId ?? "-"
      },
      {
        key: "задача",
        value: this.currentStatus.taskId ?? "-"
      },
      {
        key: "пульс",
        value: this.currentStatus.lastHeartbeatAt ?? "-"
      }
    ]);
    const signature = getStatusDescriptorSignature(descriptors);
    if (signature === this.consoleStatusSignature) {
      return;
    }
    this.consoleStatusSignature = signature;

    this.consoleStatusRow.replaceChildren(
      createStatusRowShell(descriptors, [
        createStatusActionButton({
          tooltip: "Скачать лог консоли",
          dataRole: "console-export-log",
          onClick: () => {
            void this.downloadConsoleLog();
          }
        })
      ])
    );
  }

  private renderConsoleToolRow(): void {
    if (!this.consoleToolRow) {
      return;
    }

    this.consoleToolRow.replaceChildren();
    this.consoleToolRow.classList.add("is-collapsed");
  }

  private renderChat(): void {
    this.renderChatStatus();
    this.renderChatToolRow();
    this.renderChatFeed();
  }

  private renderChatStatus(): void {
    if (!this.chatStatusRow) {
      this.chatStatusSignature = "";
      return;
    }

    const pageContext = this.getCurrentPageContext();
    const session = this.aiSession;
    const status = session?.status ?? (pageContext ? createDefaultAiStatus(pageContext.pageKey, pageContext.pageUrl, false) : null);
    if (!status) {
      this.chatStatusSignature = "";
      this.chatStatusRow.replaceChildren();
      return;
    }

    const descriptors = buildStatusChipDescriptors(
      "chat",
      buildAiChatStatusFragments(status).map(([key, value]) => ({
        key,
        value: key === "page" ? shortenPageKey(value) : value,
        fullValue: value
      }))
    );
    const signature = getStatusDescriptorSignature(descriptors);
    if (signature === this.chatStatusSignature) {
      return;
    }
    this.chatStatusSignature = signature;

    this.chatStatusRow.replaceChildren(
      createStatusRowShell(descriptors, [
        createStatusActionButton({
          tooltip: "Скачать лог чата",
          dataRole: "chat-export-log",
          onClick: () => {
            void this.downloadChatLog();
          }
        })
      ])
    );
  }

  private async downloadConsoleLog(): Promise<void> {
    try {
      const exportedAt = new Date().toISOString();
      const pageContext = this.getCurrentPageContext();
      const payload = buildConsoleLogExportPayload({
        exportedAt,
        pageContext,
        workerStatus: this.currentStatus,
        currentConfig: this.currentConfig,
        consoleEntries: this.consoleEntries,
        runtimeLogs: this.runtimeLogs,
        runtimeLogSequences: this.runtimeLogSequences,
        visibleActivitySequenceFloor: this.visibleActivitySequenceFloor
      });
      const fileName = formatLogExportFileName("console", exportedAt, pageContext?.pageKey ?? null);
      this.downloadJsonFile(fileName, payload);
      await recordLog("content", "console.log.export", "Лог консоли выгружен.", {
        fileName,
        consoleEntryCount: payload.consoleEntries.length,
        runtimeLogCount: payload.runtimeLogs.length,
        visibleActivityCount: payload.visibleActivityFeed.length
      });
    } catch (error) {
      this.pushConsole("error", formatUserFacingCommandError(error, "Не удалось выгрузить лог консоли."));
      await recordLog("content", "console.log.export.failed", "Не удалось выгрузить лог консоли.", serializeLogDetails(error), "error");
    }
  }

  private async downloadChatLog(): Promise<void> {
    try {
      const exportedAt = new Date().toISOString();
      const pageContext = this.getCurrentPageContext();
      const payload = buildChatLogExportPayload({
        exportedAt,
        pageContext,
        currentConfig: this.currentConfig,
        session: this.aiSession
      });
      const fileName = formatLogExportFileName(
        "chat",
        exportedAt,
        this.aiSession?.pageKey ?? pageContext?.pageKey ?? null
      );
      this.downloadJsonFile(fileName, payload);
      await recordLog("content", "chat.log.export", "Лог чата выгружен.", {
        fileName,
        pageKey: this.aiSession?.pageKey ?? pageContext?.pageKey ?? null,
        messageCount: this.aiSession?.messages.length ?? 0,
        transcriptItemCount: payload.transcriptItems.length
      });
    } catch (error) {
      this.pushConsole("error", formatUserFacingCommandError(error, "Не удалось выгрузить лог чата."));
      await recordLog("content", "chat.log.export.failed", "Не удалось выгрузить лог чата.", serializeLogDetails(error), "error");
    }
  }

  private downloadJsonFile(fileName: string, payload: unknown): void {
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json;charset=utf-8"
    });
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = fileName;
    link.rel = "noopener";
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => {
      URL.revokeObjectURL(objectUrl);
    }, 0);
  }

  private renderChatToolRow(): void {
    const status = this.aiSession?.status;
    const chatInputValue = this.chatInput?.value.trim() ?? "";
    const configuredModel = status?.model?.model ?? this.currentConfig?.ai.chat.model?.model ?? "";
    const canSendFromInput = configuredModel.trim().length > 0 && chatInputValue.length > 0;
    const canImportQueue = Boolean(this.getCurrentPageContext());

    if (this.chatImportQueueButton) {
      this.chatImportQueueButton.hidden = !canImportQueue;
      this.chatImportQueueButton.disabled = this.chatQueueImportInProgress;
      const tooltip = this.chatQueueImportInProgress ? "Импорт очереди JSON…" : "Загрузить очередь JSON";
      this.chatImportQueueButton.dataset.tooltip = tooltip;
      this.chatImportQueueButton.setAttribute("aria-label", tooltip);
    }

    if (this.chatSendButton) {
      this.chatSendButton.hidden = !canSendFromInput;
    }
    if (this.chatResumeButton) {
      this.chatResumeButton.hidden = !(status?.availableActions.canResume ?? false);
    }
    if (this.chatResetButton) {
      this.chatResetButton.hidden = !(status?.availableActions.canReset ?? false);
    }

    if (this.chatToolRow) {
      const hasVisibleActions = [
        this.chatImportQueueButton,
        this.chatSendButton,
        this.chatResumeButton,
        this.chatResetButton
      ].some((button) => button && !button.hidden);
      this.chatToolRow.classList.toggle("is-collapsed", !hasVisibleActions);
    }
  }

  private renderChatFeed(): void {
    if (!this.chatFeed) {
      return;
    }

    const shouldStickToBottom = this.isChatFeedPinnedToBottom();
    const previousScrollTop = this.chatFeed.scrollTop;
    const transcriptItems = buildAiChatTranscriptItems(
      this.aiSession?.messages ?? [],
      this.currentConfig?.ai.chat.instructions ?? ""
    );
    this.chatFeed.replaceChildren(
      ...transcriptItems.map((item) => this.createChatTranscriptElement(item))
    );
    if (shouldStickToBottom) {
      this.scrollChatFeedToEnd();
      return;
    }

    this.chatFeed.scrollTop = previousScrollTop;
  }

  private createChatTranscriptElement(item: AiChatTranscriptItem): HTMLElement {
    switch (item.type) {
      case "system-prompt":
        return this.createChatSystemPromptElement(item);
      case "compacted-range":
        return this.createChatCompactedRangeElement(item);
      case "compaction-request":
        return this.createChatCompactionEventElement(
          item.message,
          "Запрос сжатия",
          `Сжимаются ${item.meta?.affectedMessageIds.length ?? 0} сообщений`,
          item.meta?.instructionsText ?? ""
        );
      case "compaction-result":
        return this.createChatCompactionEventElement(
          item.message,
          "Результат сжатия",
          `Сжато в ${item.meta?.compactedItemCount ?? 0} элементов, сохранён хвост ${item.meta?.preservedTailCount ?? 0}`,
          item.meta?.resultPreviewText ?? ""
        );
      case "message":
      default:
        return this.createChatMessageElement(item.message, item.dimmed);
    }
  }

  private createChatSystemPromptElement(item: Extract<AiChatTranscriptItem, { type: "system-prompt" }>): HTMLElement {
    const card = this.createChatEntryShell("system-prompt", "промпт", "Системный промпт");
    const note = document.createElement("div");
    note.className = "chat-entry-note";
    note.textContent = "Текущие инструкции";

    const bodyText = document.createElement("div");
    bodyText.className = `chat-entry-content${item.isEmpty ? " is-placeholder" : ""}`;
    bodyText.textContent = item.isEmpty ? "Пусто" : item.promptText;

    card.querySelector(".chat-entry-body")?.append(note, bodyText);
    return card;
  }

  private createChatCompactedRangeElement(
    item: Extract<AiChatTranscriptItem, { type: "compacted-range" }>
  ): HTMLElement {
    const details = document.createElement("details");
    details.className = "chat-range";

    const summary = document.createElement("summary");
    summary.className = "chat-range-summary";

    const badge = document.createElement("span");
    badge.className = "chat-range-badge";
    badge.textContent = "архив";

    const title = document.createElement("span");
    title.className = "chat-range-title";
    title.textContent = `Сжатый фрагмент · ${item.messages.length} сообщений`;

    summary.append(badge, title);

    const body = document.createElement("div");
    body.className = "chat-range-body";
    body.append(...item.messages.map((message) => this.createChatMessageElement(message, true)));

    details.append(summary, body);
    return details;
  }

  private createChatCompactionEventElement(
    message: AiChatMessage,
    titleText: string,
    summaryText: string,
    bodyTextValue: string
  ): HTMLElement {
    const card = this.createChatEntryShell("compaction", "сжатие", `${titleText} • ${new Date(message.ts).toLocaleTimeString()}`);
    card.classList.add(`state-${message.state}`);

    const note = document.createElement("div");
    note.className = "chat-entry-note";
    note.textContent = summaryText;

    const bodyText = document.createElement("div");
    const text = bodyTextValue.trim();
    bodyText.className = `chat-entry-content${text ? "" : " is-placeholder"}`;
    bodyText.textContent = text || "Пусто";

    card.querySelector(".chat-entry-body")?.append(note, bodyText);
    return card;
  }

  private createChatMessageElement(message: AiChatMessage, dimmed = false): HTMLElement {
    const baseCard = this.createChatEntryShell(
      message.kind,
      formatAiEventKindLabel(message.kind),
      `${formatAiMessageOriginLabel(message.origin)} • ${new Date(message.ts).toLocaleTimeString()}`
    );
    baseCard.classList.add(`state-${message.state}`);
    if (dimmed) {
      baseCard.classList.add("is-dimmed");
    }

    const bodyText = document.createElement("div");
    bodyText.className = "chat-entry-content";
    bodyText.textContent = getAiMessageDisplayText(message);
    baseCard.querySelector(".chat-entry-body")?.append(bodyText);
    return baseCard;
  }

  private createChatEntryShell(kindClass: string, badgeText: string, metaText: string): HTMLElement {
    const card = document.createElement("article");
    card.className = `chat-entry kind-${kindClass}`;

    const header = document.createElement("div");
    header.className = "chat-entry-header";

    const badge = document.createElement("span");
    badge.className = "chat-entry-badge";
    badge.textContent = badgeText;

    const meta = document.createElement("span");
    meta.className = "chat-entry-meta";
    meta.textContent = metaText;

    const body = document.createElement("div");
    body.className = "chat-entry-body";

    header.append(badge, meta);
    card.append(header, body);
    return card;
  }

  private renderTexts(): void {
    this.renderTextsStatus();
    this.renderTextsToolRow();
    if (this.activeTab === "texts") {
      this.renderTextsFeed();
    }
  }

  private renderTextsStatus(): void {
    if (!this.textsStatusRow) {
      this.textStatusSignature = "";
      return;
    }

    const pageContext = this.getCurrentPageContext();
    const pageMap = this.textPageMap;
    const summary = buildTextMapSummary(pageMap);
    const displayMode = this.getTextDisplayMode();
    const descriptors = buildStatusChipDescriptors("texts", [
      {
        key: "page",
        value: pageContext ? shortenPageKey(pageContext.pageKey) : "n/a",
        fullValue: pageContext?.pageKey ?? window.location.href
      },
      {
        key: "mode",
        value: displayMode,
        fullValue: displayMode
      },
      {
        key: "store",
        value: this.textPageMapPersisted ? "saved" : "runtime",
        fullValue: this.textPageMapPersisted ? "persisted page map" : "runtime-only baseline"
      },
      {
        key: "items",
        value: String(summary.total),
        fullValue: `${summary.total} text bindings`
      },
      {
        key: "live",
        value: String(summary.live),
        fullValue: `${summary.live} live bindings`
      },
      {
        key: "stale",
        value: String(summary.stale),
        fullValue: `${summary.stale} stale bindings`
      },
      {
        key: "changed",
        value: String(summary.changed),
        fullValue: `${summary.changed} changed bindings`
      },
      {
        key: "scan",
        value: pageMap?.lastScanAt ? new Date(pageMap.lastScanAt).toLocaleTimeString() : "-",
        fullValue: pageMap?.lastScanAt ?? "not scanned"
      }
    ]);
    const signature = getStatusDescriptorSignature(descriptors);
    if (signature === this.textStatusSignature) {
      return;
    }
    this.textStatusSignature = signature;

    this.textsStatusRow.replaceChildren(
      createStatusRowShell(descriptors, [
        createStatusActionButton({
          tooltip: "Скачать карту текстов JSON",
          dataRole: "texts-export-json",
          disabled: !pageContext || !pageMap,
          onClick: () => {
            void this.downloadTextMap();
          }
        })
      ])
    );
  }

  private renderTextsToolRow(): void {
    if (!this.textsToolRow) {
      this.textToolSignature = "";
      return;
    }

    const pageContext = this.getCurrentPageContext();
    const inlineEditingEnabled = this.currentConfig?.debug.textElements.inlineEditingEnabled ?? false;
    const nextSignature = JSON.stringify({
      pageKey: pageContext?.pageKey ?? null,
      inlineEditingEnabled,
      hasPageMap: Boolean(this.textPageMap),
      hasChangedBindings: Boolean(this.textPageMap && this.textPageMap.bindings.some((binding) => binding.changed))
    });
    if (nextSignature === this.textToolSignature) {
      return;
    }
    this.textToolSignature = nextSignature;
    const buttons: HTMLButtonElement[] = [];

    if (pageContext) {
      buttons.push(
        createToolIconButton({
          tooltip: "Пересканировать тексты страницы",
          icon: TEXT_SCAN_ICON,
          dataRole: "texts-scan",
          onClick: () => {
            void this.handleTextScanCommand(true);
          }
        }),
        createToolIconButton({
          tooltip: inlineEditingEnabled
            ? "Inline-редактирование включено: правый клик по тексту"
            : "Inline-редактирование выключено, включи debug.textElements.inlineEditingEnabled",
          icon: TEXT_EDIT_ICON,
          dataRole: "texts-inline-editing",
          disabled: false,
          onClick: () => {}
        }),
        createToolIconButton({
          tooltip: "Скачать JSON карты текстов",
          icon: TEXT_DOWNLOAD_ICON,
          dataRole: "texts-download",
          disabled: !this.textPageMap,
          onClick: () => {
            void this.downloadTextMap();
          }
        }),
        createToolIconButton({
          tooltip: "Сбросить изменения текущей страницы",
          icon: TEXT_RESET_ICON,
          dataRole: "texts-reset-page",
          disabled: !this.textPageMap || this.textPageMap.bindings.every((binding) => !binding.changed),
          onClick: () => {
            void this.resetCurrentPageTextBindings();
          }
        }),
        createToolIconButton({
          tooltip: "Удалить карту текстов текущей страницы",
          icon: TEXT_DELETE_ICON,
          dataRole: "texts-delete-page",
          disabled: !this.textPageMap,
          onClick: () => {
            void this.deleteCurrentPageTextMap();
          }
        })
      );
    }

    this.textsToolRow.replaceChildren(...buttons);
    this.textsToolRow.classList.toggle("is-collapsed", buttons.length === 0);
  }

  private renderTextsFeed(): void {
    if (!this.textsFeed) {
      this.textFeedSignature = "";
      return;
    }

    const pageContext = this.getCurrentPageContext();
    const nextSignature = JSON.stringify({
      pageKey: pageContext?.pageKey ?? null,
      displayMode: this.getTextDisplayMode(),
      persisted: this.textPageMapPersisted,
      updatedAt: this.textPageMap?.updatedAt ?? null,
      bindings: (this.textPageMap?.bindings ?? []).map((binding) => ({
        bindingId: binding.bindingId,
        presence: binding.presence,
        staleSince: binding.staleSince,
        changed: binding.changed,
        replacementText: binding.replacementText
      }))
    });
    if (nextSignature === this.textFeedSignature) {
      return;
    }
    this.textFeedSignature = nextSignature;

    if (!pageContext) {
      const empty = document.createElement("div");
      empty.className = "texts-empty-state";
      empty.textContent = "Текстовая карта доступна только на обычных http(s)-страницах.";
      this.textsFeed.replaceChildren(empty);
      return;
    }

    if (!this.textPageMap) {
      const empty = document.createElement("div");
      empty.className = "texts-empty-state";
      empty.textContent = "Карта текстов ещё не собрана. Используй text.scan или кнопку пересканирования.";
      this.textsFeed.replaceChildren(empty);
      return;
    }

    const summary = buildTextMapSummary(this.textPageMap);
    const summaryCard = document.createElement("section");
    summaryCard.className = "texts-summary-card";
    summaryCard.innerHTML = `
      <div class="texts-summary-title">Текстовая карта страницы</div>
      <div class="texts-summary-meta">
        <span>Всего: ${summary.total}</span>
        <span>Live: ${summary.live}</span>
        <span>Stale: ${summary.stale}</span>
        <span>Изменено: ${summary.changed}</span>
        <span>Режим: ${this.getTextDisplayMode()}</span>
      </div>
    `;

    const bindings = [...this.textPageMap.bindings];
    const feedChildren: HTMLElement[] = [summaryCard];
    if (bindings.length === 0) {
      const empty = document.createElement("div");
      empty.className = "texts-empty-state";
      empty.textContent = "На странице не найдено подходящих текстовых элементов.";
      feedChildren.push(empty);
    } else {
      feedChildren.push(...bindings.map((binding) => this.createTextBindingElement(binding)));
    }

    this.textsFeed.replaceChildren(...feedChildren);
  }

  private createTextBindingElement(binding: TextBindingRecord): HTMLElement {
    const article = document.createElement("article");
    article.className = `text-binding-entry${binding.changed ? " is-changed" : " is-original"}${binding.presence === "stale" ? " is-stale" : ""}`;
    article.dataset.bindingId = binding.bindingId;
    article.dataset.bindingCategory = binding.category;
    article.dataset.bindingPresence = binding.presence;

    const selectorPreview =
      binding.context.selectorPreview ??
      binding.locator.preferredSelector ??
      binding.locator.elementSelector ??
      binding.locator.ancestorSelector ??
      binding.tagName;
    const displayedText = resolveDisplayedBindingText(
      {
        originalText: binding.originalText,
        replacementText: binding.replacementText
      },
      this.getTextDisplayMode()
    );

    const header = document.createElement("header");
    header.className = "text-binding-header";

    const titleRow = document.createElement("div");
    titleRow.className = "text-binding-title-row";

    const badge = document.createElement("span");
    badge.className = "text-binding-badge";
    badge.textContent = binding.category;

    const presenceBadge = document.createElement("span");
    presenceBadge.className = `text-binding-presence is-${binding.presence}`;
    presenceBadge.textContent = binding.presence;

    const bindingId = document.createElement("span");
    bindingId.className = "text-binding-id";
    bindingId.textContent = binding.bindingId;

    const meta = document.createElement("div");
    meta.className = "text-binding-meta";
    meta.textContent = truncateTextPreview(
      `${selectorPreview ?? binding.tagName}${binding.staleSince ? ` • stale since ${binding.staleSince}` : ""}`,
      220
    );

    titleRow.append(badge, presenceBadge, bindingId);
    header.append(titleRow, meta);

    const grid = document.createElement("div");
    grid.className = "text-binding-grid";
    grid.append(
      this.createTextBindingField("status", "Статус", binding.presence === "stale" ? `stale${binding.staleSince ? ` (${binding.staleSince})` : ""}` : "live"),
      this.createTextBindingField("original", "Исходный", binding.originalText),
      this.createTextBindingField("displayed", "Показывается", displayedText),
      this.createTextBindingField("replacement", "Замена", binding.replacementText ?? "—"),
      this.createTextBindingField("context", "Контекст", binding.context.ancestorText ?? "—")
    );

    article.append(header, grid);

    return article;
  }

  private createTextBindingField(fieldKey: string, labelText: string, valueText: string): HTMLElement {
    const field = document.createElement("div");
    field.className = "text-binding-field";
    field.dataset.bindingField = fieldKey;

    const label = document.createElement("span");
    label.className = "text-binding-label";
    label.textContent = labelText;

    const value = document.createElement("pre");
    value.className = "text-binding-value";
    value.textContent = valueText;

    field.append(label, value);
    return field;
  }

  private getTextDisplayMode(): TextDisplayMode {
    return this.currentConfig?.debug.textElements.displayMode ?? "effective";
  }

  private getTextAutoScanMode(): TextAutoScanMode {
    return this.currentConfig?.debug.textElements.autoScanMode ?? "off";
  }

  private getIncrementalRefreshDebounceMs(): number {
    return this.currentConfig?.debug.textElements.incrementalRefreshDebounceMs ?? TEXT_INCREMENTAL_SCAN_DELAY_MS;
  }

  private isTextAutoBlankOnScanEnabled(): boolean {
    return this.currentConfig?.debug.textElements.autoBlankOnScan ?? false;
  }

  private isDeferredMutationRetryEnabled(): boolean {
    return this.currentConfig?.debug.textElements.deferredMutationRetryEnabled ?? false;
  }

  private getDeferredMutationRetryDelayMs(): number {
    return this.currentConfig?.debug.textElements.deferredMutationRetryDelayMs ?? 180;
  }

  private canInlineEditRuntimeTarget(target: TextRuntimeTarget | null | undefined): boolean {
    return Boolean(target && target.attributeName === null);
  }

  private isIncrementalTextAutoScanEnabled(): boolean {
    return this.getTextAutoScanMode() === "incremental";
  }

  private setActiveTab(tab: OverlayTab, focusInput = true, persist = false): void {
    this.activeTab = tab;
    if (this.currentConfig) {
      this.currentConfig = {
        ...this.currentConfig,
        ui: {
          ...this.currentConfig.ui,
          overlay: {
            ...this.currentConfig.ui.overlay,
            activeTab: tab
          }
        }
      };
    }
    this.tabButtons.forEach((button) => {
      button.classList.toggle("is-active", button.dataset.tab === tab);
    });
    this.consolePanel?.classList.toggle("is-active", tab === "console");
    this.chatPanel?.classList.toggle("is-active", tab === "chat");
    this.textsPanel?.classList.toggle("is-active", tab === "texts");
    this.consoleToolRow?.classList.toggle("is-collapsed", tab === "console" && this.consoleToolRow.childElementCount === 0);

    if (persist) {
      void this.patchOverlaySessionConfig({
        activeTab: tab
      });
    }

    if (focusInput) {
      if (tab === "chat") {
        this.chatInput?.focus();
      } else if (tab === "texts") {
        this.panelWindow?.focus();
      } else {
        this.terminalInput?.focus();
      }
    }

    if (tab === "texts") {
      this.renderTexts();
      this.updateTextDebugPresentation();
      void this.ensureTextElementsHydrated({
        reason: "texts-tab",
        logSummary: false
      });
    } else {
      this.updateTextObservationState();
    }
  }

  private getCurrentPageContext(): { pageKey: string; pageUrl: string } | null {
    const pageUrl = window.location.href;
    const pageKey = normalizePageKey(pageUrl);
    if (!pageKey) {
      return null;
    }

    return {
      pageKey,
      pageUrl
    };
  }

  private requireCurrentPageContext(commandLabel: string): { pageKey: string; pageUrl: string } {
    const pageContext = this.getCurrentPageContext();
    if (!pageContext) {
      throw new Error(`${commandLabel} доступна только на обычной вкладке страницы.`);
    }

    return pageContext;
  }

  private async ensureRuntimeSnapshotLoaded(): Promise<void> {
    if (this.currentConfig && this.currentStatus) {
      return;
    }

    await this.loadSnapshot();
  }

  private cloneDefaultConfigValue(path: string): unknown {
    const defaultValue = readConfigValue(defaultConfig, path);
    return defaultValue && typeof defaultValue === "object"
      ? structuredClone(defaultValue)
      : defaultValue;
  }

  private requireEditableTerminalConfigField(path: string) {
    const descriptor = getEditableConfigField(path);
    if (!descriptor) {
      throw new Error(`Поле конфига недоступно для терминала: ${path}`);
    }
    if (descriptor.sensitive) {
      throw new Error(`Поле ${path} недоступно в консоли.`);
    }

    return descriptor;
  }

  private parseTerminalConfigValue(path: string, valueText: string): unknown {
    const descriptor = this.requireEditableTerminalConfigField(path);
    const trimmedValue = valueText.trim();

    if (
      (descriptor.valueType === "string" || descriptor.valueType === "enum") &&
      trimmedValue.startsWith("\"") &&
      trimmedValue.endsWith("\"")
    ) {
      const parsedString = JSON.parse(trimmedValue);
      if (typeof parsedString !== "string") {
        throw new Error("Строковое значение должно быть JSON-строкой.");
      }
      return descriptor.schema.parse(parsedString);
    }

    if (descriptor.valueType === "string" && trimmedValue === "\"\"") {
      return descriptor.schema.parse("");
    }

    return parseConfigFieldDraft(path, valueText);
  }

  private getAllowedModelRules(): AiAllowedModelRule[] {
    const config = this.currentConfig ?? defaultConfig;
    const value = readConfigValue(config, "ai.allowedModels");
    return normalizeAllowedModelRules(Array.isArray(value) ? value : []);
  }

  private async fetchModelCatalog(): Promise<{
    fetchedAt: string;
    models: AiModelCatalogItem[];
    warning?: string | null;
  }> {
    return AiModelCatalogResultSchema.parse(
      await sendCommand(COMMANDS.aiModelsCatalog, "overlay", "background")
    );
  }

  private findCatalogModel(
    models: readonly AiModelCatalogItem[],
    modelId: string
  ): AiModelCatalogItem | null {
    const exactMatch = models.find((item) => item.id === modelId);
    if (exactMatch) {
      return exactMatch;
    }

    const normalizedModelId = modelId.toLowerCase();
    return models.find((item) => item.id.toLowerCase() === normalizedModelId) ?? null;
  }

  private buildTerminalStatusSnapshot(): Record<string, unknown> {
    const pageContext = this.getCurrentPageContext();
    const apiKeyPresent =
      typeof this.currentConfig?.ai.openAiApiKey === "string" &&
      this.currentConfig.ai.openAiApiKey.trim().length > 0;
    const chatStatus =
      this.aiSession?.status ??
      (pageContext ? createDefaultAiStatus(pageContext.pageKey, pageContext.pageUrl, apiKeyPresent) : null);

    return {
      worker: this.currentStatus
        ? {
            running: this.currentStatus.running,
            hostConnected: this.currentStatus.hostConnected,
            bootId: this.currentStatus.bootId,
            sessionId: this.currentStatus.sessionId,
            taskId: this.currentStatus.taskId,
            startedAt: this.currentStatus.startedAt,
            lastHeartbeatAt: this.currentStatus.lastHeartbeatAt,
            reconnectAttempt: this.currentStatus.reconnectAttempt,
            nativeHostPid: this.currentStatus.nativeHostPid
          }
        : null,
      page: pageContext
        ? {
            supported: true,
            pageKey: pageContext.pageKey,
            pageUrl: pageContext.pageUrl
          }
        : {
            supported: false,
            pageUrl: window.location.href
          },
      overlay: {
        visible: this.visible,
        activeTab: this.activeTab
      },
      texts: this.buildTextStatusResult(),
      chat: chatStatus
        ? {
            requestState: chatStatus.requestState,
            pageKey: chatStatus.pageKey,
            pageUrlSample: chatStatus.pageUrlSample,
            activeRequestId: chatStatus.activeRequestId,
            queueCount: chatStatus.queueCount,
            lastError: chatStatus.lastError,
            availableActions: chatStatus.availableActions
          }
        : null
    };
  }

  private async bootstrapContentState(): Promise<void> {
    try {
      await this.loadSnapshot();
    } catch (error) {
      this.currentConfig = defaultConfig;
      await recordLog(
        "content",
        "text.bootstrap.snapshot.failed",
        "Не удалось загрузить runtime snapshot для text debug.",
        serializeLogDetails(error),
        "warn"
      );
    }

    await this.ensureTextElementsHydrated({
      reason: "bootstrap",
      logSummary: false
    });
  }

  private readonly handleStorageChanged = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string
  ): void => {
    if (areaName !== "local") {
      return;
    }

    if (STORAGE_KEYS.localConfig in changes) {
      void (async () => {
        try {
          await this.loadSnapshot();
          await this.ensureTextElementsHydrated({
            reason: "storage-config-change",
            logSummary: false
          });
        } catch (error) {
          await recordLog(
            "content",
            "text.storage.config.failed",
            "Не удалось синхронизировать debug-конфиг текстов после storage change.",
            serializeLogDetails(error),
            "warn"
          );
        }
      })();
    }

    if (STORAGE_KEYS.textMaps in changes) {
      void (async () => {
        const nextEnvelope = this.parseStoredTextEnvelope(changes[STORAGE_KEYS.textMaps]?.newValue);
        this.textStorageEnvelope = nextEnvelope;
        await this.ensureTextElementsHydrated({
          reason: "storage-text-change",
          logSummary: false
        });
      })();
    }
  };

  private buildTextStatusResult(): Record<string, unknown> | null {
    const pageContext = this.getCurrentPageContext();
    if (!pageContext) {
      return null;
    }

    const pageMap = this.textPageMap;
    const summary = buildTextMapSummary(pageMap);
    return {
      pageKey: pageContext.pageKey,
      pageUrl: pageContext.pageUrl,
      displayMode: this.getTextDisplayMode(),
      persisted: this.textPageMapPersisted,
      lastScanAt: pageMap?.lastScanAt ?? null,
      storedPages: Object.keys(this.textStorageEnvelope.pages).length,
      summary
    };
  }

  private async ensureTextElementsHydrated(options?: {
    reason?: string;
    persist?: boolean;
    logSummary?: boolean;
    forceScan?: boolean;
  }): Promise<TextPageMap | null> {
    const pageContext = this.getCurrentPageContext();
    this.textStorageEnvelope = this.textStateHydrated
      ? this.textStorageEnvelope
      : await this.loadTextStorageEnvelope();
    this.textStateHydrated = true;
    const runtimePageMap =
      pageContext && this.textPageMap?.pageKey === pageContext.pageKey
        ? this.textPageMap
        : null;
    const storedPageMap = pageContext ? this.textStorageEnvelope.pages[pageContext.pageKey] ?? null : null;
    this.textPageMap = storedPageMap ?? runtimePageMap;
    this.textPageMapPersisted = Boolean(storedPageMap);

    if (!pageContext) {
      this.textPageMapPersisted = false;
      this.resetInlineTextEditor();
      this.restoreAndClearAllTextTargets();
      this.updateTextDebugPresentation();
      this.updateTextObservationState();
      this.renderTexts();
      return null;
    }

    const autoScanSuppressed = this.suppressedTextAutoScanPageKeys.has(pageContext.pageKey);
    if (options?.forceScan) {
      return this.scanCurrentPageTextElements({
        reason: options.reason ?? "manual-scan",
        persist: options.persist,
        logSummary: options.logSummary ?? false
      });
    }

    if (autoScanSuppressed) {
      if (!storedPageMap) {
        this.textPageMap = null;
        this.textPageMapPersisted = false;
      }
      this.resetInlineTextEditor();
      this.restoreAndClearAllTextTargets();
      this.updateTextObservationState();
      this.renderTexts();
      return this.textPageMap;
    }

    if (!this.shouldHydrateTextElements()) {
      if (!storedPageMap) {
        this.textPageMap = null;
        this.textPageMapPersisted = false;
      }
      this.resetInlineTextEditor();
      this.restoreAndClearAllTextTargets();
      this.updateTextObservationState();
      this.renderTexts();
      return this.textPageMap;
    }

    if (!this.textPageMap) {
      if (this.isIncrementalTextAutoScanEnabled()) {
        return this.scanCurrentPageTextElements({
          reason: options?.reason ?? "auto-scan-bootstrap",
          persist: false,
          logSummary: options?.logSummary ?? false
        });
      }

      this.textPageMapPersisted = false;
      this.resetInlineTextEditor();
      this.restoreAndClearAllTextTargets();
      this.updateTextObservationState();
      this.renderTexts();
      return null;
    }

    this.textPageMap =
      (await this.reconcileCurrentPageTextBindingsWithAutoBlankConfig(options?.reason ?? "hydrate")) ?? this.textPageMap;

    if (this.isIncrementalTextAutoScanEnabled()) {
      this.textTrackedPageKeys.add(pageContext.pageKey);
    } else {
      this.textTrackedPageKeys.delete(pageContext.pageKey);
    }

    this.materializeCurrentPageTextTargets(this.textPageMap);
    this.updateTextDebugPresentation();
    this.renderTexts();
    this.updateTextObservationState();
    return this.textPageMap;
  }

  private shouldHydrateTextElements(): boolean {
    const pageContext = this.getCurrentPageContext();
    if (!pageContext) {
      return false;
    }

    const textDebugConfig = this.currentConfig?.debug.textElements;
    return (
      (this.visible && this.activeTab === "texts") ||
      (textDebugConfig?.highlightEnabled ?? false) ||
      (textDebugConfig?.inlineEditingEnabled ?? false) ||
      (textDebugConfig?.autoBlankOnScan ?? false) ||
      this.isIncrementalTextAutoScanEnabled()
    );
  }

  private parseStoredTextEnvelope(rawValue: unknown): TextStorageEnvelope {
    try {
      return TextStorageEnvelopeSchema.parse(rawValue ?? createEmptyTextStorageEnvelope());
    } catch {
      return createEmptyTextStorageEnvelope();
    }
  }

  private async loadTextStorageEnvelope(): Promise<TextStorageEnvelope> {
    const storedValues = await chrome.storage.local.get([STORAGE_KEYS.textMaps]);
    return this.parseStoredTextEnvelope(storedValues[STORAGE_KEYS.textMaps]);
  }

  private async persistTextStorageEnvelope(envelope: TextStorageEnvelope): Promise<void> {
    await chrome.storage.local.set({
      [STORAGE_KEYS.textMaps]: envelope
    });
  }

  private createCurrentTextPageMap(now?: string): TextPageMap {
    const pageContext = this.requireCurrentPageContext("text.scan");
    return createEmptyTextPageMap({
      pageKey: pageContext.pageKey,
      pageUrl: pageContext.pageUrl,
      pageTitle: document.title || null,
      displayMode: this.getTextDisplayMode(),
      now
    });
  }

  private buildBlankedTextPageMap(
    pageMap: TextPageMap,
    options?: {
      includeStale?: boolean;
      now?: string;
      touchMatchedAt?: boolean;
      autoBlanked?: boolean;
    }
  ): {
    pageMap: TextPageMap;
    didChange: boolean;
    blankedBindings: number;
  } {
    const now = options?.now ?? new Date().toISOString();
    const includeStale = options?.includeStale ?? false;
    const touchMatchedAt = options?.touchMatchedAt ?? false;
    const autoBlanked = options?.autoBlanked ?? false;
    let didChange = false;

    const nextBindings = pageMap.bindings.map((binding) => {
      const shouldBlank = includeStale || binding.presence === "live";
      if (!shouldBlank) {
        return binding;
      }

      const nextChanged = binding.originalText !== "";
      const nextLastMatchedAt = touchMatchedAt ? now : binding.lastMatchedAt;
      const isAlreadyBlanked =
        binding.replacementText === "" &&
        binding.effectiveText === "" &&
        binding.changed === nextChanged;
      if (isAlreadyBlanked && binding.autoBlanked === false && binding.lastMatchedAt === nextLastMatchedAt) {
        return binding;
      }
      if (
        binding.replacementText === "" &&
        binding.autoBlanked === autoBlanked &&
        binding.effectiveText === "" &&
        binding.changed === nextChanged &&
        binding.lastMatchedAt === nextLastMatchedAt
      ) {
        return binding;
      }

      didChange = true;
      return {
        ...binding,
        replacementText: "",
        autoBlanked,
        effectiveText: "",
        changed: nextChanged,
        lastMatchedAt: nextLastMatchedAt
      };
    });

    const nextPageMap: TextPageMap = didChange
      ? {
          ...pageMap,
          displayMode: this.getTextDisplayMode(),
          updatedAt: now,
          bindings: nextBindings
        }
      : pageMap.displayMode === this.getTextDisplayMode()
        ? pageMap
        : {
            ...pageMap,
            displayMode: this.getTextDisplayMode()
          };

    return {
      pageMap: nextPageMap,
      didChange,
      blankedBindings: nextBindings.filter(
        (binding) => (includeStale || binding.presence === "live") && binding.replacementText === ""
      ).length
    };
  }

  private async ensureCurrentPageTextBindingsAutoBlanked(reason: string): Promise<TextPageMap | null> {
    const currentPageMap = this.textPageMap;
    if (!currentPageMap || !this.isTextAutoBlankOnScanEnabled()) {
      return currentPageMap;
    }

    const nextBlankState = this.buildBlankedTextPageMap(currentPageMap, {
      now: new Date().toISOString(),
      autoBlanked: true
    });
    if (!nextBlankState.didChange) {
      return nextBlankState.pageMap;
    }

    this.textPageMap = nextBlankState.pageMap;
    this.textStorageEnvelope = upsertPageMapInEnvelope(this.textStorageEnvelope, nextBlankState.pageMap);
    await this.persistTextStorageEnvelope(this.textStorageEnvelope);
    this.textPageMapPersisted = true;

    await recordLog(
      "content",
      "text.page.auto_blank",
      "Тексты текущей страницы автоматически очищены пустой заменой по конфигу.",
      {
        pageKey: nextBlankState.pageMap.pageKey,
        reason,
        blankedBindings: nextBlankState.blankedBindings
      }
    );

    return nextBlankState.pageMap;
  }

  private async reconcileCurrentPageTextBindingsWithAutoBlankConfig(reason: string): Promise<TextPageMap | null> {
    const currentPageMap = this.textPageMap;
    if (!currentPageMap) {
      return currentPageMap;
    }

    const nextAutoBlankState = reconcileAutoBlankBindings(
      currentPageMap,
      this.isTextAutoBlankOnScanEnabled(),
      {
        now: new Date().toISOString()
      }
    );
    if (!nextAutoBlankState.didChange) {
      return nextAutoBlankState.pageMap;
    }

    this.textPageMap = nextAutoBlankState.pageMap;
    this.textStorageEnvelope = upsertPageMapInEnvelope(this.textStorageEnvelope, nextAutoBlankState.pageMap);
    await this.persistTextStorageEnvelope(this.textStorageEnvelope);
    this.textPageMapPersisted = true;

    await recordLog(
      "content",
      this.isTextAutoBlankOnScanEnabled() ? "text.page.auto_blank" : "text.page.auto_blank.reverted",
      this.isTextAutoBlankOnScanEnabled()
        ? "Тексты текущей страницы автоматически очищены пустой заменой по конфигу."
        : "Автоматические blank-замены текущей страницы сняты после выключения конфига.",
      {
        pageKey: nextAutoBlankState.pageMap.pageKey,
        reason,
        blankedBindings: nextAutoBlankState.blankedBindings,
        revertedBindings: nextAutoBlankState.revertedBindings
      }
    );

    return nextAutoBlankState.pageMap;
  }

  private async scanCurrentPageTextElements(options?: {
    reason?: string;
    persist?: boolean;
    logSummary?: boolean;
  }): Promise<TextPageMap | null> {
    if (this.textScanPromise) {
      return this.textScanPromise;
    }

    this.textScanPromise = (async () => {
      const pageContext = this.getCurrentPageContext();
      if (!pageContext) {
        return null;
      }
      this.suppressedTextAutoScanPageKeys.delete(pageContext.pageKey);
      this.textTrackedPageKeys.add(pageContext.pageKey);

      const now = new Date().toISOString();
      const previousTargets = new Map(this.textTargetMap);
      const existingPageMap =
        this.textPageMap ??
        this.textStorageEnvelope.pages[pageContext.pageKey] ??
        this.createCurrentTextPageMap(now);
      const liveCandidates = this.collectLiveTextCandidates();
      let nextPageMap: TextPageMap = {
        ...mergeTextPageMapWithCandidates(
          {
            ...existingPageMap,
            pageUrl: pageContext.pageUrl,
            pageTitle: document.title || null,
            displayMode: this.getTextDisplayMode()
          },
          liveCandidates.map((entry) => entry.candidate),
          {
            pageTitle: document.title || null,
            now
          }
        ),
        pageUrl: pageContext.pageUrl,
        pageTitle: document.title || null,
        displayMode: this.getTextDisplayMode()
      };
      nextPageMap = reconcileAutoBlankBindings(
        nextPageMap,
        this.isTextAutoBlankOnScanEnabled(),
        {
          now
        }
      ).pageMap;

      const liveBindings = nextPageMap.bindings.filter((binding) => binding.presence === "live");
      const matches = mapBindingsToCandidateIndices(
        liveBindings,
        liveCandidates.map((entry) => entry.candidate)
      );
      this.textTargetMap.clear();
      matches.forEach((match) => {
        const liveTarget = liveCandidates[match.candidateIndex]?.target;
        if (!liveTarget) {
          return;
        }

        this.adoptPreviousTextRuntimeTargetState(previousTargets.get(match.bindingId), liveTarget);
        liveTarget.bindingId = match.bindingId;
        this.textTargetMap.set(match.bindingId, liveTarget);
      });

      this.restoreRemovedTextTargets(previousTargets, new Set(this.textTargetMap.keys()));
      this.textPageMap = nextPageMap;
      if (options?.persist !== false) {
        this.textStorageEnvelope = upsertPageMapInEnvelope(this.textStorageEnvelope, nextPageMap);
        await this.persistTextStorageEnvelope(this.textStorageEnvelope);
        this.textPageMapPersisted = true;
      } else {
        this.textPageMapPersisted = false;
      }

      this.applyTextBindingsToDom();
      this.updateTextDebugPresentation();
      this.renderTexts();
      this.updateTextObservationState();

      if (options?.logSummary) {
        const summary = buildTextMapSummary(nextPageMap);
        await recordLog(
          "content",
          "text.scan.completed",
          "Карта текстовых элементов страницы обновлена.",
          {
            pageKey: pageContext.pageKey,
            reason: options.reason ?? "manual",
            totalBindings: summary.total,
            changedBindings: summary.changed,
            lastScanAt: nextPageMap.lastScanAt,
            autoBlankOnScan: this.isTextAutoBlankOnScanEnabled()
          }
        );
      }

      return nextPageMap;
    })();

    try {
      return await this.textScanPromise;
    } finally {
      this.textScanPromise = null;
    }
  }

  private materializeCurrentPageTextTargets(pageMap: TextPageMap): void {
    const liveCandidates = this.collectLiveTextCandidates();
    const previousTargets = new Map(this.textTargetMap);
    const liveBindings = pageMap.bindings.filter((binding) => binding.presence === "live");
    const matches = mapBindingsToCandidateIndices(
      liveBindings,
      liveCandidates.map((entry) => entry.candidate)
    );

    this.textTargetMap.clear();
    const matchedBindingIds = new Set<string>();
    matches.forEach((match) => {
      const target = liveCandidates[match.candidateIndex]?.target;
      if (!target) {
        return;
      }

      matchedBindingIds.add(match.bindingId);
      this.adoptPreviousTextRuntimeTargetState(previousTargets.get(match.bindingId), target);
      target.bindingId = match.bindingId;
      this.textTargetMap.set(match.bindingId, target);
    });
    liveBindings.forEach((binding) => {
      if (matchedBindingIds.has(binding.bindingId)) {
        return;
      }

      const previousTarget = previousTargets.get(binding.bindingId);
      if (!previousTarget || !this.canRetainChangedTextBindingWithoutCandidate(binding, previousTarget)) {
        return;
      }

      this.textTargetMap.set(binding.bindingId, previousTarget);
    });

    if (this.inlineTextEditor && !this.textTargetMap.has(this.inlineTextEditor.bindingId)) {
      this.resetInlineTextEditor();
    }

    this.restoreRemovedTextTargets(previousTargets, new Set(this.textTargetMap.keys()));
    this.applyTextBindingsToDom();
  }

  private adoptPreviousTextRuntimeTargetState(
    previousTarget: TextRuntimeTarget | undefined,
    nextTarget: TextRuntimeTarget
  ): void {
    if (!previousTarget || nextTarget.lastKnownClientRects.length > 0 || previousTarget.lastKnownClientRects.length === 0) {
      return;
    }

    nextTarget.lastKnownClientRects = previousTarget.lastKnownClientRects.map((rect) => ({ ...rect }));
  }

  private isTextBindingAffectedByMutationRoots(
    bindingId: string,
    previousTargets: ReadonlyMap<string, TextRuntimeTarget>,
    mutationRoots: readonly HTMLElement[]
  ): boolean {
    const target = previousTargets.get(bindingId);
    if (!target || !target.highlightElement.isConnected) {
      return true;
    }

    return mutationRoots.some(
      (root) =>
        root === target.highlightElement ||
        root.contains(target.highlightElement) ||
        target.highlightElement.contains(root)
    );
  }

  private canRetainChangedTextBindingWithoutCandidate(
    binding: TextBindingRecord,
    target: TextRuntimeTarget | undefined
  ): boolean {
    if (!target) {
      return false;
    }

    const inlineEditorOwnsBinding =
      this.inlineTextEditor?.bindingId === binding.bindingId &&
      this.inlineTextEditor.editor.isConnected;
    if (!inlineEditorOwnsBinding && (binding.replacementText === null || !binding.changed)) {
      return false;
    }

    if (!target.styleElement.isConnected || !target.highlightElement.isConnected) {
      return false;
    }

    if (target.textNode && !target.textNode.isConnected && !inlineEditorOwnsBinding) {
      return false;
    }

    return (
      isTextDebugPotentiallyVisibleElement(target.styleElement) ||
      isTextDebugPotentiallyVisibleElement(target.highlightElement)
    );
  }

  private buildStaleTextBinding(binding: TextBindingRecord, now: string): TextBindingRecord {
    return {
      ...binding,
      presence: "stale",
      staleSince: binding.staleSince ?? now
    };
  }

  private async refreshTextBindingsIncrementally(reason: string): Promise<void> {
    const pageContext = this.getCurrentPageContext();
    const currentPageMap = this.textPageMap;
    if (!pageContext || !currentPageMap || !this.isIncrementalTextAutoScanEnabled()) {
      this.pendingTextMutationRoots.clear();
      return;
    }

    if (this.textScanPromise) {
      await this.textScanPromise.catch(() => {});
    }

    const mutationRoots = this.normalizeMutationRoots([...this.pendingTextMutationRoots]);
    this.pendingTextMutationRoots.clear();

    const previousTargets = new Map(this.textTargetMap);
    const retainedTargets = new Map<string, TextRuntimeTarget>();
    previousTargets.forEach((target, bindingId) => {
      if (target.highlightElement.isConnected) {
        retainedTargets.set(bindingId, target);
        return;
      }

      this.highlightedTextElements.delete(target.styleElement);
    });

    const incrementalCandidates = this.collectLiveTextCandidatesFromRoots(mutationRoots);
    const affectedBindingIds = new Set(
      currentPageMap.bindings
        .filter(
          (binding) =>
            binding.presence === "live" &&
            this.isTextBindingAffectedByMutationRoots(binding.bindingId, previousTargets, mutationRoots)
        )
        .map((binding) => binding.bindingId)
    );

    if (incrementalCandidates.length === 0 && affectedBindingIds.size === 0) {
      this.updateDeferredMutationRetryStateForRoots(mutationRoots, retainedTargets);
      return;
    }

    const now = new Date().toISOString();
    const matchedBindingIds = new Set<string>();
    const updatedBindings = new Map<string, TextBindingRecord>();
    const nextTargets = new Map(retainedTargets);
    const newBindings: TextBindingRecord[] = [];
    const runtimeChangedBindingIds = new Set<string>();
    const candidateBindingPool = currentPageMap.bindings.filter(
      (binding) => binding.presence === "stale" || affectedBindingIds.has(binding.bindingId)
    );

    incrementalCandidates.forEach(({ candidate, target }) => {
      let bestBinding: TextBindingRecord | null = null;
      let bestScore = -1;
      let bestStrategy: string | null = null;

      candidateBindingPool.forEach((binding) => {
        if (matchedBindingIds.has(binding.bindingId)) {
          return;
        }

        const result = matchBindingToCandidate(binding, candidate);
        if (!isReliableTextBindingMatch(binding, candidate, result) || result.score <= bestScore) {
          return;
        }

        bestBinding = binding;
        bestScore = result.score;
        bestStrategy = result.strategy;
      });

      if (bestBinding) {
        const matchedBinding = bestBinding as TextBindingRecord;
        matchedBindingIds.add(matchedBinding.bindingId);
        const nextBinding: TextBindingRecord = {
          ...matchedBinding,
          category: candidate.category,
          presence: "live",
          staleSince: null,
          originalText: candidate.text,
          originalNormalized: candidate.normalizedText,
          autoBlanked: matchedBinding.autoBlanked,
          effectiveText: resolveDisplayedBindingText(
            {
              originalText: candidate.text,
              replacementText: matchedBinding.replacementText
            },
            "effective"
          ),
          currentText: candidate.text,
          tagName: candidate.tagName,
          attributeName: candidate.attributeName,
          locator: candidate.locator,
          context: candidate.context,
          lastSeenAt: now,
          lastMatchedAt: now,
          matchStrategy: bestStrategy,
          changed: matchedBinding.replacementText !== null && matchedBinding.replacementText !== candidate.text
        };
        if (!areTextBindingsEquivalentForPersistence(matchedBinding, nextBinding)) {
          updatedBindings.set(matchedBinding.bindingId, nextBinding);
        }
        this.adoptPreviousTextRuntimeTargetState(previousTargets.get(matchedBinding.bindingId), target);
        target.bindingId = matchedBinding.bindingId;
        if (previousTargets.get(matchedBinding.bindingId) !== target) {
          runtimeChangedBindingIds.add(matchedBinding.bindingId);
        }
        nextTargets.set(matchedBinding.bindingId, target);
        return;
      }

      const bindingId = buildTextBindingId({
        pageKey: currentPageMap.pageKey,
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

      if (currentPageMap.bindings.some((binding) => binding.bindingId === bindingId) ||
        newBindings.some((binding) => binding.bindingId === bindingId)) {
        return;
      }

      const nextBinding: TextBindingRecord = {
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
        matchStrategy: "incremental-created",
        changed: false
      };

      newBindings.push(nextBinding);
      target.bindingId = bindingId;
      runtimeChangedBindingIds.add(bindingId);
      nextTargets.set(bindingId, target);
    });

    const deletedBindingIds = new Set<string>();
    currentPageMap.bindings.forEach((binding) => {
      if (binding.presence !== "live" || !affectedBindingIds.has(binding.bindingId) || matchedBindingIds.has(binding.bindingId)) {
        return;
      }

      const previousTarget = previousTargets.get(binding.bindingId);
      if (previousTarget && this.canRetainChangedTextBindingWithoutCandidate(binding, previousTarget)) {
        nextTargets.set(binding.bindingId, previousTarget);
        return;
      }

      if (binding.changed) {
        updatedBindings.set(binding.bindingId, this.buildStaleTextBinding(binding, now));
      } else {
        deletedBindingIds.add(binding.bindingId);
      }
      nextTargets.delete(binding.bindingId);
    });

    const mergedBindings = currentPageMap.bindings
      .filter((binding) => !deletedBindingIds.has(binding.bindingId))
      .map((binding) => updatedBindings.get(binding.bindingId) ?? binding);
    const nextBindings = this.sortTextBindingsByRuntimeOrder([...mergedBindings, ...newBindings], nextTargets);
    let nextPageMap: TextPageMap = {
      ...currentPageMap,
      pageUrl: pageContext.pageUrl,
      pageTitle: document.title || null,
      displayMode: this.getTextDisplayMode(),
      updatedAt: now,
      bindings: nextBindings
    };
    nextPageMap = reconcileAutoBlankBindings(
      nextPageMap,
      this.isTextAutoBlankOnScanEnabled(),
      {
        now
      }
    ).pageMap;
    this.updateDeferredMutationRetryStateForRoots(mutationRoots, nextTargets);
    const didBindingsChange = !areTextBindingListsEquivalentForPersistence(currentPageMap.bindings, nextPageMap.bindings);
    const didRuntimeTargetsChange = runtimeChangedBindingIds.size > 0;

    if (!didBindingsChange && !didRuntimeTargetsChange) {
      return;
    }

    this.textTargetMap.clear();
    nextTargets.forEach((target, bindingId) => {
      this.textTargetMap.set(bindingId, target);
    });
    if (this.inlineTextEditor && !this.textTargetMap.has(this.inlineTextEditor.bindingId)) {
      this.resetInlineTextEditor();
    }
    this.restoreRemovedTextTargets(previousTargets, new Set(this.textTargetMap.keys()));
    this.textPageMap = nextPageMap;
    this.applyTextBindingsToDom();
    this.updateTextDebugPresentation();
    this.updateTextObservationState();

    if (!didBindingsChange) {
      return;
    }

    this.textStorageEnvelope = upsertPageMapInEnvelope(this.textStorageEnvelope, nextPageMap);
    await this.persistTextStorageEnvelope(this.textStorageEnvelope);
    this.textPageMapPersisted = true;
    this.renderTexts();

    await recordLog("content", "text.scan.incremental", "Карта текстов дополнена инкрементально.", {
      pageKey: currentPageMap.pageKey,
      reason,
      newBindings: newBindings.length,
      updatedBindings: updatedBindings.size,
      affectedRoots: mutationRoots.length,
      lastScanAt: currentPageMap.lastScanAt,
      updatedAt: now,
      autoBlankOnScan: this.isTextAutoBlankOnScanEnabled()
    });
  }

  private async refreshVisibleTextBindingsIncrementally(reason: string): Promise<void> {
    const pageContext = this.getCurrentPageContext();
    const currentPageMap = this.textPageMap;
    if (!pageContext || !currentPageMap || !this.isIncrementalTextAutoScanEnabled()) {
      return;
    }

    if (this.textScanPromise) {
      await this.textScanPromise.catch(() => {});
    }

    const viewportRoots = this.collectViewportObservationRoots();
    if (viewportRoots.length === 0) {
      return;
    }

    const incrementalCandidates = this.collectLiveTextCandidatesFromRoots(viewportRoots);
    if (incrementalCandidates.length === 0) {
      return;
    }

    const previousTargets = new Map(this.textTargetMap);
    const retainedTargets = new Map<string, TextRuntimeTarget>();
    previousTargets.forEach((target, bindingId) => {
      if (target.highlightElement.isConnected) {
        retainedTargets.set(bindingId, target);
      }
    });

    const now = new Date().toISOString();
    const matchedBindingIds = new Set<string>();
    // Pre-mark connected live bindings as matched — they don't need re-matching
    // and excluding them from the pool reduces O(candidates × all_bindings) to O(candidates × stale)
    retainedTargets.forEach((_, bindingId) => matchedBindingIds.add(bindingId));
    const updatedBindings = new Map<string, TextBindingRecord>();
    const nextTargets = new Map(retainedTargets);
    const newBindings: TextBindingRecord[] = [];
    const runtimeChangedBindingIds = new Set<string>();
    const candidateBindingPool = currentPageMap.bindings.filter(
      (b) => b.presence === "stale" || !retainedTargets.has(b.bindingId)
    );

    incrementalCandidates.forEach(({ candidate, target }) => {
      let bestBinding: TextBindingRecord | null = null;
      let bestScore = -1;
      let bestStrategy: string | null = null;

      candidateBindingPool.forEach((binding) => {
        if (matchedBindingIds.has(binding.bindingId)) {
          return;
        }

        const result = matchBindingToCandidate(binding, candidate);
        if (!isReliableTextBindingMatch(binding, candidate, result) || result.score <= bestScore) {
          return;
        }

        bestBinding = binding;
        bestScore = result.score;
        bestStrategy = result.strategy;
      });

      if (bestBinding && bestStrategy) {
        const matchedBinding = bestBinding as TextBindingRecord;
        matchedBindingIds.add(matchedBinding.bindingId);
        const nextBinding: TextBindingRecord = {
          ...matchedBinding,
          category: candidate.category,
          presence: "live",
          staleSince: null,
          originalText: candidate.text,
          originalNormalized: candidate.normalizedText,
          autoBlanked: matchedBinding.autoBlanked,
          effectiveText: resolveDisplayedBindingText(
            {
              originalText: candidate.text,
              replacementText: matchedBinding.replacementText
            },
            "effective"
          ),
          currentText: candidate.text,
          tagName: candidate.tagName,
          attributeName: candidate.attributeName,
          locator: candidate.locator,
          context: candidate.context,
          lastSeenAt: now,
          lastMatchedAt: now,
          matchStrategy: bestStrategy,
          changed: matchedBinding.replacementText !== null && matchedBinding.replacementText !== candidate.text
        };
        if (!areTextBindingsEquivalentForPersistence(matchedBinding, nextBinding)) {
          updatedBindings.set(matchedBinding.bindingId, nextBinding);
        }
        this.adoptPreviousTextRuntimeTargetState(previousTargets.get(matchedBinding.bindingId), target);
        target.bindingId = matchedBinding.bindingId;
        if (previousTargets.get(matchedBinding.bindingId) !== target) {
          runtimeChangedBindingIds.add(matchedBinding.bindingId);
        }
        nextTargets.set(matchedBinding.bindingId, target);
        return;
      }

      const bindingId = buildTextBindingId({
        pageKey: currentPageMap.pageKey,
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

      if (
        currentPageMap.bindings.some((binding) => binding.bindingId === bindingId) ||
        newBindings.some((binding) => binding.bindingId === bindingId)
      ) {
        return;
      }

      const nextBinding: TextBindingRecord = {
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
        matchStrategy: "viewport-created",
        changed: false
      };

      newBindings.push(nextBinding);
      target.bindingId = bindingId;
      runtimeChangedBindingIds.add(bindingId);
      nextTargets.set(bindingId, target);
    });

    const mergedBindings = currentPageMap.bindings
      .filter((binding) => {
        const next = updatedBindings.get(binding.bindingId) ?? binding;
        return next.presence === "live" || next.changed;
      })
      .map((binding) => updatedBindings.get(binding.bindingId) ?? binding);
    const nextBindings = this.sortTextBindingsByRuntimeOrder([...mergedBindings, ...newBindings], nextTargets);
    let nextPageMap: TextPageMap = {
      ...currentPageMap,
      pageUrl: pageContext.pageUrl,
      pageTitle: document.title || null,
      displayMode: this.getTextDisplayMode(),
      updatedAt: now,
      bindings: nextBindings
    };
    nextPageMap = reconcileAutoBlankBindings(
      nextPageMap,
      this.isTextAutoBlankOnScanEnabled(),
      {
        now
      }
    ).pageMap;
    const didBindingsChange = !areTextBindingListsEquivalentForPersistence(currentPageMap.bindings, nextPageMap.bindings);
    const didRuntimeTargetsChange = runtimeChangedBindingIds.size > 0;

    if (!didBindingsChange && !didRuntimeTargetsChange) {
      return;
    }

    this.textTargetMap.clear();
    nextTargets.forEach((target, bindingId) => {
      this.textTargetMap.set(bindingId, target);
    });
    if (this.inlineTextEditor && !this.textTargetMap.has(this.inlineTextEditor.bindingId)) {
      this.resetInlineTextEditor();
    }
    this.textPageMap = nextPageMap;
    this.applyTextBindingsToDom();
    this.updateTextDebugPresentation();
    this.updateTextObservationState();

    if (!didBindingsChange) {
      return;
    }

    this.textStorageEnvelope = upsertPageMapInEnvelope(this.textStorageEnvelope, nextPageMap);
    await this.persistTextStorageEnvelope(this.textStorageEnvelope);
    this.textPageMapPersisted = true;
    this.renderTexts();

    await recordLog("content", "text.scan.viewport", "Карта текстов дополнена из видимой области.", {
      pageKey: currentPageMap.pageKey,
      reason,
      sampledRoots: viewportRoots.length,
      sampledCandidates: incrementalCandidates.length,
      newBindings: newBindings.length,
      updatedBindings: updatedBindings.size,
      lastScanAt: currentPageMap.lastScanAt,
      updatedAt: now,
      autoBlankOnScan: this.isTextAutoBlankOnScanEnabled()
    });
  }

  private sortTextBindingsByRuntimeOrder(
    bindings: readonly TextBindingRecord[],
    runtimeTargets: ReadonlyMap<string, TextRuntimeTarget>
  ): TextBindingRecord[] {
    const originalIndex = new Map(bindings.map((binding, index) => [binding.bindingId, index]));
    const domOrderedBindingIds = bindings
      .filter((binding) => runtimeTargets.has(binding.bindingId))
      .sort((left, right) => {
        const leftTarget = runtimeTargets.get(left.bindingId)?.highlightElement;
        const rightTarget = runtimeTargets.get(right.bindingId)?.highlightElement;
        if (!leftTarget || !rightTarget || leftTarget === rightTarget) {
          return (originalIndex.get(left.bindingId) ?? 0) - (originalIndex.get(right.bindingId) ?? 0);
        }

        const position = leftTarget.compareDocumentPosition(rightTarget);
        if (position & Node.DOCUMENT_POSITION_FOLLOWING) {
          return -1;
        }
        if (position & Node.DOCUMENT_POSITION_PRECEDING) {
          return 1;
        }
        return (originalIndex.get(left.bindingId) ?? 0) - (originalIndex.get(right.bindingId) ?? 0);
      })
      .map((binding) => binding.bindingId);
    const domOrder = new Map(domOrderedBindingIds.map((bindingId, index) => [bindingId, index]));

    return [...bindings].sort((left, right) => {
      const leftDomIndex = domOrder.get(left.bindingId);
      const rightDomIndex = domOrder.get(right.bindingId);
      if (leftDomIndex !== undefined && rightDomIndex !== undefined) {
        return leftDomIndex - rightDomIndex;
      }
      if (leftDomIndex !== undefined) {
        return -1;
      }
      if (rightDomIndex !== undefined) {
        return 1;
      }
      return (originalIndex.get(left.bindingId) ?? 0) - (originalIndex.get(right.bindingId) ?? 0);
    });
  }

  private collectLiveTextCandidates(): LiveTextCandidate[] {
    const candidates: LiveTextCandidate[] = [];
    const root = document.body ?? document.documentElement;
    if (!root) {
      return candidates;
    }

    const textWalker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let currentTextNode = textWalker.nextNode();
    while (currentTextNode) {
      if (currentTextNode instanceof Text) {
        const candidate = this.createTextNodeCandidate(currentTextNode);
        if (candidate) {
          candidates.push(candidate);
        }
      }
      currentTextNode = textWalker.nextNode();
    }

    const attributeElements = root.querySelectorAll<HTMLElement>("input, textarea, select");
    attributeElements.forEach((element) => {
      candidates.push(...this.createAttributeCandidates(element));
    });

    return candidates;
  }

  private collectLiveTextCandidatesFromRoots(roots: readonly HTMLElement[]): LiveTextCandidate[] {
    const dedupe = new Map<string, LiveTextCandidate>();
    const addCandidate = (candidate: LiveTextCandidate | null) => {
      if (!candidate) {
        return;
      }

      const key = [
        candidate.candidate.locator.preferredSelector ?? "",
        candidate.candidate.locator.elementSelector ?? "",
        candidate.candidate.attributeName ?? "",
        candidate.candidate.normalizedText,
        candidate.candidate.locator.nodeIndex ?? ""
      ].join("\u001f");

      if (!dedupe.has(key)) {
        dedupe.set(key, candidate);
      }
    };

    this.normalizeMutationRoots(roots).forEach((root) => {
      if (isTextDebugSkippableElement(root) || !isTextDebugPotentiallyVisibleElement(root)) {
        return;
      }

      const rootTextWalker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let currentTextNode = rootTextWalker.nextNode();
      while (currentTextNode) {
        if (currentTextNode instanceof Text) {
          addCandidate(this.createTextNodeCandidate(currentTextNode));
        }
        currentTextNode = rootTextWalker.nextNode();
      }

      if (root.matches("input, textarea, select")) {
        this.createAttributeCandidates(root).forEach((candidate) => addCandidate(candidate));
      }

      root
        .querySelectorAll<HTMLElement>("input, textarea, select")
        .forEach((element) => {
          this.createAttributeCandidates(element).forEach((candidate) => addCandidate(candidate));
        });
    });

    return [...dedupe.values()];
  }

  private collectViewportObservationRoots(): HTMLElement[] {
    const viewportWidth = Math.max(1, window.innerWidth);
    const viewportHeight = Math.max(1, window.innerHeight);
    const xFractions = [0.08, 0.22, 0.36, 0.5, 0.64, 0.78, 0.92];
    const yFractions = [0.08, 0.2, 0.32, 0.44, 0.56, 0.68, 0.8, 0.92];
    const roots = new Set<HTMLElement>();

    const addElement = (element: Element | null | undefined) => {
      if (!(element instanceof HTMLElement)) {
        return;
      }
      if (this.isElementInsideOverlay(element) || isTextDebugSkippableElement(element)) {
        return;
      }

      const hostElement = resolveTextBindingHostElement(element);
      if (isTextDebugVisibleElement(hostElement)) {
        roots.add(hostElement);
      }

      let current: HTMLElement | null = hostElement.parentElement;
      let depth = 0;
      while (current && depth < 3) {
        if (isTextDebugVisibleElement(current)) {
          roots.add(current);
        }
        current = current.parentElement;
        depth += 1;
      }
    };

    for (const yFraction of yFractions) {
      for (const xFraction of xFractions) {
        const x = Math.min(viewportWidth - 1, Math.max(0, Math.floor(viewportWidth * xFraction)));
        const y = Math.min(viewportHeight - 1, Math.max(0, Math.floor(viewportHeight * yFraction)));
        const elementsAtPoint =
          typeof document.elementsFromPoint === "function"
            ? document.elementsFromPoint(x, y)
            : [document.elementFromPoint(x, y)].filter((value): value is Element => value instanceof Element);
        elementsAtPoint.slice(0, 5).forEach((element) => addElement(element));
      }
    }

    return this.normalizeMutationRoots([...roots]);
  }

  private createTextNodeCandidate(textNode: Text): LiveTextCandidate | null {
    const parentElement = textNode.parentElement;
    if (!parentElement || isTextDebugSkippableElement(parentElement)) {
      return null;
    }

    if (!isTextDebugPotentiallyVisibleElement(parentElement)) {
      return null;
    }

    const originalText = this.textNodeOriginalMap.get(textNode) ?? (textNode.textContent ?? "");
    this.textNodeOriginalMap.set(textNode, originalText);
    const normalizedText = normalizeTextForBinding(originalText);
    if (!normalizedText) {
      return null;
    }

    const hostElement = resolveTextBindingHostElement(parentElement);
    const readRenderableState = (): {
      highlightElement: HTMLElement;
      textRects: TextRectSnapshot[];
      fallbackRects: TextRectSnapshot[];
    } => {
      const nextHighlightElement = resolveTextHighlightElement(hostElement.isConnected ? hostElement : parentElement);
      const textRects = getRenderableTextNodeClientRects(textNode);
      return {
        highlightElement: nextHighlightElement,
        textRects,
        fallbackRects: getRenderableElementClientRects(nextHighlightElement)
      };
    };
    const initialRenderableState = readRenderableState();
    if (initialRenderableState.textRects.length === 0 && initialRenderableState.fallbackRects.length === 0) {
      return null;
    }
    let runtimeHighlightElement = initialRenderableState.highlightElement;
    const initialPreciseRects =
      initialRenderableState.textRects.length > 0 ? initialRenderableState.textRects : initialRenderableState.fallbackRects;
    let lastKnownClientRects = initialPreciseRects.map((rect) => ({ ...rect }));
    const getLiveTextRects = (): TextRectSnapshot[] => {
      const nextRenderableState = readRenderableState();
      runtimeHighlightElement = nextRenderableState.highlightElement;
      if (nextRenderableState.textRects.length > 0) {
        lastKnownClientRects = nextRenderableState.textRects.map((rect) => ({ ...rect }));
        return lastKnownClientRects;
      }
      return [];
    };
    const getRenderableCandidateRects = (): TextRectSnapshot[] => {
      const liveRects = getLiveTextRects();
      if (liveRects.length > 0) {
        target.lastKnownClientRects = liveRects;
        return liveRects;
      }
      if (lastKnownClientRects.length > 0) {
        target.lastKnownClientRects = lastKnownClientRects;
        return lastKnownClientRects;
      }
      const nextRenderableState = readRenderableState();
      runtimeHighlightElement = nextRenderableState.highlightElement;
      return nextRenderableState.fallbackRects;
    };
    const preferredSelector = buildPreferredTextSelector(hostElement);
    const elementSelector = buildElementSelectorPath(hostElement);
    const selectorPreview = elementSelector ?? preferredSelector;
    const ancestorText = normalizeTextForBinding(hostElement.parentElement?.textContent ?? "");
    const locator = {
      preferredSelector,
      ancestorSelector: buildAncestorSelector(hostElement),
      elementSelector,
      nodeIndex: getElementTextNodeIndexWithinHost(hostElement, textNode, {
        originalTextLookup: (candidate) => this.textNodeOriginalMap.get(candidate) ?? candidate.textContent ?? ""
      }),
      tagName: hostElement.tagName.toLowerCase(),
      attributeName: null,
      classNames: Array.from(hostElement.classList).slice(0, 8),
      stableAttributes: getTextDebugStableAttributes(hostElement)
    };

    const target: TextRuntimeTarget = {
      bindingId: null,
      element: hostElement,
      highlightElement: runtimeHighlightElement,
      styleElement: parentElement,
      attributeName: null,
      textNode,
      lastKnownClientRects,
      readCurrentText: () => textNode.textContent ?? "",
      applyRenderedText: (value: string) => {
        textNode.textContent = value;
      },
      getOriginalText: () => this.textNodeOriginalMap.get(textNode) ?? originalText,
      getLiveClientRects: () => {
        const rects = getLiveTextRects();
        target.highlightElement = runtimeHighlightElement;
        if (rects.length > 0) {
          target.lastKnownClientRects = rects;
        }
        return rects;
      },
      getClientRects: () => {
        const rects = getRenderableCandidateRects();
        target.highlightElement = runtimeHighlightElement;
        return rects;
      },
      getBoundingClientRect: () => buildTextRectUnion(target.getClientRects())
    };

    return {
      candidate: {
        category: categorizeTextElement({
          tagName: hostElement.tagName,
          role: hostElement.getAttribute("role")
        }),
        text: originalText,
        normalizedText,
        tagName: hostElement.tagName.toLowerCase(),
        attributeName: null,
        locator,
        context: {
          pageTitle: document.title || null,
          selectorPreview,
          ancestorText: ancestorText.length > 0 ? truncateTextPreview(ancestorText, 180) : null
        }
      },
      target
    };
  }

  private createAttributeCandidates(element: HTMLElement): LiveTextCandidate[] {
    if (isTextDebugSkippableElement(element) || !isTextDebugPotentiallyVisibleElement(element)) {
      return [];
    }

    const candidates: LiveTextCandidate[] = [];
    if (element instanceof HTMLInputElement) {
      if (element.type !== "hidden" && element.type !== "password") {
        const valueCandidate = this.createElementAttributeCandidate(element, "value", element.value);
        if (valueCandidate) {
          candidates.push(valueCandidate);
        }
      }

      if (element.value.length === 0) {
        const placeholderCandidate = this.createElementAttributeCandidate(
          element,
          "placeholder",
          element.getAttribute("placeholder") ?? ""
        );
        if (placeholderCandidate) {
          candidates.push(placeholderCandidate);
        }
      }
    } else if (element instanceof HTMLTextAreaElement) {
      const valueCandidate = this.createElementAttributeCandidate(element, "value", element.value);
      if (valueCandidate) {
        candidates.push(valueCandidate);
      }

      if (element.value.length === 0) {
        const placeholderCandidate = this.createElementAttributeCandidate(
          element,
          "placeholder",
          element.getAttribute("placeholder") ?? ""
        );
        if (placeholderCandidate) {
          candidates.push(placeholderCandidate);
        }
      }
    } else if (element instanceof HTMLSelectElement) {
      const selectedText = element.selectedOptions[0]?.textContent ?? "";
      const valueCandidate = this.createElementAttributeCandidate(element, "value", selectedText);
      if (valueCandidate) {
        candidates.push(valueCandidate);
      }
    }

    return candidates;
  }

  private createElementAttributeCandidate(
    element: HTMLElement,
    attributeName: string,
    currentValue: string
  ): LiveTextCandidate | null {
    const originalText = this.getAttributeOriginalText(element, attributeName, currentValue);
    const normalizedText = normalizeTextForBinding(originalText);
    if (!normalizedText) {
      return null;
    }

    if (!isTextBindingAttributeVisuallyRenderable(attributeName)) {
      return null;
    }

    const preferredSelector = buildPreferredTextSelector(element);
    const elementSelector = buildElementSelectorPath(element);
    const selectorPreview = elementSelector ?? preferredSelector;
    const ancestorText = normalizeTextForBinding(element.parentElement?.textContent ?? "");
    const tagName = element.tagName.toLowerCase();
    const readRenderableState = (): {
      highlightElement: HTMLElement;
      textRects: TextRectSnapshot[];
      fallbackRects: TextRectSnapshot[];
    } => {
      const nextHighlightElement = resolveTextHighlightElement(element);
      const formControlRects =
        (attributeName === "value" || attributeName === "placeholder") &&
        (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)
          ? measureFormControlTextRects(element, attributeName, readCurrentAttributeText())
          : [];
      return {
        highlightElement: nextHighlightElement,
        textRects: formControlRects,
        fallbackRects: getRenderableElementClientRects(nextHighlightElement)
      };
    };
    const readCurrentAttributeText = () => {
      if (attributeName === "value" && element instanceof HTMLSelectElement) {
        return element.selectedOptions[0]?.textContent ?? "";
      }
      if (attributeName === "value" && (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
        return element.value;
      }
      return element.getAttribute(attributeName) ?? "";
    };
    const applyRenderedAttributeText = (value: string) => {
      if (attributeName === "value" && element instanceof HTMLSelectElement) {
        const selectedOption = element.selectedOptions[0] ?? element.options[0];
        if (selectedOption) {
          selectedOption.textContent = value;
          selectedOption.label = value;
        }
        return;
      }
      if (attributeName === "value" && (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
        element.value = value;
        element.setAttribute("value", value);
        return;
      }

      element.setAttribute(attributeName, value);
    };
    const initialRenderableState = readRenderableState();
    if (initialRenderableState.textRects.length === 0 && initialRenderableState.fallbackRects.length === 0) {
      return null;
    }
    let runtimeHighlightElement = initialRenderableState.highlightElement;
    const initialPreciseRects =
      initialRenderableState.textRects.length > 0 ? initialRenderableState.textRects : initialRenderableState.fallbackRects;
    let lastKnownClientRects = initialPreciseRects.map((rect) => ({ ...rect }));
    const getLiveAttributeRects = (): TextRectSnapshot[] => {
      const nextRenderableState = readRenderableState();
      runtimeHighlightElement = nextRenderableState.highlightElement;
      if (nextRenderableState.textRects.length > 0) {
        lastKnownClientRects = nextRenderableState.textRects.map((rect) => ({ ...rect }));
        return lastKnownClientRects;
      }
      return [];
    };
    const getRenderableAttributeRects = () => {
      const liveRects = getLiveAttributeRects();
      if (liveRects.length > 0) {
        target.lastKnownClientRects = liveRects;
        return liveRects;
      }
      if (lastKnownClientRects.length > 0) {
        target.lastKnownClientRects = lastKnownClientRects;
        return lastKnownClientRects;
      }
      const nextRenderableState = readRenderableState();
      runtimeHighlightElement = nextRenderableState.highlightElement;
      return nextRenderableState.fallbackRects;
    };
    const locator = {
      preferredSelector,
      ancestorSelector: buildAncestorSelector(element),
      elementSelector,
      nodeIndex: null,
      tagName,
      attributeName,
      classNames: Array.from(element.classList).slice(0, 8),
      stableAttributes: getTextDebugStableAttributes(element)
    };

    const target: TextRuntimeTarget = {
      bindingId: null,
      element,
      highlightElement: runtimeHighlightElement,
      styleElement: element,
      attributeName,
      textNode: null,
      lastKnownClientRects,
      readCurrentText: readCurrentAttributeText,
      applyRenderedText: applyRenderedAttributeText,
      getOriginalText: () => this.getAttributeOriginalText(element, attributeName, originalText),
      getLiveClientRects: () => {
        const rects = getLiveAttributeRects();
        target.highlightElement = runtimeHighlightElement;
        if (rects.length > 0) {
          target.lastKnownClientRects = rects;
        }
        return rects;
      },
      getClientRects: () => {
        const rects = getRenderableAttributeRects();
        target.highlightElement = runtimeHighlightElement;
        return rects;
      },
      getBoundingClientRect: () => buildTextRectUnion(target.getClientRects())
    };

    return {
      candidate: {
        category: categorizeTextElement({
          tagName,
          role: element.getAttribute("role"),
          attributeName
        }),
        text: originalText,
        normalizedText,
        tagName,
        attributeName,
        locator,
        context: {
          pageTitle: document.title || null,
          selectorPreview,
          ancestorText: ancestorText.length > 0 ? truncateTextPreview(ancestorText, 180) : null
        }
      },
      target
    };
  }

  private trackRuntimeTargetAttribute(
    trackedAttributesByElement: Map<HTMLElement, Set<string>>,
    element: HTMLElement,
    attributeName: string
  ): void {
    const current = trackedAttributesByElement.get(element) ?? new Set<string>();
    current.add(attributeName);
    trackedAttributesByElement.set(element, current);
  }

  private getDeferredRetryTrackedTargets(runtimeTargets: ReadonlyMap<string, TextRuntimeTarget>): {
    trackedTextNodes: Set<Text>;
    trackedAttributesByElement: Map<HTMLElement, Set<string>>;
  } {
    const trackedTextNodes = new Set<Text>();
    const trackedAttributesByElement = new Map<HTMLElement, Set<string>>();

    runtimeTargets.forEach((target) => {
      if (!target.styleElement.isConnected && !target.highlightElement.isConnected) {
        return;
      }

      if (target.textNode) {
        trackedTextNodes.add(target.textNode);
      }
      if (target.attributeName !== null) {
        this.trackRuntimeTargetAttribute(trackedAttributesByElement, target.element, target.attributeName);
      }
    });

    return {
      trackedTextNodes,
      trackedAttributesByElement
    };
  }

  private getCurrentTextValueForAttributeCandidate(
    element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
    attributeName: "value" | "placeholder"
  ): string {
    if (attributeName === "value" && element instanceof HTMLSelectElement) {
      return element.selectedOptions[0]?.textContent ?? "";
    }
    if (attributeName === "value") {
      return element.value;
    }
    return element.getAttribute(attributeName) ?? "";
  }

  private doesFormControlAttributeNeedDeferredRetry(
    element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
    attributeName: "value" | "placeholder"
  ): boolean {
    if (!isTextDebugPotentiallyVisibleElement(element)) {
      return false;
    }

    if (element instanceof HTMLInputElement && (element.type === "hidden" || element.type === "password")) {
      return false;
    }

    const currentValue = this.getCurrentTextValueForAttributeCandidate(element, attributeName);
    const originalText = this.getAttributeOriginalText(element, attributeName, currentValue);
    if (!normalizeTextForBinding(originalText)) {
      return false;
    }

    if (attributeName === "placeholder" && "value" in element && element.value.length > 0) {
      return false;
    }

    if (
      attributeName === "value" &&
      (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) &&
      element.value.length === 0
    ) {
      return false;
    }

    const textRects = measureFormControlTextRects(element, attributeName, currentValue);
    if (textRects.length > 0) {
      return false;
    }

    return getRenderableElementClientRects(resolveTextHighlightElement(element)).length === 0;
  }

  private rootNeedsDeferredMutationRetry(
    root: HTMLElement,
    trackedTextNodes: ReadonlySet<Text>,
    trackedAttributesByElement: ReadonlyMap<HTMLElement, ReadonlySet<string>>
  ): boolean {
    if (!root.isConnected || isTextDebugSkippableElement(root) || !isTextDebugPotentiallyVisibleElement(root)) {
      return false;
    }

    const textWalker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let currentTextNode = textWalker.nextNode();
    while (currentTextNode) {
      if (currentTextNode instanceof Text) {
        const parentElement = currentTextNode.parentElement;
        const originalText = this.textNodeOriginalMap.get(currentTextNode) ?? (currentTextNode.textContent ?? "");
        if (
          parentElement &&
          !trackedTextNodes.has(currentTextNode) &&
          !isTextDebugSkippableElement(parentElement) &&
          isTextDebugPotentiallyVisibleElement(parentElement) &&
          normalizeTextForBinding(originalText).length > 0
        ) {
          const hostElement = resolveTextBindingHostElement(parentElement);
          const highlightElement = resolveTextHighlightElement(hostElement.isConnected ? hostElement : parentElement);
          if (
            getRenderableTextNodeClientRects(currentTextNode).length === 0 &&
            getRenderableElementClientRects(highlightElement).length === 0
          ) {
            return true;
          }
        }
      }
      currentTextNode = textWalker.nextNode();
    }

    const formControls = new Set<HTMLElement>();
    if (root.matches("input, textarea, select")) {
      formControls.add(root);
    }
    root.querySelectorAll<HTMLElement>("input, textarea, select").forEach((element) => {
      formControls.add(element);
    });

    for (const element of formControls) {
      const trackedAttributes = trackedAttributesByElement.get(element) ?? new Set<string>();
      if (
        (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) &&
        !trackedAttributes.has("value") &&
        this.doesFormControlAttributeNeedDeferredRetry(element, "value")
      ) {
        return true;
      }

      if (
        (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) &&
        !trackedAttributes.has("placeholder") &&
        this.doesFormControlAttributeNeedDeferredRetry(element, "placeholder")
      ) {
        return true;
      }
    }

    return false;
  }

  private collectDeferredMutationRetryRoots(
    roots: readonly HTMLElement[],
    runtimeTargets: ReadonlyMap<string, TextRuntimeTarget>
  ): HTMLElement[] {
    if (!this.isDeferredMutationRetryEnabled() || roots.length === 0) {
      return [];
    }

    const { trackedTextNodes, trackedAttributesByElement } = this.getDeferredRetryTrackedTargets(runtimeTargets);
    return this.normalizeMutationRoots(
      roots.filter((root) => this.rootNeedsDeferredMutationRetry(root, trackedTextNodes, trackedAttributesByElement))
    );
  }

  private updateDeferredMutationRetryStateForRoots(
    roots: readonly HTMLElement[],
    runtimeTargets: ReadonlyMap<string, TextRuntimeTarget>
  ): void {
    if (roots.length === 0) {
      return;
    }

    if (!this.isDeferredMutationRetryEnabled()) {
      this.clearDeferredMutationRetryStateForRoots(roots);
      return;
    }

    const deferredRoots = this.collectDeferredMutationRetryRoots(roots, runtimeTargets);
    const deferredRootSet = new Set(deferredRoots);
    roots.forEach((root) => {
      if (!deferredRootSet.has(root)) {
        this.clearDeferredMutationRetryStateForRoots([root]);
      }
    });
    this.scheduleDeferredMutationRetryRoots(deferredRoots);
  }

  private getAttributeOriginalText(element: Element, attributeName: string, fallback: string): string {
    const originalValues = this.textAttributeOriginalMap.get(element);
    if (originalValues?.has(attributeName)) {
      return originalValues.get(attributeName) ?? fallback;
    }

    const nextValues = originalValues ?? new Map<string, string>();
    nextValues.set(attributeName, fallback);
    this.textAttributeOriginalMap.set(element, nextValues);
    return fallback;
  }

  private restoreRemovedTextTargets(
    previousTargets: ReadonlyMap<string, TextRuntimeTarget>,
    liveBindingIds: ReadonlySet<string>
  ): void {
    previousTargets.forEach((target, bindingId) => {
      if (liveBindingIds.has(bindingId)) {
        return;
      }

      this.restoreRuntimeTargetOriginalText(target);
    });
  }

  private restoreRuntimeTargetOriginalText(target: TextRuntimeTarget): void {
    this.withTextObserverSuppressed(() => {
      target.applyRenderedText(target.getOriginalText());
      target.styleElement.removeAttribute("data-lextrace-text-binding-id");
      target.styleElement.removeAttribute("data-lextrace-text-debug");
      target.styleElement.removeAttribute("data-lextrace-text-editable");
    });
  }

  private restoreAndClearAllTextTargets(): void {
    this.textTargetMap.forEach((target) => {
      this.restoreRuntimeTargetOriginalText(target);
    });
    this.textTargetMap.clear();
    this.clearTextHighlights();
  }

  private isRuntimeTextTargetCurrent(target: TextRuntimeTarget | undefined): boolean {
    if (!target) {
      return false;
    }

    if (!target.styleElement.isConnected || !target.highlightElement.isConnected) {
      return false;
    }

    if (target.textNode === null || target.textNode.isConnected) {
      return true;
    }

    return (
      this.inlineTextEditor?.bindingId === target.bindingId &&
      this.inlineTextEditor.editor.isConnected
    );
  }

  private ensureCurrentTextTargetsMaterialized(pageMap: TextPageMap): void {
    const needsRematerialization = pageMap.bindings.some((binding) => {
      if (binding.presence !== "live") {
        return false;
      }
      return !this.isRuntimeTextTargetCurrent(this.textTargetMap.get(binding.bindingId));
    });

    if (!needsRematerialization) {
      return;
    }

    this.materializeCurrentPageTextTargets(pageMap);
  }

  private withTextObserverSuppressed(action: () => void): void {
    this.textObserverSuppressionDepth += 1;
    this.textObserverSuppressedUntil = Math.max(
      this.textObserverSuppressedUntil,
      Date.now() + TEXT_OBSERVER_SUPPRESSION_WINDOW_MS
    );
    try {
      action();
    } finally {
      window.setTimeout(() => {
        this.textObserverSuppressionDepth = Math.max(0, this.textObserverSuppressionDepth - 1);
      }, TEXT_OBSERVER_SUPPRESSION_WINDOW_MS);
    }
  }

  private isTextObserverSuppressed(): boolean {
    return this.textObserverSuppressionDepth > 0 || Date.now() < this.textObserverSuppressedUntil;
  }

  private schedulePendingIncrementalTextRefresh(reason: string, delayMs = this.getIncrementalRefreshDebounceMs()): void {
    if (this.textScanTimer !== null) {
      window.clearTimeout(this.textScanTimer);
    }

    this.textScanTimer = window.setTimeout(() => {
      this.textScanTimer = null;
      void this.refreshTextBindingsIncrementally(reason);
    }, Math.max(0, delayMs));
  }

  private scheduleIncrementalTextRefreshFromRoots(
    roots: Iterable<HTMLElement>,
    reason: string,
    delayMs = this.getIncrementalRefreshDebounceMs()
  ): void {
    for (const root of roots) {
      this.pendingTextMutationRoots.add(root);
    }

    this.schedulePendingIncrementalTextRefresh(reason, delayMs);
  }

  private scheduleSuppressedTextMutationFlush(): void {
    if (this.textObserverSuppressionFlushTimer !== null) {
      window.clearTimeout(this.textObserverSuppressionFlushTimer);
    }

    const delayMs = Math.max(0, this.textObserverSuppressedUntil - Date.now()) + 8;
    this.textObserverSuppressionFlushTimer = window.setTimeout(() => {
      this.textObserverSuppressionFlushTimer = null;
      this.flushSuppressedTextMutationRoots();
    }, delayMs);
  }

  private flushSuppressedTextMutationRoots(): void {
    if (this.pendingSuppressedTextMutationRoots.size === 0 || !this.shouldObserveTextElements()) {
      this.pendingSuppressedTextMutationRoots.clear();
      return;
    }

    if (this.isTextObserverSuppressed()) {
      this.scheduleSuppressedTextMutationFlush();
      return;
    }

    this.scheduleIncrementalTextRefreshFromRoots(
      [...this.pendingSuppressedTextMutationRoots],
      "mutation:deferred"
    );
    this.pendingSuppressedTextMutationRoots.clear();
  }

  private clearDeferredMutationRetryStateForRoots(roots: Iterable<HTMLElement>): void {
    let didChange = false;
    for (const root of roots) {
      if (this.pendingDeferredTextMutationRetryRoots.delete(root)) {
        didChange = true;
      }
      this.deferredTextMutationRetryAttempts.delete(root);
    }

    if (
      didChange &&
      this.pendingDeferredTextMutationRetryRoots.size === 0 &&
      this.textDeferredMutationRetryTimer !== null
    ) {
      window.clearTimeout(this.textDeferredMutationRetryTimer);
      this.textDeferredMutationRetryTimer = null;
    }
  }

  private scheduleDeferredMutationRetryRoots(roots: readonly HTMLElement[]): void {
    if (!this.isDeferredMutationRetryEnabled() || roots.length === 0 || !this.shouldObserveTextElements()) {
      return;
    }

    let didQueueRoot = false;
    roots.forEach((root) => {
      if (!root.isConnected || isTextDebugSkippableElement(root)) {
        this.deferredTextMutationRetryAttempts.delete(root);
        this.pendingDeferredTextMutationRetryRoots.delete(root);
        return;
      }

      const nextAttempt = (this.deferredTextMutationRetryAttempts.get(root) ?? 0) + 1;
      if (nextAttempt > TEXT_DEFERRED_MUTATION_RETRY_MAX_ATTEMPTS) {
        this.deferredTextMutationRetryAttempts.delete(root);
        this.pendingDeferredTextMutationRetryRoots.delete(root);
        return;
      }

      this.deferredTextMutationRetryAttempts.set(root, nextAttempt);
      this.pendingDeferredTextMutationRetryRoots.add(root);
      didQueueRoot = true;
    });

    if (!didQueueRoot) {
      return;
    }

    if (this.textDeferredMutationRetryTimer !== null) {
      window.clearTimeout(this.textDeferredMutationRetryTimer);
    }

    this.textDeferredMutationRetryTimer = window.setTimeout(() => {
      this.textDeferredMutationRetryTimer = null;
      this.flushDeferredMutationRetryRoots();
    }, this.getDeferredMutationRetryDelayMs());
  }

  private flushDeferredMutationRetryRoots(): void {
    if (!this.shouldObserveTextElements() || this.pendingDeferredTextMutationRetryRoots.size === 0) {
      this.pendingDeferredTextMutationRetryRoots.clear();
      return;
    }

    const retryRoots = this.normalizeMutationRoots(
      [...this.pendingDeferredTextMutationRetryRoots].filter(
        (root) => root.isConnected && !isTextDebugSkippableElement(root) && isTextDebugPotentiallyVisibleElement(root)
      )
    );
    this.pendingDeferredTextMutationRetryRoots.clear();
    if (retryRoots.length === 0) {
      return;
    }

    this.scheduleIncrementalTextRefreshFromRoots(retryRoots, "mutation:retry", 0);
  }

  private applyTextBindingsToDom(): void {
    const pageMap = this.textPageMap;
    if (!pageMap) {
      this.clearTextHighlights();
      return;
    }

    const displayMode = this.getTextDisplayMode();
    this.withTextObserverSuppressed(() => {
      pageMap.bindings.forEach((binding) => {
        const target = this.textTargetMap.get(binding.bindingId);
        if (!target) {
          return;
        }

        const desiredText = resolveDisplayedBindingText(
          {
            originalText: target.getOriginalText(),
            replacementText: binding.replacementText
          },
          displayMode
        );
        if (target.readCurrentText() !== desiredText) {
          target.applyRenderedText(desiredText);
        }
      });
    });
  }

  private ensureTextDebugStyleElement(): void {
    if (this.textDebugStyleElement?.isConnected) {
      return;
    }

    const style = document.createElement("style");
    style.id = "lextrace-text-debug-style";
    style.textContent = `
      [data-lextrace-text-editable="true"] {
        cursor: text !important;
      }
      [data-lextrace-text-binding-id][data-lextrace-text-debug="source"] {
        outline: 2px solid rgba(198, 84, 84, 0.98);
        outline-offset: 1px;
        background: rgba(198, 84, 84, 0.12);
        text-decoration: underline rgba(198, 84, 84, 1.0) 2px;
        text-underline-offset: 2px;
      }
      [data-lextrace-text-binding-id][data-lextrace-text-debug="changed"] {
        outline: 2px solid rgba(46, 148, 84, 0.98);
        outline-offset: 1px;
        background: rgba(46, 148, 84, 0.12);
        text-decoration: underline rgba(46, 148, 84, 1.0) 2px;
        text-underline-offset: 2px;
      }
      .lextrace-text-highlight-layer {
        position: fixed;
        inset: 0;
        z-index: 2147483645;
        pointer-events: none;
        overflow: hidden;
        contain: layout style paint;
      }
      .lextrace-text-highlight-box {
        position: absolute;
        box-sizing: border-box;
        border-radius: 2px;
        contain: paint;
      }
      .lextrace-text-highlight-box.is-source {
        box-shadow:
          inset 0 0 0 2px rgba(198, 84, 84, 0.98),
          0 0 0 1px rgba(198, 84, 84, 0.28),
          0 0 14px rgba(198, 84, 84, 0.32);
        background: rgba(198, 84, 84, 0.18);
      }
      .lextrace-text-highlight-box.is-changed {
        box-shadow:
          inset 0 0 0 2px rgba(46, 148, 84, 0.98),
          0 0 0 1px rgba(46, 148, 84, 0.24),
          0 0 14px rgba(46, 148, 84, 0.32);
        background: rgba(46, 148, 84, 0.18);
      }
      ::highlight(${TEXT_SOURCE_HIGHLIGHT_NAME}) {
        background: rgba(198, 84, 84, 0.35);
        color: inherit;
        text-decoration: underline rgba(198, 84, 84, 1.0) 3px;
        text-underline-offset: 2px;
      }
      ::highlight(${TEXT_CHANGED_HIGHLIGHT_NAME}) {
        background: rgba(46, 148, 84, 0.35);
        color: inherit;
        text-decoration: underline rgba(46, 148, 84, 1.0) 3px;
        text-underline-offset: 2px;
      }
      .lextrace-inline-text-editor {
        position: fixed;
        z-index: 2147483646;
        box-sizing: border-box;
        min-width: 1px;
        min-height: 1px;
        margin: 0;
        padding: 0;
        border: none;
        outline: 1px solid #111111;
        outline-offset: 0;
        border-radius: 0;
        background: rgba(255, 253, 247, 0.96);
        color: #111111;
        caret-color: #111111;
        font: 13px/1.4 "Bahnschrift", "Segoe UI Variable Text", "Segoe UI", sans-serif;
        resize: both;
        box-shadow: 0 12px 28px rgba(17, 17, 17, 0.18);
        overflow: hidden;
      }
      .lextrace-inline-text-editor-inline {
        display: inline;
        position: static;
        z-index: auto;
        width: auto;
        height: auto;
        min-width: 0;
        min-height: 0;
        padding: 0;
        margin: 0;
        border: none;
        border-radius: 0;
        outline: none;
        background: transparent;
        color: inherit;
        caret-color: #111111;
        white-space: pre-wrap;
        resize: none;
        box-shadow: none;
        overflow: visible;
        vertical-align: baseline;
        text-decoration: inherit;
      }
    `;
    document.documentElement.appendChild(style);
    this.textDebugStyleElement = style;
  }

  private getNativeTextHighlightRegistry():
    | {
        set: (name: string, highlight: TextHighlightHandle) => void;
        delete: (name: string) => void;
      }
    | null {
    if (!supportsNativeTextHighlights()) {
      return null;
    }

    return (CSS as typeof CSS & {
      highlights: {
        set: (name: string, highlight: TextHighlightHandle) => void;
        delete: (name: string) => void;
      };
    }).highlights;
  }

  private ensureNativeTextHighlights(): boolean {
    const registry = this.getNativeTextHighlightRegistry();
    if (!registry) {
      return false;
    }

    if (!this.textSourceHighlightHandle) {
      this.textSourceHighlightHandle = new Highlight();
      registry.set(TEXT_SOURCE_HIGHLIGHT_NAME, this.textSourceHighlightHandle);
    }
    if (!this.textChangedHighlightHandle) {
      this.textChangedHighlightHandle = new Highlight();
      registry.set(TEXT_CHANGED_HIGHLIGHT_NAME, this.textChangedHighlightHandle);
    }
    return true;
  }

  private clearNativeTextHighlights(): void {
    this.textHighlightRanges.forEach((range) => {
      this.textSourceHighlightHandle?.delete(range);
      this.textChangedHighlightHandle?.delete(range);
    });
    this.textHighlightRanges.clear();
    this.textHighlightRangeKinds.clear();

    const registry = this.getNativeTextHighlightRegistry();
    if (registry) {
      registry.delete(TEXT_SOURCE_HIGHLIGHT_NAME);
      registry.delete(TEXT_CHANGED_HIGHLIGHT_NAME);
    }
    this.textSourceHighlightHandle = null;
    this.textChangedHighlightHandle = null;
  }

  private removeTextHighlightRangeForBinding(bindingId: string): void {
    const range = this.textHighlightRanges.get(bindingId);
    if (!range) {
      return;
    }

    this.textSourceHighlightHandle?.delete(range);
    this.textChangedHighlightHandle?.delete(range);
    this.textHighlightRanges.delete(bindingId);
    this.textHighlightRangeKinds.delete(bindingId);
  }

  private renderNativeTextHighlightForBinding(bindingId: string, binding: TextBindingRecord, target: TextRuntimeTarget): boolean {
    if (!target.textNode || target.attributeName !== null || !target.textNode.isConnected || !this.ensureNativeTextHighlights()) {
      this.removeTextHighlightRangeForBinding(bindingId);
      return false;
    }

    const rects = getRenderableTextNodeClientRects(target.textNode).filter((rect) => isRenderableTextRect(rect));
    if (rects.length === 0) {
      this.removeTextHighlightRangeForBinding(bindingId);
      return false;
    }

    const nextDebugKind = binding.changed ? "changed" : "source";
    const existingRange = this.textHighlightRanges.get(bindingId);
    const existingKind = this.textHighlightRangeKinds.get(bindingId);
    if (
      existingRange &&
      existingKind === nextDebugKind &&
      existingRange.startContainer === target.textNode &&
      existingRange.endContainer === target.textNode
    ) {
      return true;
    }

    this.removeTextHighlightRangeForBinding(bindingId);
    const range = document.createRange();
    range.selectNodeContents(target.textNode);
    const handle = binding.changed ? this.textChangedHighlightHandle : this.textSourceHighlightHandle;
    handle?.add(range);
    this.textHighlightRanges.set(bindingId, range);
    this.textHighlightRangeKinds.set(bindingId, nextDebugKind);
    return true;
  }

  private renderTextHighlightBoxesForBinding(bindingId: string, binding?: TextBindingRecord | null): void {
    const pageMap = this.textPageMap;
    const activeBinding = binding ?? pageMap?.bindings.find((candidate) => candidate.bindingId === bindingId) ?? null;
    const target = this.textTargetMap.get(bindingId);
    if (
      !pageMap ||
      !(this.currentConfig?.debug.textElements.highlightEnabled ?? false) ||
      !activeBinding ||
      activeBinding.presence !== "live" ||
      !target ||
      !isRuntimeTargetVisuallyRenderable(target)
    ) {
      this.removeTextHighlightRangeForBinding(bindingId);
      return;
    }

    if (this.renderNativeTextHighlightForBinding(bindingId, activeBinding, target)) {
      return;
    }

    this.removeTextHighlightRangeForBinding(bindingId);
  }

  private renderTextHighlightBoxes(): void {
    const pageMap = this.textPageMap;
    if (!pageMap || !(this.currentConfig?.debug.textElements.highlightEnabled ?? false)) {
      this.clearNativeTextHighlights();
      return;
    }

    const liveBindingIds = new Set<string>();
    for (const binding of pageMap.bindings) {
      if (binding.presence === "live") {
        liveBindingIds.add(binding.bindingId);
        this.renderTextHighlightBoxesForBinding(binding.bindingId, binding);
      }
    }

    this.textHighlightRanges.forEach((_range, bindingId) => {
      if (!liveBindingIds.has(bindingId)) {
        this.removeTextHighlightRangeForBinding(bindingId);
      }
    });
  }

  private clearTextHighlights(): void {
    this.clearTextHighlightAttributes();
    this.clearNativeTextHighlights();
  }

  private clearTextHighlightAttributes(): void {
    this.highlightedTextElements.forEach((element) => {
      element.removeAttribute("data-lextrace-text-binding-id");
      element.removeAttribute("data-lextrace-text-debug");
      element.removeAttribute("data-lextrace-text-editable");
    });
    this.highlightedTextElements.clear();
  }

  private updateTextDebugPresentation(): void {
    this.applyTextBindingsToDom();
    this.clearTextHighlightAttributes();

    const pageMap = this.textPageMap;
    if (!pageMap) {
      this.clearNativeTextHighlights();
      this.resetInlineTextEditor();
      return;
    }

    const highlightEnabled = this.currentConfig?.debug.textElements.highlightEnabled ?? false;
    const inlineEditingEnabled = this.currentConfig?.debug.textElements.inlineEditingEnabled ?? false;
    if (!inlineEditingEnabled) {
      this.resetInlineTextEditor();
    }
    if (!highlightEnabled && !inlineEditingEnabled) {
      this.clearNativeTextHighlights();
      return;
    }

    this.ensureTextDebugStyleElement();
    pageMap.bindings.forEach((binding) => {
      const target = this.textTargetMap.get(binding.bindingId);
      if (!target) {
        return;
      }

      const interactiveElement = target.styleElement;
      if (isRuntimeTargetVisuallyRenderable(target)) {
        interactiveElement.setAttribute("data-lextrace-text-binding-id", binding.bindingId);
        if (inlineEditingEnabled && this.canInlineEditRuntimeTarget(target)) {
          interactiveElement.setAttribute("data-lextrace-text-editable", "true");
        }
        if (highlightEnabled && !canUseNativeTextPresentation(target)) {
          interactiveElement.setAttribute("data-lextrace-text-debug", binding.changed ? "changed" : "source");
        }
      }
      this.highlightedTextElements.add(interactiveElement);
    });

    if (highlightEnabled) {
      this.renderTextHighlightBoxes();
      return;
    }

    this.clearNativeTextHighlights();
  }

  private shouldObserveTextElements(): boolean {
    const pageContext = this.getCurrentPageContext();
    if (!pageContext || !this.textPageMap) {
      return false;
    }

    return this.isIncrementalTextAutoScanEnabled() &&
      this.textTrackedPageKeys.has(pageContext.pageKey) &&
      this.shouldHydrateTextElements();
  }

  private updateTextObservationState(): void {
    const shouldObserve = this.shouldObserveTextElements();
    const root = document.body ?? document.documentElement;
    if (shouldObserve && root && !this.textMutationObserver) {
      this.textMutationObserver = new MutationObserver((records) => {
        if (this.isTextObserverSuppressed()) {
          const suppressedRoots = new Set<HTMLElement>();
          records.forEach((record) => {
            this.collectMutationRoots(record).forEach((mutationRoot) => {
              suppressedRoots.add(mutationRoot);
            });
          });
          this.clearDeferredMutationRetryStateForRoots(suppressedRoots);
          suppressedRoots.forEach((mutationRoot) => {
            this.pendingSuppressedTextMutationRoots.add(mutationRoot);
          });
          this.scheduleSuppressedTextMutationFlush();
          return;
        }
        this.scheduleIncrementalTextRefresh(records, "mutation");
      });
      this.textMutationObserver.observe(root, {
        childList: true,
        characterData: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["placeholder", "value", "hidden", "aria-hidden"]
      });
      return;
    }

    if (!shouldObserve && this.textMutationObserver) {
      this.textMutationObserver.disconnect();
      this.textMutationObserver = null;
    }

    if (!shouldObserve) {
      this.pendingTextMutationRoots.clear();
      this.pendingSuppressedTextMutationRoots.clear();
      this.pendingDeferredTextMutationRetryRoots.clear();
      this.deferredTextMutationRetryAttempts.clear();
      if (this.textScanTimer !== null) {
        window.clearTimeout(this.textScanTimer);
        this.textScanTimer = null;
      }
      if (this.textObserverSuppressionFlushTimer !== null) {
        window.clearTimeout(this.textObserverSuppressionFlushTimer);
        this.textObserverSuppressionFlushTimer = null;
      }
      if (this.textDeferredMutationRetryTimer !== null) {
        window.clearTimeout(this.textDeferredMutationRetryTimer);
        this.textDeferredMutationRetryTimer = null;
      }
      if (this.textViewportScanTimer !== null) {
        window.clearTimeout(this.textViewportScanTimer);
        this.textViewportScanTimer = null;
      }
    }
  }

  private scheduleIncrementalTextRefresh(records: MutationRecord[], reason: string): void {
    const nextRoots = new Set<HTMLElement>();
    records.forEach((record) => {
      this.collectMutationRoots(record).forEach((root) => {
        nextRoots.add(root);
      });
    });
    this.clearDeferredMutationRetryStateForRoots(nextRoots);
    nextRoots.forEach((root) => {
      this.pendingTextMutationRoots.add(root);
    });
    this.schedulePendingIncrementalTextRefresh(reason);
  }

  private collectMutationRoots(record: MutationRecord): HTMLElement[] {
    const roots = new Set<HTMLElement>();
    const addRoot = (value: Node | null | undefined) => {
      if (!value) {
        return;
      }

      if (value instanceof HTMLElement) {
        if (this.isElementInsideOverlay(value) || isTextDebugSkippableElement(value)) {
          return;
        }
        roots.add(value);
        return;
      }

      if (value instanceof Text && value.parentElement) {
        if (
          this.isElementInsideOverlay(value.parentElement) ||
          isTextDebugSkippableElement(value.parentElement)
        ) {
          return;
        }
        roots.add(value.parentElement);
      }
    };

    addRoot(record.target);
    if (record.type === "childList") {
      record.addedNodes.forEach((node) => addRoot(node));
      record.removedNodes.forEach((node) => addRoot(node.parentNode));
    }

    return this.normalizeMutationRoots([...roots]);
  }

  private normalizeMutationRoots(roots: readonly HTMLElement[]): HTMLElement[] {
    const uniqueRoots = roots.filter((root, index, array) => array.indexOf(root) === index);
    return uniqueRoots.filter((root) => !uniqueRoots.some((candidate) => candidate !== root && candidate.contains(root)));
  }

  private async handleTextScanCommand(logSummary = true): Promise<TextPageMap | null> {
    try {
      return await this.ensureTextElementsHydrated({
        reason: "manual-scan",
        logSummary,
        forceScan: true
      });
    } catch (error) {
      this.pushConsole("error", formatUserFacingCommandError(error, "Не удалось пересканировать тексты страницы."));
      await recordLog(
        "content",
        "text.scan.failed",
        "Не удалось пересканировать тексты страницы.",
        serializeLogDetails(error),
        "error"
      );
      return null;
    }
  }

  private buildTextBindingOutput(binding: TextBindingRecord): Record<string, unknown> {
    return {
      bindingId: binding.bindingId,
      category: binding.category,
      presence: binding.presence,
      staleSince: binding.staleSince,
      changed: binding.changed,
      originalText: binding.originalText,
      replacementText: binding.replacementText,
      displayedText: resolveDisplayedBindingText(
        {
          originalText: binding.originalText,
          replacementText: binding.replacementText
        },
        this.getTextDisplayMode()
      ),
      currentText: binding.currentText,
      selector:
        binding.context.selectorPreview ??
        binding.locator.preferredSelector ??
        binding.locator.elementSelector ??
        binding.locator.ancestorSelector,
      attributeName: binding.attributeName,
      matchStrategy: binding.matchStrategy
    };
  }

  private async downloadTextMap(): Promise<void> {
    const pageContext = this.requireCurrentPageContext("text.download");
    await this.ensureTextElementsHydrated({
      reason: "download",
      logSummary: false
    });
    const pageMap = this.textPageMap ?? this.textStorageEnvelope.pages[pageContext.pageKey] ?? null;
    if (!pageMap) {
      throw new Error("Карта текстов ещё не собрана. Сначала запусти text.scan.");
    }

    const exportedAt = new Date().toISOString();
    const payload = {
      schemaVersion: 1,
      scope: "text-map",
      exportedAt,
      pageKey: pageContext.pageKey,
      pageUrl: pageContext.pageUrl,
      summary: buildTextMapSummary(pageMap),
      pageMap
    };
    const fileName = formatTextMapExportFileName(pageContext.pageKey, exportedAt);
    this.downloadJsonFile(fileName, payload);
    await recordLog("content", "text.map.export", "Карта текстов выгружена в JSON.", {
      fileName,
      pageKey: pageContext.pageKey,
      bindingCount: pageMap.bindings.length
    });
  }

  private async updateCurrentPageTextBinding(
    bindingId: string,
    replacementText: string | null
  ): Promise<TextBindingRecord> {
    const currentPageMap =
      (await this.ensureTextElementsHydrated({
        reason: "binding-update",
        logSummary: false
      })) ?? this.textPageMap;
    if (!currentPageMap) {
      throw new Error("Карта текстов текущей страницы недоступна.");
    }

    const existingBinding = currentPageMap.bindings.find((binding) => binding.bindingId === bindingId);
    if (!existingBinding) {
      throw new Error(`Текстовая привязка не найдена: ${bindingId}`);
    }

    const normalizedReplacement = replacementText === null
      ? null
      : sanitizeReplacementText(replacementText) === existingBinding.originalText
        ? null
        : sanitizeReplacementText(replacementText);
    const nextPageMap = {
      ...updateBindingReplacement(currentPageMap, bindingId, normalizedReplacement, {
        now: new Date().toISOString()
      }),
      displayMode: this.getTextDisplayMode()
    };
    this.textPageMap = nextPageMap;
    this.textStorageEnvelope = upsertPageMapInEnvelope(this.textStorageEnvelope, nextPageMap);
    await this.persistTextStorageEnvelope(this.textStorageEnvelope);
    this.textPageMapPersisted = true;
    this.ensureCurrentTextTargetsMaterialized(nextPageMap);
    this.updateTextDebugPresentation();
    this.renderTexts();

    const updatedBinding = nextPageMap.bindings.find((binding) => binding.bindingId === bindingId);
    if (!updatedBinding) {
      throw new Error(`Не удалось обновить текстовую привязку ${bindingId}.`);
    }

    await recordLog("content", "text.binding.updated", "Текстовая привязка обновлена.", {
      bindingId,
      changed: updatedBinding.changed,
      category: updatedBinding.category
    });

    return updatedBinding;
  }

  private async resetCurrentPageTextBindings(): Promise<TextPageMap> {
    const currentPageMap =
      (await this.ensureTextElementsHydrated({
        reason: "page-reset",
        logSummary: false
      })) ?? this.textPageMap;
    if (!currentPageMap) {
      throw new Error("Карта текстов текущей страницы недоступна.");
    }

    const nextPageMap = {
      ...resetPageBindings(currentPageMap, {
        now: new Date().toISOString()
      }),
      displayMode: this.getTextDisplayMode()
    };
    this.textPageMap = nextPageMap;
    this.textStorageEnvelope = upsertPageMapInEnvelope(this.textStorageEnvelope, nextPageMap);
    await this.persistTextStorageEnvelope(this.textStorageEnvelope);
    this.textPageMapPersisted = true;
    this.ensureCurrentTextTargetsMaterialized(nextPageMap);
    this.updateTextDebugPresentation();
    this.renderTexts();

    await recordLog("content", "text.page.reset", "Изменения текстов текущей страницы сброшены.", {
      pageKey: nextPageMap.pageKey,
      bindingCount: nextPageMap.bindings.length
    });

    return nextPageMap;
  }

  private async blankCurrentPageTextBindings(): Promise<TextPageMap> {
    const currentPageMap =
      (await this.ensureTextElementsHydrated({
        reason: "page-blank",
        logSummary: false
      })) ?? this.textPageMap;
    if (!currentPageMap) {
      throw new Error("Карта текстов текущей страницы недоступна.");
    }

    const nextBlankState = this.buildBlankedTextPageMap(currentPageMap, {
      includeStale: true,
      now: new Date().toISOString(),
      touchMatchedAt: true,
      autoBlanked: false
    });
    const nextPageMap = nextBlankState.pageMap;

    this.textPageMap = nextPageMap;
    this.textStorageEnvelope = upsertPageMapInEnvelope(this.textStorageEnvelope, nextPageMap);
    await this.persistTextStorageEnvelope(this.textStorageEnvelope);
    this.textPageMapPersisted = true;
    this.ensureCurrentTextTargetsMaterialized(nextPageMap);
    this.applyTextBindingsToDom();
    window.setTimeout(() => {
      if (
        this.textPageMap?.pageKey === nextPageMap.pageKey &&
        this.textPageMap.updatedAt === nextPageMap.updatedAt
      ) {
        this.updateTextDebugPresentation();
      }
    }, 0);
    this.renderTexts();

    await recordLog("content", "text.page.blank", "Тексты текущей страницы очищены пустой заменой.", {
      pageKey: nextPageMap.pageKey,
      bindingCount: nextBlankState.blankedBindings
    });

    return nextPageMap;
  }

  private async deleteCurrentTextBinding(bindingId: string): Promise<{ bindingId: string; remainingBindings: number }> {
    const pageContext = this.requireCurrentPageContext("text.delete");
    await this.ensureTextElementsHydrated({
      reason: "binding-delete",
      logSummary: false
    });
    const currentPageMap = this.textPageMap ?? this.textStorageEnvelope.pages[pageContext.pageKey] ?? null;
    if (!currentPageMap) {
      throw new Error("Карта текстов текущей страницы недоступна.");
    }

    const existingBinding = currentPageMap.bindings.find((binding) => binding.bindingId === bindingId);
    if (!existingBinding) {
      throw new Error(`Текстовая привязка не найдена: ${bindingId}`);
    }

    if (this.inlineTextEditor?.bindingId === bindingId) {
      this.resetInlineTextEditor();
    }

    const runtimeTarget = this.textTargetMap.get(bindingId);
    if (runtimeTarget) {
      this.restoreRuntimeTargetOriginalText(runtimeTarget);
      this.textTargetMap.delete(bindingId);
      this.highlightedTextElements.delete(runtimeTarget.styleElement);
    }

    const nextPageMap = removeBindingFromPageMap(currentPageMap, bindingId, {
      now: new Date().toISOString()
    });

    if (nextPageMap.bindings.length > 0) {
      this.textPageMap = nextPageMap;
      this.textStorageEnvelope = upsertPageMapInEnvelope(this.textStorageEnvelope, nextPageMap);
      this.textPageMapPersisted = true;
    } else {
      this.suppressedTextAutoScanPageKeys.add(currentPageMap.pageKey);
      this.textTrackedPageKeys.delete(currentPageMap.pageKey);
      this.textPageMap = null;
      this.textPageMapPersisted = false;
      this.textStorageEnvelope = removePageMapFromEnvelope(this.textStorageEnvelope, currentPageMap.pageKey);
    }

    await this.persistTextStorageEnvelope(this.textStorageEnvelope);
    this.renderTexts();
    this.updateTextObservationState();

    await recordLog("content", "text.binding.deleted", "Текстовая привязка удалена из карты.", {
      bindingId,
      pageKey: currentPageMap.pageKey,
      remainingBindings: nextPageMap.bindings.length
    });

    return {
      bindingId,
      remainingBindings: nextPageMap.bindings.length
    };
  }

  private async deleteCurrentPageTextMap(): Promise<{ pageKey: string; removedBindings: number }> {
    const pageContext = this.requireCurrentPageContext("text.delete");
    await this.ensureTextElementsHydrated({
      reason: "page-delete",
      logSummary: false
    });
    const currentPageMap = this.textPageMap ?? this.textStorageEnvelope.pages[pageContext.pageKey] ?? null;
    if (!currentPageMap) {
      throw new Error("Для текущей страницы нет сохранённой карты текстов.");
    }

    this.resetInlineTextEditor();
    this.restoreAndClearAllTextTargets();
    this.suppressedTextAutoScanPageKeys.add(currentPageMap.pageKey);
    this.textTrackedPageKeys.delete(currentPageMap.pageKey);
    this.textPageMap = null;
    this.textPageMapPersisted = false;
    this.textStorageEnvelope = removePageMapFromEnvelope(this.textStorageEnvelope, currentPageMap.pageKey);
    await this.persistTextStorageEnvelope(this.textStorageEnvelope);
    this.renderTexts();
    this.updateTextObservationState();

    await recordLog("content", "text.page.deleted", "Карта текстов текущей страницы удалена.", {
      pageKey: currentPageMap.pageKey,
      removedBindings: currentPageMap.bindings.length
    });

    return {
      pageKey: currentPageMap.pageKey,
      removedBindings: currentPageMap.bindings.length
    };
  }

  private async resetAllTextStorage(): Promise<{ clearedPages: number }> {
    await this.ensureTextElementsHydrated({
      reason: "storage-reset",
      logSummary: false
    });
    const clearedPages = Object.keys(this.textStorageEnvelope.pages).length;
    const now = new Date().toISOString();
    const currentPageContext = this.getCurrentPageContext();
    this.resetInlineTextEditor();
    this.withTextObserverSuppressed(() => {
      if (this.textPageMap) {
        this.textPageMap = {
          ...resetPageBindings(this.textPageMap, {
            now
          }),
          displayMode: this.getTextDisplayMode()
        };
        this.applyTextBindingsToDom();
      }

      this.restoreAndClearAllTextTargets();
    });
    if (currentPageContext) {
      this.suppressedTextAutoScanPageKeys.add(currentPageContext.pageKey);
    }
    this.textTrackedPageKeys.clear();
    this.textStorageEnvelope = createEmptyTextStorageEnvelope();
    this.textPageMap = null;
    this.textPageMapPersisted = false;
    await this.persistTextStorageEnvelope(this.textStorageEnvelope);
    this.renderTexts();
    this.updateTextObservationState();

    await recordLog("content", "text.storage.reset", "Все сохранённые карты текстов удалены.", {
      clearedPages
    });

    return {
      clearedPages
    };
  }

  private readonly handleDocumentTextContextMenu = (event: MouseEvent): void => {
    if (!(this.currentConfig?.debug.textElements.inlineEditingEnabled ?? false)) {
      return;
    }

    if (this.isElementInsideOverlay(event.target)) {
      return;
    }

    const targetElement = event.target instanceof Element
      ? event.target.closest<HTMLElement>("[data-lextrace-text-editable='true']")
      : null;
    const targetBindingId = targetElement?.getAttribute("data-lextrace-text-binding-id");
    const bindingIdAtPoint =
      targetBindingId ? null : this.resolveEditableTextBindingIdAtPoint(event.clientX, event.clientY);
    const bindingId = targetBindingId ?? bindingIdAtPoint;
    if (!bindingId || !this.textPageMap) {
      return;
    }

    const binding = this.textPageMap.bindings.find((candidate) => candidate.bindingId === bindingId);
    const runtimeTarget = this.textTargetMap.get(bindingId);
    if (!binding || !runtimeTarget || !this.canInlineEditRuntimeTarget(runtimeTarget)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
    this.openInlineTextEditor(binding, runtimeTarget);
  };

  private resolveEditableTextBindingIdAtPoint(clientX: number, clientY: number): string | null {
    const pageMap = this.textPageMap;
    if (!pageMap) {
      return null;
    }

    const matches = pageMap.bindings
      .map((binding) => {
        const target = this.textTargetMap.get(binding.bindingId);
        if (!target || !isRuntimeTargetVisuallyRenderable(target) || !this.canInlineEditRuntimeTarget(target)) {
          return null;
        }

        const matchingRect = target.getClientRects().find(
          (rect) =>
            clientX >= rect.left &&
            clientX <= rect.left + rect.width &&
            clientY >= rect.top &&
            clientY <= rect.top + rect.height
        );
        if (!matchingRect) {
          return null;
        }

        return {
          bindingId: binding.bindingId,
          area: matchingRect.width * matchingRect.height,
          prefersTextNode: target.textNode ? 0 : 1
        };
      })
      .filter((entry): entry is { bindingId: string; area: number; prefersTextNode: number } => entry !== null)
      .sort((left, right) => {
        if (left.prefersTextNode !== right.prefersTextNode) {
          return left.prefersTextNode - right.prefersTextNode;
        }
        return left.area - right.area;
      });

    return matches[0]?.bindingId ?? null;
  }

  private openInlineTextEditor(binding: TextBindingRecord, target: TextRuntimeTarget): void {
    this.resetInlineTextEditor();
    this.ensureTextDebugStyleElement();

    if (target.attributeName !== null) {
      return;
    }
    this.openInlineTextNodeEditor(binding, target);
  }

  private openInlineTextNodeEditor(binding: TextBindingRecord, target: TextRuntimeTarget): void {
    const sourceParent = target.textNode?.parentElement ?? target.styleElement;
    if (!sourceParent) {
      return;
    }
    let sourceTextNode = target.textNode;
    if (!sourceTextNode || !sourceTextNode.isConnected || sourceTextNode.parentElement !== sourceParent) {
      sourceTextNode = document.createTextNode(target.readCurrentText());
      this.withTextObserverSuppressed(() => {
        sourceParent.append(sourceTextNode as Text);
      });
    }

    this.removeTextHighlightRangeForBinding(binding.bindingId);

    const editor = document.createElement("span");
    editor.className = "lextrace-inline-text-editor lextrace-inline-text-editor-inline";
    editor.setAttribute("contenteditable", "true");
    editor.setAttribute("data-lextrace-inline-mode", "text-node");
    editor.setAttribute("data-lextrace-text-debug-skip", "true");
    editor.spellcheck = false;
    editor.textContent = target.readCurrentText();
    this.applyInlineTextEditorTextStyle(target, editor);
    this.applyInlineTextNodeEditorBoxStyle(editor);

    const bindingId = binding.bindingId;
    const commit = () => {
      void this.commitInlineTextEditor(bindingId);
    };
    editor.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        this.resetInlineTextEditor();
        return;
      }

      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        commit();
      }
    });
    editor.addEventListener("blur", () => {
      this.scheduleInlineTextEditorBlurCommit(bindingId, editor);
    });
    editor.addEventListener("paste", (event) => {
      const pastedText = event.clipboardData?.getData("text/plain");
      if (typeof pastedText !== "string") {
        return;
      }

      event.preventDefault();
      this.insertPlainTextIntoInlineEditor(editor, pastedText);
    });

    this.withTextObserverSuppressed(() => {
      sourceTextNode.replaceWith(editor);
    });
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    selection?.removeAllRanges();
    selection?.addRange(range);
    editor.focus();

    this.inlineTextEditor = {
      bindingId,
      editor,
      target,
      readValue: () => editor.textContent ?? "",
      restoreTextNode: sourceTextNode,
      cleanup: () => {
        this.withTextObserverSuppressed(() => {
          if (editor.isConnected) {
            editor.replaceWith(sourceTextNode);
          } else if (!sourceTextNode.isConnected) {
            sourceParent.append(sourceTextNode);
          }
        });
      }
    };
  }

  private applyInlineTextEditorTextStyle(target: TextRuntimeTarget, editor: HTMLElement): void {
    const sourceElement = target.textNode?.parentElement ?? target.styleElement;
    const style = window.getComputedStyle(sourceElement);
    editor.style.font = style.font;
    editor.style.fontSize = style.fontSize;
    editor.style.fontFamily = style.fontFamily;
    editor.style.fontWeight = style.fontWeight;
    editor.style.fontStyle = style.fontStyle;
    editor.style.lineHeight = style.lineHeight;
    editor.style.letterSpacing = style.letterSpacing;
    editor.style.textTransform = style.textTransform;
    editor.style.textAlign = style.textAlign;
    editor.style.whiteSpace = style.whiteSpace;
    editor.style.wordBreak = style.wordBreak;
    editor.style.overflowWrap = style.overflowWrap;
  }

  private applyInlineTextNodeEditorBoxStyle(editor: HTMLElement): void {
    editor.style.position = "static";
    editor.style.display = "inline";
    editor.style.zIndex = "auto";
    editor.style.left = "auto";
    editor.style.top = "auto";
    editor.style.right = "auto";
    editor.style.bottom = "auto";
    editor.style.width = "auto";
    editor.style.height = "auto";
    editor.style.minWidth = "0";
    editor.style.minHeight = "0";
    editor.style.margin = "0";
    editor.style.padding = "0";
    editor.style.border = "none";
    editor.style.borderRadius = "0";
    editor.style.outline = "none";
    editor.style.background = "transparent";
    editor.style.boxShadow = "none";
    editor.style.overflow = "visible";
    editor.style.resize = "none";
    editor.style.verticalAlign = "baseline";
  }

  private insertPlainTextIntoInlineEditor(editor: HTMLElement, text: string): void {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      editor.textContent = `${editor.textContent ?? ""}${text}`;
      return;
    }

    const range = selection.getRangeAt(0);
    if (!editor.contains(range.commonAncestorContainer)) {
      editor.textContent = `${editor.textContent ?? ""}${text}`;
      return;
    }

    range.deleteContents();
    const textNode = document.createTextNode(text);
    range.insertNode(textNode);
    range.setStartAfter(textNode);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  private isInlineTextEditorInteractionActive(editor: HTMLElement): boolean {
    const activeElement = document.activeElement;
    if (activeElement === editor) {
      return true;
    }
    if (activeElement instanceof Node && editor.contains(activeElement)) {
      return true;
    }

    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      return false;
    }

    return (
      (selection.anchorNode instanceof Node && editor.contains(selection.anchorNode)) ||
      (selection.focusNode instanceof Node && editor.contains(selection.focusNode))
    );
  }

  private scheduleInlineTextEditorBlurCommit(bindingId: string, editor: HTMLElement): void {
    window.setTimeout(() => {
      if (!this.inlineTextEditor || this.inlineTextEditor.bindingId !== bindingId || this.inlineTextEditor.editor !== editor) {
        return;
      }

      if (this.isInlineTextEditorInteractionActive(editor)) {
        return;
      }

      void this.commitInlineTextEditor(bindingId);
    }, 120);
  }

  private async commitInlineTextEditor(bindingId: string): Promise<void> {
    if (!this.inlineTextEditor || this.inlineTextEditor.bindingId !== bindingId) {
      return;
    }

    const nextValue = this.inlineTextEditor.readValue();
    if (this.inlineTextEditor.restoreTextNode) {
      this.inlineTextEditor.restoreTextNode.textContent = nextValue;
    }
    this.resetInlineTextEditor();
    await this.updateCurrentPageTextBinding(bindingId, nextValue);
  }

  private resetInlineTextEditor(): void {
    if (!this.inlineTextEditor) {
      return;
    }

    const bindingId = this.inlineTextEditor.bindingId;
    this.inlineTextEditor.cleanup();
    this.inlineTextEditor.editor.remove();
    this.inlineTextEditor = null;
    if (
      this.textPageMap?.bindings.some((binding) => binding.bindingId === bindingId) &&
      (this.currentConfig?.debug.textElements.highlightEnabled ?? false)
    ) {
      this.renderTextHighlightBoxesForBinding(bindingId);
    }
  }

  private buildOverlayTargetPayload(target: TerminalOverlayTarget): { tabId?: number; expectedUrl?: string } {
    switch (target.type) {
      case "tab":
        return {
          tabId: target.tabId
        };
      case "url":
        return {
          expectedUrl: target.url
        };
      case "current":
      default:
        return {};
    }
  }

  private resolveChatTarget(
    target: TerminalChatTarget,
    commandLabel: string
  ): { pageKey: string; pageUrl?: string; isCurrentPage: boolean } {
    if (target.type === "current") {
      const pageContext = this.requireCurrentPageContext(commandLabel);
      return {
        pageKey: pageContext.pageKey,
        pageUrl: pageContext.pageUrl,
        isCurrentPage: true
      };
    }

    const currentPageContext = this.getCurrentPageContext();
    if (target.type === "url") {
      const pageKey = normalizePageKey(target.url);
      if (!pageKey) {
        throw new Error(`${commandLabel} требует обычный http(s) URL страницы.`);
      }
      return {
        pageKey,
        pageUrl: target.url,
        isCurrentPage: currentPageContext?.pageKey === pageKey
      };
    }

    return {
      pageKey: target.pageKey,
      pageUrl: target.pageUrl ?? undefined,
      isCurrentPage: currentPageContext?.pageKey === target.pageKey
    };
  }

  private applyAiSessionResult(session: AiChatPageSession, isCurrentPage: boolean): AiChatPageSession {
    if (isCurrentPage) {
      this.aiSession = session;
      this.renderChat();
    }
    return session;
  }

  private parseTerminalSecretValue(valueText: string, commandLabel: string): string {
    const trimmed = valueText.trim();
    if (!trimmed.length) {
      throw new Error(`${commandLabel} требует значение.`);
    }

    if (trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
      const parsedValue = JSON.parse(trimmed);
      if (typeof parsedValue !== "string") {
        throw new Error(`${commandLabel} принимает строку.`);
      }
      return parsedValue;
    }

    return valueText;
  }

  private async getAiKeyStatusResult(): Promise<Record<string, unknown>> {
    const managedKey =
      typeof this.currentConfig?.ai.openAiApiKey === "string" ? this.currentConfig.ai.openAiApiKey.trim() : "";
    const currentPageStatus = this.aiSession?.status?.apiKeyPresent ?? null;
    let sessionApiKeyPresent = currentPageStatus;

    if (sessionApiKeyPresent === null) {
      const pageContext = this.getCurrentPageContext();
      if (pageContext) {
        const response = await sendCommand<{ session: AiChatPageSession }>(
          COMMANDS.aiChatStatus,
          "overlay",
          "background",
          {
            pageKey: pageContext.pageKey,
            pageUrl: pageContext.pageUrl
          }
        );
        const session = AiChatPageSessionSchema.parse(response.session);
        sessionApiKeyPresent = session.status.apiKeyPresent;
        this.applyAiSessionResult(session, true);
      }
    }

    if (sessionApiKeyPresent === null) {
      const listResult = await sendCommand<{ sessions: AiChatPageSession[] }>(COMMANDS.aiChatList, "overlay", "background");
      sessionApiKeyPresent = listResult.sessions.some((session) => session.status.apiKeyPresent);
    }

    const mode = managedKey.length > 0 ? "managed" : sessionApiKeyPresent ? "environment" : "missing";
    return {
      mode,
      apiKeyPresent: managedKey.length > 0 || sessionApiKeyPresent === true,
      managed: managedKey.length > 0
    };
  }

  private async sendAiChatToTarget(
    target: TerminalChatTarget,
    origin: "user" | "code",
    text: string
  ): Promise<AiChatPageSession> {
    const resolvedTarget = this.resolveChatTarget(target, origin === "code" ? "chat.code" : "chat.send");
    const response = await sendCommand<{ session: AiChatPageSession }>(
      COMMANDS.aiChatSend,
      "overlay",
      "background",
      {
        pageKey: resolvedTarget.pageKey,
        pageUrl: resolvedTarget.pageUrl ?? resolvedTarget.pageKey,
        origin,
        text
      }
    );
    const session = AiChatPageSessionSchema.parse(response.session);
    return this.applyAiSessionResult(session, resolvedTarget.isCurrentPage);
  }

  private async sendAiChat(origin: "user" | "code", text: string): Promise<AiChatPageSession> {
    return this.sendAiChatToTarget({ type: "current" }, origin, text);
  }

  private async resumeAiChatSessionForTarget(target: TerminalChatTarget): Promise<AiChatPageSession> {
    const resolvedTarget = this.resolveChatTarget(target, "chat.resume");
    const response = await sendCommand<{ session: AiChatPageSession }>(
      COMMANDS.aiChatResume,
      "overlay",
      "background",
      {
        pageKey: resolvedTarget.pageKey
      }
    );
    const session = AiChatPageSessionSchema.parse(response.session);
    return this.applyAiSessionResult(session, resolvedTarget.isCurrentPage);
  }

  private async resumeAiChatSession(): Promise<AiChatPageSession> {
    return this.resumeAiChatSessionForTarget({ type: "current" });
  }

  private async resetAiChatSessionForTarget(target: TerminalChatTarget): Promise<AiChatPageSession> {
    const resolvedTarget = this.resolveChatTarget(target, "chat.reset");
    const response = await sendCommand<{ session: AiChatPageSession }>(
      COMMANDS.aiChatReset,
      "overlay",
      "background",
      {
        pageKey: resolvedTarget.pageKey
      }
    );
    const session = AiChatPageSessionSchema.parse(response.session);
    return this.applyAiSessionResult(session, resolvedTarget.isCurrentPage);
  }

  private async resetAiChatSession(): Promise<AiChatPageSession> {
    return this.resetAiChatSessionForTarget({ type: "current" });
  }

  private async refreshAiChatStatusSessionForTarget(target: TerminalChatTarget): Promise<AiChatPageSession> {
    const resolvedTarget = this.resolveChatTarget(target, "chat.status");
    const response = await sendCommand<{ session: AiChatPageSession }>(
      COMMANDS.aiChatStatus,
      "overlay",
      "background",
      {
        pageKey: resolvedTarget.pageKey,
        pageUrl: resolvedTarget.pageUrl
      }
    );
    const session = AiChatPageSessionSchema.parse(response.session);
    return this.applyAiSessionResult(session, resolvedTarget.isCurrentPage);
  }

  private async refreshAiChatStatusSession(): Promise<AiChatPageSession> {
    return this.refreshAiChatStatusSessionForTarget({ type: "current" });
  }

  private async compactAiChatSessionForTarget(
    target: TerminalChatTarget,
    mode: "safe" | "force"
  ): Promise<{
    session: AiChatPageSession;
    triggered: boolean;
    mode: "safe" | "force";
    compactionId?: string | null;
    reason?: string | null;
    affectedMessageCount?: number;
    compactedItemCount?: number;
    preservedTailCount?: number;
  }> {
    const resolvedTarget = this.resolveChatTarget(target, mode === "force" ? "chat.compact.force" : "chat.compact");
    const response = AiChatCompactResultSchema.parse(
      await sendCommand(
        COMMANDS.aiChatCompact,
        "overlay",
        "background",
        {
          pageKey: resolvedTarget.pageKey,
          pageUrl: resolvedTarget.pageUrl,
          mode
        }
      )
    );
    this.applyAiSessionResult(response.session, resolvedTarget.isCurrentPage);
    return response;
  }

  private subscribeCurrentPageToStream(): void {
    const pageContext = this.getCurrentPageContext();
    if (!pageContext) {
      return;
    }

    try {
      this.streamPort?.postMessage({
        type: "page.subscribe",
        pageKey: pageContext.pageKey,
        pageUrl: pageContext.pageUrl,
        viewId: this.pageViewId
      });
    } catch {
      // Reconnect path owns recovery.
    }
  }

  private async sendChatMessage(): Promise<void> {
    const text = this.chatInput?.value.trim() ?? "";
    if (!text) {
      this.renderChatToolRow();
      return;
    }

    try {
      this.chatInput!.value = "";
      this.renderChatToolRow();
      await this.sendAiChat("user", text);
    } catch (error) {
      this.pushConsole("error", formatUserFacingCommandError(error, "Не удалось отправить сообщение в AI-чат."));
      await recordLog("content", "chat.send.failed", "Не удалось отправить сообщение в AI-чат.", serializeLogDetails(error), "error");
    }
  }

  private openChatQueueImportPicker(): void {
    if (this.chatQueueImportInProgress || !this.chatQueueFileInput) {
      return;
    }

    this.chatQueueFileInput.value = "";
    this.chatQueueFileInput.click();
  }

  private async handleChatQueueFileSelection(): Promise<void> {
    const input = this.chatQueueFileInput;
    const file = input?.files?.[0] ?? null;
    if (!file) {
      return;
    }

    try {
      await this.importChatQueueFromFile(file);
    } catch (error) {
      const details = serializeLogDetails(error);
      this.pushConsole(
        "error",
        formatUserFacingCommandError(error, `Не удалось загрузить очередь AI-запросов из ${file.name}.`)
      );
      await recordLog(
        "content",
        "chat.queue-import.failed",
        "Не удалось загрузить очередь AI-запросов из JSON.",
        {
          fileName: file.name,
          ...((details && typeof details === "object" && !Array.isArray(details)) ? details : { error: details })
        },
        "error"
      );
    } finally {
      if (input) {
        input.value = "";
      }
    }
  }

  private async importChatQueueFromFile(file: File): Promise<void> {
    this.chatQueueImportInProgress = true;
    this.renderChatToolRow();

    let importedCount = 0;
    try {
      const pageContext = this.requireCurrentPageContext("Импорт очереди AI");
      const target: TerminalChatTarget = {
        type: "key",
        pageKey: pageContext.pageKey,
        pageUrl: pageContext.pageUrl
      };
      const parsedRequests = parseAiQueueImportJson(await file.text());
      this.pushConsole(
        "system",
        `Импорт очереди AI из ${file.name} начат: ${parsedRequests.length} ${parsedRequests.length === 1 ? "запрос" : parsedRequests.length < 5 ? "запроса" : "запросов"}.`
      );
      await recordLog(
        "content",
        "chat.queue-import.started",
        "Импорт очереди AI из JSON начат.",
        {
          fileName: file.name,
          requestCount: parsedRequests.length
        }
      );

      for (const [index, request] of parsedRequests.entries()) {
        try {
          await this.sendAiChatToTarget(target, request.origin, request.text);
          importedCount += 1;
        } catch (error) {
          throw new Error(
            `Импорт очереди остановлен на элементе ${index + 1}/${parsedRequests.length}: ${formatUserFacingCommandError(
              error,
              "Не удалось поставить AI-запрос в очередь."
            )}`
          );
        }
      }

      this.pushConsole(
        "result",
        `Очередь AI из ${file.name} загружена: ${importedCount}/${parsedRequests.length} ${parsedRequests.length === 1 ? "запрос" : parsedRequests.length < 5 ? "запроса" : "запросов"}.`
      );
      await recordLog(
        "content",
        "chat.queue-import.completed",
        "Импорт очереди AI из JSON завершён.",
        {
          fileName: file.name,
          requestCount: parsedRequests.length,
          importedCount
        }
      );
    } finally {
      this.chatQueueImportInProgress = false;
      this.renderChatToolRow();
    }
  }

  private async resumeChat(): Promise<void> {
    try {
      await this.resumeAiChatSession();
    } catch (error) {
      this.pushConsole("error", formatUserFacingCommandError(error, "Не удалось возобновить AI-чат."));
      await recordLog("content", "chat.resume.failed", "Не удалось возобновить AI-чат.", serializeLogDetails(error), "error");
    }
  }

  private async resetChat(): Promise<void> {
    try {
      await this.resetAiChatSession();
    } catch (error) {
      this.pushConsole("error", formatUserFacingCommandError(error, "Не удалось сбросить AI-чат."));
      await recordLog("content", "chat.reset.failed", "Не удалось сбросить AI-чат.", serializeLogDetails(error), "error");
    }
  }

  private renderActivityFeed(forceScrollToEnd = false): void {
    if (!this.activityFeed) {
      return;
    }

    const shouldStickToBottom = forceScrollToEnd || this.isActivityFeedPinnedToBottom();
    const feedItems = buildOverlayActivityFeed(
      this.consoleEntries,
      this.runtimeLogs,
      this.runtimeLogSequences
    ).filter((item) => item.sequence >= this.visibleActivitySequenceFloor);

    this.activityFeed.replaceChildren(
      ...feedItems.map((item) =>
        item.type === "terminal"
          ? this.createTerminalActivityElement(item.id, item.terminalKind, item.ts, item.text)
          : this.createLogActivityElement(item.logEntry)
      )
    );

    if (shouldStickToBottom) {
      this.scrollActivityFeedToEnd();
    }
  }

  private setRuntimeLogs(logs: LogEntry[]): void {
    this.runtimeLogs = logs;

    const liveIds = new Set<string>();
    for (const entry of logs) {
      liveIds.add(entry.id);
      if (!this.runtimeLogSequences.has(entry.id)) {
        this.runtimeLogSequences.set(entry.id, this.nextActivitySequence++);
      }
    }

    for (const knownId of Array.from(this.runtimeLogSequences.keys())) {
      if (!liveIds.has(knownId)) {
        this.runtimeLogSequences.delete(knownId);
      }
    }

    for (const knownId of Array.from(this.activityOpenState.keys())) {
      if (!liveIds.has(knownId)) {
        this.activityOpenState.delete(knownId);
      }
    }
  }

  private isActivityFeedPinnedToBottom(): boolean {
    if (!this.activityFeed) {
      return true;
    }

    return isScrollPinnedToBottom(
      this.activityFeed.scrollHeight,
      this.activityFeed.scrollTop,
      this.activityFeed.clientHeight
    );
  }

  private scrollActivityFeedToEnd(): void {
    if (!this.activityFeed) {
      return;
    }

    this.activityFeed.scrollTop = this.activityFeed.scrollHeight;
  }

  private isChatFeedPinnedToBottom(): boolean {
    if (!this.chatFeed) {
      return true;
    }

    return isScrollPinnedToBottom(
      this.chatFeed.scrollHeight,
      this.chatFeed.scrollTop,
      this.chatFeed.clientHeight
    );
  }

  private scrollChatFeedToEnd(): void {
    if (!this.chatFeed) {
      return;
    }

    this.chatFeed.scrollTop = this.chatFeed.scrollHeight;
  }

  private createTerminalActivityElement(
    entryId: string,
    kind: OverlayConsoleEntryKind,
    ts: string,
    text: string
  ): HTMLElement {
    const details = document.createElement("details");
    details.className = `activity-entry activity-terminal terminal-${kind}`;
    details.open = this.activityOpenState.get(entryId) ?? false;
    details.addEventListener("toggle", () => {
      this.activityOpenState.set(entryId, details.open);
    });

    const summaryRow = document.createElement("summary");
    summaryRow.className = "activity-terminal-summary";

    const badge = document.createElement("span");
    badge.className = "activity-kind";
    badge.textContent = this.getTerminalActivityBadgeLabel(kind);

    const title = document.createElement("span");
    title.className = "activity-title";
    title.textContent = this.getTerminalActivityTitle(kind);

    const summary = document.createElement("span");
    summary.className = "activity-summary";
    summary.textContent = text.split("\n")[0] ?? "";

    const time = document.createElement("time");
    time.className = "activity-ts";
    time.textContent = new Date(ts).toLocaleTimeString();

    const body = document.createElement("pre");
    body.className = "activity-body";
    body.textContent = text;

    summaryRow.append(badge, title, summary, time);
    details.append(summaryRow, body);
    return details;
  }

  private createLogActivityElement(entry: LogEntry): HTMLElement {
    const details = document.createElement("details");
    details.className = `activity-entry activity-log level-${entry.level}`;
    details.open = this.activityOpenState.get(entry.id) ?? false;
    details.addEventListener("toggle", () => {
      this.activityOpenState.set(entry.id, details.open);
    });

    const summary = document.createElement("summary");
    summary.className = "log-summary";

    const level = document.createElement("span");
    level.className = `log-level level-${entry.level}`;
    level.textContent = formatOverlayLogLevel(entry.level);

    const headingBlock = document.createElement("span");
    headingBlock.className = "log-heading-block";

    const heading = document.createElement("span");
    heading.className = "log-heading";
    heading.textContent = `${entry.source} :: ${entry.summary}`;
    headingBlock.append(heading);

    const ts = document.createElement("time");
    ts.className = "log-ts";
    ts.textContent = new Date(entry.ts).toLocaleTimeString();

    summary.append(level, headingBlock, ts);

    const meta = document.createElement("div");
    meta.className = "log-meta";
    meta.textContent = `${entry.event}${entry.correlationId ? ` • ${entry.correlationId}` : ""}`;

    const body = document.createElement("pre");
    body.className = "log-body";
    body.textContent = serializeLogDetails(entry.details) || "Подробности отсутствуют";

    details.append(summary, meta, body);
    return details;
  }

  private getTerminalActivityBadgeLabel(kind: OverlayConsoleEntryKind): string {
    switch (kind) {
      case "command":
        return "КОМ";
      case "result":
        return "ОК";
      case "error":
        return "ОШ";
      case "system":
      default:
        return "СИС";
    }
  }

  private getTerminalActivityTitle(kind: OverlayConsoleEntryKind): string {
    switch (kind) {
      case "command":
        return "Команда терминала";
      case "result":
        return "Ответ терминала";
      case "error":
        return "Ошибка терминала";
      case "system":
      default:
        return "Событие оверлея";
    }
  }

  private refreshTerminalSuggestions(): void {
    const rawInput = this.terminalInput?.value ?? "";
    if (!rawInput.trim()) {
      this.closeTerminalSuggestions();
      return;
    }

    this.currentSuggestions = getTerminalSuggestions(rawInput, 6, this.getTerminalCatalogOptions());
    this.selectedSuggestionIndex = this.currentSuggestions.length > 0 ? 0 : -1;
    this.renderTerminalSuggestions();
  }

  private renderTerminalSuggestions(): void {
    if (!this.terminalSuggestionList) {
      return;
    }

    this.terminalSuggestionList.replaceChildren(
      ...this.currentSuggestions.map((suggestion, index) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "terminal-suggestion-item";
        button.dataset.suggestionIndex = String(index);
        button.classList.toggle("is-selected", index === this.selectedSuggestionIndex);
        button.textContent = suggestion;
        button.addEventListener("pointerdown", (event) => {
          event.preventDefault();
        });
        button.addEventListener("click", () => {
          this.applyTerminalSuggestion(index);
        });
        return button;
      })
    );

    this.terminalSuggestionList.classList.toggle("is-hidden", this.currentSuggestions.length === 0);
  }

  private closeTerminalSuggestions(): void {
    this.currentSuggestions = [];
    this.selectedSuggestionIndex = -1;
    this.renderTerminalSuggestions();
  }

  private handleTerminalInputKeydown(event: KeyboardEvent): boolean {
    if (event.key === "ArrowDown") {
      if (this.currentSuggestions.length === 0) {
        this.refreshTerminalSuggestions();
      }
      if (this.currentSuggestions.length > 0) {
        event.preventDefault();
        event.stopImmediatePropagation();
        event.stopPropagation();
        this.selectedSuggestionIndex =
          (this.selectedSuggestionIndex + 1 + this.currentSuggestions.length) % this.currentSuggestions.length;
        this.renderTerminalSuggestions();
      }
      return true;
    }

    if (event.key === "ArrowUp") {
      if (this.currentSuggestions.length > 0) {
        event.preventDefault();
        event.stopImmediatePropagation();
        event.stopPropagation();
        this.selectedSuggestionIndex =
          (this.selectedSuggestionIndex - 1 + this.currentSuggestions.length) % this.currentSuggestions.length;
        this.renderTerminalSuggestions();
      }
      return true;
    }

    if (event.key === "Escape" && this.currentSuggestions.length > 0) {
      event.preventDefault();
      event.stopImmediatePropagation();
      event.stopPropagation();
      this.closeTerminalSuggestions();
      return true;
    }

    if ((event.key === "Tab" || event.key === "Enter") && this.shouldApplySelectedSuggestion()) {
      event.preventDefault();
      event.stopImmediatePropagation();
      event.stopPropagation();
      this.applyTerminalSuggestion(this.selectedSuggestionIndex);
      return true;
    }

    return false;
  }

  private shouldApplySelectedSuggestion(): boolean {
    if (this.selectedSuggestionIndex < 0 || this.selectedSuggestionIndex >= this.currentSuggestions.length) {
      return false;
    }

    const currentValue = this.terminalInput?.value.trim() ?? "";
    if (!currentValue) {
      return false;
    }

    const selectedSuggestion = this.currentSuggestions[this.selectedSuggestionIndex];
    return currentValue !== selectedSuggestion;
  }

  private applyTerminalSuggestion(index: number): void {
    const suggestion = this.currentSuggestions[index];
    if (!suggestion || !this.terminalInput) {
      return;
    }

    this.terminalInput.value = suggestion;
    this.terminalInput.focus();
    this.terminalInput.setSelectionRange(suggestion.length, suggestion.length);
    this.closeTerminalSuggestions();
  }

  private formatTerminalOutput(output: unknown): string {
    if (typeof output === "string") {
      return output;
    }

    const serialized = JSON.stringify(output, null, 2);
    if (typeof serialized === "string") {
      return serialized;
    }

    return String(output);
  }

  private async applyTerminalPostAction(
    postAction: TerminalExecutionResult["postAction"] | undefined
  ): Promise<void> {
    if (!postAction) {
      return;
    }

    if (postAction.type === "close-overlay") {
      await this.close();
      return;
    }

    this.setActiveTab(postAction.tab, true, false);
  }

  private async applyConfigValueCommand(path: string, value: unknown): Promise<TerminalExecutionResult> {
    const descriptor = this.requireEditableTerminalConfigField(path);

    if (path === "ui.overlay.visible" && value === false) {
      return {
        output: {
          path,
          scope: descriptor.scope,
          value,
          hidden: true
        },
        logDetails: {
          path,
          scope: descriptor.scope,
          value
        },
        postAction: {
          type: "close-overlay"
        }
      };
    }

    await this.sendConfigPatch(descriptor.scope, buildConfigPatchFromPath(path, value));
    return {
      output: {
        path,
        scope: descriptor.scope,
        value
      },
      logDetails: {
        path,
        scope: descriptor.scope,
        value
      },
      postAction:
        path === "ui.overlay.activeTab"
          ? {
              type: "switch-overlay-tab",
              tab: value as OverlayTab
            }
          : undefined
    };
  }

  private async resetConfigFieldCommand(path: string): Promise<TerminalExecutionResult> {
    const defaultValue = this.cloneDefaultConfigValue(path);
    return this.applyConfigValueCommand(path, defaultValue);
  }

  private async executeLocalTerminalCommand(
    parsed: Extract<ParsedTerminalCommand, { kind: "local" }>
  ): Promise<TerminalExecutionResult | null> {
    if (parsed.action === "clear") {
      this.consoleEntries = [];
      this.activityOpenState.clear();
      this.visibleActivitySequenceFloor = this.nextActivitySequence;
      this.renderActivityFeed(true);
      return null;
    }

    if (parsed.action === "help") {
      return {
        output: getTerminalHelpLines(this.getTerminalCatalogOptions(), parsed.topic).join("\n")
      };
    }

    await this.ensureRuntimeSnapshotLoaded();
    return {
      output: this.buildTerminalStatusSnapshot()
    };
  }

  private async executeAliasCommand(
    parsed: Extract<ParsedTerminalCommand, { kind: "alias" }>
  ): Promise<TerminalExecutionResult> {
    await this.ensureRuntimeSnapshotLoaded();

    switch (parsed.namespace) {
      case "config":
        switch (parsed.action) {
          case "paths":
            return {
              output: {
                prefix: parsed.prefix,
                paths: getEditableConfigPaths({
                  prefix: parsed.prefix ?? undefined,
                  includeSensitive: false
                })
              },
              logDetails: {
                prefix: parsed.prefix
              }
            };
          case "get":
            if (!parsed.path) {
              return {
                output: omitSensitiveConfigData(structuredClone(this.currentConfig ?? defaultConfig))
              };
            }

            return {
              output: {
                path: parsed.path,
                scope: this.requireEditableTerminalConfigField(parsed.path).scope,
                value: readConfigValue(this.currentConfig ?? defaultConfig, parsed.path)
              },
              logDetails: {
                path: parsed.path
              }
            };
          case "set":
            return this.applyConfigValueCommand(parsed.path, this.parseTerminalConfigValue(parsed.path, parsed.valueText));
          case "reset-field":
            return this.resetConfigFieldCommand(parsed.path);
          case "reset": {
            const snapshot = await this.sendConfigReset(parsed.scope);
            const sanitizedConfig = omitSensitiveConfigData(structuredClone(snapshot.config));
            return {
              output: {
                scope: parsed.scope,
                config: sanitizedConfig,
                workerStatus: snapshot.workerStatus,
                logCount: snapshot.logs.length
              },
              logDetails: {
                scope: parsed.scope
              },
              postAction:
                parsed.scope === "session" && snapshot.config.ui.overlay.visible === false
                  ? {
                      type: "close-overlay"
                    }
                  : undefined
            };
          }
        }
        break;
      case "ai-key":
        switch (parsed.action) {
          case "status":
            return {
              output: await this.getAiKeyStatusResult()
            };
          case "set": {
            const nextValue = this.parseTerminalSecretValue(parsed.valueText, "ai.key.set");
            await this.sendConfigPatch("local", buildConfigPatchFromPath("ai.openAiApiKey", nextValue));
            return {
              output: {
                mode: "managed",
                apiKeyPresent: nextValue.trim().length > 0
              },
              logDetails: {
                path: "ai.openAiApiKey",
                action: "set",
                redacted: true
              }
            };
          }
          case "clear":
            await this.sendConfigPatch("local", buildConfigPatchFromPath("ai.openAiApiKey", ""));
            return {
              output: {
                mode: "missing",
                apiKeyPresent: false
              },
              logDetails: {
                path: "ai.openAiApiKey",
                action: "clear",
                redacted: true
              }
            };
          case "unmanage":
            await this.sendConfigPatch("local", buildConfigPatchFromPath("ai.openAiApiKey", null));
            return {
              output: {
                mode: "environment",
                managed: false
              },
              logDetails: {
                path: "ai.openAiApiKey",
                action: "unmanage",
                redacted: true
              }
            };
        }
        break;
      case "chat":
        switch (parsed.action) {
          case "status":
            return {
              output: {
                session: await this.refreshAiChatStatusSessionForTarget(parsed.target)
              }
            };
          case "send":
            return {
              output: {
                session: await this.sendAiChatToTarget(parsed.target, "user", parsed.text)
              },
              logDetails: {
                target: parsed.target,
                origin: "user",
                text: parsed.text
              }
            };
          case "code":
            return {
              output: {
                session: await this.sendAiChatToTarget(parsed.target, "code", parsed.text)
              },
              logDetails: {
                target: parsed.target,
                origin: "code",
                text: parsed.text
              }
            };
          case "resume":
            return {
              output: {
                session: await this.resumeAiChatSessionForTarget(parsed.target)
              }
            };
          case "reset":
            return {
              output: {
                session: await this.resetAiChatSessionForTarget(parsed.target)
              }
            };
          case "list":
            return {
              output: await sendCommand(COMMANDS.aiChatList, "overlay", "background")
            };
          case "compact":
            return {
              output: await this.compactAiChatSessionForTarget(parsed.target, parsed.mode),
              logDetails: {
                target: parsed.target,
                mode: parsed.mode
              }
            };
        }
        break;
      case "text":
        switch (parsed.action) {
          case "status":
            await this.ensureTextElementsHydrated({
              reason: "text-status",
              logSummary: false
            });
            return {
              output: this.buildTextStatusResult()
            };
          case "scan": {
            const pageMap = await this.handleTextScanCommand(true);
            return {
              output: {
                ...this.buildTextStatusResult(),
                pageMap
              }
            };
          }
          case "list": {
            const pageMap =
              (await this.ensureTextElementsHydrated({
                reason: "text-list",
                logSummary: false
              })) ?? this.textPageMap;
            return {
              output: {
                ...this.buildTextStatusResult(),
                bindings: (pageMap?.bindings ?? [])
                  .filter((binding) => parsed.filter === "all" || binding.changed)
                  .map((binding) => this.buildTextBindingOutput(binding))
              }
            };
          }
          case "set": {
            const binding = await this.updateCurrentPageTextBinding(parsed.bindingId, parsed.text);
            return {
              output: {
                ...this.buildTextStatusResult(),
                binding: this.buildTextBindingOutput(binding)
              },
              logDetails: {
                bindingId: parsed.bindingId
              }
            };
          }
          case "blank": {
            const pageMap = await this.blankCurrentPageTextBindings();
            return {
              output: {
                ...this.buildTextStatusResult(),
                blankedBindings: pageMap.bindings.filter(
                  (binding) => binding.presence === "live" && binding.replacementText === ""
                ).length,
                updatedAt: pageMap.updatedAt
              }
            };
          }
          case "revert": {
            const binding = await this.updateCurrentPageTextBinding(parsed.bindingId, null);
            return {
              output: {
                ...this.buildTextStatusResult(),
                binding: this.buildTextBindingOutput(binding)
              },
              logDetails: {
                bindingId: parsed.bindingId,
                reverted: true
              }
            };
          }
          case "mode":
            await this.sendConfigPatch("local", buildConfigPatchFromPath("debug.textElements.displayMode", parsed.mode));
            await this.ensureTextElementsHydrated({
              reason: "text-mode",
              logSummary: false
            });
            return {
              output: this.buildTextStatusResult(),
              logDetails: {
                displayMode: parsed.mode
              }
            };
          case "download":
            await this.downloadTextMap();
            return {
              output: {
                ...this.buildTextStatusResult(),
                downloaded: true
              }
            };
          case "reset":
            if (parsed.scope === "page") {
              const pageMap = await this.resetCurrentPageTextBindings();
              return {
                output: {
                  ...this.buildTextStatusResult(),
                  pageMap
                }
              };
            }
            return {
              output: await this.resetAllTextStorage()
            };
          case "delete":
            if ("scope" in parsed) {
              if (parsed.scope === "page") {
                return {
                  output: await this.deleteCurrentPageTextMap()
                };
              }
              return {
                output: await this.resetAllTextStorage()
              };
            }
            return {
              output: await this.deleteCurrentTextBinding(parsed.bindingId),
              logDetails: {
                bindingId: parsed.bindingId,
                deleted: true
              }
            };
        }
        break;
      case "models":
        switch (parsed.action) {
          case "list":
            return {
              output: await this.fetchModelCatalog()
            };
          case "allow-list":
            return {
              output: {
                allowedModels: this.getAllowedModelRules()
              }
            };
          case "allow-clear": {
            const nextRules: AiAllowedModelRule[] = [];
            await this.sendConfigPatch("local", buildConfigPatchFromPath("ai.allowedModels", nextRules));
            return {
              output: {
                allowedModels: nextRules
              },
              logDetails: {
                path: "ai.allowedModels",
                value: nextRules
              }
            };
          }
          case "allow-add": {
            const catalog = await this.fetchModelCatalog();
            const catalogModel = this.findCatalogModel(catalog.models, parsed.model);
            if (!catalogModel) {
              throw new Error(`Модель ${parsed.model} не найдена в каталоге.`);
            }
            if (!isAiModelTierAvailable(catalogModel, parsed.tier)) {
              throw new Error(`Модель ${catalogModel.id} недоступна в тарифе ${parsed.tier}.`);
            }

            const nextRules = normalizeAllowedModelRules([
              ...this.getAllowedModelRules(),
              {
                model: catalogModel.id,
                tier: parsed.tier
              }
            ]);
            await this.sendConfigPatch("local", buildConfigPatchFromPath("ai.allowedModels", nextRules));
            return {
              output: {
                allowedModels: nextRules
              },
              logDetails: {
                path: "ai.allowedModels",
                value: nextRules
              }
            };
          }
          case "allow-remove": {
            const targetModel = parsed.model.toLowerCase();
            const nextRules = this.getAllowedModelRules().filter(
              (rule) => !(rule.model.toLowerCase() === targetModel && rule.tier === parsed.tier)
            );
            await this.sendConfigPatch("local", buildConfigPatchFromPath("ai.allowedModels", nextRules));
            return {
              output: {
                allowedModels: nextRules
              },
              logDetails: {
                path: "ai.allowedModels",
                value: nextRules
              }
            };
          }
          case "select": {
            const catalog = await this.fetchModelCatalog();
            const catalogModel = this.findCatalogModel(catalog.models, parsed.model);
            if (!catalogModel) {
              throw new Error(`Модель ${parsed.model} не найдена в каталоге.`);
            }
            if (!isAiModelTierAvailable(catalogModel, parsed.tier)) {
              throw new Error(`Модель ${catalogModel.id} недоступна в тарифе ${parsed.tier}.`);
            }

            const nextSelection = {
              model: catalogModel.id,
              tier: parsed.tier as AiServiceTier
            };
            const isAllowed = this.getAllowedModelRules().some(
              (rule) => rule.model === nextSelection.model && rule.tier === nextSelection.tier
            );
            if (!isAllowed) {
              throw new Error("Сначала добавьте модель через models.allow add.");
            }

            const path = parsed.target === "chat" ? "ai.chat.model" : "ai.compaction.modelOverride";
            return this.applyConfigValueCommand(path, nextSelection);
          }
        }
        break;
      case "logs":
        switch (parsed.action) {
          case "tail":
            return {
              output: await sendCommand(COMMANDS.logList, "overlay", "background", {
                limit: parsed.limit
              }),
              logDetails: {
                limit: parsed.limit
              }
            };
          case "subscribe":
            return {
              output: await sendCommand(COMMANDS.logSubscribe, "overlay", "background", {
                since: parsed.since
              }),
              logDetails: {
                since: parsed.since
              }
            };
          case "note":
            return {
              output: await sendCommand(COMMANDS.logRecord, "overlay", "background", {
                level: "info",
                source: "overlay",
                event: "manual.note",
                summary: parsed.summary
              }),
              logDetails: {
                summary: parsed.summary
              }
            };
        }
        break;
      case "overlay":
        switch (parsed.action) {
          case "probe":
            return {
              output: await sendCommand(COMMANDS.overlayProbe, "overlay", "background", this.buildOverlayTargetPayload(parsed.target)),
              logDetails: this.buildOverlayTargetPayload(parsed.target)
            };
          case "open":
            return {
              output: await sendCommand(COMMANDS.overlayOpen, "overlay", "background", this.buildOverlayTargetPayload(parsed.target)),
              logDetails: this.buildOverlayTargetPayload(parsed.target)
            };
          case "close":
            if (parsed.target.type === "current") {
              return {
                output: {
                  closed: true,
                  current: true
                },
                postAction: {
                  type: "close-overlay"
                }
              };
            }
            return {
              output: await sendCommand(COMMANDS.overlayClose, "overlay", "background", this.buildOverlayTargetPayload(parsed.target)),
              logDetails: this.buildOverlayTargetPayload(parsed.target)
            };
          case "tab":
            return this.applyConfigValueCommand("ui.overlay.activeTab", parsed.tab);
          case "hide":
            return {
              output: {
                hidden: true
              },
              postAction: {
                type: "close-overlay"
              }
            };
        }
        break;
      case "popup":
        switch (parsed.action) {
          case "tab":
            return this.applyConfigValueCommand("ui.popupActiveTab", parsed.tab as PopupTab);
        }
        break;
      case "host":
        switch (parsed.action) {
          case "connect":
            return { output: await sendCommand(COMMANDS.hostConnect, "overlay", "background") };
          case "disconnect":
            return { output: await sendCommand(COMMANDS.hostDisconnect, "overlay", "background") };
          case "status":
            return { output: await sendCommand(COMMANDS.hostStatus, "overlay", "background") };
          case "restart":
            return { output: await sendCommand(COMMANDS.hostRestart, "overlay", "background") };
          case "crash":
            return { output: await sendCommand(COMMANDS.testHostCrash, "overlay", "background") };
        }
        break;
      case "worker":
        switch (parsed.action) {
          case "start":
            return { output: await sendCommand(COMMANDS.workerStart, "overlay", "background") };
          case "stop":
            return { output: await sendCommand(COMMANDS.workerStop, "overlay", "background") };
          case "status":
            return { output: await sendCommand(COMMANDS.workerStatus, "overlay", "background") };
        }
        break;
      case "demo":
        switch (parsed.action) {
          case "start":
            return {
              output: await sendCommand(
                COMMANDS.taskDemoStart,
                "overlay",
                "background",
                parsed.taskId ? { taskId: parsed.taskId } : undefined
              ),
              logDetails: {
                taskId: parsed.taskId
              }
            };
          case "stop":
            return {
              output: await sendCommand(COMMANDS.taskDemoStop, "overlay", "background")
            };
        }
        break;
    }

    throw new Error("Неподдерживаемая alias-команда.");
  }

  private async executeCommand(): Promise<void> {
    const rawInput = this.terminalInput?.value ?? "";
    this.terminalInput?.focus();
    this.terminalInput!.value = "";
    this.closeTerminalSuggestions();

    try {
      const parsed = parseTerminalCommand(rawInput);
      if (!parsed) {
        return;
      }

      this.pushConsole("command", `NT3> ${parsed.raw}`);

      let result: TerminalExecutionResult | null;
      if (parsed.kind === "local") {
        result = await this.executeLocalTerminalCommand(parsed);
      } else if (parsed.kind === "alias") {
        result = await this.executeAliasCommand(parsed);
      } else {
        result = {
          output: await sendCommand(parsed.action, "overlay", "background", parsed.payload),
          logDetails: parsed.payload
        };
      }

      if (!result) {
        return;
      }

      this.pushConsole("result", this.formatTerminalOutput(result.output));
      await recordLog(
        "content",
        "overlay.command",
        `Выполнена команда ${parsed.raw}.`,
        result.logDetails ?? (parsed.kind === "protocol" ? parsed.payload : { raw: parsed.raw })
      );
      await this.applyTerminalPostAction(result.postAction);
    } catch (error) {
      this.pushConsole(
        "error",
        formatUserFacingCommandError(error, "Не удалось выполнить команду терминала.")
      );
      await recordLog(
        "content",
        "overlay.command.failed",
        "Не удалось выполнить команду оверлейного терминала.",
        {
          raw: rawInput.trim(),
          message: error instanceof Error ? error.message : String(error)
        },
        "error"
      );
    }
  }

  private pushConsole(kind: OverlayConsoleEntryKind, text: string): void {
    this.consoleEntries = [
      ...this.consoleEntries.slice(-199),
      {
        id: crypto.randomUUID(),
        ts: new Date().toISOString(),
        kind,
        text,
        sequence: this.nextActivitySequence++
      }
    ];
    this.renderActivityFeed(true);
  }

  private applyRuntimeCommandResult(result: RuntimeSnapshotResponse): RuntimeSnapshotResponse {
    const parsedConfig = this.reconcileIncomingOverlayGeometry(ExtensionConfigSchema.parse(result.config));
    const parsedLogs = result.logs.map((entry) => LogEntrySchema.parse(entry));
    this.currentConfig = parsedConfig;
    this.currentStatus = parseRuntimeWorkerStatus(result);
    this.setRuntimeLogs(parsedLogs);
    this.applyGeometry(parsedConfig);
    this.render(true);
    this.updateTextObservationState();
    this.updateTextDebugPresentation();
    return {
      config: parsedConfig,
      workerStatus: this.currentStatus,
      logs: parsedLogs
    };
  }

  private async sendConfigPatch(scope: "local" | "session", patch: ExtensionConfigPatch): Promise<RuntimeSnapshotResponse> {
    const result = await sendCommand<RuntimeSnapshotResponse>(COMMANDS.configPatch, "content", "background", {
      scope,
      patch
    });
    return this.applyRuntimeCommandResult(result);
  }

  private async sendConfigReset(scope: "local" | "session"): Promise<RuntimeSnapshotResponse> {
    const result = await sendCommand<RuntimeSnapshotResponse>(COMMANDS.configReset, "content", "background", {
      scope
    });
    return this.applyRuntimeCommandResult(result);
  }

  private async patchOverlaySessionConfig(patch: Partial<ExtensionConfig["ui"]["overlay"]>): Promise<void> {
    try {
      await this.sendConfigPatch("session", {
        ui: {
          overlay: patch
        }
      });
    } catch {
      // Ignore config patch failures during teardown paths.
    }
  }

  private async patchOverlayLocalConfig(patch: Partial<ExtensionConfig["ui"]["overlay"]>): Promise<void> {
    if (
      patch.left !== undefined ||
      patch.top !== undefined ||
      patch.width !== undefined ||
      patch.height !== undefined
    ) {
      const currentGeometry = this.readCurrentGeometry();
      this.pendingOverlayGeometry = {
        left: patch.left ?? currentGeometry.left,
        top: patch.top ?? currentGeometry.top,
        width: patch.width ?? currentGeometry.width,
        height: patch.height ?? currentGeometry.height
      };
    }

    try {
      await this.sendConfigPatch("local", {
        ui: {
          overlay: patch
        }
      });
    } catch {
      this.pendingOverlayGeometry = null;
      // Ignore drag persistence failures. The window already moved locally.
    }
  }

  private reconcileIncomingOverlayGeometry(config: ExtensionConfig): ExtensionConfig {
    if (!this.pendingOverlayGeometry) {
      return config;
    }

    const pending = this.pendingOverlayGeometry;
    const overlay = config.ui.overlay;
    const matchesPendingGeometry =
      overlay.left === pending.left &&
      overlay.top === pending.top &&
      overlay.width === pending.width &&
      overlay.height === pending.height;

    if (matchesPendingGeometry) {
      this.pendingOverlayGeometry = null;
      return config;
    }

    return {
      ...config,
      ui: {
        ...config.ui,
        overlay: {
          ...overlay,
          left: pending.left,
          top: pending.top,
          width: pending.width,
          height: pending.height
        }
      }
    };
  }

  private applyGeometry(config: ExtensionConfig): void {
    if (!this.panelWindow) {
      return;
    }

    this.panelWindow.style.width = `${config.ui.overlay.width}px`;
    this.panelWindow.style.height = `${config.ui.overlay.height}px`;
    this.panelWindow.style.left = `${config.ui.overlay.left}px`;
    this.panelWindow.style.top = `${config.ui.overlay.top}px`;
  }

  private getTerminalCatalogOptions(): TerminalCatalogOptions {
    return {
      testCommandsEnabled: this.currentConfig?.protocol.testCommandsEnabled ?? true,
      allowHostCrashCommand: this.currentConfig?.test.allowHostCrashCommand ?? true
    };
  }

  private getViewportSize(): OverlayViewport {
    return {
      width: window.innerWidth,
      height: window.innerHeight
    };
  }

  private shouldCenterPanelOnOpen(): boolean {
    const overlay = this.currentConfig?.ui.overlay;
    const defaults = defaultConfig.ui.overlay;
    return (
      !overlay ||
      (overlay.width === defaults.width &&
        overlay.height === defaults.height &&
        overlay.left === defaults.left &&
        overlay.top === defaults.top)
    );
  }

  private centerPanelInViewport(): OverlayGeometry | null {
    if (!this.panelWindow) {
      return null;
    }

    const geometry = this.readCurrentGeometry();
    const centeredPosition = getCenteredOverlayPosition(this.getViewportSize(), geometry);
    const nextGeometry = {
      ...geometry,
      ...centeredPosition
    };
    this.applyLocalGeometry(nextGeometry);
    return nextGeometry;
  }

  private async clampPanelIntoViewport(): Promise<void> {
    if (!this.panelWindow) {
      return;
    }

    const currentGeometry = this.readCurrentGeometry();
    const clampedGeometry = clampOverlayGeometryToViewport(currentGeometry, this.getViewportSize());
    if (clampedGeometry.left === currentGeometry.left && clampedGeometry.top === currentGeometry.top) {
      return;
    }

    this.applyLocalGeometry(clampedGeometry);
    await this.patchOverlayLocalConfig({
      left: clampedGeometry.left,
      top: clampedGeometry.top
    });
  }

  private beginDrag(event: PointerEvent): void {
    if (!this.visible || !this.panelWindow || !this.panelHeader) {
      return;
    }

    if (this.resizeState || event.button !== 0 || this.isInteractiveElement(event.target)) {
      return;
    }

    const { left, top } = this.readCurrentPosition();
    this.dragState = {
      pointerId: event.pointerId,
      originX: event.clientX,
      originY: event.clientY,
      startLeft: left,
      startTop: top,
      moved: false
    };

    this.panelHeader.setPointerCapture(event.pointerId);
    this.panelWindow.focus();
    event.preventDefault();
    event.stopPropagation();
  }

  private updateDrag(event: PointerEvent): void {
    if (!this.dragState || !this.panelWindow || event.pointerId !== this.dragState.pointerId) {
      return;
    }

    const deltaX = event.clientX - this.dragState.originX;
    const deltaY = event.clientY - this.dragState.originY;
    const nextLeft = this.clampLeft(this.dragState.startLeft + deltaX);
    const nextTop = this.clampTop(this.dragState.startTop + deltaY);

    this.dragState.moved = this.dragState.moved || deltaX !== 0 || deltaY !== 0;
    this.applyLocalPosition(nextLeft, nextTop);
    event.preventDefault();
    event.stopPropagation();
  }

  private async endDrag(event: PointerEvent): Promise<void> {
    if (!this.dragState || event.pointerId !== this.dragState.pointerId || !this.panelHeader) {
      return;
    }

    const finishedState = this.dragState;
    this.dragState = null;

    if (this.panelHeader.hasPointerCapture(event.pointerId)) {
      this.panelHeader.releasePointerCapture(event.pointerId);
    }

    event.preventDefault();
    event.stopPropagation();

    if (!finishedState.moved) {
      return;
    }

    const { left, top } = this.readCurrentPosition();
    await this.patchOverlayLocalConfig({
      left,
      top
    });
    await recordLog("content", "overlay.drag", "Оверлейный терминал перемещён.", {
      left,
      top
    });
  }

  private beginResize(event: PointerEvent, direction: OverlayResizeHandle, handle: HTMLElement): void {
    if (!this.visible || !this.panelWindow || event.button !== 0 || this.dragState) {
      return;
    }

    this.resizeState = {
      pointerId: event.pointerId,
      direction,
      originX: event.clientX,
      originY: event.clientY,
      startGeometry: this.readCurrentGeometry(),
      moved: false
    };

    handle.setPointerCapture(event.pointerId);
    this.panelWindow.classList.add("is-resizing");
    this.setDocumentCursor(RESIZE_HANDLE_CURSOR[direction]);
    this.panelWindow.focus();
    event.preventDefault();
    event.stopPropagation();
  }

  private updateResize(event: PointerEvent): void {
    if (!this.resizeState || event.pointerId !== this.resizeState.pointerId) {
      return;
    }

    const deltaX = event.clientX - this.resizeState.originX;
    const deltaY = event.clientY - this.resizeState.originY;
    const nextGeometry = resizeOverlayGeometry(
      this.resizeState.startGeometry,
      this.resizeState.direction,
      deltaX,
      deltaY,
      this.getViewportSize(),
      {
        minWidth: OVERLAY_MIN_WIDTH,
        minHeight: OVERLAY_MIN_HEIGHT
      }
    );

    this.resizeState.moved = this.resizeState.moved || deltaX !== 0 || deltaY !== 0;
    this.applyLocalGeometry(nextGeometry);
    this.setDocumentCursor(RESIZE_HANDLE_CURSOR[this.resizeState.direction]);
    event.preventDefault();
    event.stopPropagation();
  }

  private async endResize(event: PointerEvent, handle: HTMLElement): Promise<void> {
    if (!this.resizeState || event.pointerId !== this.resizeState.pointerId || !this.panelWindow) {
      return;
    }

    const finishedState = this.resizeState;
    this.resizeState = null;

    if (handle.hasPointerCapture(event.pointerId)) {
      handle.releasePointerCapture(event.pointerId);
    }

    this.panelWindow.classList.remove("is-resizing");
    this.setDocumentCursor(null);
    event.preventDefault();
    event.stopPropagation();

    if (!finishedState.moved) {
      return;
    }

    const geometry = this.readCurrentGeometry();
    await this.patchOverlayLocalConfig({
      left: geometry.left,
      top: geometry.top,
      width: geometry.width,
      height: geometry.height
    });
    await recordLog("content", "overlay.resize", "Оверлейный терминал изменён по размеру.", geometry);
  }

  private setDocumentCursor(cursor: string | null): void {
    const style = document.documentElement.style;
    if (cursor) {
      if (this.documentCursorRestoreValue === null) {
        this.documentCursorRestoreValue = style.cursor;
      }
      style.cursor = cursor;
      return;
    }

    if (this.documentCursorRestoreValue !== null) {
      style.cursor = this.documentCursorRestoreValue;
      this.documentCursorRestoreValue = null;
    }
  }

  private applyLocalGeometry(geometry: OverlayGeometry): void {
    if (!this.panelWindow) {
      return;
    }

    this.panelWindow.style.left = `${geometry.left}px`;
    this.panelWindow.style.top = `${geometry.top}px`;
    this.panelWindow.style.width = `${geometry.width}px`;
    this.panelWindow.style.height = `${geometry.height}px`;

    if (this.currentConfig) {
      this.currentConfig = {
        ...this.currentConfig,
        ui: {
          ...this.currentConfig.ui,
          overlay: {
            ...this.currentConfig.ui.overlay,
            left: geometry.left,
            top: geometry.top,
            width: geometry.width,
            height: geometry.height
          }
        }
      };
    }
  }

  private applyLocalPosition(left: number, top: number): void {
    const geometry = this.readCurrentGeometry();
    this.applyLocalGeometry({
      ...geometry,
      left,
      top
    });
  }

  private readCurrentPosition(): { left: number; top: number } {
    const geometry = this.readCurrentGeometry();
    return {
      left: geometry.left,
      top: geometry.top
    };
  }

  private readCurrentGeometry(): OverlayGeometry {
    const fallbackLeft = this.currentConfig?.ui.overlay.left ?? 32;
    const fallbackTop = this.currentConfig?.ui.overlay.top ?? 32;
    const fallbackWidth = this.currentConfig?.ui.overlay.width ?? defaultConfig.ui.overlay.width;
    const fallbackHeight = this.currentConfig?.ui.overlay.height ?? defaultConfig.ui.overlay.height;

    if (!this.panelWindow) {
      return {
        left: fallbackLeft,
        top: fallbackTop,
        width: fallbackWidth,
        height: fallbackHeight
      };
    }

    const parsedLeft = Number.parseInt(this.panelWindow.style.left || "", 10);
    const parsedTop = Number.parseInt(this.panelWindow.style.top || "", 10);
    const parsedWidth = Number.parseInt(this.panelWindow.style.width || "", 10);
    const parsedHeight = Number.parseInt(this.panelWindow.style.height || "", 10);

    return {
      left: Number.isFinite(parsedLeft) ? parsedLeft : fallbackLeft,
      top: Number.isFinite(parsedTop) ? parsedTop : fallbackTop,
      width: Number.isFinite(parsedWidth) ? parsedWidth : (this.panelWindow.offsetWidth || fallbackWidth),
      height: Number.isFinite(parsedHeight) ? parsedHeight : (this.panelWindow.offsetHeight || fallbackHeight)
    };
  }

  private clampLeft(candidateLeft: number): number {
    const geometry = this.readCurrentGeometry();
    return clampOverlayGeometryToViewport(
      {
        ...geometry,
        left: candidateLeft
      },
      this.getViewportSize()
    ).left;
  }

  private clampTop(candidateTop: number): number {
    const geometry = this.readCurrentGeometry();
    return clampOverlayGeometryToViewport(
      {
        ...geometry,
        top: candidateTop
      },
      this.getViewportSize()
    ).top;
  }

  private readonly handleCapturedKeyboardEvent = (event: KeyboardEvent): void => {
    if (!this.shouldCaptureKeyboardEvent(event)) {
      return;
    }

    if (event.composedPath()[0] === this.terminalInput && this.handleTerminalInputKeydown(event)) {
      return;
    }

    if (event.type === "keydown" && event.key === "Tab") {
      event.preventDefault();
      event.stopImmediatePropagation();
      event.stopPropagation();
      this.moveOverlayFocus(event.shiftKey ? -1 : 1);
      return;
    }

    event.stopImmediatePropagation();
    event.stopPropagation();

    if (!this.isTypingElement(event.composedPath()[0])) {
      event.preventDefault();
    }
  };

  private shouldCaptureKeyboardEvent(event: KeyboardEvent): boolean {
    if (!this.visible) {
      return false;
    }

    return this.isEventInsideOverlay(event) || this.isOverlayFocusActive();
  }

  private readonly handleOverlayPointerEvent = (event: Event): void => {
    if (!this.visible || !this.isEventInsideOverlay(event)) {
      return;
    }

    event.stopPropagation();
  };

  private readonly handleOverlayWheelEvent = (event: WheelEvent): void => {
    if (!this.visible || !this.isEventInsideOverlay(event)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const scrollContainer = this.findScrollableOverlayAncestor(event.composedPath()[0]);
    if (!scrollContainer) {
      return;
    }

    scrollContainer.scrollTop += event.deltaY;
  };

  private isEventInsideOverlay(event: Event): boolean {
    if (!this.visible) {
      return false;
    }

    return event.composedPath().some((candidate) => this.isOverlayCandidate(candidate));
  }

  private isOverlayFocusActive(): boolean {
    if (!this.visible) {
      return false;
    }

    if (this.shadowRoot?.activeElement) {
      return true;
    }

    if (this.panelWindow?.matches(":focus-within")) {
      return true;
    }

    return document.activeElement === this.panelWindow;
  }

  private focusPreferredOverlayElement(): void {
    if (this.activeTab === "chat") {
      this.chatInput?.focus();
    } else if (this.activeTab === "texts") {
      this.panelWindow?.focus();
    } else {
      this.terminalInput?.focus();
    }
    if (this.shadowRoot?.activeElement || this.panelWindow?.matches(":focus-within")) {
      return;
    }

    this.panelWindow?.focus();
  }

  private moveOverlayFocus(direction: -1 | 1): void {
    const focusableElements = this.getOverlayFocusableElements();
    if (focusableElements.length === 0) {
      this.focusPreferredOverlayElement();
      return;
    }

    const activeElement = this.shadowRoot?.activeElement;
    const currentIndex = activeElement ? focusableElements.indexOf(activeElement as HTMLElement) : -1;
    const nextIndex =
      currentIndex === -1
        ? direction > 0
          ? 0
          : focusableElements.length - 1
        : (currentIndex + direction + focusableElements.length) % focusableElements.length;

    focusableElements[nextIndex]?.focus();
  }

  private getOverlayFocusableElements(): HTMLElement[] {
    if (!this.shadowRoot) {
      return [];
    }

    return Array.from(
      this.shadowRoot.querySelectorAll<HTMLElement>(
        'button, input, select, textarea, summary, [tabindex]:not([tabindex="-1"])'
      )
    ).filter((element) => {
      if (element.hasAttribute("disabled")) {
        return false;
      }

      if (element.tabIndex < 0) {
        return false;
      }

      return element.offsetParent !== null || element === this.panelWindow;
    });
  }

  private isOverlayCandidate(candidate: EventTarget | null | undefined): boolean {
    if (!candidate) {
      return false;
    }

    if (candidate === this.host) {
      return true;
    }

    return candidate instanceof Node && !!this.shadowRoot?.contains(candidate);
  }

  private isElementInsideOverlay(candidate: EventTarget | null | undefined): boolean {
    return this.isOverlayCandidate(candidate);
  }

  private findScrollableOverlayAncestor(candidate: EventTarget | null | undefined): HTMLElement | null {
    if (!(candidate instanceof Element)) {
      return null;
    }

    const scrollContainer = candidate.closest<HTMLElement>(".activity-feed, .chat-feed, .texts-feed");
    if (scrollContainer) {
      return scrollContainer;
    }

    const nestedScrollable = candidate.closest<HTMLElement>(".log-body, .activity-body");
    if (nestedScrollable) {
      return nestedScrollable;
    }

    return this.activityFeed;
  }

  private isTypingElement(candidate: EventTarget | null | undefined): boolean {
    if (!(candidate instanceof HTMLElement)) {
      return false;
    }

    return (
      candidate instanceof HTMLInputElement ||
      candidate instanceof HTMLTextAreaElement ||
      candidate instanceof HTMLSelectElement ||
      candidate.isContentEditable
    );
  }

  private isInteractiveElement(candidate: EventTarget | null | undefined): boolean {
    if (!(candidate instanceof Element)) {
      return false;
    }

    return !!candidate.closest("button, input, select, textarea, a, summary");
  }
}

const contentGlobals = globalThis as typeof globalThis & {
  __lextraceNt3ContentBootstrapped?: boolean;
  __lextraceNt3OverlayController?: OverlayTerminalController;
};

if (!contentGlobals.__lextraceNt3ContentBootstrapped) {
  contentGlobals.__lextraceNt3OverlayController = new OverlayTerminalController();
  contentGlobals.__lextraceNt3ContentBootstrapped = true;
  void recordLog("content", "content.bootstrap", "Контент-скрипт инициализирован.");
}

function formatOverlayLogLevel(level: LogEntry["level"]): string {
  switch (level) {
    case "debug":
      return "отладка";
    case "info":
      return "инфо";
    case "warn":
      return "предупр.";
    case "error":
    default:
      return "ошибка";
  }
}

const overlayStyles = `
  :host {
    all: initial;
    --scroll-track: #dadada;
    --scroll-thumb: #111111;
    --scroll-thumb-hover: #303030;
    --scroll-thumb-active: #000000;
    --scroll-size: 12px;
  }

  * {
    box-sizing: border-box;
    scrollbar-width: thin;
    scrollbar-color: var(--scroll-thumb) var(--scroll-track);
  }

  *::-webkit-scrollbar {
    width: var(--scroll-size);
    height: var(--scroll-size);
  }

  *::-webkit-scrollbar-track {
    background: var(--scroll-track);
    border-left: 1px solid #111111;
  }

  *::-webkit-scrollbar-thumb {
    background: var(--scroll-thumb);
    border: 1px solid #ffffff;
    border-radius: 0;
  }

  *::-webkit-scrollbar-thumb:hover {
    background: var(--scroll-thumb-hover);
  }

  *::-webkit-scrollbar-thumb:active {
    background: var(--scroll-thumb-active);
  }

  *::-webkit-scrollbar-button {
    display: none;
  }

  *::-webkit-scrollbar-corner {
    background: var(--scroll-track);
  }

  .overlay-window {
    position: fixed;
    inset: 0;
    pointer-events: none;
    font-family: "Bahnschrift", "Segoe UI Variable Text", "Segoe UI", sans-serif;
    color: #111111;
  }

  .panel-shell {
    position: fixed;
    pointer-events: auto;
    border: 1px solid #111111;
    background: rgba(238, 238, 238, 0.98);
    display: grid;
    grid-template-rows: auto auto 1fr;
    gap: 0;
    overflow: hidden;
    overscroll-behavior: contain;
  }

  .panel-shell.is-resizing {
    user-select: none;
  }

  .overlay-resize-handle {
    position: absolute;
    z-index: 9;
    background: transparent;
    touch-action: none;
  }

  .overlay-resize-handle--n {
    top: 0;
    left: 10px;
    right: 10px;
    height: 6px;
    cursor: ns-resize;
  }

  .overlay-resize-handle--s {
    left: 10px;
    right: 10px;
    bottom: 0;
    height: 6px;
    cursor: ns-resize;
  }

  .overlay-resize-handle--e {
    top: 10px;
    right: 0;
    bottom: 10px;
    width: 6px;
    cursor: ew-resize;
  }

  .overlay-resize-handle--w {
    top: 10px;
    left: 0;
    bottom: 10px;
    width: 6px;
    cursor: ew-resize;
  }

  .overlay-resize-handle--ne {
    top: 0;
    right: 0;
    width: 12px;
    height: 12px;
    cursor: nesw-resize;
  }

  .overlay-resize-handle--nw {
    top: 0;
    left: 0;
    width: 12px;
    height: 12px;
    cursor: nwse-resize;
  }

  .overlay-resize-handle--se {
    right: 0;
    bottom: 0;
    width: 12px;
    height: 12px;
    cursor: nwse-resize;
  }

  .overlay-resize-handle--sw {
    left: 0;
    bottom: 0;
    width: 12px;
    height: 12px;
    cursor: nesw-resize;
  }

  .panel-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 0;
    padding: 10px 12px;
    border-bottom: 1px solid #111111;
    background: #f3f3f3;
    cursor: move;
    user-select: none;
    touch-action: none;
  }

  .panel-header h1,
  .panel-kicker {
    margin: 0;
  }

  .panel-kicker {
    font-size: 11px;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: #5b5b5b;
  }

  .panel-header h1 {
    font-size: 28px;
    line-height: 1;
    font-weight: 600;
    letter-spacing: 0.04em;
  }

  .close-button {
    appearance: none;
    border: 0;
    color: #111111;
    font: inherit;
    cursor: pointer;
  }

  .close-button {
    min-height: 34px;
    padding: 0 12px;
    border-left: 1px solid #111111;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    font-size: 12px;
    background: transparent;
    cursor: pointer;
  }

  .overlay-tab-strip {
    display: flex;
    gap: 0;
    border-bottom: 1px solid #111111;
    background: #ffffff;
  }

  .overlay-tab-button {
    appearance: none;
    border: 0;
    border-right: 1px solid #111111;
    background: #ffffff;
    color: #111111;
    min-height: 36px;
    padding: 0 14px;
    font: inherit;
    font-size: 12px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    cursor: pointer;
  }

  .overlay-tab-button.is-active {
    background: #111111;
    color: #ffffff;
  }

  .tab-surface {
    display: none;
    min-height: 0;
    grid-template-rows: auto auto 1fr;
  }

  .tab-surface.is-active {
    display: grid;
  }

  .tab-surface.chat-surface {
    grid-template-rows: auto 1fr;
  }

  .status-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 0;
    border-bottom: 1px solid #111111;
    background: #ffffff;
  }

  .status-chip-list {
    display: grid;
    min-width: 0;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 108px), 1fr));
    gap: 0;
  }

  .status-row-actions {
    display: flex;
    align-items: stretch;
    min-height: 100%;
    border-left: 1px solid #111111;
    background: #fafafa;
  }

  .tool-row {
    display: flex;
    align-items: center;
    gap: 0;
    min-height: 32px;
    border-bottom: 1px solid #111111;
    background: #fafafa;
  }

  .tool-row.is-collapsed {
    min-height: 0;
    height: 0;
    border-bottom: 0;
    overflow: hidden;
    pointer-events: none;
  }

  .status-chip {
    position: relative;
    display: inline-flex;
    width: 100%;
    box-sizing: border-box;
    align-items: center;
    gap: 5px;
    min-width: 0;
    max-width: 100%;
    min-height: 24px;
    border-right: 1px solid #111111;
    padding: 3px 5px;
    background: #ffffff;
    color: #111111;
    font-size: 10px;
    letter-spacing: 0.03em;
    line-height: 1;
    cursor: default;
    transition: background 120ms ease, color 120ms ease;
  }

  .status-chip-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 12px;
    height: 12px;
    flex: 0 0 auto;
  }

  .status-chip-icon svg {
    width: 11px;
    height: 11px;
    stroke: currentColor;
    stroke-width: 1.35;
    stroke-linecap: round;
    stroke-linejoin: round;
    fill: none;
  }

  .status-chip-value {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .status-chip--short .status-chip-value {
    max-width: 56px;
  }

  .status-chip--wide .status-chip-value {
    max-width: 100%;
  }

  .status-chip--page .status-chip-value {
    max-width: 100%;
  }

  .status-chip:hover,
  .status-chip:focus-visible {
    background: #f3f3f3;
    outline: none;
  }

  .status-chip:focus-visible {
    box-shadow: inset 0 0 0 2px #111111;
    z-index: 2;
  }

  .status-action {
    appearance: none;
    border: 0;
    border-left: 1px solid #111111;
    background: transparent;
    color: #111111;
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 28px;
    min-height: 24px;
    padding: 0 6px;
    cursor: pointer;
    transition: background 120ms ease, color 120ms ease;
  }

  .status-row-actions .status-action:first-child {
    border-left: 0;
  }

  .status-action svg {
    width: 12px;
    height: 12px;
    stroke: currentColor;
    stroke-width: 1.35;
    stroke-linecap: round;
    stroke-linejoin: round;
    fill: none;
  }

  .status-action:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .tool-icon {
    appearance: none;
    border: 0;
    border-left: 1px solid #111111;
    background: transparent;
    color: #111111;
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 34px;
    min-height: 34px;
    padding: 0;
    cursor: pointer;
    transition: background 120ms ease, color 120ms ease;
  }

  .tool-icon svg {
    width: 14px;
    height: 14px;
    stroke: currentColor;
    stroke-width: 1.45;
    stroke-linecap: round;
    stroke-linejoin: round;
    fill: none;
  }

  .tool-icon:disabled {
    opacity: 0.5;
    cursor: progress;
  }

  .tool-icon::before,
  .tool-icon::after,
  .status-chip::before,
  .status-chip::after,
  .status-action::before,
  .status-action::after {
    position: absolute;
    left: 50%;
    opacity: 0;
    visibility: hidden;
    pointer-events: none;
    transition:
      opacity 120ms ease,
      visibility 120ms ease,
      transform 120ms ease;
  }

  .tool-icon::before,
  .status-chip::before,
  .status-action::before {
    content: "";
    bottom: calc(100% + 3px);
    width: 8px;
    height: 8px;
    border-left: 1px solid #111111;
    border-top: 1px solid #111111;
    background: #f3f3f3;
    transform: translateX(-50%) rotate(45deg);
  }

  .tool-icon::after,
  .status-chip::after,
  .status-action::after {
    content: attr(data-tooltip);
    display: block;
    bottom: calc(100% + 8px);
    padding: 3px 6px;
    border: 1px solid #111111;
    background: #f3f3f3;
    color: #111111;
    font-family: "Bahnschrift", "Segoe UI Variable Text", "Segoe UI", sans-serif;
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    box-shadow: 2px 2px 0 rgba(17, 17, 17, 0.08);
    transform: translate(-50%, 4px);
    z-index: 12;
  }

  .tool-icon::after,
  .status-action::after {
    white-space: nowrap;
  }

  .status-chip::after {
    width: max-content;
    max-width: min(320px, calc(100vw - 32px));
    white-space: normal;
    overflow-wrap: break-word;
    word-break: normal;
    line-height: 1.35;
    text-align: left;
    text-transform: none;
  }

  .tool-icon:hover,
  .tool-icon:focus-visible {
    background: #111111;
    color: #ffffff;
    outline: none;
    z-index: 10;
  }

  .tool-icon:focus-visible {
    box-shadow: inset 0 0 0 2px #ffffff;
  }

  .status-action:hover,
  .status-action:focus-visible {
    background: #111111;
    color: #ffffff;
    outline: none;
    z-index: 10;
  }

  .status-action:focus-visible {
    box-shadow: inset 0 0 0 2px #ffffff;
  }

  .tool-icon:hover::before,
  .tool-icon:hover::after,
  .tool-icon:focus-visible::before,
  .tool-icon:focus-visible::after,
  .status-action:hover::before,
  .status-action:hover::after,
  .status-action:focus-visible::before,
  .status-action:focus-visible::after,
  .status-chip:hover::before,
  .status-chip:hover::after,
  .status-chip:focus-visible::before,
  .status-chip:focus-visible::after {
    opacity: 1;
    visibility: visible;
  }

  .tool-icon:hover::after,
  .tool-icon:focus-visible::after,
  .status-action:hover::after,
  .status-action:focus-visible::after,
  .status-chip:hover::after,
  .status-chip:focus-visible::after {
    transform: translate(-50%, 0);
  }

  .tool-icon:active {
    background: #2f2f2f;
    color: #ffffff;
  }

  .status-chip:hover,
  .status-chip:focus-visible {
    z-index: 10;
  }

  .panel-body {
    min-height: 0;
    display: grid;
    grid-template-rows: 1fr auto;
    background: rgba(255, 255, 255, 0.96);
  }

  .activity-feed {
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    border: 0;
    padding: 0;
    overscroll-behavior: contain;
  }

  .chat-feed {
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    background: #ffffff;
    overscroll-behavior: contain;
  }

  .texts-body {
    grid-template-rows: 1fr;
  }

  .texts-feed {
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 10px;
    background: #fcfcfc;
    display: grid;
    align-content: start;
    gap: 10px;
    overscroll-behavior: contain;
  }

  .texts-empty-state,
  .texts-summary-card,
  .text-binding-entry {
    border: 1px solid #111111;
    background: #ffffff;
  }

  .texts-empty-state {
    padding: 12px 14px;
    font-size: 13px;
    line-height: 1.45;
  }

  .texts-summary-card {
    display: grid;
    gap: 6px;
    padding: 10px 12px;
  }

  .texts-summary-title {
    font-size: 12px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }

  .texts-summary-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 12px;
    font-size: 12px;
  }

  .text-binding-entry {
    display: grid;
    gap: 0;
  }

  .text-binding-entry.is-changed {
    border-color: #1f7d49;
    box-shadow: inset 0 0 0 1px rgba(31, 125, 73, 0.22);
  }

  .text-binding-entry.is-stale {
    border-color: rgba(120, 86, 37, 0.42);
    background: rgba(189, 146, 72, 0.06);
  }

  .text-binding-header {
    display: grid;
    gap: 6px;
    padding: 10px 12px;
    border-bottom: 1px solid rgba(17, 17, 17, 0.12);
  }

  .text-binding-title-row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  }

  .text-binding-badge,
  .text-binding-presence,
  .text-binding-id {
    display: inline-flex;
    align-items: center;
    min-height: 22px;
    padding: 0 8px;
    border: 1px solid #111111;
    font-size: 10px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }

  .text-binding-badge {
    background: #111111;
    color: #ffffff;
  }

  .text-binding-presence.is-live {
    background: rgba(46, 148, 84, 0.12);
    border-color: rgba(46, 148, 84, 0.55);
    color: #145f31;
  }

  .text-binding-presence.is-stale {
    background: rgba(189, 146, 72, 0.12);
    border-color: rgba(189, 146, 72, 0.55);
    color: #7b4c10;
  }

  .text-binding-meta {
    font-size: 12px;
    line-height: 1.45;
    color: #353535;
    word-break: break-word;
  }

  .text-binding-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 0;
  }

  .text-binding-field {
    display: grid;
    gap: 6px;
    padding: 10px 12px;
    border-top: 1px solid rgba(17, 17, 17, 0.12);
    border-right: 1px solid rgba(17, 17, 17, 0.12);
  }

  .text-binding-label {
    font-size: 10px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: #4f4f4f;
  }

  .text-binding-value {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
    font-family: "Bahnschrift", "Segoe UI Variable Text", "Segoe UI", sans-serif;
    font-size: 12px;
    line-height: 1.45;
  }

  .activity-entry {
    border-bottom: 1px solid rgba(17, 17, 17, 0.14);
    background: #ffffff;
  }

  .activity-terminal-summary {
    display: grid;
    grid-template-columns: auto auto 1fr auto;
    gap: 6px;
    align-items: center;
    min-height: 24px;
    padding: 4px 8px;
    cursor: pointer;
    list-style: none;
  }

  .activity-kind,
  .log-level {
    display: inline-flex;
    min-width: 56px;
    justify-content: center;
    border: 1px solid currentColor;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    font-size: 11px;
    padding: 4px 8px;
  }

  .activity-terminal .activity-kind {
    min-width: 44px;
    padding: 2px 6px;
    font-size: 10px;
  }

  .activity-title,
  .activity-ts,
  .log-ts,
  .log-meta {
    font-size: 11px;
    color: #5b5b5b;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .activity-title {
    white-space: nowrap;
  }

  .activity-summary,
  .log-heading {
    font-size: 12px;
    line-height: 1.5;
    overflow-wrap: anywhere;
  }

  .activity-summary {
    color: #3b3b3b;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .activity-terminal-summary::-webkit-details-marker {
    display: none;
  }

  .activity-body,
  .log-body {
    margin: 0;
    padding: 0 10px 10px;
    font-family: "Cascadia Code", "Consolas", monospace;
    font-size: 12px;
    line-height: 1.5;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    overflow-x: hidden;
  }

  .terminal-command .activity-kind,
  .terminal-command .activity-title {
    color: #1d4ed8;
  }

  .terminal-result .activity-kind,
  .terminal-result .activity-title {
    color: #166534;
  }

  .terminal-error .activity-kind,
  .terminal-error .activity-title {
    color: #b91c1c;
  }

  .terminal-system .activity-kind,
  .terminal-system .activity-title {
    color: #4b5563;
  }

  .terminal-form {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 8px;
    align-items: center;
    border-top: 1px solid #111111;
    background: #ffffff;
    padding: 0 10px;
    min-height: 40px;
  }

  .chat-form {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    gap: 0;
    align-items: stretch;
    border-top: 1px solid #111111;
    background: #ffffff;
    padding: 0 0 0 10px;
    min-height: 40px;
  }

  .chat-form .prompt-label {
    display: inline-flex;
    align-items: center;
    margin-right: 8px;
  }

  .prompt-label {
    font-family: "Cascadia Code", "Consolas", monospace;
    font-size: 12px;
    letter-spacing: 0.1em;
  }

  .terminal-input-shell {
    position: relative;
    min-width: 0;
  }

  .terminal-input {
    width: 100%;
    border: 0;
    background: transparent;
    font: inherit;
    font-family: "Cascadia Code", "Consolas", monospace;
    font-size: 13px;
    color: #111111;
    outline: none;
  }

  .chat-input {
    width: 100%;
    border: 0;
    background: transparent;
    font: inherit;
    font-family: "Cascadia Code", "Consolas", monospace;
    font-size: 13px;
    color: #111111;
    outline: none;
  }

  .chat-input-shell {
    min-width: 0;
    display: flex;
    align-items: center;
  }

  .chat-queue-file-input {
    display: none;
  }

  .chat-tool-row {
    align-self: stretch;
    flex-shrink: 0;
    align-items: stretch;
    min-height: 100%;
    border-bottom: 0;
    border-left: 1px solid #111111;
    background: #f6f6f6;
  }

  .chat-tool-row .tool-icon:first-child {
    border-left: 0;
  }

  .chat-tool-row.is-collapsed {
    display: none;
  }

  .terminal-suggestion-list {
    position: absolute;
    left: 0;
    right: 0;
    bottom: calc(100% + 1px);
    display: grid;
    max-height: 108px;
    overflow-y: auto;
    overflow-x: hidden;
    border: 1px solid #111111;
    background: #ffffff;
    box-shadow: 0 -1px 0 rgba(17, 17, 17, 0.05);
    z-index: 2;
  }

  .terminal-suggestion-list.is-hidden {
    display: none;
  }

  .terminal-suggestion-item {
    appearance: none;
    border: 0;
    border-bottom: 1px solid rgba(17, 17, 17, 0.12);
    background: #ffffff;
    color: #111111;
    min-height: 20px;
    padding: 2px 6px;
    text-align: left;
    font-family: "Cascadia Code", "Consolas", monospace;
    font-size: 10px;
    line-height: 1.2;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    cursor: pointer;
  }

  .terminal-suggestion-item.is-selected {
    background: #111111;
    color: #ffffff;
  }

  .activity-log {
    overflow: hidden;
  }

  .activity-log .log-summary {
    min-height: 24px;
    padding: 3px 8px;
  }

  .activity-log .log-level {
    min-width: 44px;
    padding: 2px 6px;
    font-size: 10px;
  }

  .log-summary {
    display: grid;
    grid-template-columns: auto 1fr auto;
    gap: 6px;
    align-items: center;
    min-height: 28px;
    padding: 4px 8px;
    cursor: pointer;
    list-style: none;
  }

  .log-summary::-webkit-details-marker {
    display: none;
  }

  .log-heading-block {
    display: block;
    min-width: 0;
  }

  .log-heading {
    color: #111111;
    font-size: 11px;
    line-height: 1.35;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .log-meta,
  .log-body {
    padding: 0 10px 10px;
  }

  .log-meta {
    color: #5b5b5b;
  }

  .level-debug {
    color: #4b5563;
  }

  .level-info {
    color: #1d4ed8;
  }

  .level-warn {
    color: #b45309;
  }

  .level-error {
    color: #b91c1c;
  }

  .chat-entry {
    display: grid;
    gap: 0;
    border-bottom: 1px solid rgba(17, 17, 17, 0.14);
    background: #ffffff;
  }

  .chat-entry-header {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 8px;
    align-items: center;
    min-height: 26px;
    padding: 4px 8px;
  }

  .chat-entry-badge {
    display: inline-flex;
    justify-content: center;
    min-width: 52px;
    border: 1px solid currentColor;
    padding: 2px 6px;
    font-size: 10px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }

  .chat-entry-meta {
    min-width: 0;
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #5b5b5b;
  }

  .chat-entry-body {
    padding: 0 10px 10px;
    display: grid;
    gap: 6px;
    font-size: 12px;
    line-height: 1.55;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    overflow-x: hidden;
  }

  .chat-entry-note {
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #5b5b5b;
  }

  .chat-entry-content {
    min-width: 0;
  }

  .chat-entry-content.is-placeholder {
    color: #7a7a7a;
  }

  .chat-entry.is-dimmed {
    background: #f6f6f6;
    opacity: 0.56;
  }

  .chat-entry.kind-system-prompt {
    background: #f7f7f7;
  }

  .chat-entry.kind-system-prompt .chat-entry-badge,
  .chat-entry.kind-compaction .chat-entry-badge {
    color: #4b5563;
  }

  .chat-range {
    border-bottom: 1px solid rgba(17, 17, 17, 0.14);
    background: #fafafa;
  }

  .chat-range-summary {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 8px;
    align-items: center;
    min-height: 30px;
    padding: 5px 8px;
    cursor: pointer;
    list-style: none;
  }

  .chat-range-summary::-webkit-details-marker {
    display: none;
  }

  .chat-range-badge {
    display: inline-flex;
    justify-content: center;
    min-width: 52px;
    border: 1px solid #4b5563;
    color: #4b5563;
    padding: 2px 6px;
    font-size: 10px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }

  .chat-range-title {
    min-width: 0;
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #5b5b5b;
  }

  .chat-range-body {
    display: grid;
  }

  .chat-entry.kind-assistant .chat-entry-badge {
    color: #166534;
  }

  .chat-entry.kind-user .chat-entry-badge,
  .chat-entry.kind-code .chat-entry-badge {
    color: #1d4ed8;
  }

  .chat-entry.kind-error .chat-entry-badge {
    color: #b91c1c;
  }
`;
