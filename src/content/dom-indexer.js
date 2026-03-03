import { stableHash } from "../shared/utils.js";

const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "CODE", "PRE", "TEXTAREA", "INPUT"]);
const ANCHOR_ATTR = "data-nt-anchor-id";
let anchorCounter = 0;

function isVisibleElement(element) {
  if (!element || !(element instanceof Element)) {
    return false;
  }
  const style = window.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden") {
    return false;
  }
  if (element.closest("[aria-hidden='true']")) {
    return false;
  }
  return true;
}

function shouldSkipNode(textNode) {
  const parent = textNode.parentElement;
  if (!parent) {
    return true;
  }
  if (SKIP_TAGS.has(parent.tagName)) {
    return true;
  }
  if (!isVisibleElement(parent)) {
    return true;
  }
  const value = textNode.nodeValue || "";
  if (!value.trim()) {
    return true;
  }
  return false;
}

export function createNodePath(textNode) {
  const path = [];
  let cursor = textNode;
  while (cursor && cursor !== document.body) {
    const parent = cursor.parentNode;
    if (!parent) {
      break;
    }
    const index = Array.prototype.indexOf.call(parent.childNodes, cursor);
    path.push(index);
    cursor = parent;
  }
  path.push(0);
  return path.reverse();
}

export function resolveNodePath(path) {
  if (!Array.isArray(path) || path.length === 0) {
    return null;
  }
  let cursor = document.body;
  for (let i = 1; i < path.length; i += 1) {
    const idx = path[i];
    cursor = cursor?.childNodes?.[idx] || null;
    if (!cursor) {
      return null;
    }
  }
  return cursor.nodeType === Node.TEXT_NODE ? cursor : null;
}

export function resolveAnchor(anchor) {
  if (!anchor || typeof anchor !== "object") {
    return null;
  }

  const byPath = resolveNodePath(anchor.path);
  if (byPath && matchesTextHash(byPath, anchor.textHash)) {
    return byPath;
  }

  if (anchor.parentAnchorId) {
    const escapedId = escapeAttributeValue(anchor.parentAnchorId);
    const parent = document.querySelector(`[${ANCHOR_ATTR}="${escapedId}"]`);
    if (parent) {
      const byHash = findTextNodeByHash(parent, anchor.textHash);
      if (byHash) {
        return byHash;
      }
      return findFirstUsefulTextNode(parent);
    }
  }

  return byPath;
}

export function scanTextBlocks() {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const blocks = [];
  let order = 0;

  while (walker.nextNode()) {
    const textNode = walker.currentNode;
    if (shouldSkipNode(textNode)) {
      continue;
    }

    const path = createNodePath(textNode);
    const text = textNode.nodeValue.trim();
    const parentAnchorId = getOrCreateParentAnchorId(textNode.parentElement);
    const textHash = stableHash(text);
    const blockId = `blk_${stableHash(`${location.href}|${parentAnchorId}|${path.join(".")}|${textHash}`)}`;

    blocks.push({
      blockId,
      text,
      order,
      anchor: {
        path,
        parentAnchorId,
        textHash
      },
      parentTag: textNode.parentElement?.tagName || "DIV"
    });

    order += 1;
  }

  return blocks;
}

function getOrCreateParentAnchorId(element) {
  if (!element || !(element instanceof Element)) {
    return "";
  }
  const existing = element.getAttribute(ANCHOR_ATTR);
  if (existing) {
    return existing;
  }
  const created = `nta_${++anchorCounter}_${stableHash(element.tagName + (element.className || "")).slice(0, 6)}`;
  element.setAttribute(ANCHOR_ATTR, created);
  return created;
}

function matchesTextHash(node, expectedHash) {
  if (!expectedHash || !node) {
    return true;
  }
  const text = String(node.nodeValue || "").trim();
  if (!text) {
    return false;
  }
  return stableHash(text) === expectedHash;
}

function findTextNodeByHash(parent, expectedHash) {
  if (!expectedHash) {
    return null;
  }
  const walker = document.createTreeWalker(parent, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const text = String(node.nodeValue || "").trim();
    if (!text) {
      continue;
    }
    if (stableHash(text) === expectedHash) {
      return node;
    }
  }
  return null;
}

function findFirstUsefulTextNode(parent) {
  const walker = document.createTreeWalker(parent, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (String(node.nodeValue || "").trim()) {
      return node;
    }
  }
  return null;
}

function escapeAttributeValue(value) {
  const input = String(value ?? "");
  if (globalThis.CSS?.escape) {
    return globalThis.CSS.escape(input);
  }
  return input.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
