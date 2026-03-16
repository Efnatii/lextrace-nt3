import type {
  AiAllowedModelRule,
  AiModelCatalogItem,
  AiModelBudgetMap,
  AiModelBudgetState,
  AiModelPricingTier,
  AiServiceTier
} from "./ai";

export type ModelCatalogSort =
  | "name-asc"
  | "name-desc"
  | "availability"
  | "price-asc"
  | "price-desc"
  | "input-asc"
  | "input-desc"
  | "output-asc"
  | "output-desc"
  | "newest"
  | "oldest";

export type AllowedModelSectionItem = {
  rule: AiAllowedModelRule;
  model: AiModelCatalogItem | null;
  summaryPrice: string;
  tooltip: string;
};

export function getAiModelPricingTier(model: AiModelCatalogItem, serviceTier: AiServiceTier): AiModelPricingTier {
  return model.pricing[serviceTier];
}

export function isAiModelTierAvailable(model: AiModelCatalogItem, serviceTier: AiServiceTier): boolean {
  const pricing = getAiModelPricingTier(model, serviceTier);
  return pricing.summaryUsdPer1M !== null && model.matchedBy[serviceTier] !== "unavailable";
}

export function formatAiModelSummaryPrice(model: AiModelCatalogItem, serviceTier: AiServiceTier): string {
  const pricing = getAiModelPricingTier(model, serviceTier);
  if (pricing.summaryUsdPer1M === null) {
    return "Σ н/д";
  }

  return `Σ $${formatPrice(pricing.summaryUsdPer1M)} / 1M`;
}

export function formatAiModelTooltip(
  model: AiModelCatalogItem,
  activeTier: AiServiceTier,
  budgetState?: AiModelBudgetState | null
): string {
  const createdAt =
    typeof model.created === "number"
      ? new Date(model.created * 1000).toISOString().slice(0, 10)
      : "н/д";

  const tierSections: AiServiceTier[] = ["standard", "flex", "priority"];
  const lines = [
    `Модель: ${model.id}`,
    `Семейство: ${model.family}`,
    `Владелец: ${model.ownedBy ?? "н/д"}`,
    `Создана: ${createdAt}`,
    `Активный раздел: ${activeTier}`,
    ""
  ];

  for (const tier of tierSections) {
    const pricing = getAiModelPricingTier(model, tier);
    const matchedBy = model.matchedBy[tier];
    const mainLine = [
      `[${tier}]`,
      `совпадение: ${pricing.pricingModelId ?? "н/д"} (${matchedBy})`,
      `Σ ${formatOptionalPrice(pricing.summaryUsdPer1M, "/ 1M")}`,
      `in ${formatOptionalPrice(pricing.inputUsdPer1M, "/ 1M")}`,
      `cache ${formatOptionalPrice(pricing.cachedInputUsdPer1M, "/ 1M")}`,
      `out ${formatOptionalPrice(pricing.outputUsdPer1M, "/ 1M")}`
    ].join(" | ");

    lines.push(mainLine);
    if (pricing.trainingUsdPer1M !== null || pricing.trainingUsdPerHour !== null) {
      lines.push(
        `training: ${formatOptionalPrice(pricing.trainingUsdPer1M, "/ 1M")} | hourly: ${formatOptionalPrice(pricing.trainingUsdPerHour, "/ час")}`
      );
    }
  }

  lines.push("");
  lines.push("[budget]");
  if (budgetState) {
    lines.push(
      `RPM: ${formatBudgetPair(budgetState.serverRemainingRequests, budgetState.serverLimitRequests)}`,
      `TPM: ${formatBudgetPair(budgetState.serverRemainingTokens, budgetState.serverLimitTokens)}`,
      `Reset RPM: ${budgetState.serverResetRequests ?? "н/д"}`,
      `Reset TPM: ${budgetState.serverResetTokens ?? "н/д"}`,
      `Observed: ${budgetState.observedAt ?? "н/д"}`,
      `Served: ${budgetState.lastResolvedServiceTier ?? "н/д"}`,
      ""
    );
  } else {
    lines.push("Телеметрия лимитов пока не получена.", "");
  }

  lines.push(`Источник: ${model.pricing.sourceUrl}`);
  return lines.join("\n");
}

export function formatAiModelCompactTooltip(
  model: AiModelCatalogItem,
  tier: AiServiceTier,
  budgetState?: AiModelBudgetState | null
): string {
  const pricing = getAiModelPricingTier(model, tier);
  const lines = [
    model.id,
    `[${tier}] Σ ${formatOptionalPrice(pricing.summaryUsdPer1M, "/ 1M")} | in ${formatOptionalPrice(pricing.inputUsdPer1M, "/ 1M")} | out ${formatOptionalPrice(pricing.outputUsdPer1M, "/ 1M")}`
  ];

  if (budgetState) {
    lines.push(
      `RPM ${formatBudgetPair(budgetState.serverRemainingRequests, budgetState.serverLimitRequests)} | TPM ${formatBudgetPair(budgetState.serverRemainingTokens, budgetState.serverLimitTokens)}`
    );

    const resetParts = [
      budgetState.serverResetRequests ? `req ${budgetState.serverResetRequests}` : null,
      budgetState.serverResetTokens ? `tok ${budgetState.serverResetTokens}` : null
    ].filter(Boolean);
    if (resetParts.length > 0) {
      lines.push(`reset ${resetParts.join(" | ")}`);
    }
  }

  return lines.join("\n");
}

export function sortAiModelCatalog(
  models: readonly AiModelCatalogItem[],
  sort: ModelCatalogSort,
  serviceTier: AiServiceTier
): AiModelCatalogItem[] {
  const collator = new Intl.Collator("en", {
    sensitivity: "base",
    numeric: true
  });

  return [...models].sort((left, right) => {
    const fallback = collator.compare(left.id, right.id);
    const leftPricing = getAiModelPricingTier(left, serviceTier);
    const rightPricing = getAiModelPricingTier(right, serviceTier);

    switch (sort) {
      case "name-desc":
        return collator.compare(right.id, left.id);
      case "availability":
        return compareAvailability(left, right, serviceTier, fallback);
      case "price-asc":
        return compareNullableNumber(
          leftPricing.summaryUsdPer1M,
          rightPricing.summaryUsdPer1M,
          "asc",
          compareAvailability(left, right, serviceTier, fallback)
        );
      case "price-desc":
        return compareNullableNumber(
          leftPricing.summaryUsdPer1M,
          rightPricing.summaryUsdPer1M,
          "desc",
          compareAvailability(left, right, serviceTier, fallback)
        );
      case "input-asc":
        return compareNullableNumber(
          leftPricing.inputUsdPer1M,
          rightPricing.inputUsdPer1M,
          "asc",
          compareAvailability(left, right, serviceTier, fallback)
        );
      case "input-desc":
        return compareNullableNumber(
          leftPricing.inputUsdPer1M,
          rightPricing.inputUsdPer1M,
          "desc",
          compareAvailability(left, right, serviceTier, fallback)
        );
      case "output-asc":
        return compareNullableNumber(
          leftPricing.outputUsdPer1M,
          rightPricing.outputUsdPer1M,
          "asc",
          compareAvailability(left, right, serviceTier, fallback)
        );
      case "output-desc":
        return compareNullableNumber(
          leftPricing.outputUsdPer1M,
          rightPricing.outputUsdPer1M,
          "desc",
          compareAvailability(left, right, serviceTier, fallback)
        );
      case "newest":
        return compareNullableNumber(left.created, right.created, "desc", fallback);
      case "oldest":
        return compareNullableNumber(left.created, right.created, "asc", fallback);
      case "name-asc":
      default:
        return fallback;
    }
  });
}

export function buildModelSelectOptions(
  models: readonly AiModelCatalogItem[],
  allowedModelRules: readonly AiAllowedModelRule[],
  currentValue: string,
  serviceTier: AiServiceTier,
  includeEmptyOption = false,
  modelBudgets: AiModelBudgetMap = {}
): Array<{ label: string; title: string; value: string }> {
  const selectedSet = new Set(
    allowedModelRules
      .filter((rule) => rule.tier === serviceTier)
      .map((rule) => rule.model)
  );
  const sourceModels =
    selectedSet.size > 0
      ? models.filter((model) => selectedSet.has(model.id))
      : [...models];

  const options = sortAiModelCatalog(sourceModels, "name-asc", serviceTier).map((model) => ({
    label: `${model.id} ${formatAiModelSummaryPrice(model, serviceTier)}`,
    title: formatAiModelCompactTooltip(model, serviceTier, resolveModelBudget(modelBudgets, model.id)),
    value: model.id
  }));

  if (includeEmptyOption) {
    options.unshift({
      label: "не задано",
      title: "Оставить поле пустым.",
      value: ""
    });
  }

  if (
    currentValue &&
    !options.some((option) => option.value === currentValue)
  ) {
    options.unshift({
      label: `${currentValue} (текущее)`,
      title: "Текущее значение отсутствует в списке разрешённых моделей.",
      value: currentValue
    });
  }

  return options;
}

export function buildAllowedModelSections(
  models: readonly AiModelCatalogItem[],
  allowedModelRules: readonly AiAllowedModelRule[],
  modelBudgets: AiModelBudgetMap = {}
): Record<AiServiceTier, AllowedModelSectionItem[]> {
  const modelIndex = new Map(models.map((model) => [model.id, model]));
  const sections: Record<AiServiceTier, AllowedModelSectionItem[]> = {
    standard: [],
    flex: [],
    priority: []
  };

  for (const tier of ["standard", "flex", "priority"] as const satisfies readonly AiServiceTier[]) {
    const tierRules = [...allowedModelRules]
      .filter((rule) => rule.tier === tier)
      .sort((left, right) => left.model.localeCompare(right.model, "en", { sensitivity: "base", numeric: true }));

    sections[tier] = tierRules.map((rule) => {
      const model = modelIndex.get(rule.model) ?? null;
      const budgetState = resolveModelBudget(modelBudgets, rule.model);
      return {
        rule,
        model,
        summaryPrice: model ? formatAiModelSummaryPrice(model, tier) : "Σ н/д",
        tooltip: model
          ? formatAiModelTooltip(model, tier, budgetState)
          : [
              `Модель: ${rule.model}`,
              `Раздел: ${tier}`,
              "Модель отсутствует в текущем каталоге OpenAI.",
              budgetState
                ? `Budget: RPM ${formatBudgetPair(budgetState.serverRemainingRequests, budgetState.serverLimitRequests)}, TPM ${formatBudgetPair(
                    budgetState.serverRemainingTokens,
                    budgetState.serverLimitTokens
                  )}`
                : "Телеметрия лимитов пока не получена."
            ].join("\n")
      };
    });
  }

  return sections;
}

export function formatAllowedModelsDisplay(modelRules: readonly AiAllowedModelRule[]): string {
  if (modelRules.length === 0) {
    return "[]";
  }

  if (modelRules.length === 1) {
    const [rule] = modelRules;
    return `[{\"model\":\"${rule.model}\",\"tier\":\"${rule.tier}\"}]`;
  }

  const preview = modelRules
    .slice(0, 2)
    .map((rule) => `{\"model\":\"${rule.model}\",\"tier\":\"${rule.tier}\"}`)
    .join(", ");
  const suffix = modelRules.length > 2 ? `, +${modelRules.length - 2}` : "";
  return `[${preview}${suffix}]`;
}

function compareAvailability(
  left: AiModelCatalogItem,
  right: AiModelCatalogItem,
  serviceTier: AiServiceTier,
  fallback: number
): number {
  const leftScore = getAvailabilityRank(left, serviceTier);
  const rightScore = getAvailabilityRank(right, serviceTier);
  if (leftScore === rightScore) {
    return fallback;
  }

  return leftScore - rightScore;
}

function getAvailabilityRank(model: AiModelCatalogItem, serviceTier: AiServiceTier): number {
  const pricing = getAiModelPricingTier(model, serviceTier);
  if (pricing.summaryUsdPer1M === null) {
    return 2;
  }

  const matchedBy = model.matchedBy[serviceTier];
  if (matchedBy === "exact") {
    return 0;
  }

  if (matchedBy === "family") {
    return 1;
  }

  return 2;
}

function compareNullableNumber(
  left: number | null,
  right: number | null,
  direction: "asc" | "desc",
  fallback: number
): number {
  if (left === null && right === null) {
    return fallback;
  }

  if (left === null) {
    return 1;
  }

  if (right === null) {
    return -1;
  }

  if (left === right) {
    return fallback;
  }

  return direction === "asc" ? left - right : right - left;
}

function formatOptionalPrice(value: number | null, suffix: string): string {
  if (value === null) {
    return "н/д";
  }

  return `$${formatPrice(value)} ${suffix}`.trim();
}

function formatPrice(value: number): string {
  return value.toFixed(value >= 1 ? 2 : value >= 0.1 ? 3 : 4).replace(/\.?0+$/, "");
}

function formatBudgetPair(remaining: number | null, limit: number | null): string {
  if (remaining === null || limit === null) {
    return "н/д";
  }

  return `${remaining}/${limit}`;
}

function resolveModelBudget(modelBudgets: AiModelBudgetMap, modelId: string): AiModelBudgetState | null {
  const exact = modelBudgets[modelId];
  if (exact) {
    return exact;
  }

  const loweredTarget = modelId.toLowerCase();
  for (const [key, value] of Object.entries(modelBudgets)) {
    if (key.toLowerCase() === loweredTarget || value.model.toLowerCase() === loweredTarget) {
      return value;
    }
  }

  return null;
}
