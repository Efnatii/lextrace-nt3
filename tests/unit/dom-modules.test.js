// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { classifyBlocks } from "../../src/content/dom-classifier.js";
import { DomApplier } from "../../src/content/dom-applier.js";
import { resolveAnchor, scanTextBlocks } from "../../src/content/dom-indexer.js";
import { VIEW_MODE } from "../../src/shared/constants.js";

describe("DOM modules", () => {
  it("indexes text blocks in stable order and applies views", () => {
    document.body.innerHTML = `
      <div>
        <h1>Header</h1>
        <p>First paragraph text.</p>
        <p><span>Inline part</span> end.</p>
      </div>
    `;

    const blocks = classifyBlocks(scanTextBlocks());
    expect(blocks.length).toBeGreaterThanOrEqual(3);
    expect(blocks[0].text).toContain("Header");

    const applier = new DomApplier();
    applier.prime(blocks);

    const first = blocks[0];
    applier.applyBatch({
      batchId: "b1",
      translations: [
        {
          blockId: first.blockId,
          translatedText: "Translated header"
        }
      ]
    });

    applier.switchView(VIEW_MODE.TRANSLATION);
    expect(document.body.textContent).toContain("Translated header");

    applier.switchView(VIEW_MODE.ORIGINAL);
    expect(document.body.textContent).toContain("Header");

    applier.switchView(VIEW_MODE.DIFF);
    expect(document.body.textContent).toContain("Translated header");
  });

  it("resolves anchor by parent id and hash when path is stale", () => {
    document.body.innerHTML = `
      <div id="root">
        <p>Stable anchor text.</p>
      </div>
    `;

    const [block] = classifyBlocks(scanTextBlocks());
    expect(block).toBeTruthy();

    const firstParent = document.querySelector("p");
    const inserted = document.createElement("span");
    inserted.textContent = "new sibling";
    firstParent.prepend(inserted);

    const resolved = resolveAnchor(block.anchor);
    expect(resolved).toBeTruthy();
    expect(String(resolved.nodeValue)).toContain("Stable anchor text.");
  });
});
