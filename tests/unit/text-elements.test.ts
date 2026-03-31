import { describe, expect, it } from "vitest";

import {
  areTextBindingListsEquivalentForPersistence,
  areTextBindingsEquivalentForPersistence,
  buildInlineTextEditorGeometry,
  buildControlTextLayoutRects,
  isTextBindingAttributeVisuallyRenderable,
  buildTextBindingId,
  buildTextMapSummary,
  buildTextRectUnion,
  categorizeTextElement,
  createEmptyTextPageMap,
  createEmptyTextStorageEnvelope,
  formatTextMapExportFileName,
  mapBindingsToCandidateIndices,
  mergeTextPageMapWithCandidates,
  normalizeTextForBinding,
  removeBindingFromPageMap,
  removePageMapFromEnvelope,
  resetPageBindings,
  resolveDisplayedBindingText,
  updateBindingReplacement,
  upsertPageMapInEnvelope,
  type TextScanCandidate
} from "../../extension/src/shared/text-elements";

function createCandidate(overrides: Partial<TextScanCandidate> & Pick<TextScanCandidate, "text" | "normalizedText">): TextScanCandidate {
  const locator = overrides.locator;
  const context = overrides.context;
  return {
    category: overrides.category ?? "generic",
    text: overrides.text,
    normalizedText: overrides.normalizedText,
    tagName: overrides.tagName ?? "span",
    attributeName: overrides.attributeName ?? null,
    locator: locator ?? {
      preferredSelector: "#target",
      ancestorSelector: "main",
      elementSelector: "main > span:nth-of-type(1)",
      nodeIndex: 0,
      tagName: "span",
      attributeName: null,
      classNames: [],
      stableAttributes: {}
    },
    context: context ?? {
      pageTitle: "Example page",
      selectorPreview: "#target",
      ancestorText: "ancestor"
    }
  };
}

describe("text element helpers", () => {
  it("normalizes whitespace-only differences for bindings", () => {
    expect(normalizeTextForBinding("  Hello   world \n again ")).toBe("Hello world again");
  });

  it("categorizes common element kinds", () => {
    expect(categorizeTextElement({ tagName: "h2" })).toBe("heading");
    expect(categorizeTextElement({ tagName: "a" })).toBe("link");
    expect(categorizeTextElement({ tagName: "button" })).toBe("button");
    expect(categorizeTextElement({ tagName: "img", attributeName: "alt" })).toBe("image-alt");
    expect(categorizeTextElement({ tagName: "input", attributeName: "placeholder" })).toBe("input-placeholder");
    expect(categorizeTextElement({ tagName: "select", attributeName: "value" })).toBe("option");
    expect(categorizeTextElement({ tagName: "div" })).toBe("generic");
  });

  it("treats only visible text attributes as in-page renderable", () => {
    expect(isTextBindingAttributeVisuallyRenderable(null)).toBe(true);
    expect(isTextBindingAttributeVisuallyRenderable("value")).toBe(true);
    expect(isTextBindingAttributeVisuallyRenderable("placeholder")).toBe(true);
    expect(isTextBindingAttributeVisuallyRenderable("title")).toBe(false);
    expect(isTextBindingAttributeVisuallyRenderable("aria-label")).toBe(false);
    expect(isTextBindingAttributeVisuallyRenderable("alt")).toBe(false);
  });

  it("builds stable binding ids from locator seeds", () => {
    const first = buildTextBindingId({
      pageKey: "https://example.com/path",
      category: "paragraph",
      normalizedText: "Hello world",
      preferredSelector: "#intro",
      ancestorSelector: "main",
      attributeName: null,
      nodeIndex: 0
    });
    const second = buildTextBindingId({
      pageKey: "https://example.com/path",
      category: "paragraph",
      normalizedText: "Hello world",
      preferredSelector: "#intro",
      ancestorSelector: "main",
      attributeName: null,
      nodeIndex: 0
    });

    expect(first).toBe(second);
    expect(first).toMatch(/^txt_[a-f0-9]{8}$/);
  });

  it("distinguishes bindings that share a preferred selector but differ by element selector", () => {
    const first = buildTextBindingId({
      pageKey: "https://example.com/path",
      category: "input-placeholder",
      normalizedText: "Search Stories",
      preferredSelector: "input[name=\"q\"]",
      elementSelector: "header form:nth-of-type(1) > input:nth-of-type(1)",
      ancestorSelector: "header form:nth-of-type(1)",
      attributeName: "placeholder",
      nodeIndex: null
    });
    const second = buildTextBindingId({
      pageKey: "https://example.com/path",
      category: "input-placeholder",
      normalizedText: "Search Stories",
      preferredSelector: "input[name=\"q\"]",
      elementSelector: "header form:nth-of-type(2) > input:nth-of-type(1)",
      ancestorSelector: "header form:nth-of-type(2)",
      attributeName: "placeholder",
      nodeIndex: null
    });

    expect(first).not.toBe(second);
  });

  it("merges rescans back into the same binding and preserves replacement text", () => {
    const initialMap = createEmptyTextPageMap({
      pageKey: "https://example.com/path",
      pageUrl: "https://example.com/path",
      pageTitle: "Example page",
      now: "2026-03-29T00:00:00.000Z"
    });

    const firstScan = mergeTextPageMapWithCandidates(
      initialMap,
      [
        createCandidate({
          category: "paragraph",
          text: "Hello world",
          normalizedText: "Hello world"
        })
      ],
      {
        pageTitle: "Example page",
        now: "2026-03-29T00:00:01.000Z"
      }
    );

    const changed = updateBindingReplacement(firstScan, firstScan.bindings[0]!.bindingId, "Updated text", {
      now: "2026-03-29T00:00:02.000Z"
    });

    const rescanned = mergeTextPageMapWithCandidates(
      changed,
      [
        createCandidate({
          category: "paragraph",
          text: "Hello world",
          normalizedText: "Hello world"
        })
      ],
      {
        pageTitle: "Example page",
        now: "2026-03-29T00:00:03.000Z"
      }
    );

    expect(rescanned.bindings).toHaveLength(1);
    expect(rescanned.bindings[0]?.replacementText).toBe("Updated text");
    expect(rescanned.bindings[0]?.effectiveText).toBe("Updated text");
    expect(rescanned.bindings[0]?.matchStrategy).toBe("preferred-selector");
    expect(rescanned.bindings[0]?.changed).toBe(true);
  });

  it("keeps duplicate-looking controls separate when only the element selector differs", () => {
    const pageMap = createEmptyTextPageMap({
      pageKey: "https://example.com/path",
      pageUrl: "https://example.com/path",
      pageTitle: "Example page",
      now: "2026-03-29T00:00:00.000Z"
    });

    const scanned = mergeTextPageMapWithCandidates(
      pageMap,
      [
        createCandidate({
          category: "input-placeholder",
          tagName: "input",
          text: "Search Stories",
          normalizedText: "Search Stories",
          attributeName: "placeholder",
          locator: {
            preferredSelector: "input[name=\"q\"]",
            ancestorSelector: "header form:nth-of-type(1)",
            elementSelector: "header form:nth-of-type(1) > input:nth-of-type(1)",
            nodeIndex: null,
            tagName: "input",
            attributeName: "placeholder",
            classNames: [],
            stableAttributes: {
              name: "q"
            }
          }
        }),
        createCandidate({
          category: "input-placeholder",
          tagName: "input",
          text: "Search Stories",
          normalizedText: "Search Stories",
          attributeName: "placeholder",
          locator: {
            preferredSelector: "input[name=\"q\"]",
            ancestorSelector: "header form:nth-of-type(2)",
            elementSelector: "header form:nth-of-type(2) > input:nth-of-type(1)",
            nodeIndex: null,
            tagName: "input",
            attributeName: "placeholder",
            classNames: [],
            stableAttributes: {
              name: "q"
            }
          }
        })
      ],
      {
        pageTitle: "Example page",
        now: "2026-03-29T00:00:01.000Z"
      }
    );

    expect(scanned.bindings).toHaveLength(2);
    expect(new Set(scanned.bindings.map((binding) => binding.bindingId)).size).toBe(2);
  });

  it("treats timestamp-only rebinding updates as persistence-equivalent", () => {
    const base = mergeTextPageMapWithCandidates(
      createEmptyTextPageMap({
        pageKey: "https://example.com/path",
        pageUrl: "https://example.com/path",
        pageTitle: "Example page",
        now: "2026-03-30T00:00:00.000Z"
      }),
      [
        createCandidate({
          category: "paragraph",
          text: "Alpha",
          normalizedText: "Alpha"
        })
      ],
      {
        pageTitle: "Example page",
        now: "2026-03-30T00:00:01.000Z"
      }
    ).bindings[0]!;

    const timestampOnly = {
      ...base,
      lastSeenAt: "2026-03-30T00:00:02.000Z",
      lastMatchedAt: "2026-03-30T00:00:02.000Z",
      matchStrategy: "incremental-match"
    };

    expect(areTextBindingsEquivalentForPersistence(base, timestampOnly)).toBe(true);
  });

  it("detects meaningful binding order changes for persistence", () => {
    const pageMap = mergeTextPageMapWithCandidates(
      createEmptyTextPageMap({
        pageKey: "https://example.com/path",
        pageUrl: "https://example.com/path",
        pageTitle: "Example page",
        now: "2026-03-30T00:00:00.000Z"
      }),
      [
        createCandidate({
          category: "paragraph",
          text: "Alpha",
          normalizedText: "Alpha",
          locator: {
            preferredSelector: "#alpha",
            ancestorSelector: "main",
            elementSelector: "main > p:nth-of-type(1)",
            nodeIndex: 0,
            tagName: "p",
            attributeName: null,
            classNames: [],
            stableAttributes: {}
          }
        }),
        createCandidate({
          category: "paragraph",
          text: "Beta",
          normalizedText: "Beta",
          locator: {
            preferredSelector: "#beta",
            ancestorSelector: "main",
            elementSelector: "main > p:nth-of-type(2)",
            nodeIndex: 0,
            tagName: "p",
            attributeName: null,
            classNames: [],
            stableAttributes: {}
          }
        })
      ],
      {
        pageTitle: "Example page",
        now: "2026-03-30T00:00:01.000Z"
      }
    );

    expect(
      areTextBindingListsEquivalentForPersistence(pageMap.bindings, [...pageMap.bindings].reverse())
    ).toBe(false);
  });

  it("creates a new binding when locator and text drift too far", () => {
    const pageMap = createEmptyTextPageMap({
      pageKey: "https://example.com/path",
      pageUrl: "https://example.com/path",
      now: "2026-03-29T00:00:00.000Z"
    });

    const firstScan = mergeTextPageMapWithCandidates(
      pageMap,
      [
        createCandidate({
          category: "paragraph",
          text: "Alpha",
          normalizedText: "Alpha",
          locator: {
            preferredSelector: "#alpha",
            ancestorSelector: "main",
            elementSelector: "main > p:nth-of-type(1)",
            nodeIndex: 0,
            tagName: "p",
            attributeName: null,
            classNames: [],
            stableAttributes: {}
          }
        })
      ],
      {
        now: "2026-03-29T00:00:01.000Z"
      }
    );

    const secondScan = mergeTextPageMapWithCandidates(
      firstScan,
      [
        createCandidate({
          category: "button",
          text: "Launch",
          normalizedText: "Launch",
          tagName: "button",
          locator: {
            preferredSelector: "#launch",
            ancestorSelector: "footer",
            elementSelector: "footer > button:nth-of-type(1)",
            nodeIndex: 0,
            tagName: "button",
            attributeName: null,
            classNames: [],
            stableAttributes: {}
          },
          context: {
            pageTitle: "Example page",
            selectorPreview: "#launch",
            ancestorText: "footer"
          }
        })
      ],
      {
        now: "2026-03-29T00:00:02.000Z"
      }
    );

    expect(secondScan.bindings).toHaveLength(2);
    expect(secondScan.bindings[0]?.category).toBe("button");
    expect(secondScan.bindings[0]?.originalText).toBe("Launch");
    expect(secondScan.bindings[0]?.presence).toBe("live");
    expect(secondScan.bindings[1]?.originalText).toBe("Alpha");
    expect(secondScan.bindings[1]?.presence).toBe("stale");
    expect(secondScan.bindings[1]?.staleSince).toBe("2026-03-29T00:00:02.000Z");
  });

  it("keeps missing bindings as stale and reactivates them on a later full scan", () => {
    const pageMap = createEmptyTextPageMap({
      pageKey: "https://example.com/path",
      pageUrl: "https://example.com/path",
      now: "2026-03-30T00:00:00.000Z"
    });

    const firstScan = mergeTextPageMapWithCandidates(
      pageMap,
      [
        createCandidate({
          category: "paragraph",
          text: "Alpha",
          normalizedText: "Alpha",
          locator: {
            preferredSelector: "#alpha",
            ancestorSelector: "main",
            elementSelector: "main > p:nth-of-type(1)",
            nodeIndex: 0,
            tagName: "p",
            attributeName: null,
            classNames: [],
            stableAttributes: {}
          }
        })
      ],
      {
        now: "2026-03-30T00:00:01.000Z"
      }
    );

    const staleScan = mergeTextPageMapWithCandidates(
      firstScan,
      [],
      {
        now: "2026-03-30T00:00:02.000Z"
      }
    );

    expect(staleScan.bindings).toHaveLength(1);
    expect(staleScan.bindings[0]?.presence).toBe("stale");
    expect(staleScan.bindings[0]?.staleSince).toBe("2026-03-30T00:00:02.000Z");

    const reactivatedScan = mergeTextPageMapWithCandidates(
      staleScan,
      [
        createCandidate({
          category: "paragraph",
          text: "Alpha",
          normalizedText: "Alpha",
          locator: {
            preferredSelector: "#alpha",
            ancestorSelector: "main",
            elementSelector: "main > p:nth-of-type(1)",
            nodeIndex: 0,
            tagName: "p",
            attributeName: null,
            classNames: [],
            stableAttributes: {}
          }
        })
      ],
      {
        now: "2026-03-30T00:00:03.000Z"
      }
    );

    expect(reactivatedScan.bindings).toHaveLength(1);
    expect(reactivatedScan.bindings[0]?.bindingId).toBe(firstScan.bindings[0]?.bindingId);
    expect(reactivatedScan.bindings[0]?.presence).toBe("live");
    expect(reactivatedScan.bindings[0]?.staleSince).toBeNull();
  });

  it("resolves display mode correctly", () => {
    expect(resolveDisplayedBindingText({ originalText: "Original", replacementText: "Changed" }, "effective")).toBe("Changed");
    expect(resolveDisplayedBindingText({ originalText: "Original", replacementText: "Changed" }, "original")).toBe("Original");
    expect(resolveDisplayedBindingText({ originalText: "Original", replacementText: null }, "effective")).toBe("Original");
  });

  it("resets replacements and summarizes bindings", () => {
    const pageMap = updateBindingReplacement(
      mergeTextPageMapWithCandidates(
        createEmptyTextPageMap({
          pageKey: "https://example.com/path",
          pageUrl: "https://example.com/path",
          now: "2026-03-29T00:00:00.000Z"
        }),
        [
          createCandidate({
            category: "heading",
            tagName: "h1",
            text: "Heading",
            normalizedText: "Heading"
          }),
          createCandidate({
            category: "paragraph",
            tagName: "p",
            text: "Paragraph",
            normalizedText: "Paragraph",
            locator: {
              preferredSelector: "#paragraph",
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
              selectorPreview: "#paragraph",
              ancestorText: "main"
            }
          })
        ],
        {
          now: "2026-03-29T00:00:01.000Z"
        }
      ),
      buildTextBindingId({
        pageKey: "https://example.com/path",
        category: "heading",
        normalizedText: "Heading",
        preferredSelector: "#target",
        elementSelector: "main > span:nth-of-type(1)",
        ancestorSelector: "main",
        attributeName: null,
        nodeIndex: 0
      }),
      "Changed heading",
      {
        now: "2026-03-29T00:00:02.000Z"
      }
    );

    const summaryBefore = buildTextMapSummary(pageMap);
    const reset = resetPageBindings(pageMap, {
      now: "2026-03-29T00:00:03.000Z"
    });
    const summaryAfter = buildTextMapSummary(reset);

    expect(summaryBefore.total).toBe(2);
    expect(summaryBefore.live).toBe(2);
    expect(summaryBefore.stale).toBe(0);
    expect(summaryBefore.changed).toBe(1);
    expect(summaryBefore.categories.heading).toBe(1);
    expect(summaryAfter.changed).toBe(0);
    expect(reset.bindings.every((binding) => binding.replacementText === null)).toBe(true);
  });

  it("upserts, removes and exports page maps cleanly", () => {
    const envelope = createEmptyTextStorageEnvelope();
    const pageMap = createEmptyTextPageMap({
      pageKey: "https://example.com/path",
      pageUrl: "https://example.com/path",
      now: "2026-03-29T00:00:00.000Z"
    });
    const inserted = upsertPageMapInEnvelope(envelope, pageMap);
    const removed = removePageMapFromEnvelope(inserted, pageMap.pageKey);

    expect(Object.keys(inserted.pages)).toEqual([pageMap.pageKey]);
    expect(removed.pages).toEqual({});
    expect(formatTextMapExportFileName("https://example.com/path", "2026-03-29T00:00:00.000Z")).toBe(
      "lextrace-text-map-example.com-path-2026-03-29T00-00-00-000Z.json"
    );
  });

  it("removes individual bindings without touching the rest of the page map", () => {
    const scanned = mergeTextPageMapWithCandidates(
      createEmptyTextPageMap({
        pageKey: "https://example.com/path",
        pageUrl: "https://example.com/path",
        now: "2026-03-29T00:00:00.000Z"
      }),
      [
        createCandidate({
          category: "heading",
          tagName: "h1",
          text: "Heading",
          normalizedText: "Heading"
        }),
        createCandidate({
          category: "paragraph",
          tagName: "p",
          text: "Paragraph",
          normalizedText: "Paragraph",
          locator: {
            preferredSelector: "#paragraph",
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
            selectorPreview: "#paragraph",
            ancestorText: "main"
          }
        })
      ],
      {
        now: "2026-03-29T00:00:01.000Z"
      }
    );

    const removed = removeBindingFromPageMap(scanned, scanned.bindings[0]!.bindingId, {
      now: "2026-03-29T00:00:02.000Z"
    });

    expect(removed.bindings).toHaveLength(1);
    expect(removed.bindings[0]?.originalText).toBe("Paragraph");
    expect(removed.updatedAt).toBe("2026-03-29T00:00:02.000Z");
  });

  it("builds inline editor geometry anchored to the target rect", () => {
    const geometry = buildInlineTextEditorGeometry({
      targetRect: {
        left: 120,
        top: 480,
        width: 140,
        height: 28
      },
      scrollX: 40,
      scrollY: 600,
      viewportWidth: 1280,
      documentWidth: 1600
    });

    expect(geometry.left).toBe(160);
    expect(geometry.top).toBe(1080);
    expect(geometry.width).toBe(140);
    expect(geometry.height).toBe(28);
  });

  it("builds a union rect from multiple text fragments", () => {
    expect(
      buildTextRectUnion([
        {
          left: 100,
          top: 40,
          width: 80,
          height: 18
        },
        {
          left: 96,
          top: 62,
          width: 110,
          height: 18
        }
      ])
    ).toEqual({
      left: 96,
      top: 40,
      width: 110,
      height: 40
    });
  });

  it("builds single-line control text rects inside the control content box", () => {
    expect(
      buildControlTextLayoutRects({
        elementRect: {
          left: 20,
          top: 40,
          width: 300,
          height: 44
        },
        borderLeft: 1,
        borderTop: 1,
        borderRight: 1,
        borderBottom: 1,
        paddingLeft: 12,
        paddingTop: 6,
        paddingRight: 12,
        paddingBottom: 6,
        lineHeight: 20,
        lineWidths: [108]
      })
    ).toEqual([
      {
        left: 33,
        top: 52,
        width: 108,
        height: 20
      }
    ]);
  });

  it("maps existing bindings onto the best live candidates without inventing new bindings", () => {
    const pageMap = mergeTextPageMapWithCandidates(
      createEmptyTextPageMap({
        pageKey: "https://example.com/path",
        pageUrl: "https://example.com/path",
        now: "2026-03-29T00:00:00.000Z"
      }),
      [
        createCandidate({
          category: "heading",
          tagName: "h1",
          text: "Alpha title",
          normalizedText: "Alpha title",
          locator: {
            preferredSelector: "#alpha-title",
            ancestorSelector: "main",
            elementSelector: "#alpha-title",
            nodeIndex: 0,
            tagName: "h1",
            attributeName: null,
            classNames: [],
            stableAttributes: {
              id: "alpha-title"
            }
          }
        }),
        createCandidate({
          category: "paragraph",
          tagName: "p",
          text: "Alpha paragraph",
          normalizedText: "Alpha paragraph",
          locator: {
            preferredSelector: "#alpha-copy",
            ancestorSelector: "main",
            elementSelector: "#alpha-copy",
            nodeIndex: 0,
            tagName: "p",
            attributeName: null,
            classNames: [],
            stableAttributes: {
              id: "alpha-copy"
            }
          }
        })
      ],
      {
        now: "2026-03-29T00:00:01.000Z"
      }
    );

    const matches = mapBindingsToCandidateIndices(pageMap.bindings, [
      createCandidate({
        category: "paragraph",
        tagName: "p",
        text: "Alpha paragraph",
        normalizedText: "Alpha paragraph",
        locator: {
          preferredSelector: "#alpha-copy",
          ancestorSelector: "main",
          elementSelector: "#alpha-copy",
          nodeIndex: 0,
          tagName: "p",
          attributeName: null,
          classNames: [],
          stableAttributes: {
            id: "alpha-copy"
          }
        }
      }),
      createCandidate({
        category: "heading",
        tagName: "h1",
        text: "Alpha title",
        normalizedText: "Alpha title",
        locator: {
          preferredSelector: "#alpha-title",
          ancestorSelector: "main",
          elementSelector: "#alpha-title",
          nodeIndex: 0,
          tagName: "h1",
          attributeName: null,
          classNames: [],
          stableAttributes: {
            id: "alpha-title"
          }
        }
      }),
      createCandidate({
        category: "button",
        tagName: "button",
        text: "Extra button",
        normalizedText: "Extra button",
        locator: {
          preferredSelector: "#extra-button",
          ancestorSelector: "main",
          elementSelector: "#extra-button",
          nodeIndex: 0,
          tagName: "button",
          attributeName: null,
          classNames: [],
          stableAttributes: {
            id: "extra-button"
          }
        }
      })
    ]);

    expect(matches).toHaveLength(2);
    expect(matches.map((match) => match.bindingId)).toEqual(pageMap.bindings.map((binding) => binding.bindingId));
    expect(matches.map((match) => match.candidateIndex)).toEqual([1, 0]);
  });
});
