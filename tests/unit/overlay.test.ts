import { describe, expect, it } from "vitest";

import {
  clampOverlayGeometryToViewport,
  createOverlayProbeResult,
  getCenteredOverlayPosition,
  getOverlaySupportReason,
  getOverlayUserMessage,
  resizeOverlayGeometry
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

  it("centers overlay geometry inside the viewport", () => {
    expect(
      getCenteredOverlayPosition(
        {
          width: 1600,
          height: 900
        },
        {
          width: 920,
          height: 620
        }
      )
    ).toEqual({
      left: 340,
      top: 140
    });
  });

  it("clamps an offscreen overlay back into the viewport", () => {
    expect(
      clampOverlayGeometryToViewport(
        {
          left: 999,
          top: 777,
          width: 920,
          height: 620
        },
        {
          width: 1600,
          height: 900
        }
      )
    ).toEqual({
      left: 680,
      top: 280,
      width: 920,
      height: 620
    });
  });

  it("resizes overlay geometry from the west edge without crossing minimum width", () => {
    expect(
      resizeOverlayGeometry(
        {
          left: 200,
          top: 80,
          width: 920,
          height: 620
        },
        "w",
        600,
        0,
        {
          width: 1600,
          height: 900
        }
      )
    ).toEqual({
      left: 640,
      top: 80,
      width: 480,
      height: 620
    });
  });

  it("resizes overlay geometry from the south-east corner within the viewport", () => {
    expect(
      resizeOverlayGeometry(
        {
          left: 100,
          top: 60,
          width: 920,
          height: 620
        },
        "se",
        700,
        500,
        {
          width: 1600,
          height: 900
        }
      )
    ).toEqual({
      left: 100,
      top: 60,
      width: 1500,
      height: 840
    });
  });
});
