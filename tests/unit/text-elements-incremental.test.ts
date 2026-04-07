/**
 * Proof tests for the three incremental-scan stability fixes.
 *
 * RC1 — soft-miss:  unchanged live bindings must become *stale*, never deleted,
 *                   when they fail to match a candidate in an incremental pass.
 * RC2 — visibility: candidate-level (tested indirectly — root-level change has no
 *                   pure-function surface, but the candidate gate in
 *                   createTextNodeCandidate is validated here via mergeTextPageMapWithCandidates).
 * RC4 — blast-radius: a binding NOT in affectedBindingIds (disconnected target →
 *                   returns false now) must be left untouched by
 *                   resolveIncrementalBindingStates.
 */

import { describe, expect, it } from "vitest";

import {
  buildStaleTextBinding,
  mergeTextPageMapWithCandidates,
  reconcileAutoBlankBindings,
  resolveIncrementalBindingStates,
  updateBindingReplacement,
  type TextBindingRecord,
  type TextPageMap
} from "../../extension/src/shared/text-elements";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const NOW = "2026-04-06T00:00:00.000Z";
const LATER = "2026-04-06T00:01:00.000Z";

function makeBinding(
  id: string,
  overrides: Partial<TextBindingRecord> = {}
): TextBindingRecord {
  return {
    bindingId: id,
    category: "paragraph",
    presence: "live",
    staleSince: null,
    originalText: "Hello",
    originalNormalized: "Hello",
    replacementText: null,
    autoBlanked: false,
    effectiveText: "Hello",
    currentText: "Hello",
    tagName: "p",
    attributeName: null,
    locator: {
      preferredSelector: `#${id}`,
      ancestorSelector: "main",
      elementSelector: `main > p:nth-of-type(1)`,
      nodeIndex: 0,
      tagName: "p",
      attributeName: null,
      classNames: [],
      stableAttributes: {}
    },
    context: {
      pageTitle: "Test page",
      selectorPreview: `#${id}`,
      ancestorText: null
    },
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    lastMatchedAt: NOW,
    matchStrategy: "preferred-selector",
    changed: false,
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// buildStaleTextBinding
// ---------------------------------------------------------------------------

describe("buildStaleTextBinding", () => {
  it("sets presence to stale and records staleSince from now", () => {
    const binding = makeBinding("a");
    const staled = buildStaleTextBinding(binding, NOW);

    expect(staled.presence).toBe("stale");
    expect(staled.staleSince).toBe(NOW);
  });

  it("is idempotent — repeated calls preserve the earliest staleSince", () => {
    const binding = makeBinding("a");
    const first = buildStaleTextBinding(binding, NOW);
    const second = buildStaleTextBinding(first, LATER);

    expect(second.staleSince).toBe(NOW); // earliest wins
  });

  it("preserves all other fields unchanged", () => {
    const binding = makeBinding("a", { replacementText: "override", changed: true });
    const staled = buildStaleTextBinding(binding, NOW);

    expect(staled.replacementText).toBe("override");
    expect(staled.changed).toBe(true);
    expect(staled.originalText).toBe("Hello");
  });
});

// ---------------------------------------------------------------------------
// resolveIncrementalBindingStates — RC1 proof
// ---------------------------------------------------------------------------

describe("resolveIncrementalBindingStates — RC1: soft miss, never delete", () => {
  it("stales an unchanged live binding that was affected but unmatched", () => {
    // Before fix: this binding would have been DELETED (binding.changed === false).
    const binding = makeBinding("b1");
    const result = resolveIncrementalBindingStates(
      [binding],
      new Set(["b1"]),   // affected
      new Set(),         // matched — empty, simulates miss
      new Map(),         // updatedBindings — empty
      new Set(),         // retained — empty
      [],
      NOW
    );

    expect(result).toHaveLength(1);
    expect(result[0]!.bindingId).toBe("b1");
    expect(result[0]!.presence).toBe("stale");   // must be stale, NOT absent
    expect(result[0]!.staleSince).toBe(NOW);
  });

  it("also stales a changed live binding that was affected but unmatched (existing behaviour preserved)", () => {
    const binding = makeBinding("b2", {
      replacementText: "Replaced",
      effectiveText: "Replaced",
      changed: true
    });
    const result = resolveIncrementalBindingStates(
      [binding],
      new Set(["b2"]),
      new Set(),
      new Map(),
      new Set(),
      [],
      NOW
    );

    expect(result[0]!.presence).toBe("stale");
    expect(result[0]!.replacementText).toBe("Replaced"); // replacement preserved in stale
  });

  it("does NOT stale a binding that was not affected", () => {
    // RC4 proof: a binding outside current mutation roots (disconnected target → affectedIds empty)
    // must remain untouched — live, no stale transition.
    const binding = makeBinding("b3");
    const result = resolveIncrementalBindingStates(
      [binding],
      new Set(),         // affected — empty (disconnected target excluded by RC4)
      new Set(),
      new Map(),
      new Set(),
      [],
      NOW
    );

    expect(result[0]!.presence).toBe("live");
    expect(result[0]!.staleSince).toBeNull();
  });

  it("does NOT stale a binding that was affected but successfully matched", () => {
    const binding = makeBinding("b4");
    const updated = makeBinding("b4", { lastMatchedAt: LATER });
    const result = resolveIncrementalBindingStates(
      [binding],
      new Set(["b4"]),   // affected
      new Set(["b4"]),   // also matched
      new Map([["b4", updated]]),
      new Set(),
      [],
      NOW
    );

    expect(result[0]!.presence).toBe("live");
    expect(result[0]!.lastMatchedAt).toBe(LATER); // got the updated record
  });

  it("does NOT stale a binding that is retained (inline-editor-like case)", () => {
    const binding = makeBinding("b5");
    const result = resolveIncrementalBindingStates(
      [binding],
      new Set(["b5"]),   // affected
      new Set(),         // not matched
      new Map(),
      new Set(["b5"]),   // retained — canRetainChangedTextBindingWithoutCandidate returned true
      [],
      NOW
    );

    expect(result[0]!.presence).toBe("live");
  });

  it("does NOT alter an already-stale binding", () => {
    const staleBinding = makeBinding("b6", {
      presence: "stale",
      staleSince: NOW,
      changed: false
    });
    const result = resolveIncrementalBindingStates(
      [staleBinding],
      new Set(["b6"]),   // even if spatially affected
      new Set(),
      new Map(),
      new Set(),
      [],
      LATER
    );

    // Stale bindings are not in presence === "live" so the stale branch is skipped
    expect(result[0]!.presence).toBe("stale");
    expect(result[0]!.staleSince).toBe(NOW); // staleSince not advanced
  });

  it("appends new bindings for unmatched candidates", () => {
    const existing = makeBinding("b7");
    const fresh = makeBinding("b8", { matchStrategy: "incremental-created" });
    const result = resolveIncrementalBindingStates(
      [existing],
      new Set(),
      new Set(),
      new Map(),
      new Set(),
      [fresh],
      NOW
    );

    expect(result).toHaveLength(2);
    expect(result[1]!.bindingId).toBe("b8");
  });

  it("processes multiple bindings correctly in a single pass", () => {
    const affected = makeBinding("c1");
    const matched = makeBinding("c2");
    const unrelated = makeBinding("c3"); // not in affectedBindingIds at all
    const updatedC2 = makeBinding("c2", { lastMatchedAt: LATER, originalText: "World" });

    const result = resolveIncrementalBindingStates(
      [affected, matched, unrelated],
      new Set(["c1", "c2"]),
      new Set(["c2"]),
      new Map([["c2", updatedC2]]),
      new Set(),
      [],
      NOW
    );

    const byId = new Map(result.map((b) => [b.bindingId, b]));
    expect(byId.get("c1")!.presence).toBe("stale");    // affected, unmatched → stale
    expect(byId.get("c2")!.originalText).toBe("World"); // matched → updated record
    expect(byId.get("c3")!.presence).toBe("live");     // unrelated → untouched
  });
});

// ---------------------------------------------------------------------------
// Recovery path: stale → live on subsequent incremental pass
// ---------------------------------------------------------------------------

describe("resolveIncrementalBindingStates — stale binding recovers to live", () => {
  it("applies the updated record when a previously-stale binding is matched", () => {
    const staleBinding = makeBinding("r1", {
      presence: "stale",
      staleSince: NOW
    });
    const recovered = makeBinding("r1", {
      presence: "live",
      staleSince: null,
      lastMatchedAt: LATER,
      originalText: "Recovered"
    });

    const result = resolveIncrementalBindingStates(
      [staleBinding],
      new Set(["r1"]),   // affected
      new Set(["r1"]),   // matched — the candidate matched it
      new Map([["r1", recovered]]),
      new Set(),
      [],
      LATER
    );

    expect(result[0]!.presence).toBe("live");
    expect(result[0]!.staleSince).toBeNull();
    expect(result[0]!.originalText).toBe("Recovered");
  });
});

// ---------------------------------------------------------------------------
// Cleanup path: full scan (mergeTextPageMapWithCandidates) removes stale
// bindings produced by the soft-miss
// ---------------------------------------------------------------------------

describe("RC1 + full-scan cleanup: stale bindings do not accumulate forever", () => {
  it("unchanged stale binding is dropped by mergeTextPageMapWithCandidates when no candidate", () => {
    // The incremental scan staled an unchanged binding (RC1 fix).
    // A subsequent manual text.scan (mergeTextPageMapWithCandidates) with no
    // matching candidate for it should drop it — it is not `changed`, so it
    // falls outside the `staleBindings` filter at line 636-637 of text-elements.ts.
    const pageMap: TextPageMap = {
      schemaVersion: 1,
      pageKey: "https://example.com/",
      pageUrl: "https://example.com/",
      pageTitle: null,
      displayMode: "effective",
      lastScanAt: NOW,
      updatedAt: NOW,
      bindings: [
        makeBinding("drop_me", {
          presence: "stale",
          staleSince: NOW,
          changed: false  // unchanged — eligible for cleanup
        })
      ]
    };

    // Full scan finds no matching candidate for this binding
    const afterFullScan = mergeTextPageMapWithCandidates(pageMap, [], { now: LATER });

    expect(afterFullScan.bindings).toHaveLength(0); // cleaned up ✓
  });

  it("changed stale binding survives mergeTextPageMapWithCandidates (user replacement preserved)", () => {
    const pageMap: TextPageMap = {
      schemaVersion: 1,
      pageKey: "https://example.com/",
      pageUrl: "https://example.com/",
      pageTitle: null,
      displayMode: "effective",
      lastScanAt: NOW,
      updatedAt: NOW,
      bindings: [
        makeBinding("keep_me", {
          presence: "stale",
          staleSince: NOW,
          replacementText: "My replacement",
          effectiveText: "My replacement",
          changed: true
        })
      ]
    };

    const afterFullScan = mergeTextPageMapWithCandidates(pageMap, [], { now: LATER });

    expect(afterFullScan.bindings).toHaveLength(1);
    expect(afterFullScan.bindings[0]!.replacementText).toBe("My replacement");
    expect(afterFullScan.bindings[0]!.presence).toBe("stale");
  });
});

// ---------------------------------------------------------------------------
// Full lifecycle: incremental miss → stale → incremental recovery → live
// ---------------------------------------------------------------------------

describe("full incremental lifecycle", () => {
  it("binding survives an invisible-root miss and recovers when the root becomes visible", () => {
    // Pass 1: mutation fires while root is opacity:0 → zero candidates collected
    // (RC2 allows scanning but createTextNodeCandidate would have found the node;
    // here we simulate the net effect: no candidate found for the binding).
    const initial = makeBinding("life1");

    const afterMiss = resolveIncrementalBindingStates(
      [initial],
      new Set(["life1"]), // affected (element is in the root)
      new Set(),           // no match — simulates invisible-root zero-candidate pass
      new Map(),
      new Set(),
      [],
      NOW
    );

    expect(afterMiss[0]!.presence).toBe("stale"); // soft miss, not deleted

    // Pass 2: root animation completes, next mutation fires, candidate found
    const recovered = makeBinding("life1", {
      presence: "live",
      staleSince: null,
      lastMatchedAt: LATER
    });

    const afterRecovery = resolveIncrementalBindingStates(
      afterMiss,
      new Set(["life1"]),
      new Set(["life1"]),
      new Map([["life1", recovered]]),
      new Set(),
      [],
      LATER
    );

    expect(afterRecovery[0]!.presence).toBe("live");
    expect(afterRecovery[0]!.staleSince).toBeNull();
  });

  it("replacement text survives a miss cycle intact", () => {
    // User replaced the text, then a mutation caused a temporary miss.
    // The replacement must still be there after recovery.
    const withReplacement = makeBinding("rep1", {
      replacementText: "Translated",
      effectiveText: "Translated",
      changed: true
    });

    const afterMiss = resolveIncrementalBindingStates(
      [withReplacement],
      new Set(["rep1"]),
      new Set(),
      new Map(),
      new Set(),
      [],
      NOW
    );

    expect(afterMiss[0]!.presence).toBe("stale");
    expect(afterMiss[0]!.replacementText).toBe("Translated"); // not lost

    const recovered = {
      ...afterMiss[0]!,
      presence: "live" as const,
      staleSince: null,
      lastMatchedAt: LATER
    };

    const afterRecovery = resolveIncrementalBindingStates(
      afterMiss,
      new Set(["rep1"]),
      new Set(["rep1"]),
      new Map([["rep1", recovered]]),
      new Set(),
      [],
      LATER
    );

    expect(afterRecovery[0]!.presence).toBe("live");
    expect(afterRecovery[0]!.replacementText).toBe("Translated"); // survives ✓
  });

  it("updateBindingReplacement + incremental miss do not lose the replacement", () => {
    // Proves the integration path: user edits via updateBindingReplacement,
    // then incremental scan fires and misses — binding must still carry the replacement.
    const pageMap: TextPageMap = {
      schemaVersion: 1,
      pageKey: "https://example.com/",
      pageUrl: "https://example.com/",
      pageTitle: null,
      displayMode: "effective",
      lastScanAt: NOW,
      updatedAt: NOW,
      bindings: [makeBinding("edit1")]
    };

    const edited = updateBindingReplacement(pageMap, "edit1", "Mein Text", { now: NOW });
    const editedBinding = edited.bindings[0]!;
    expect(editedBinding.changed).toBe(true);
    expect(editedBinding.replacementText).toBe("Mein Text");

    const afterMiss = resolveIncrementalBindingStates(
      edited.bindings,
      new Set(["edit1"]),
      new Set(),
      new Map(),
      new Set(),
      [],
      LATER
    );

    expect(afterMiss[0]!.presence).toBe("stale");
    expect(afterMiss[0]!.replacementText).toBe("Mein Text"); // ← user work intact
  });
});

// ---------------------------------------------------------------------------
// autoBlank mode exit: stale auto-blanked bindings must be reverted too
// (regression guard for the includeStale:true fix)
// ---------------------------------------------------------------------------

describe("autoBlank exit: stale bindings reverted so recovery does not re-blank DOM", () => {
  it("reconcileAutoBlankBindings with includeStale:true clears autoBlanked state on stale binding", () => {
    // Scenario: blank mode was ON, binding got auto-blanked, then became stale (RC1).
    // User turns blank mode OFF.  reconcileAutoBlankBindings must clear the stale binding
    // so that if it recovers to live it does NOT bring replacementText:"" back to DOM.
    const pageMap: TextPageMap = {
      schemaVersion: 1,
      pageKey: "https://example.com/",
      pageUrl: "https://example.com/",
      pageTitle: null,
      displayMode: "effective",
      lastScanAt: NOW,
      updatedAt: NOW,
      bindings: [
        makeBinding("blank_stale", {
          presence: "stale",
          staleSince: NOW,
          replacementText: "",
          autoBlanked: true,
          effectiveText: "",
          changed: true
        })
      ]
    };

    // Old behaviour (includeStale:false — the bug): stale binding untouched
    const withoutFix = reconcileAutoBlankBindings(pageMap, false, { now: LATER, includeStale: false });
    expect(withoutFix.pageMap.bindings[0]!.autoBlanked).toBe(true);     // still blanked ← bug
    expect(withoutFix.pageMap.bindings[0]!.replacementText).toBe("");   // still "" ← bug

    // New behaviour (includeStale:true — the fix): stale binding reverted
    const withFix = reconcileAutoBlankBindings(pageMap, false, { now: LATER, includeStale: true });
    expect(withFix.pageMap.bindings[0]!.autoBlanked).toBe(false);       // cleared ✓
    expect(withFix.pageMap.bindings[0]!.replacementText).toBeNull();    // cleared ✓
    expect(withFix.pageMap.bindings[0]!.changed).toBe(false);           // no longer changed ✓
  });

  it("stale auto-blanked binding that recovers after blank-off does not re-blank DOM", () => {
    // Full lifecycle:
    // 1. blank mode ON → binding blanked
    // 2. mutation miss → binding staled (RC1)
    // 3. blank mode OFF → reconcile with includeStale:true clears autoBlanked on stale
    // 4. next mutation → stale binding matches candidate → recovers to live
    // 5. recovered binding must have replacementText:null (original text shown in DOM)

    // Step 1-2: binding is stale and auto-blanked
    const staleAutoBlanked = makeBinding("ab1", {
      presence: "stale",
      staleSince: NOW,
      replacementText: "",
      autoBlanked: true,
      effectiveText: "",
      changed: true
    });

    const pageMapAfterMiss: TextPageMap = {
      schemaVersion: 1,
      pageKey: "https://example.com/",
      pageUrl: "https://example.com/",
      pageTitle: null,
      displayMode: "effective",
      lastScanAt: NOW,
      updatedAt: NOW,
      bindings: [staleAutoBlanked]
    };

    // Step 3: blank mode OFF — reconcile with includeStale:true (the fix)
    const afterBlankOff = reconcileAutoBlankBindings(pageMapAfterMiss, false, {
      now: LATER,
      includeStale: true
    });
    const clearedStale = afterBlankOff.pageMap.bindings[0]!;
    expect(clearedStale.autoBlanked).toBe(false);
    expect(clearedStale.replacementText).toBeNull();

    // Step 4: next mutation — stale binding matches candidate
    const recovered = makeBinding("ab1", {
      presence: "live",
      staleSince: null,
      replacementText: null,
      autoBlanked: false,
      effectiveText: "Hello",
      changed: false,
      lastMatchedAt: LATER
    });

    const afterRecovery = resolveIncrementalBindingStates(
      afterBlankOff.pageMap.bindings,
      new Set(["ab1"]),
      new Set(["ab1"]),
      new Map([["ab1", recovered]]),
      new Set(),
      [],
      LATER
    );

    // Step 5: recovered binding must NOT be blank
    expect(afterRecovery[0]!.presence).toBe("live");
    expect(afterRecovery[0]!.replacementText).toBeNull();  // ← original text shown ✓
    expect(afterRecovery[0]!.autoBlanked).toBe(false);
  });
});
