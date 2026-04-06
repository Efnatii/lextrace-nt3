import { describe, expect, it } from "vitest";

import {
  createEmptyTextPageMap,
  updateBindingReplacement,
  type TextPageMap
} from "../../extension/src/shared/text-elements";

function createPageMap(): TextPageMap {
  return {
    ...createEmptyTextPageMap({
      pageKey: "https://example.com/page",
      pageUrl: "https://example.com/page",
      now: "2026-04-04T10:00:00.000Z"
    }),
    lastScanAt: "2026-04-04T10:00:00.000Z",
    bindings: [
      {
        bindingId: "txt_heading",
        category: "heading",
        presence: "live",
        staleSince: null,
        originalText: "Headline",
        originalNormalized: "Headline",
        replacementText: null,
        effectiveText: "Headline",
        currentText: "Headline",
        tagName: "h1",
        attributeName: null,
        locator: {
          preferredSelector: "#headline",
          ancestorSelector: "main",
          elementSelector: "main > h1:nth-of-type(1)",
          nodeIndex: 0,
          tagName: "h1",
          attributeName: null,
          classNames: [],
          stableAttributes: {}
        },
        context: {
          pageTitle: "Example page",
          selectorPreview: "#headline",
          ancestorText: "Example page"
        },
        firstSeenAt: "2026-04-04T10:00:00.000Z",
        lastSeenAt: "2026-04-04T10:00:00.000Z",
        lastMatchedAt: "2026-04-04T10:00:00.000Z",
        matchStrategy: "preferred-selector",
        changed: false
      },
      {
        bindingId: "txt_copy",
        category: "paragraph",
        presence: "live",
        staleSince: null,
        originalText: "Body copy",
        originalNormalized: "Body copy",
        replacementText: null,
        effectiveText: "Body copy",
        currentText: "Body copy",
        tagName: "p",
        attributeName: null,
        locator: {
          preferredSelector: "#copy",
          ancestorSelector: "main",
          elementSelector: "main > p:nth-of-type(1)",
          nodeIndex: 0,
          tagName: "p",
          attributeName: null,
          classNames: [],
          stableAttributes: {}
        },
        context: {
          pageTitle: "Example page",
          selectorPreview: "#copy",
          ancestorText: "Example page"
        },
        firstSeenAt: "2026-04-04T10:00:00.000Z",
        lastSeenAt: "2026-04-04T10:00:00.000Z",
        lastMatchedAt: "2026-04-04T10:00:00.000Z",
        matchStrategy: "preferred-selector",
        changed: false
      }
    ]
  };
}

describe("text blanking replacement", () => {
  it("persists an empty-string replacement without resetting lastScanAt", () => {
    const pageMap = createPageMap();

    const updated = updateBindingReplacement(pageMap, "txt_copy", "", {
      now: "2026-04-04T10:05:00.000Z"
    });

    expect(updated.lastScanAt).toBe(pageMap.lastScanAt);
    expect(updated.updatedAt).toBe("2026-04-04T10:05:00.000Z");
    expect(updated.bindings[1]?.replacementText).toBe("");
    expect(updated.bindings[1]?.effectiveText).toBe("");
    expect(updated.bindings[1]?.changed).toBe(true);
  });

  it("updates only the targeted binding when blanking text", () => {
    const pageMap = createPageMap();

    const updated = updateBindingReplacement(pageMap, "txt_copy", "", {
      now: "2026-04-04T10:05:00.000Z"
    });

    expect(updated.bindings[0]).toMatchObject({
      bindingId: "txt_heading",
      replacementText: null,
      effectiveText: "Headline",
      changed: false
    });
    expect(updated.bindings[1]).toMatchObject({
      bindingId: "txt_copy",
      replacementText: "",
      effectiveText: "",
      changed: true
    });
  });
});
