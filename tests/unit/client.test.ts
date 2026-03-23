import { describe, expect, it } from "vitest";

import { ProtocolCommandError, formatUserFacingCommandError } from "../../extension/src/shared/client";

describe("client error formatting", () => {
  it("maps unsupported tabs to a clear message", () => {
    expect(
      formatUserFacingCommandError(
        new ProtocolCommandError("unsupported_tab", "nope"),
        "fallback"
      )
    ).toBe("Терминал недоступен: переключитесь на обычную http(s)-страницу.");
  });

  it("maps OpenAI region blocks to a user-facing explanation", () => {
    const error = new ProtocolCommandError(
      "ai_models_catalog_failed",
      'OpenAI HTTP 403: {"error":{"code":"unsupported_country_region_territory","message":"Country, region, or territory not supported","param":null,"type":"request_forbidden"}}'
    );

    expect(formatUserFacingCommandError(error, "fallback")).toBe(
      "OpenAI API недоступен для текущей страны, региона или территории. Сетевые AI-запросы из этого окружения не выполнятся."
    );
  });
});
