import { MODEL_PRICE_CATALOG } from "./constants.js";

export async function listModelsWithPricing({ baseUrl, apiKey, useProxyToken, proxyToken }) {
  const headers = { "Content-Type": "application/json" };
  if (useProxyToken) {
    headers.Authorization = `Bearer ${proxyToken}`;
  } else if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, {
    method: "GET",
    headers
  });

  if (!response.ok) {
    throw new Error(`Failed to load models: HTTP ${response.status}`);
  }

  const json = await response.json();
  const models = Array.isArray(json.data) ? json.data : [];

  const mapped = models
    .map((model) => {
      const price = MODEL_PRICE_CATALOG[model.id] || null;
      return {
        id: model.id,
        ownedBy: model.owned_by,
        pricing: price,
        totalPricePer1M: price ? price.input + price.output : Number.POSITIVE_INFINITY
      };
    })
    .sort((a, b) => a.totalPricePer1M - b.totalPricePer1M || a.id.localeCompare(b.id));

  return mapped;
}