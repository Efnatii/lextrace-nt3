import { describe, expect, it } from "vitest";

import { normalizePageKey } from "../../extension/src/shared/page";

describe("page key normalization", () => {
  it("ignores query and hash while preserving origin and pathname", () => {
    expect(normalizePageKey("https://Example.com:443/path/to/page/?x=1#anchor")).toBe(
      "https://example.com/path/to/page"
    );
  });

  it("returns null for unsupported protocols", () => {
    expect(normalizePageKey("chrome-extension://abc/popup.html")).toBeNull();
    expect(normalizePageKey("edge://extensions")).toBeNull();
  });
});
