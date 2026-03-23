import assert from "node:assert/strict";
import path from "node:path";

import { ensureDir, paths, writeJson } from "./lib/common.mjs";
import {
  BASE_CHAT_INSTRUCTIONS,
  COMMANDS,
  STRUCTURED_DESCRIPTION,
  STRUCTURED_NAME,
  STRUCTURED_SCHEMA,
  chooseModelFromCatalog,
  closeAiHarnessSession,
  getAiStatus,
  getUserEnvironmentVariable,
  normalizePageKey,
  patchConfig,
  prepareEdgeAiArtifacts,
  resetAllSessions,
  restoreBaselineAiConfig,
  sendCommand,
  sessionHasAssistantJson,
  sessionHasAssistantText,
  startAiHarnessSession,
  waitForSession
} from "./lib/edge-ai-harness.mjs";

const OPENAI_API_KEY_ENV_VAR_NAME = "OPENAI_API_KEY";
const SUPPORTED_24H_MODELS = new Set([
  "gpt-4.1",
  "gpt-4.1-mini",
  "gpt-4.1-nano",
  "gpt-5",
  "gpt-5-mini",
  "gpt-5-nano",
  "o4-mini"
]);
const SCENARIO_ORDER = [
  "cache.single-static-repeat",
  "cache.static-context-changing-tail",
  "cache.long-multi-turn",
  "cache.structured-output-repeat",
  "cache.instructions-change-miss",
  "cache.compaction-loop",
  "cache.retention-24h"
];
const DEFAULT_REPORT_PATH = path.join(paths.artifacts, "test-results", "edge-ai-prompt-cache-report.json");
const STATIC_CONTEXT = Array.from({ length: 160 }, (_, index) =>
  `Context line ${index + 1}: preserve this stable cache prefix marker ${index + 1} and the phrase lexical prompt cache anchor.`
).join("\n");

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.listScenarios) {
    console.log(SCENARIO_ORDER.join("\n"));
    return;
  }

  let session = null;
  const report = createReport();

  try {
    await prepareEdgeAiArtifacts({
      runPreflight: !options.skipPreflight && !options.reuseArtifacts,
      reuseArtifacts: options.reuseArtifacts
    });
    session = await startAiHarnessSession();
    report.environment.extensionId = session.extensionId;

    const apiKeyPresent = Boolean(getUserEnvironmentVariable(OPENAI_API_KEY_ENV_VAR_NAME));
    report.environment.apiKeyPresent = apiKeyPresent;
    if (!apiKeyPresent) {
      for (const scenarioName of selectScenarioNames(options)) {
        skipScenario(report, scenarioName, "OPENAI_API_KEY is unavailable.");
      }
      return;
    }

    let catalogResult = null;
    try {
      catalogResult = await runScenario(report, "catalog.lookup", async () => {
        const result = await sendCommand(session.driver, COMMANDS.aiModelsCatalog, {});
        const selectedModel = chooseModelFromCatalog(result.models) ?? chooseFallbackModel(result.models);
        assert.ok(selectedModel, "No usable OpenAI model was found in the catalog.");
        return {
          selectedModel,
          modelCount: result.models.length
        };
      });
    } catch (error) {
      if (/unsupported_country_region_territory|Country, region, or territory not supported/i.test(error instanceof Error ? error.message : String(error))) {
        for (const scenarioName of selectScenarioNames(options)) {
          skipScenario(report, scenarioName, "OpenAI provider access is region-blocked.");
        }
        return;
      }
      throw error;
    }

    const selectedModel = catalogResult?.selectedModel ?? null;
    if (!selectedModel) {
      for (const scenarioName of selectScenarioNames(options)) {
        skipScenario(report, scenarioName, "No supported OpenAI model could be selected.");
      }
      return;
    }

    report.environment.selectedModel = selectedModel;

    for (const scenarioName of selectScenarioNames(options)) {
      await restoreBaselineAiConfig(
        session.driver,
        selectedModel,
        getUserEnvironmentVariable(OPENAI_API_KEY_ENV_VAR_NAME)
      );

      switch (scenarioName) {
        case "cache.single-static-repeat":
          await runScenario(report, scenarioName, async () =>
            await runSingleStaticRepeatScenario(session, selectedModel)
          );
          break;
        case "cache.static-context-changing-tail":
          await runScenario(report, scenarioName, async () =>
            await runStaticContextChangingTailScenario(session, selectedModel)
          );
          break;
        case "cache.long-multi-turn":
          await runScenario(report, scenarioName, async () =>
            await runLongMultiTurnScenario(session, selectedModel)
          );
          break;
        case "cache.structured-output-repeat":
          await runScenario(report, scenarioName, async () =>
            await runStructuredOutputRepeatScenario(session, selectedModel)
          );
          break;
        case "cache.instructions-change-miss":
          await runScenario(report, scenarioName, async () =>
            await runInstructionsChangeMissScenario(session, selectedModel)
          );
          break;
        case "cache.compaction-loop":
          await runScenario(report, scenarioName, async () =>
            await runCompactionLoopScenario(session, selectedModel)
          );
          break;
        case "cache.retention-24h":
          if (!SUPPORTED_24H_MODELS.has(selectedModel.model)) {
            skipScenario(report, scenarioName, `Model ${selectedModel.model} is outside the official 24h prompt-cache allowlist.`);
            break;
          }
          await runScenario(report, scenarioName, async () =>
            await runExtendedRetentionScenario(session, selectedModel)
          );
          break;
        default:
          throw new Error(`Unsupported scenario: ${scenarioName}`);
      }
    }
  } finally {
    report.finishedAt = new Date().toISOString();
    await ensureDir(path.dirname(options.reportPath));
    await writeJson(options.reportPath, report);
    await closeAiHarnessSession(session);
  }

  const failedScenarios = report.scenarios.filter((scenario) => scenario.status === "failed");
  if (failedScenarios.length > 0) {
    throw new Error(`Prompt cache suite finished with ${failedScenarios.length} failed scenario(s). Report: ${options.reportPath}`);
  }

  console.log(`Prompt cache suite passed. Scenarios: ${report.scenarios.length}. Report: ${options.reportPath}`);
}

function parseArgs(argv) {
  const options = {
    scenarioNames: null,
    skipPreflight: false,
    reuseArtifacts: false,
    listScenarios: false,
    reportPath: DEFAULT_REPORT_PATH
  };

  for (const argument of argv) {
    if (argument === "--skip-preflight") {
      options.skipPreflight = true;
      continue;
    }

    if (argument === "--reuse-artifacts") {
      options.reuseArtifacts = true;
      continue;
    }

    if (argument === "--list-scenarios") {
      options.listScenarios = true;
      continue;
    }

    if (argument.startsWith("--scenario=") || argument.startsWith("--scenarios=")) {
      options.scenarioNames = argument
        .slice(argument.indexOf("=") + 1)
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      continue;
    }

    if (argument.startsWith("--report=")) {
      options.reportPath = path.resolve(argument.slice("--report=".length));
      continue;
    }

    throw new Error(`Unsupported argument: ${argument}`);
  }

  return options;
}

function createReport() {
  return {
    startedAt: new Date().toISOString(),
    finishedAt: null,
    environment: {
      browser: "Microsoft Edge",
      extensionId: null,
      apiKeyPresent: false,
      selectedModel: null
    },
    scenarios: []
  };
}

function chooseFallbackModel(models) {
  const preferredIds = ["gpt-5", "gpt-5-mini", "gpt-4.1", "gpt-4.1-mini", "o4-mini"];
  for (const modelId of preferredIds) {
    if (models.some((item) => item?.id === modelId)) {
      return {
        model: modelId,
        tier: "standard"
      };
    }
  }

  const firstModelId = models.find((item) => typeof item?.id === "string")?.id ?? null;
  return firstModelId
    ? {
        model: firstModelId,
        tier: "standard"
      }
    : null;
}

function selectScenarioNames(options) {
  return Array.isArray(options.scenarioNames) && options.scenarioNames.length > 0
    ? options.scenarioNames
    : SCENARIO_ORDER;
}

async function runScenario(report, name, execute) {
  const entry = {
    name,
    status: "running",
    startedAt: new Date().toISOString()
  };
  report.scenarios.push(entry);

  try {
    const details = await execute();
    entry.status = "passed";
    entry.details = details;
    return details;
  } catch (error) {
    entry.status = "failed";
    entry.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    entry.finishedAt = new Date().toISOString();
  }
}

function skipScenario(report, name, reason) {
  report.scenarios.push({
    name,
    status: "skipped",
    reason,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString()
  });
}

async function runSingleStaticRepeatScenario(session, selectedModel) {
  const { driver, server } = session;
  await patchConfig(driver, {
    ai: {
      chat: {
        instructions: buildLongInstructions("Repeat the requested token exactly and treat the stable context as fixed background.")
      },
      compaction: {
        enabled: false
      },
      promptCaching: {
        routing: "stable_session_prefix",
        retention: "in_memory"
      }
    }
  });

  const pageUrl = server.makeUrl("/prompt-cache-single-repeat");
  const prompt = `${STATIC_CONTEXT}\nFinal instruction: Reply with exact token EDGE_PROMPT_CACHE_SINGLE_OK and nothing else.`;
  const first = await sendPromptAndMeasure(session, pageUrl, prompt, (candidate) =>
    candidate.status.requestState === "idle" &&
    sessionHasAssistantText(candidate, "EDGE_PROMPT_CACHE_SINGLE_OK")
  );
  await resetPage(driver, pageUrl);
  const second = await sendPromptUntilCacheHit(session, pageUrl, prompt, (candidate) =>
    candidate.status.requestState === "idle" &&
    sessionHasAssistantText(candidate, "EDGE_PROMPT_CACHE_SINGLE_OK"),
    "Repeated static request did not produce cached_tokens."
  );

  return {
    pageKey: normalizePageKey(pageUrl),
    firstDurationMs: first.durationMs,
    secondDurationMs: second.durationMs,
    attemptsUsed: second.attemptsUsed,
    promptCaching: second.sessionState.status.promptCaching
  };
}

async function runStaticContextChangingTailScenario(session) {
  const { driver, server } = session;
  await patchConfig(driver, {
    ai: {
      chat: {
        instructions: buildLongInstructions("The static context is fixed; only the final instruction line changes.")
      },
      compaction: {
        enabled: false
      },
      promptCaching: {
        routing: "stable_session_prefix",
        retention: "in_memory"
      }
    }
  });

  const pageUrl = server.makeUrl("/prompt-cache-changing-tail");
  const basePrompt = `${STATIC_CONTEXT}\nStable note: preserve every preceding line as shared context.`;
  await sendPromptAndMeasure(session, pageUrl, `${basePrompt}\nFinal instruction: Reply with exact token EDGE_TAIL_A and nothing else.`, (candidate) =>
    candidate.status.requestState === "idle" &&
    sessionHasAssistantText(candidate, "EDGE_TAIL_A")
  );
  await resetPage(driver, pageUrl);
  const second = await sendPromptUntilCacheHit(session, pageUrl, `${basePrompt}\nFinal instruction: Reply with exact token EDGE_TAIL_B and nothing else.`, (candidate) =>
    candidate.status.requestState === "idle" &&
    sessionHasAssistantText(candidate, "EDGE_TAIL_B"),
    "Changing only the prompt tail did not retain a cacheable prefix."
  );
  return {
    pageKey: normalizePageKey(pageUrl),
    secondDurationMs: second.durationMs,
    attemptsUsed: second.attemptsUsed,
    promptCaching: second.sessionState.status.promptCaching
  };
}

async function runLongMultiTurnScenario(session) {
  const { driver, server } = session;
  await patchConfig(driver, {
    ai: {
      chat: {
        instructions: buildLongInstructions(BASE_CHAT_INSTRUCTIONS)
      },
      compaction: {
        enabled: false
      },
      promptCaching: {
        routing: "stable_session_prefix",
        retention: "in_memory"
      }
    }
  });

  const pageUrl = server.makeUrl("/prompt-cache-multi-turn");
  let latest = null;
  for (const token of ["EDGE_MULTI_A", "EDGE_MULTI_B", "EDGE_MULTI_C"]) {
    latest = await sendPromptAndMeasure(session, pageUrl, `Reply with exact token ${token} and nothing else.`, (candidate) =>
      candidate.status.requestState === "idle" &&
      sessionHasAssistantText(candidate, token)
    );
  }

  assert.ok(latest, "Long multi-turn scenario did not produce a final session.");
  assert.ok(latest.sessionState.status.promptCaching.session.requestCount >= 3, "Session prompt-cache counters did not accumulate requests.");
  assert.ok(latest.sessionState.status.promptCaching.session.cachedTokens > 0, "Long multi-turn scenario did not accumulate cached tokens.");
  assert.equal(latest.sessionState.status.promptCaching.session.compactionRequestCount, 0, "Compaction should remain disabled in the long multi-turn scenario.");

  return {
    pageKey: normalizePageKey(pageUrl),
    finalDurationMs: latest.durationMs,
    promptCaching: latest.sessionState.status.promptCaching
  };
}

async function runStructuredOutputRepeatScenario(session) {
  const { driver, server } = session;
  await patchConfig(driver, {
    ai: {
      chat: {
        instructions: buildLongInstructions("Return structured JSON that matches the configured schema exactly."),
        structuredOutput: {
          name: STRUCTURED_NAME,
          description: STRUCTURED_DESCRIPTION,
          schema: STRUCTURED_SCHEMA,
          strict: true
        }
      },
      compaction: {
        enabled: false
      },
      promptCaching: {
        routing: "stable_session_prefix",
        retention: "in_memory"
      }
    }
  });

  const pageUrl = server.makeUrl("/prompt-cache-structured");
  const prompt = `${STATIC_CONTEXT}\nReturn token EDGE_STRUCTURED_CACHE_OK and variant prompt-cache.`;
  await sendPromptAndMeasure(session, pageUrl, prompt, (candidate) =>
    candidate.status.requestState === "idle" &&
    sessionHasAssistantJson(candidate, (parsed) => parsed?.token === "EDGE_STRUCTURED_CACHE_OK")
  );
  await resetPage(driver, pageUrl);
  const second = await sendPromptUntilCacheHit(session, pageUrl, prompt, (candidate) =>
    candidate.status.requestState === "idle" &&
    sessionHasAssistantJson(candidate, (parsed) => parsed?.token === "EDGE_STRUCTURED_CACHE_OK"),
    "Repeated structured-output request did not produce cached_tokens."
  );
  return {
    pageKey: normalizePageKey(pageUrl),
    secondDurationMs: second.durationMs,
    attemptsUsed: second.attemptsUsed,
    promptCaching: second.sessionState.status.promptCaching
  };
}

async function runInstructionsChangeMissScenario(session) {
  const { driver, server } = session;
  const pageUrl = server.makeUrl("/prompt-cache-instructions-miss");
  const prompt = `${STATIC_CONTEXT}\nFinal instruction: Reply with exact token EDGE_INSTRUCTIONS_MISS_OK and nothing else.`;

  await patchConfig(driver, {
    ai: {
      chat: {
        instructions: buildLongInstructions("Instruction family A: treat the following stable context as canonical.")
      },
      compaction: {
        enabled: false
      },
      promptCaching: {
        routing: "stable_session_prefix",
        retention: "in_memory"
      }
    }
  });
  await sendPromptAndMeasure(session, pageUrl, prompt, (candidate) =>
    candidate.status.requestState === "idle" &&
    sessionHasAssistantText(candidate, "EDGE_INSTRUCTIONS_MISS_OK")
  );

  await resetPage(driver, pageUrl);
  await patchConfig(driver, {
    ai: {
      chat: {
        instructions: buildLongInstructions("Instruction family B: the very first tokens differ, so cache hits should disappear.")
      }
    }
  });
  const second = await sendPromptAndMeasure(session, pageUrl, prompt, (candidate) =>
    candidate.status.requestState === "idle" &&
    sessionHasAssistantText(candidate, "EDGE_INSTRUCTIONS_MISS_OK")
  );

  const lastRequest = second.sessionState.status.promptCaching.lastRequest;
  assert.ok(lastRequest, "Instructions-change scenario did not expose prompt caching telemetry.");
  assert.equal(lastRequest.cachedTokens ?? 0, 0, "Changing the system prompt should break cache reuse for this scenario.");
  assert.equal(lastRequest.status, "miss", "Changing the system prompt should produce a cache miss.");

  return {
    pageKey: normalizePageKey(pageUrl),
    secondDurationMs: second.durationMs,
    promptCaching: second.sessionState.status.promptCaching
  };
}

async function runCompactionLoopScenario(session) {
  const { driver, server } = session;
  await patchConfig(driver, {
    ai: {
      chat: {
        instructions: buildLongInstructions("Use the preserved conversation context to answer exactly. When earlier turns request different tokens, always obey only the latest user message.")
      },
      compaction: {
        enabled: true,
        triggerPromptTokens: 64,
        preserveRecentTurns: 1,
        maxPassesPerPage: 2
      },
      promptCaching: {
        routing: "stable_session_prefix",
        retention: "in_memory"
      }
    }
  });

  const pageUrl = server.makeUrl("/prompt-cache-compaction-loop");
  let latest = null;
  for (const token of ["EDGE_COMPACTION_LOOP_A", "EDGE_COMPACTION_LOOP_B", "EDGE_COMPACTION_LOOP_C"]) {
    latest = await sendPromptAndMeasure(session, pageUrl, `${STATIC_CONTEXT}\nFinal instruction: Ignore every earlier token request in the conversation. Reply with exact token ${token} and nothing else.`, (candidate) =>
      candidate.status.requestState === "idle" &&
      sessionHasAssistantText(candidate, token)
    );
  }

  assert.ok(latest, "Compaction loop scenario did not produce a final session.");
  assert.ok(
    latest.sessionState.messages.some((message) => message.kind === "compaction-result"),
    "Compaction loop scenario did not emit compaction result messages."
  );
  assert.ok(latest.sessionState.status.promptCaching.session.compactionRequestCount > 0, "Compaction loop scenario did not record compaction prompt-cache telemetry.");

  return {
    pageKey: normalizePageKey(pageUrl),
    finalDurationMs: latest.durationMs,
    promptCaching: latest.sessionState.status.promptCaching,
    compactionMessages: latest.sessionState.messages.filter((message) =>
      message.kind === "compaction-request" || message.kind === "compaction-result"
    ).length
  };
}

async function runExtendedRetentionScenario(session) {
  const { driver, server } = session;
  await patchConfig(driver, {
    ai: {
      chat: {
        instructions: buildLongInstructions("Use the official 24h retention setting when it is supported by the selected model.")
      },
      compaction: {
        enabled: false
      },
      promptCaching: {
        routing: "stable_session_prefix",
        retention: "24h"
      }
    }
  });

  const pageUrl = server.makeUrl("/prompt-cache-retention-24h");
  const prompt = `${STATIC_CONTEXT}\nFinal instruction: Reply with exact token EDGE_RETENTION_24H_OK and nothing else.`;
  await sendPromptAndMeasure(session, pageUrl, prompt, (candidate) =>
    candidate.status.requestState === "idle" &&
    sessionHasAssistantText(candidate, "EDGE_RETENTION_24H_OK")
  );
  await resetPage(driver, pageUrl);
  const second = await sendPromptUntilCacheHit(session, pageUrl, prompt, (candidate) =>
    candidate.status.requestState === "idle" &&
    sessionHasAssistantText(candidate, "EDGE_RETENTION_24H_OK"),
    "24h retention scenario did not produce cached_tokens."
  );
  assert.equal(second.sessionState.status.promptCaching.lastRequest?.retentionApplied, "24h", "24h retention was not applied.");

  return {
    pageKey: normalizePageKey(pageUrl),
    secondDurationMs: second.durationMs,
    attemptsUsed: second.attemptsUsed,
    promptCaching: second.sessionState.status.promptCaching
  };
}

function buildLongInstructions(prefix) {
  return `${prefix}\n\nStatic system context:\n${STATIC_CONTEXT}`;
}

async function sendPromptAndMeasure(session, pageUrl, text, predicate) {
  const { driver } = session;
  const pageKey = normalizePageKey(pageUrl);
  const startedAt = Date.now();
  await sendCommand(driver, COMMANDS.aiChatSend, {
    pageKey,
    pageUrl,
    origin: "user",
    text
  });
  const sessionState = await waitForSession(driver, pageKey, pageUrl, predicate, 180000);
  return {
    pageKey,
    sessionState,
    durationMs: Date.now() - startedAt
  };
}

async function sendPromptUntilCacheHit(session, pageUrl, text, predicate, failureMessage, maxAttempts = 3) {
  let latest = null;
  let attemptsUsed = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    latest = await sendPromptAndMeasure(session, pageUrl, text, predicate);
    attemptsUsed = attempt;
    if (hasPromptCacheHit(latest.sessionState)) {
      break;
    }
  }

  assert.ok(latest, "Prompt-cache retry helper did not produce a session.");
  assertPromptCacheHit(latest.sessionState, failureMessage);
  return {
    ...latest,
    attemptsUsed
  };
}

async function resetPage(driver, pageUrl) {
  const pageKey = normalizePageKey(pageUrl);
  await sendCommand(driver, COMMANDS.aiChatReset, {
    pageKey
  });
  const status = await getAiStatus(driver, pageUrl);
  assert.equal(status.status.promptCaching.session.requestCount, 0, "Reset should clear prompt-cache session aggregates.");
}

function assertPromptCacheHit(sessionState, message) {
  const lastRequest = sessionState.status.promptCaching.lastRequest;
  assert.ok(lastRequest, "Prompt caching telemetry is missing.");
  assert.ok((lastRequest.cachedTokens ?? 0) > 0, message);
  assert.ok(
    lastRequest.status === "partial_hit" || lastRequest.status === "full_hit",
    `Expected a prompt cache hit classification, received ${lastRequest.status}.`
  );
}

function hasPromptCacheHit(sessionState) {
  const lastRequest = sessionState.status.promptCaching.lastRequest;
  return !!lastRequest &&
    (lastRequest.cachedTokens ?? 0) > 0 &&
    (lastRequest.status === "partial_hit" || lastRequest.status === "full_hit");
}

await main();
