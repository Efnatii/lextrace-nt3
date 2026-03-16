import { describe, expect, it } from "vitest";

import {
  buildAllowedModelSections,
  buildModelSelectOptions,
  formatAiModelSummaryPrice,
  formatAiModelTooltip,
  formatAllowedModelsDisplay,
  isAiModelTierAvailable,
  sortAiModelCatalog
} from "../../extension/src/shared/ai-model-catalog";
import type { AiAllowedModelRule, AiModelCatalogItem } from "../../extension/src/shared/ai";

const modelCatalog: AiModelCatalogItem[] = [
  {
    id: "gpt-4.1",
    created: 1744316542,
    ownedBy: "system",
    family: "gpt-4.1",
    matchedBy: {
      standard: "exact",
      flex: "exact",
      priority: "exact"
    },
    pricing: {
      sourceUrl: "https://developers.openai.com/api/docs/pricing",
      standard: {
        tier: "standard",
        pricingModelId: "gpt-4.1",
        inputUsdPer1M: 2,
        cachedInputUsdPer1M: 0.5,
        outputUsdPer1M: 8,
        trainingUsdPer1M: null,
        trainingUsdPerHour: null,
        summaryUsdPer1M: 10
      },
      flex: {
        tier: "flex",
        pricingModelId: "gpt-4.1",
        inputUsdPer1M: null,
        cachedInputUsdPer1M: null,
        outputUsdPer1M: null,
        trainingUsdPer1M: null,
        trainingUsdPerHour: null,
        summaryUsdPer1M: null
      },
      priority: {
        tier: "priority",
        pricingModelId: "gpt-4.1",
        inputUsdPer1M: 3.5,
        cachedInputUsdPer1M: 0.875,
        outputUsdPer1M: 14,
        trainingUsdPer1M: null,
        trainingUsdPerHour: null,
        summaryUsdPer1M: 17.5
      }
    }
  },
  {
    id: "gpt-5-mini",
    created: 1754425928,
    ownedBy: "system",
    family: "gpt-5-mini",
    matchedBy: {
      standard: "exact",
      flex: "exact",
      priority: "exact"
    },
    pricing: {
      sourceUrl: "https://developers.openai.com/api/docs/pricing",
      standard: {
        tier: "standard",
        pricingModelId: "gpt-5-mini",
        inputUsdPer1M: 0.25,
        cachedInputUsdPer1M: 0.025,
        outputUsdPer1M: 2,
        trainingUsdPer1M: null,
        trainingUsdPerHour: null,
        summaryUsdPer1M: 2.25
      },
      flex: {
        tier: "flex",
        pricingModelId: "gpt-5-mini",
        inputUsdPer1M: 0.125,
        cachedInputUsdPer1M: 0.0125,
        outputUsdPer1M: 1,
        trainingUsdPer1M: null,
        trainingUsdPerHour: null,
        summaryUsdPer1M: 1.125
      },
      priority: {
        tier: "priority",
        pricingModelId: "gpt-5-mini",
        inputUsdPer1M: 0.45,
        cachedInputUsdPer1M: 0.045,
        outputUsdPer1M: 3.6,
        trainingUsdPer1M: null,
        trainingUsdPerHour: null,
        summaryUsdPer1M: 4.05
      }
    }
  },
  {
    id: "gpt-5-chat-latest",
    created: 1754073306,
    ownedBy: "system",
    family: "gpt-5",
    matchedBy: {
      standard: "family",
      flex: "family",
      priority: "family"
    },
    pricing: {
      sourceUrl: "https://developers.openai.com/api/docs/pricing",
      standard: {
        tier: "standard",
        pricingModelId: "gpt-5",
        inputUsdPer1M: 1.25,
        cachedInputUsdPer1M: 0.125,
        outputUsdPer1M: 10,
        trainingUsdPer1M: null,
        trainingUsdPerHour: null,
        summaryUsdPer1M: 11.25
      },
      flex: {
        tier: "flex",
        pricingModelId: "gpt-5",
        inputUsdPer1M: 0.625,
        cachedInputUsdPer1M: 0.0625,
        outputUsdPer1M: 5,
        trainingUsdPer1M: null,
        trainingUsdPerHour: null,
        summaryUsdPer1M: 5.625
      },
      priority: {
        tier: "priority",
        pricingModelId: "gpt-5",
        inputUsdPer1M: 2.5,
        cachedInputUsdPer1M: 0.25,
        outputUsdPer1M: 20,
        trainingUsdPer1M: null,
        trainingUsdPerHour: null,
        summaryUsdPer1M: 22.5
      }
    }
  }
];

describe("AI model catalog helpers", () => {
  it("sorts the catalog by tier-specific price and age", () => {
    expect(sortAiModelCatalog(modelCatalog, "price-asc", "standard").map((item) => item.id)).toEqual([
      "gpt-5-mini",
      "gpt-4.1",
      "gpt-5-chat-latest"
    ]);

    expect(sortAiModelCatalog(modelCatalog, "price-desc", "priority").map((item) => item.id)).toEqual([
      "gpt-5-chat-latest",
      "gpt-4.1",
      "gpt-5-mini"
    ]);

    expect(sortAiModelCatalog(modelCatalog, "newest", "standard").map((item) => item.id)).toEqual([
      "gpt-5-mini",
      "gpt-5-chat-latest",
      "gpt-4.1"
    ]);
  });

  it("formats summary price and tooltip text for the selected tier", () => {
    expect(formatAiModelSummaryPrice(modelCatalog[0], "priority")).toBe("Σ $17.5 / 1M");
    expect(formatAiModelTooltip(modelCatalog[2], "flex")).toContain("Активный раздел: flex");
    expect(formatAiModelTooltip(modelCatalog[2], "flex")).toContain("[priority]");
    expect(formatAiModelTooltip(modelCatalog[2], "flex")).toContain("совпадение: gpt-5 (family)");
    expect(
      formatAiModelTooltip(modelCatalog[1], "standard", {
        model: "gpt-5-mini",
        observedAt: "2026-03-15T12:00:00.000Z",
        lastResolvedServiceTier: "flex",
        serverLimitRequests: 5000,
        serverLimitTokens: 2000000,
        serverRemainingRequests: 120,
        serverRemainingTokens: 64000,
        serverResetRequests: "10s",
        serverResetTokens: "5s"
      })
    ).toContain("[budget]");
  });

  it("detects tier availability from pricing and catalog match", () => {
    expect(isAiModelTierAvailable(modelCatalog[0], "standard")).toBe(true);
    expect(isAiModelTierAvailable(modelCatalog[0], "flex")).toBe(false);
    expect(isAiModelTierAvailable(modelCatalog[1], "flex")).toBe(true);
  });

  it("builds model select options from the allowed list with tier-aware prices", () => {
    const allowedRules: AiAllowedModelRule[] = [{ model: "gpt-5-mini", tier: "flex" }];

    expect(
      buildModelSelectOptions(modelCatalog, allowedRules, "gpt-5-mini", "flex").map(
        (option) => option.value
      )
    ).toEqual(["gpt-5-mini"]);

    const options = buildModelSelectOptions(modelCatalog, allowedRules, "gpt-4.1", "priority");
    expect(options.map((option) => option.value)).toEqual([
      "gpt-4.1",
      "gpt-5-chat-latest",
      "gpt-5-mini"
    ]);
    expect(options[2]?.label).toContain("$4.05");
  });

  it("formats the allowed-models JSON preview", () => {
    expect(formatAllowedModelsDisplay([])).toBe("[]");
    expect(formatAllowedModelsDisplay([{ model: "gpt-5", tier: "standard" }])).toBe(
      '[{"model":"gpt-5","tier":"standard"}]'
    );
    expect(
      formatAllowedModelsDisplay([
        { model: "gpt-5", tier: "standard" },
        { model: "gpt-4.1", tier: "priority" },
        { model: "o4-mini", tier: "flex" }
      ])
    ).toBe(
      '[{"model":"gpt-5","tier":"standard"}, {"model":"gpt-4.1","tier":"priority"}, +1]'
    );
  });

  it("builds tier sections for the single-select editor from allowed model rules", () => {
    const sections = buildAllowedModelSections(
      modelCatalog,
      [
        { model: "gpt-5-mini", tier: "flex" },
        { model: "gpt-4.1", tier: "priority" }
      ],
      {
        "gpt-5-mini": {
          model: "gpt-5-mini",
          observedAt: "2026-03-15T12:00:00.000Z",
          lastResolvedServiceTier: "flex",
          serverLimitRequests: 5000,
          serverLimitTokens: 2000000,
          serverRemainingRequests: 120,
          serverRemainingTokens: 64000,
          serverResetRequests: "10s",
          serverResetTokens: "5s"
        }
      }
    );

    expect(sections.standard).toEqual([]);
    expect(sections.flex[0]?.rule).toEqual({ model: "gpt-5-mini", tier: "flex" });
    expect(sections.flex[0]?.summaryPrice).toContain("$1.13");
    expect(sections.flex[0]?.tooltip).toContain("RPM: 120/5000");
    expect(sections.priority[0]?.rule).toEqual({ model: "gpt-4.1", tier: "priority" });
  });
});
