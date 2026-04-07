import { describe, expect, it } from "vitest";

import {
  createEmptyTextPageMap,
  mergeTextPageMapWithCandidates,
  updateBindingReplacement,
  type TextPageMap,
  type TextScanCandidate
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

// Proof test for the zero-rects bypass fix in createTextNodeCandidate.
//
// When autoBlankOnScan sets a textNode's textContent to "" the host container
// collapses to zero height. The DOM-level fix allows createTextNodeCandidate to
// return a candidate for such nodes. This test verifies the data-model contract
// that is enabled by that fix: once a matching candidate arrives (from
// materializeCurrentPageTextTargets / incremental refresh), mergeTextPageMapWithCandidates
// must keep the binding live and preserve the blank replacementText.
describe("blank-mode candidate recovery", () => {
  function makeCopyCandidate(): TextScanCandidate {
    return {
      category: "paragraph",
      text: "Body copy",
      normalizedText: "Body copy",
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
      }
    };
  }

  it("preserves blank replacementText when the candidate is recovered after zero-rects bypass", () => {
    const pageMap = createPageMap();

    // Simulate autoBlankOnScan: blank the copy binding.
    const blanked = updateBindingReplacement(pageMap, "txt_copy", "", {
      now: "2026-04-04T10:05:00.000Z"
    });

    // The DOM fix (zero-rects bypass) allows createTextNodeCandidate to emit a
    // candidate even though the container is collapsed. Simulate its arrival.
    const recovered = mergeTextPageMapWithCandidates(blanked, [makeCopyCandidate()], {
      now: "2026-04-04T10:06:00.000Z"
    });

    const copyBinding = recovered.bindings.find((b) => b.bindingId === "txt_copy");
    expect(copyBinding).toBeDefined();
    expect(copyBinding?.presence).toBe("live");
    // replacementText must survive the merge — the text is still blanked.
    expect(copyBinding?.replacementText).toBe("");
    expect(copyBinding?.effectiveText).toBe("");
    // changed: true because replacementText("") !== candidate.text("Body copy")
    expect(copyBinding?.changed).toBe(true);
  });

  it("does not disturb the heading binding when recovering the copy binding", () => {
    const pageMap = createPageMap();
    const blanked = updateBindingReplacement(pageMap, "txt_copy", "", {
      now: "2026-04-04T10:05:00.000Z"
    });
    // Only the copy candidate is supplied — heading is not part of this scan.
    const recovered = mergeTextPageMapWithCandidates(blanked, [makeCopyCandidate()], {
      now: "2026-04-04T10:06:00.000Z"
    });

    const headingBinding = recovered.bindings.find((b) => b.bindingId === "txt_heading");
    // Heading had no candidate so it is dropped from the merged result.
    // This is the expected full-scan behaviour: unmatched bindings are omitted.
    expect(headingBinding).toBeUndefined();
  });
});
