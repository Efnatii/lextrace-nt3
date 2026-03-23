import { describe, expect, it } from "vitest";

import {
  createOverlayProbeResult,
  getOverlaySupportReason,
  getOverlayUserMessage
} from "../../extension/src/shared/overlay";

describe("overlay target support", () => {
  it("accepts regular http(s) pages and rejects unsupported urls", () => {
    expect(getOverlaySupportReason("https://example.com/")).toBeNull();
    expect(getOverlaySupportReason("http://example.com/path")).toBeNull();
    expect(getOverlaySupportReason("edge://extensions")).toBe("unsupported_tab");
    expect(getOverlaySupportReason("chrome-extension://abc/popup.html")).toBe("unsupported_tab");
    expect(getOverlaySupportReason("https://example.com/manual.pdf")).toBe("unsupported_tab");
  });

  it("preserves eligibility for content-not-ready states", () => {
    const result = createOverlayProbeResult(11, "https://example.com/", false, "content_not_ready");

    expect(result.eligible).toBe(true);
    expect(result.ready).toBe(false);
    expect(result.reason).toBe("content_not_ready");
    expect(getOverlayUserMessage(result)).toMatch(/перезагруз/i);
  });
});
