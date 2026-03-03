import { MESSAGE, MODEL_PRICE_CATALOG } from "../shared/constants.js";
import { RateLimitError } from "../shared/rate-limit-controller.js";
import { TRANSLATION_JSON_SCHEMA, validateStructuredTranslation } from "../shared/translation-schema.js";
import { parseRetryAfterSeconds } from "../shared/utils.js";

const inflight = new Map();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  Promise.resolve()
    .then(async () => {
      switch (message?.type) {
        case MESSAGE.OFFSCREEN_EXECUTE:
          return runOperation(message.payload);
        case MESSAGE.OFFSCREEN_CANCEL:
          return cancelRequest(message.requestId, message.pageSessionId);
        default:
          return null;
      }
    })
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => {
      sendResponse({
        ok: false,
        error: error?.message || String(error),
        status: error?.status,
        retryAfterMs: error?.retryAfterMs || 0
      });
    });

  return true;
});

async function runOperation(payload) {
  if (!payload?.operation) {
    throw new Error("Offscreen payload missing operation");
  }

  switch (payload.operation) {
    case "openai.responses":
      return runResponses(payload);
    case "openai.models":
      return runModels(payload);
    default:
      throw new Error(`Unsupported offscreen operation: ${payload.operation}`);
  }
}

function createHeaders(access) {
  const headers = {
    "Content-Type": "application/json"
  };

  if (access?.mode === "PROXY") {
    headers.Authorization = `Bearer ${access.token}`;
  } else {
    headers.Authorization = `Bearer ${access.apiKey}`;
  }
  return headers;
}

async function runResponses({ requestId, payload, access }) {
  const mockMode = payload?.mockMode?.enabled;
  const delayMs = payload?.mockMode?.artificialDelayMs || 0;

  if (mockMode) {
    if (payload?.mockMode?.forceError && payload?.role === "translation") {
      const error = new Error("Mock translation error");
      error.status = 500;
      throw error;
    }
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    return mockResponses(payload);
  }

  const controller = new AbortController();
  inflight.set(requestId, controller);

  try {
    const baseUrl = String(access?.baseUrl || "https://api.openai.com/v1").replace(/\/$/, "");
    const endpoint = `${baseUrl}/responses`;

    const body = buildResponsesBody(payload);
    const response = await fetch(endpoint, {
      method: "POST",
      headers: createHeaders(access),
      body: JSON.stringify(body),
      signal: controller.signal
    });

    if (response.status === 429) {
      const retryAfterSeconds = parseRetryAfterSeconds(response.headers);
      throw new RateLimitError("Rate limit reached", {
        retryAfterMs: (retryAfterSeconds || 1) * 1000,
        status: 429
      });
    }

    if (!response.ok) {
      const text = await response.text();
      const error = new Error(`OpenAI HTTP ${response.status}: ${text.slice(0, 600)}`);
      error.status = response.status;
      throw error;
    }

    const json = await response.json();
    return normalizeResponsesPayload(payload, json);
  } finally {
    inflight.delete(requestId);
  }
}

function buildResponsesBody(payload) {
  const role = payload.role;
  const model = payload.model;

  if (role === "context") {
    return {
      model,
      temperature: 0.2,
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text:
                "You produce exhaustive global translation context. Include domain assumptions, named entities, glossary hints, consistency constraints, tone policy and critical disambiguations."
            }
          ]
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: JSON.stringify(payload.input)
            }
          ]
        }
      ]
    };
  }

  return {
    model,
    temperature: 0.1,
    text: {
      format: {
        type: "json_schema",
        name: "translation_output",
        strict: true,
        schema: TRANSLATION_JSON_SCHEMA
      }
    },
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text:
              "Translate each block preserving semantics, entities, formatting intent, and consistency with global context/history. Output strictly valid JSON matching schema."
          }
        ]
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: JSON.stringify(payload.input)
          }
        ]
      }
    ]
  };
}

function normalizeResponsesPayload(payload, json) {
  const text = readOutputText(json);
  const usage = readUsage(json);
  if (payload.role === "context") {
    return {
      text,
      structured: {
        context: text
      },
      usage,
      raw: json
    };
  }

  const structured = parseJsonStrict(text);
  validateStructuredTranslation(structured);
  return {
    text,
    structured,
    usage,
    raw: json
  };
}

function readUsage(json) {
  const usage = json?.usage || {};
  const inputTokens = Number.isFinite(Number(usage.input_tokens)) ? Number(usage.input_tokens) : null;
  const outputTokens = Number.isFinite(Number(usage.output_tokens)) ? Number(usage.output_tokens) : null;
  const totalTokens = Number.isFinite(Number(usage.total_tokens)) ? Number(usage.total_tokens) : null;
  const cachedInputTokens = Number.isFinite(Number(usage?.input_tokens_details?.cached_tokens))
    ? Number(usage.input_tokens_details.cached_tokens)
    : null;

  if (inputTokens === null && outputTokens === null && totalTokens === null && cachedInputTokens === null) {
    return null;
  }

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cachedInputTokens
  };
}

function readOutputText(json) {
  if (typeof json?.output_text === "string" && json.output_text) {
    return json.output_text;
  }

  const output = Array.isArray(json?.output) ? json.output : [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const chunk of content) {
      if (typeof chunk?.text === "string") {
        return chunk.text;
      }
      if (typeof chunk?.output_text === "string") {
        return chunk.output_text;
      }
    }
  }

  return "";
}

function parseJsonStrict(text) {
  if (!text || typeof text !== "string") {
    throw new Error("Structured output missing JSON text");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Structured output is not valid JSON");
  }
}

function mockResponses(payload) {
  if (payload.role === "context") {
    return {
      text: `Mock global context for ${payload.pageSessionId}`,
      structured: {
        context: `Mock context for ${payload.pageSessionId}`
      }
    };
  }

  const blocks = payload.input?.blocks || [];
  const structured = {
    batchId: payload.batchId,
    sourceLang: "auto",
    targetLang: "ru",
    glossaryHints: [],
    qualityFlags: ["mock"],
    translations: blocks.map((block) => ({
      blockId: block.blockId,
      translatedText: `[RU] ${block.text}`,
      warnings: []
    }))
  };
  validateStructuredTranslation(structured);
  return {
    text: JSON.stringify(structured),
    structured
  };
}

async function runModels({ access, payload }) {
  const baseUrl = String(access?.baseUrl || payload?.baseUrl || "https://api.openai.com/v1").replace(/\/$/, "");
  const endpoint = `${baseUrl}/models`;

  const response = await fetch(endpoint, {
    method: "GET",
    headers: createHeaders(access)
  });

  if (!response.ok) {
    throw new Error(`Failed to list models. HTTP ${response.status}`);
  }

  const json = await response.json();
  const models = Array.isArray(json.data) ? json.data : [];

  const sorted = models
    .map((item) => {
      const pricing = MODEL_PRICE_CATALOG[item.id] || null;
      return {
        id: item.id,
        ownedBy: item.owned_by,
        pricing,
        totalPricePer1M: pricing ? pricing.input + pricing.output : Number.POSITIVE_INFINITY
      };
    })
    .sort((a, b) => a.totalPricePer1M - b.totalPricePer1M || a.id.localeCompare(b.id));

  return {
    models: sorted
  };
}

function cancelRequest(requestId, pageSessionId) {
  if (requestId) {
    const controller = inflight.get(requestId);
    if (controller) {
      controller.abort();
      inflight.delete(requestId);
    }
    return { cancelledRequestId: requestId };
  }

  if (pageSessionId) {
    for (const [id, controller] of inflight.entries()) {
      if (id.includes(pageSessionId)) {
        controller.abort();
        inflight.delete(id);
      }
    }
    return { cancelledSession: pageSessionId };
  }

  return { cancelledRequestId: null };
}
