import { describe, expect, it } from "vitest";

import { COMMANDS } from "../../extension/src/shared/constants";
import {
  ProtocolResponseSchema,
  createEnvelope,
  createErrorResponse,
  validateEnvelope,
  validateEnvelopePayload
} from "../../extension/src/shared/protocol";

describe("protocol validation", () => {
  it("accepts valid protocol envelope and payload", () => {
    const envelope = createEnvelope(
      COMMANDS.configPatch,
      "popup",
      "background",
      {
        scope: "session",
        patch: {
          ui: {
            popupActiveTab: "config"
          }
        }
      }
    );

    const parsedEnvelope = validateEnvelope(envelope);
    const parsedPayload = validateEnvelopePayload(parsedEnvelope);

    expect(parsedEnvelope.action).toBe(COMMANDS.configPatch);
    expect(parsedPayload).toMatchObject({
      scope: "session"
    });
  });

  it("rejects unsupported actions", () => {
    expect(() =>
      validateEnvelope({
        ...createEnvelope(COMMANDS.ping, "tests", "background"),
        action: "unknown.command"
      })
    ).toThrow(/Unsupported action/);
  });

  it("accepts overlay probe payloads and structured overlay errors", () => {
    const envelope = createEnvelope(COMMANDS.overlayProbe, "tests", "background", {
      tabId: 77,
      expectedUrl: "https://example.com/slow"
    });

    expect(validateEnvelopePayload(validateEnvelope(envelope))).toMatchObject({
      tabId: 77,
      expectedUrl: "https://example.com/slow"
    });

    const response = ProtocolResponseSchema.parse(
      createErrorResponse("req-1", "content_not_ready", "Reload the page first.")
    );

    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe("content_not_ready");
  });
});
