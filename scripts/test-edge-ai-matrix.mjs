import assert from "node:assert/strict";
import path from "node:path";

import { ensureDir, paths, writeJson } from "./lib/common.mjs";
import {
  AI_UI_PATHS,
  BASE_CHAT_INSTRUCTIONS,
  BASE_COMPACTION_INSTRUCTIONS,
  COMMANDS,
  OPENAI_API_KEY_ENV_VAR_NAME,
  STRUCTURED_DESCRIPTION,
  STRUCTURED_NAME,
  STRUCTURED_SCHEMA,
  TEMP_MANAGED_API_KEY,
  closeAiHarnessSession,
  closePopupModal,
  chooseAlternateModelFromCatalog,
  chooseModelFromCatalog,
  findLatestAssistantMessage,
  getAiStatus,
  getPopupAiConfigPaths,
  getUserEnvironmentVariableAsync,
  getRuntimeSnapshot,
  normalizePageKey,
  openBrowserTab,
  openConfigPanel,
  openConfigTab,
  patchConfig,
  patchConfigExpectingError,
  patchConfigForScope,
  prepareEdgeAiArtifacts,
  pruneBrowserTabs,
  readButtonText,
  readNativeHostState,
  readOpenModelPanelMessages,
  readPopupControlState,
  readValueAtPath,
  redactSensitiveValue,
  resetConfigScope,
  resetAllSessions,
  restoreBaselineAiConfig,
  sessionHasAssistantJson,
  sessionHasAssistantText,
  sendCommand,
  sendCommandExpectingError,
  setAllowedModel,
  setInlineValue,
  setModalTextValue,
  setModelPanelValue,
  setSelectValue,
  startAiHarnessSession,
  waitFor,
  waitForSession
} from "./lib/edge-ai-harness.mjs";
import {
  BASELINE_SCENARIO_ORDER,
  createBaselineAiReport,
  createBaselineAiState,
  runBaselineAiSuite
} from "./lib/edge-ai-baseline-suite.mjs";

const DEFAULT_PROFILE = "balanced";
const DEFAULT_REPORT_PATH = path.join(paths.artifacts, "test-results", "edge-ai-matrix-report.json");

const PROFILE_VALUES = new Set([DEFAULT_PROFILE]);
const PROVIDER_BLOCK_ERROR = /unsupported_country_region_territory|Country, region, or territory not supported/i;
const FULL_RUN_PHASE_GROUPS = [
  ["baseline_regression", "ui_roundtrip", "host_sync"],
  ["scope_precedence", "status_reflection", "session_management"],
  ["legacy_compat_extra", "popup_modal"],
  ["invalid_patch_shapes_extra", "popup_inline_invalid_extra", "popup_modal_state_extra", "scope_reset_extra"],
  ["numeric_boundaries", "model_selection"],
  ["transport_output"],
  ["compaction_matrix"],
  ["queue_rate_limits"],
  ["recovery_stability"]
];

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const balancedCases = createBalancedCases();
  const fallbackCases = createFallbackCases();
  if (options.listGroups) {
    printAvailableGroups(balancedCases, fallbackCases);
    return;
  }
  const state = createMatrixState();
  const report = createMatrixReport(options, state, balancedCases, fallbackCases);

  try {
    await prepareEdgeAiArtifacts({
      runPreflight: !options.skipPreflight && !options.reuseArtifacts,
      reuseArtifacts: options.reuseArtifacts
    });
    if (isFullMatrixRun(options)) {
      for (const phaseGroups of FULL_RUN_PHASE_GROUPS) {
        const shouldContinue = await runMatrixPhase(report, balancedCases, fallbackCases, state, {
          ...options,
          groups: new Set(phaseGroups)
        });
        if (!shouldContinue) {
          break;
        }
      }

      if (countNonSkippedCases(report) < 100) {
        await runMatrixPhase(report, balancedCases, fallbackCases, state, {
          ...options,
          groups: new Set(["fallback_pool"])
        });
      }
    } else {
      await runMatrixPhase(report, balancedCases, fallbackCases, state, options);
    }
  } finally {
    report.finishedAt = new Date().toISOString();
    report.summary = buildSummary(report);
    await ensureDir(path.dirname(options.reportPath));
    await writeJson(options.reportPath, redactSensitiveValue(report));
  }

  finalize(report, options);
}

async function runMatrixPhase(report, balancedCases, fallbackCases, state, options) {
  let session = null;
  let stopAfterBaseline = false;
  resetPhaseState(state);

  try {
    session = await startAiHarnessSession();
    report.environment.extensionId = session.extensionId;

    const shouldRunBaseline =
      matchesGroup("baseline_regression", options.groups) &&
      (!options.grep || BASELINE_SCENARIO_ORDER.some((name) => matchesGrep(name, options.grep)));
    if (shouldRunBaseline) {
      const baselineReport = createBaselineAiReport(session.extensionId, state);
      const baselineScenarioNames = options.grep
        ? BASELINE_SCENARIO_ORDER.filter((name) => matchesGrep(name, options.grep))
        : null;
      const baselineResult = await runBaselineAiSuite(session, {
        report: baselineReport,
        state,
        scenarioNames: baselineScenarioNames
      });
      mergeBaselineReport(report, baselineResult.report, state, options.grep, options.groups);
      if (!options.continueOnFail && report.cases.some((item) => item.group === "baseline_regression" && item.status === "failed")) {
        stopAfterBaseline = true;
      }
    }

    if (!stopAfterBaseline) {
      const plannedCases = options.grep
        ? [...balancedCases, ...fallbackCases]
        : [...balancedCases, ...fallbackCases];
      for (const testCase of plannedCases) {
        if (!matchesCaseFilters(testCase, options)) {
          continue;
        }

        await runMatrixCase(report, testCase, { session, state, options });
        if (!options.continueOnFail && report.cases[report.cases.length - 1]?.status === "failed") {
          return false;
        }
      }
    }
  } finally {
    if (session?.driver && state.selectedModel) {
      try {
        await restoreBaselineAiConfig(session.driver, state.selectedModel, state.originalUserApiKey, {
          verifyApiKeyPresent: Boolean(state.originalUserApiKey)
        });
      } catch {
        // Best-effort cleanup.
      }
    }

    await closeAiHarnessSession(session);
  }

  return true;
}

function parseArgs(argv) {
  const options = {
    profile: DEFAULT_PROFILE,
    grep: null,
    groups: new Set(),
    reportPath: DEFAULT_REPORT_PATH,
    continueOnFail: false,
    skipPreflight: false,
    reuseArtifacts: false,
    listGroups: false
  };

  for (const argument of argv) {
    if (argument === "--continue-on-fail") {
      options.continueOnFail = true;
      continue;
    }

    if (argument === "--skip-preflight") {
      options.skipPreflight = true;
      continue;
    }

    if (argument === "--reuse-artifacts") {
      options.reuseArtifacts = true;
      continue;
    }

    if (argument === "--list-groups") {
      options.listGroups = true;
      continue;
    }

    if (argument.startsWith("--profile=")) {
      options.profile = argument.slice("--profile=".length);
      continue;
    }

    if (argument.startsWith("--grep=")) {
      options.grep = argument.slice("--grep=".length);
      continue;
    }

    if (argument.startsWith("--report=")) {
      options.reportPath = path.resolve(argument.slice("--report=".length));
      continue;
    }

    if (argument.startsWith("--group=") || argument.startsWith("--groups=")) {
      const rawValue = argument.slice(argument.indexOf("=") + 1);
      for (const groupName of rawValue.split(",").map((value) => value.trim()).filter(Boolean)) {
        options.groups.add(groupName);
      }
      continue;
    }

    throw new Error(`Unsupported argument: ${argument}`);
  }

  if (!PROFILE_VALUES.has(options.profile)) {
    throw new Error(`Unsupported profile: ${options.profile}`);
  }

  return options;
}

function createMatrixState() {
  return {
    ...createBaselineAiState(),
    catalogResolved: false,
    budgetRemainingTokens: null,
    caseCounter: 0
  };
}

function resetPhaseState(state) {
  state.selectedModel = null;
  state.alternateModel = null;
  state.catalogModels = [];
  state.catalogResolved = false;
  state.providerRegionBlocked = false;
  state.catalogError = null;
  state.budgetRemainingTokens = null;
}

function createMatrixReport(options, state, balancedCases, fallbackCases) {
  const availableGroups = new Set([
    "baseline_regression",
    ...balancedCases.map((testCase) => testCase.group),
    ...fallbackCases.map((testCase) => testCase.group)
  ]);
  return {
    startedAt: new Date().toISOString(),
    profile: options.profile,
    options: {
      grep: options.grep,
      groups: [...options.groups],
      continueOnFail: options.continueOnFail,
      reportPath: options.reportPath,
      skipPreflight: options.skipPreflight,
      reuseArtifacts: options.reuseArtifacts
    },
    environment: {
      browser: "Microsoft Edge",
      manifestVersion: 3,
      extensionId: null,
      originalUserApiKeyPresent: Boolean(state.originalUserApiKey)
    },
    coverage: {
      expectedAiUiPaths: AI_UI_PATHS,
      baselineScenarioCount: BASELINE_SCENARIO_ORDER.length,
      plannedBalancedCases: BASELINE_SCENARIO_ORDER.length + balancedCases.length,
      fallbackPoolSize: fallbackCases.length,
      availableGroups: [...availableGroups].sort()
    },
    cases: [],
    summary: null
  };
}

function mergeBaselineReport(report, baselineReport, state, grep, groups = report.options.groups ?? []) {
  report.environment.providerRegionBlocked = Boolean(state.providerRegionBlocked);
  report.environment.selectedModel = state.selectedModel ?? null;
  report.environment.alternateModel = state.alternateModel ?? null;
  const selectedGroups = new Set(groups ?? []);

  for (const scenario of baselineReport.scenarios) {
    if ((grep && !matchesGrep(scenario.name, grep)) || !matchesGroup("baseline_regression", selectedGroups)) {
      continue;
    }

    report.cases.push({
      caseId: scenario.name,
      name: scenario.name,
      group: "baseline_regression",
      status: scenario.status,
      startedAt: scenario.startedAt,
      finishedAt: scenario.finishedAt,
      selectedModel: state.selectedModel ?? null,
      alternateModel: state.alternateModel ?? null,
      ...(scenario.reason ? { skipReason: scenario.reason } : {}),
      ...(scenario.error ? { error: scenario.error } : {}),
      ...(scenario.errorDetails ? { errorDetails: redactSensitiveValue(scenario.errorDetails) } : {}),
      ...(scenario.details ? { details: redactSensitiveValue(scenario.details) } : {})
    });
  }
}

async function runMatrixCase(report, testCase, context) {
  const entry = {
    caseId: testCase.caseId,
    name: testCase.name ?? testCase.caseId,
    group: testCase.group,
    status: "running",
    startedAt: new Date().toISOString(),
    selectedModel: context.state.selectedModel ?? null,
    alternateModel: context.state.alternateModel ?? null
  };
  report.cases.push(entry);
  const retryErrors = [];

  try {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      entry.attempts = attempt;
      try {
        await prepareCaseState(testCase, context);
        entry.selectedModel = context.state.selectedModel ?? null;
        entry.alternateModel = context.state.alternateModel ?? null;
        const details = await testCase.execute(context);
        entry.status = "passed";
        if (details !== undefined) {
          entry.details = redactSensitiveValue(details);
        }
        if (retryErrors.length > 0) {
          entry.retryErrors = redactSensitiveValue(retryErrors);
        }
        break;
      } catch (error) {
        if (error?.name === "SkipCaseError") {
          entry.status = "skipped";
          entry.skipReason = error.reason;
          if (error.details !== undefined) {
            entry.details = redactSensitiveValue(error.details);
          }
          break;
        }

        const errorDetails = redactSensitiveValue(serializeError(error));
        if (attempt < 2 && isRetryableCaseError(testCase, error)) {
          retryErrors.push(errorDetails);
          await pruneBrowserTabs(context.session.driver, [context.session.mainHandle, context.session.popupHandle]).catch(() => {});
          continue;
        }

        entry.status = "failed";
        entry.error = error instanceof Error ? error.message : String(error);
        entry.errorDetails = errorDetails;
        if (retryErrors.length > 0) {
          entry.retryErrors = redactSensitiveValue(retryErrors);
        }
        break;
      }
    }
  } finally {
    await pruneBrowserTabs(context.session.driver, [context.session.mainHandle, context.session.popupHandle]).catch(() => {});
    entry.finishedAt = new Date().toISOString();
  }
}

function serializeError(error) {
  if (error instanceof Error) {
    const extendedError = error;
    return {
      name: error.name,
      message: error.message,
      stack: error.stack ?? null,
      ...(extendedError.code !== undefined ? { code: extendedError.code } : {}),
      ...(extendedError.details !== undefined ? { details: extendedError.details } : {})
    };
  }

  return {
    message: String(error)
  };
}

function isRetryableCaseError(testCase, error) {
  if (!testCase.liveDependent) {
    return false;
  }

  const message = error instanceof Error ? error.message : String(error);
  return /Object reference not set to an instance of an object|Native host request timed out|did not reach the expected state/i.test(message);
}

async function prepareCaseState(testCase, context) {
  const { session, state } = context;
  const { driver } = session;

  if (testCase.requiresSelectedModel || testCase.requiresAlternateModel || testCase.usesModelCatalog) {
    await ensureCatalogState(driver, state);
  }

  if (testCase.liveDependent && !state.originalUserApiKey) {
    throwSkip("A user OpenAI API key is unavailable.");
  }

  if (testCase.requiresSelectedModel && !state.selectedModel) {
    throwSkip("A usable AI model is unavailable.");
  }

  if (testCase.requiresAlternateModel && !state.alternateModel) {
    throwSkip("An alternate AI model is unavailable.");
  }

  if (testCase.providerSuccessRequired && state.providerRegionBlocked) {
    throwSkip("OpenAI provider access is region-blocked.");
  }

  if (testCase.prepare !== "none") {
    if (state.selectedModel) {
      await restoreBaselineAiConfig(driver, state.selectedModel, state.originalUserApiKey, {
        verifyApiKeyPresent: Boolean(state.originalUserApiKey)
      });
    } else {
      await resetAllSessions(driver);
    }
  }
}

async function ensureCatalogState(driver, state) {
  if (state.catalogResolved) {
    return state;
  }

  try {
    const result = await sendCommand(driver, COMMANDS.aiModelsCatalog, {});
    state.catalogModels = Array.isArray(result.models) ? result.models : [];
    state.selectedModel = chooseModelFromCatalog(state.catalogModels);
    state.alternateModel = chooseAlternateModelFromCatalog(state.catalogModels, state.selectedModel);
    state.catalogError = null;
    state.providerRegionBlocked = false;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    state.catalogError = message;
    state.providerRegionBlocked = PROVIDER_BLOCK_ERROR.test(message);
    if (state.providerRegionBlocked) {
      state.selectedModel = {
        model: "gpt-5",
        tier: "standard"
      };
    }
    state.alternateModel = null;
  } finally {
    state.catalogResolved = true;
  }

  return state;
}

function finalize(report, options) {
  const failedCases = report.cases.filter((item) => item.status === "failed");
  const nonSkipped = countNonSkippedCases(report);

  if (isFullMatrixRun(options) && nonSkipped < 100) {
    throw new Error(`Edge AI matrix produced only ${nonSkipped} non-skipped case(s). Report: ${options.reportPath}`);
  }

  if (failedCases.length > 0) {
    throw new Error(`Edge AI matrix finished with ${failedCases.length} failed case(s). Report: ${options.reportPath}`);
  }

  console.log(`Edge AI matrix passed. Cases: ${report.cases.length}. Report: ${options.reportPath}`);
}

function buildSummary(report) {
  const counts = {
    planned: report.coverage.plannedBalancedCases,
    totalReported: report.cases.length,
    passed: 0,
    failed: 0,
    skipped: 0,
    nonSkipped: 0
  };

  for (const entry of report.cases) {
    if (entry.status === "passed") {
      counts.passed += 1;
      counts.nonSkipped += 1;
    } else if (entry.status === "failed") {
      counts.failed += 1;
      counts.nonSkipped += 1;
    } else if (entry.status === "skipped") {
      counts.skipped += 1;
    }
  }

  return counts;
}

function countNonSkippedCases(report) {
  return report.cases.filter((item) => item.status === "passed" || item.status === "failed").length;
}

function matchesGrep(value, grep) {
  return !grep || value.toLowerCase().includes(grep.toLowerCase());
}

function matchesGroup(groupName, groups) {
  return !groups || groups.size === 0 || groups.has(groupName);
}

function matchesCaseFilters(testCase, options) {
  return matchesGroup(testCase.group, options.groups) &&
    matchesGrep(testCase.caseId, options.grep);
}

function isFullMatrixRun(options) {
  return !options.grep && options.groups.size === 0;
}

function printAvailableGroups(balancedCases, fallbackCases) {
  const groupNames = new Set([
    "baseline_regression",
    ...balancedCases.map((testCase) => testCase.group),
    ...fallbackCases.map((testCase) => testCase.group)
  ]);
  console.log([...groupNames].sort().join("\n"));
}

function throwSkip(reason, details) {
  const error = new Error(reason);
  error.name = "SkipCaseError";
  error.reason = reason;
  error.details = details;
  throw error;
}

function buildPatchFromPath(dottedPath, value) {
  const root = {};
  const segments = dottedPath.split(".");
  let cursor = root;
  for (let index = 0; index < segments.length; index += 1) {
    const key = segments[index];
    if (index === segments.length - 1) {
      cursor[key] = value;
    } else {
      cursor[key] = {};
      cursor = cursor[key];
    }
  }
  return root;
}

function createCaseUrl(session, caseId, suffix = "") {
  const safeId = caseId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const pathname = suffix ? `/matrix/${safeId}/${suffix}` : `/matrix/${safeId}`;
  return session.server.makeUrl(pathname);
}

function sortModelRules(rules) {
  return [...rules].sort((left, right) => {
    const leftKey = `${left.tier}:${left.model}`.toLowerCase();
    const rightKey = `${right.tier}:${right.model}`.toLowerCase();
    return leftKey.localeCompare(rightKey);
  });
}

function normalizeComparableValue(pathName, value) {
  if (pathName === "ai.allowedModels" && Array.isArray(value)) {
    return sortModelRules(value);
  }

  return value;
}

function assertPathValueMatches(pathName, actual, expected, message) {
  assert.deepEqual(
    normalizeComparableValue(pathName, actual),
    normalizeComparableValue(pathName, expected),
    message
  );
}

function getButtonExpectationTokens(pathName, value) {
  if (pathName === "ai.openAiApiKey") {
    return [];
  }

  if (pathName === "ai.allowedModels" && Array.isArray(value)) {
    return value.flatMap((rule) => [rule.model, rule.tier]).slice(0, 4);
  }

  if ((pathName === "ai.chat.model" || pathName === "ai.compaction.modelOverride") && value) {
    return [value.model, value.tier];
  }

  if (typeof value === "string") {
    const line = value.trim().split(/\r?\n/).find(Boolean) ?? value.trim();
    if (!line) {
      return [];
    }
    if (pathName === "ai.chat.structuredOutput.schema") {
      return ["type", "object"];
    }
    return [line.slice(0, 24)];
  }

  if (typeof value === "boolean" || typeof value === "number") {
    return [String(value)];
  }

  return [];
}

async function assertButtonReflectsValue(driver, pathName, value) {
  const tokens = getButtonExpectationTokens(pathName, value);
  let buttonText = "";

  await waitFor(async () => {
    buttonText = await readButtonText(driver, pathName);
    if (pathName === "ai.openAiApiKey") {
      return buttonText.length > 0 && buttonText.includes(String(value)) === false;
    }

    return tokens.every((token) => buttonText.includes(token));
  }, 10000, `${pathName} button did not reflect the updated value.`);

  if (pathName === "ai.openAiApiKey") {
    return buttonText;
  }

  return buttonText;
}

function popupModelCatalogUnavailable(state) {
  return Array.isArray(state.catalogModels) &&
    state.catalogModels.length === 0 &&
    typeof state.catalogError === "string" &&
    state.catalogError.length > 0;
}

function isProviderCatalogBlocked(state) {
  return Boolean(state.providerRegionBlocked) || PROVIDER_BLOCK_ERROR.test(state.catalogError ?? "");
}

async function ensureAllowedModelsForSelection(driver, state, value) {
  if (!value) {
    return;
  }

  const allowedModels = state.alternateModel
    ? sortModelRules([state.selectedModel, state.alternateModel])
    : [state.selectedModel];
  if (!allowedModels.some((rule) => rule.model === value.model && rule.tier === value.tier)) {
    allowedModels.push(value);
  }

  await patchConfig(driver, {
    ai: {
      allowedModels: sortModelRules(allowedModels)
    }
  });
}

async function ensureBudgetRemainingTokens(session, state, caseId) {
  if (typeof state.budgetRemainingTokens === "number") {
    return state.budgetRemainingTokens;
  }

  const { driver } = session;
  const probeUrl = createCaseUrl(session, `${caseId}-budget-probe`);
  const probePageKey = normalizePageKey(probeUrl);
  await sendCommand(driver, COMMANDS.aiChatSend, {
    pageKey: probePageKey,
    pageUrl: probeUrl,
    origin: "user",
    text: "Reply with exact token EDGE_MATRIX_BUDGET_OK and nothing else."
  });
  await waitForSession(driver, probePageKey, probeUrl, (candidate) =>
    candidate.status.requestState === "idle" &&
    sessionHasAssistantText(candidate, "EDGE_MATRIX_BUDGET_OK")
  );

  const status = await getAiStatus(driver, probeUrl);
  const remainingTokens =
    status.status.currentModelBudget?.serverRemainingTokens ??
    status.status.rateLimits?.serverRemainingTokens ??
    null;
  if (remainingTokens === null) {
    throwSkip("Current model budget telemetry did not expose remaining token data.");
  }

  state.budgetRemainingTokens = remainingTokens;
  return remainingTokens;
}

async function verifyHostValue(pathName, expected, state) {
  const nativeState = await readNativeHostState();
  assert.ok(nativeState?.aiConfig, "Native host state is unavailable.");

  const pathMap = {
    "ai.chat.model": "aiConfig.chat.model",
    "ai.chat.streamingEnabled": "aiConfig.chat.streamingEnabled",
    "ai.chat.instructions": "aiConfig.chat.instructions",
    "ai.chat.structuredOutput.name": "aiConfig.chat.structuredOutput.name",
    "ai.chat.structuredOutput.description": "aiConfig.chat.structuredOutput.description",
    "ai.chat.structuredOutput.schema": "aiConfig.chat.structuredOutput.schema",
    "ai.chat.structuredOutput.strict": "aiConfig.chat.structuredOutput.strict",
    "ai.compaction.enabled": "aiConfig.compaction.enabled",
    "ai.compaction.streamingEnabled": "aiConfig.compaction.streamingEnabled",
    "ai.compaction.modelOverride": "aiConfig.compaction.modelOverride",
    "ai.compaction.instructions": "aiConfig.compaction.instructions",
    "ai.compaction.triggerPromptTokens": "aiConfig.compaction.triggerPromptTokens",
    "ai.compaction.preserveRecentTurns": "aiConfig.compaction.preserveRecentTurns",
    "ai.compaction.maxPassesPerPage": "aiConfig.compaction.maxPassesPerPage",
    "ai.promptCaching.routing": "aiConfig.promptCaching.routing",
    "ai.promptCaching.retention": "aiConfig.promptCaching.retention",
    "ai.rateLimits.reserveOutputTokens": "aiConfig.rateLimits.reserveOutputTokens",
    "ai.rateLimits.maxQueuedPerPage": "aiConfig.rateLimits.maxQueuedPerPage",
    "ai.rateLimits.maxQueuedGlobal": "aiConfig.rateLimits.maxQueuedGlobal"
  };

  if (pathName === "ai.openAiApiKey") {
    const currentValue = await getUserEnvironmentVariableAsync(OPENAI_API_KEY_ENV_VAR_NAME);
    assert.equal(currentValue, expected, "Managed OPENAI_API_KEY was not updated.");
    assert.equal("openAiApiKey" in nativeState.aiConfig, false, "Native host state should not persist the raw API key.");
    return {
      envUpdated: true
    };
  }

  if (pathName === "ai.allowedModels") {
    assert.equal("allowedModels" in nativeState.aiConfig, false, "Native host state should not persist ai.allowedModels.");
    return {
      hostFieldPersisted: false
    };
  }

  const hostValuePath = pathMap[pathName];
  assert.ok(hostValuePath, `No native-host path mapping is registered for ${pathName}.`);
  const actualValue = readValueAtPath(nativeState, hostValuePath);
  assertPathValueMatches(pathName, actualValue, expected, `Native host value for ${pathName} did not match.`);
  return {
    hostValuePath
  };
}

function getPathCaseDefinitions() {
  return [
    {
      path: "ai.openAiApiKey",
      editor: "modal",
      requiresSelectedModel: false,
      getValue: () => TEMP_MANAGED_API_KEY
    },
    {
      path: "ai.allowedModels",
      editor: "allowed-models",
      requiresSelectedModel: true,
      usesModelCatalog: true,
      getValue: (state) => (state.alternateModel ? sortModelRules([state.selectedModel, state.alternateModel]) : [state.selectedModel])
    },
    {
      path: "ai.chat.model",
      editor: "model-select",
      requiresSelectedModel: true,
      usesModelCatalog: true,
      getValue: (state) => state.alternateModel ?? state.selectedModel
    },
    {
      path: "ai.chat.streamingEnabled",
      editor: "select",
      requiresSelectedModel: true,
      getValue: () => false
    },
    {
      path: "ai.chat.instructions",
      editor: "modal",
      requiresSelectedModel: true,
      getValue: () => "Matrix UI chat instructions.\nReturn the requested token exactly."
    },
    {
      path: "ai.chat.structuredOutput.name",
      editor: "inline",
      requiresSelectedModel: true,
      getValue: () => "matrix_structured_reply"
    },
    {
      path: "ai.chat.structuredOutput.description",
      editor: "modal",
      requiresSelectedModel: true,
      getValue: () => "Matrix structured output description.\nCompact and deterministic."
    },
    {
      path: "ai.chat.structuredOutput.schema",
      editor: "modal",
      requiresSelectedModel: true,
      getValue: () => STRUCTURED_SCHEMA
    },
    {
      path: "ai.chat.structuredOutput.strict",
      editor: "select",
      requiresSelectedModel: true,
      getValue: () => false
    },
    {
      path: "ai.compaction.enabled",
      editor: "select",
      requiresSelectedModel: true,
      getValue: () => false
    },
    {
      path: "ai.compaction.streamingEnabled",
      editor: "select",
      requiresSelectedModel: true,
      getValue: () => false
    },
    {
      path: "ai.compaction.modelOverride",
      editor: "model-select",
      requiresSelectedModel: true,
      usesModelCatalog: true,
      getValue: (state) => state.alternateModel ?? state.selectedModel
    },
    {
      path: "ai.compaction.instructions",
      editor: "modal",
      requiresSelectedModel: true,
      getValue: () => "Matrix compaction instructions.\nPreserve exact facts."
    },
    {
      path: "ai.compaction.triggerPromptTokens",
      editor: "inline",
      requiresSelectedModel: true,
      getValue: () => 32
    },
    {
      path: "ai.compaction.preserveRecentTurns",
      editor: "inline",
      requiresSelectedModel: true,
      getValue: () => 0
    },
    {
      path: "ai.compaction.maxPassesPerPage",
      editor: "inline",
      requiresSelectedModel: true,
      getValue: () => 1
    },
    {
      path: "ai.promptCaching.routing",
      editor: "select",
      requiresSelectedModel: true,
      getValue: () => "provider_default"
    },
    {
      path: "ai.promptCaching.retention",
      editor: "select",
      requiresSelectedModel: true,
      getValue: () => "24h"
    },
    {
      path: "ai.rateLimits.reserveOutputTokens",
      editor: "inline",
      requiresSelectedModel: true,
      getValue: () => 1
    },
    {
      path: "ai.rateLimits.maxQueuedPerPage",
      editor: "inline",
      requiresSelectedModel: true,
      getValue: () => 1
    },
    {
      path: "ai.rateLimits.maxQueuedGlobal",
      editor: "inline",
      requiresSelectedModel: true,
      getValue: () => 1
    }
  ];
}

function getBaselineValueForPath(pathName, state) {
  switch (pathName) {
    case "ai.openAiApiKey":
      return null;
    case "ai.allowedModels":
      return [state.selectedModel];
    case "ai.chat.model":
      return state.selectedModel;
    case "ai.chat.streamingEnabled":
      return true;
    case "ai.chat.instructions":
      return BASE_CHAT_INSTRUCTIONS;
    case "ai.chat.structuredOutput.name":
      return STRUCTURED_NAME;
    case "ai.chat.structuredOutput.description":
      return STRUCTURED_DESCRIPTION;
    case "ai.chat.structuredOutput.schema":
      return "";
    case "ai.chat.structuredOutput.strict":
      return true;
    case "ai.compaction.enabled":
      return true;
    case "ai.compaction.streamingEnabled":
      return true;
    case "ai.compaction.modelOverride":
      return state.selectedModel;
    case "ai.compaction.instructions":
      return BASE_COMPACTION_INSTRUCTIONS;
    case "ai.compaction.triggerPromptTokens":
      return 64;
    case "ai.compaction.preserveRecentTurns":
      return 1;
    case "ai.compaction.maxPassesPerPage":
      return 2;
    case "ai.promptCaching.routing":
      return "stable_session_prefix";
    case "ai.promptCaching.retention":
      return "in_memory";
    case "ai.rateLimits.reserveOutputTokens":
      return 512;
    case "ai.rateLimits.maxQueuedPerPage":
      return 2;
    case "ai.rateLimits.maxQueuedGlobal":
      return 3;
    default:
      throw new Error(`No baseline AI value is registered for ${pathName}.`);
  }
}

async function readOpenModalTextareaValue(driver) {
  const value = await driver.executeScript(`
    const textarea = document.querySelector('.popup-modal-textarea');
    return textarea instanceof HTMLTextAreaElement ? textarea.value : null;
  `);
  assert.equal(typeof value, "string", "Popup modal textarea is unavailable.");
  return value;
}

async function seedModalValue(context, definition) {
  const { driver } = context.session;
  await patchConfig(driver, buildPatchFromPath(definition.path, definition.initialValue));

  if (definition.usesEnv) {
    await waitFor(async () => {
      const currentValue = await getUserEnvironmentVariableAsync(OPENAI_API_KEY_ENV_VAR_NAME);
      return currentValue === definition.initialValue;
    }, 15000, `${definition.path} seed value did not reach the managed environment variable.`);
  }
}

async function assertModalValuePersisted(context, definition, expectedValue) {
  const { driver } = context.session;
  if (definition.usesEnv) {
    const currentValue = await getUserEnvironmentVariableAsync(OPENAI_API_KEY_ENV_VAR_NAME);
    assert.equal(currentValue, expectedValue, `${definition.path} modal value did not persist in the managed environment variable.`);
    return;
  }

  const snapshot = await getRuntimeSnapshot(driver);
  const actualValue = readValueAtPath(snapshot.config, definition.path);
  assertPathValueMatches(definition.path, actualValue, expectedValue, `${definition.path} modal value did not persist.`);
}

function createScopeResetExtraCases() {
  const definitions = [
    {
      path: "ai.allowedModels",
      requiresAlternateModel: true,
      getValue: (state) => sortModelRules([state.selectedModel, state.alternateModel])
    },
    {
      path: "ai.chat.model",
      getValue: (state) => state.alternateModel ?? null
    },
    {
      path: "ai.chat.streamingEnabled",
      getValue: () => false
    },
    {
      path: "ai.chat.instructions",
      getValue: () => "Scope reset session chat instructions.\nSession override should disappear after reset."
    },
    {
      path: "ai.chat.structuredOutput.name",
      getValue: () => "scope_reset_structured_reply"
    },
    {
      path: "ai.chat.structuredOutput.description",
      getValue: () => "Scope reset structured description."
    },
    {
      path: "ai.chat.structuredOutput.schema",
      getValue: () => STRUCTURED_SCHEMA
    },
    {
      path: "ai.chat.structuredOutput.strict",
      getValue: () => false
    },
    {
      path: "ai.compaction.enabled",
      getValue: () => false
    },
    {
      path: "ai.compaction.streamingEnabled",
      getValue: () => false
    },
    {
      path: "ai.compaction.modelOverride",
      getValue: () => null
    },
    {
      path: "ai.compaction.instructions",
      getValue: () => "Scope reset compaction instructions.\nCollapse aggressively."
    },
    {
      path: "ai.compaction.triggerPromptTokens",
      getValue: () => 32
    },
    {
      path: "ai.compaction.preserveRecentTurns",
      getValue: () => 0
    },
    {
      path: "ai.compaction.maxPassesPerPage",
      getValue: () => 1
    },
    {
      path: "ai.rateLimits.reserveOutputTokens",
      getValue: () => 1
    },
    {
      path: "ai.rateLimits.maxQueuedPerPage",
      getValue: () => 1
    },
    {
      path: "ai.rateLimits.maxQueuedGlobal",
      getValue: () => 1
    }
  ];

  return definitions.map((definition) => ({
    caseId: `scope.reset.${definition.path.replace(/^ai\./, "").replace(/\./g, "-")}.session-reset-restores-baseline`,
    group: "scope_reset_extra",
    prepare: "baseline",
    requiresSelectedModel: true,
    requiresAlternateModel: Boolean(definition.requiresAlternateModel),
    execute: async (context) => {
      const { driver } = context.session;
      const overrideValue = definition.getValue(context.state);
      const baselineValue = getBaselineValueForPath(definition.path, context.state);
      await patchConfigForScope(driver, "session", buildPatchFromPath(definition.path, overrideValue));

      const overrideSnapshot = await getRuntimeSnapshot(driver);
      assertPathValueMatches(
        definition.path,
        readValueAtPath(overrideSnapshot.config, definition.path),
        overrideValue,
        `${definition.path} session override did not apply before reset.`
      );

      await resetConfigScope(driver, "session");

      const restoredSnapshot = await getRuntimeSnapshot(driver);
      assertPathValueMatches(
        definition.path,
        readValueAtPath(restoredSnapshot.config, definition.path),
        baselineValue,
        `${definition.path} did not return to the baseline value after resetting the session scope.`
      );

      const buttonText =
        definition.path === "ai.chat.structuredOutput.schema" && baselineValue === ""
          ? await readButtonText(driver, definition.path)
          : await assertButtonReflectsValue(driver, definition.path, baselineValue);

      return {
        configPath: definition.path,
        configPatch: {
          sessionOverride: buildPatchFromPath(definition.path, overrideValue)
        },
        assertions: [
          "A divergent session-scope override was applied.",
          "resetConfigScope(session) restored the baseline effective value.",
          "Popup button text returned to the baseline state."
        ],
        artifacts: {
          buttonText
        }
      };
    }
  }));
}

function createInvalidPatchShapeExtraCases() {
  const definitions = [
    { path: "ai.openAiApiKey", invalidValue: 123, requiresSelectedModel: false },
    { path: "ai.allowedModels", invalidValue: 123, requiresSelectedModel: true },
    { path: "ai.chat.model", invalidValue: 123, requiresSelectedModel: true },
    { path: "ai.chat.streamingEnabled", invalidValue: 123, requiresSelectedModel: true },
    { path: "ai.chat.instructions", invalidValue: 123, requiresSelectedModel: true },
    { path: "ai.chat.structuredOutput.name", invalidValue: 123, requiresSelectedModel: true },
    { path: "ai.chat.structuredOutput.description", invalidValue: 123, requiresSelectedModel: true },
    { path: "ai.chat.structuredOutput.schema", invalidValue: 123, requiresSelectedModel: true },
    { path: "ai.chat.structuredOutput.strict", invalidValue: 123, requiresSelectedModel: true },
    { path: "ai.compaction.enabled", invalidValue: 123, requiresSelectedModel: true },
    { path: "ai.compaction.streamingEnabled", invalidValue: 123, requiresSelectedModel: true },
    { path: "ai.compaction.modelOverride", invalidValue: 123, requiresSelectedModel: true },
    { path: "ai.compaction.instructions", invalidValue: 123, requiresSelectedModel: true },
    { path: "ai.compaction.triggerPromptTokens", invalidValue: 32.5, requiresSelectedModel: true },
    { path: "ai.compaction.preserveRecentTurns", invalidValue: 1.5, requiresSelectedModel: true },
    { path: "ai.compaction.maxPassesPerPage", invalidValue: 1.5, requiresSelectedModel: true },
    { path: "ai.promptCaching.routing", invalidValue: 123, requiresSelectedModel: true },
    { path: "ai.promptCaching.retention", invalidValue: 123, requiresSelectedModel: true },
    { path: "ai.rateLimits.reserveOutputTokens", invalidValue: 1.5, requiresSelectedModel: true },
    { path: "ai.rateLimits.maxQueuedPerPage", invalidValue: 1.5, requiresSelectedModel: true },
    { path: "ai.rateLimits.maxQueuedGlobal", invalidValue: 1.5, requiresSelectedModel: true }
  ];

  return definitions.map((definition) => ({
    caseId: `patch.invalid-shape.${definition.path.replace(/^ai\./, "").replace(/\./g, "-")}.rejected`,
    group: "invalid_patch_shapes_extra",
    prepare: "baseline",
    requiresSelectedModel: Boolean(definition.requiresSelectedModel),
    execute: async (context) => {
      const { driver } = context.session;
      const snapshotBefore = await getRuntimeSnapshot(driver);
      const previousValue = readValueAtPath(snapshotBefore.config, definition.path);
      const invalidPatch = buildPatchFromPath(definition.path, definition.invalidValue);
      const errorResult = await patchConfigExpectingError(driver, invalidPatch);
      assert.ok(errorResult.message.length > 0, `${definition.path} invalid patch did not return an error message.`);

      const snapshotAfter = await getRuntimeSnapshot(driver);
      assertPathValueMatches(
        definition.path,
        readValueAtPath(snapshotAfter.config, definition.path),
        previousValue,
        `${definition.path} changed after an invalid-shape patch was rejected.`
      );

      return {
        configPath: definition.path,
        configPatch: {
          invalid: invalidPatch
        },
        assertions: [
          "config.patch rejected the invalid-shaped payload.",
          "The previous effective value remained active after rejection."
        ],
        artifacts: {
          errorCode: errorResult.code,
          errorMessage: errorResult.message
        }
      };
    }
  }));
}

function createPopupModalStateExtraCases() {
  const definitions = [
    {
      path: "ai.openAiApiKey",
      initialValue: TEMP_MANAGED_API_KEY,
      usesEnv: true
    },
    {
      path: "ai.chat.instructions",
      initialValue: "Popup modal chat instructions.\nPreserve this exact text."
    },
    {
      path: "ai.chat.structuredOutput.description",
      initialValue: "Popup modal structured description."
    },
    {
      path: "ai.chat.structuredOutput.schema",
      initialValue: STRUCTURED_SCHEMA
    },
    {
      path: "ai.compaction.instructions",
      initialValue: "Popup modal compaction instructions.\nPreserve this exact text."
    }
  ];

  return [
    ...definitions.map((definition) => ({
      caseId: `popup.modal-state.${definition.path.replace(/^ai\./, "").replace(/\./g, "-")}.cancel-preserves-current`,
      group: "popup_modal_state_extra",
      prepare: "baseline",
      requiresSelectedModel: !definition.usesEnv,
      execute: async (context) => {
        const { driver } = context.session;
        await seedModalValue(context, definition);
        await openConfigTab(driver);
        await openConfigPanel(driver, definition.path);
        await closePopupModal(driver);
        await assertModalValuePersisted(context, definition, definition.initialValue);
        return {
          configPath: definition.path,
          assertions: ["Closing the modal without saving preserved the existing value."]
        };
      }
    })),
    ...definitions.map((definition) => ({
      caseId: `popup.modal-state.${definition.path.replace(/^ai\./, "").replace(/\./g, "-")}.reopen-shows-current`,
      group: "popup_modal_state_extra",
      prepare: "baseline",
      requiresSelectedModel: !definition.usesEnv,
      execute: async (context) => {
        const { driver } = context.session;
        await seedModalValue(context, definition);
        await openConfigTab(driver);
        await openConfigPanel(driver, definition.path);
        const textareaValue = await readOpenModalTextareaValue(driver);
        assert.equal(textareaValue, definition.initialValue, `${definition.path} modal did not reopen with the current saved value.`);
        await closePopupModal(driver);
        return {
          configPath: definition.path,
          assertions: ["Reopening the modal showed the current saved value."],
          artifacts: {
            textareaValue
          }
        };
      }
    })),
    ...definitions
      .filter((definition) => !definition.usesEnv)
      .map((definition) => ({
        caseId: `popup.modal-state.${definition.path.replace(/^ai\./, "").replace(/\./g, "-")}.clear-to-empty`,
        group: "popup_modal_state_extra",
        prepare: "baseline",
        requiresSelectedModel: true,
        execute: async (context) => {
          const { driver } = context.session;
          await seedModalValue(context, definition);
          await openConfigTab(driver);
          await setModalTextValue(driver, definition.path, "");
          await assertModalValuePersisted(context, definition, "");
          return {
            configPath: definition.path,
            assertions: ["Saving an empty modal value cleared the stored field."]
          };
        }
      }))
  ];
}

function createPopupInlineInvalidExtraCases() {
  const definitions = [
    {
      path: "ai.compaction.triggerPromptTokens",
      valid: 32,
      invalidInputs: [
        { suffix: "below-min", value: "31" },
        { suffix: "fractional", value: "32.5" }
      ]
    },
    {
      path: "ai.compaction.preserveRecentTurns",
      valid: 0,
      invalidInputs: [
        { suffix: "below-min", value: "-1" },
        { suffix: "fractional", value: "1.5" }
      ]
    },
    {
      path: "ai.compaction.maxPassesPerPage",
      valid: 1,
      invalidInputs: [
        { suffix: "below-min", value: "0" },
        { suffix: "fractional", value: "1.5" }
      ]
    },
    {
      path: "ai.rateLimits.reserveOutputTokens",
      valid: 1,
      invalidInputs: [
        { suffix: "below-min", value: "0" },
        { suffix: "fractional", value: "1.5" }
      ]
    },
    {
      path: "ai.rateLimits.maxQueuedPerPage",
      valid: 1,
      invalidInputs: [
        { suffix: "below-min", value: "0" },
        { suffix: "fractional", value: "1.5" }
      ]
    },
    {
      path: "ai.rateLimits.maxQueuedGlobal",
      valid: 1,
      invalidInputs: [
        { suffix: "below-min", value: "0" },
        { suffix: "fractional", value: "1.5" }
      ]
    }
  ];

  return definitions.flatMap((definition) =>
    definition.invalidInputs.map((invalidInput) => ({
      caseId: `popup.inline-invalid.${definition.path.replace(/^ai\./, "").replace(/\./g, "-")}.${invalidInput.suffix}`,
      group: "popup_inline_invalid_extra",
      prepare: "baseline",
      requiresSelectedModel: true,
      execute: async (context) => {
        const { driver } = context.session;
        await patchConfig(driver, buildPatchFromPath(definition.path, definition.valid));
        await openConfigTab(driver);
        const beforeControlState = await readPopupControlState(driver);
        await setInlineValue(driver, definition.path, invalidInput.value);
        const afterControlState = await readPopupControlState(driver);
        assert.ok(afterControlState.text.length > 0, `${definition.path} invalid inline edit did not produce a control message.`);
        assert.ok(
          afterControlState.text !== beforeControlState.text ||
            afterControlState.tone !== beforeControlState.tone ||
            afterControlState.tone.length > 0,
          `${definition.path} invalid inline edit did not visibly change popup control state.`
        );

        const snapshot = await getRuntimeSnapshot(driver);
        assertPathValueMatches(
          definition.path,
          readValueAtPath(snapshot.config, definition.path),
          definition.valid,
          `${definition.path} changed after an invalid inline edit.`
        );
        const buttonText = await assertButtonReflectsValue(driver, definition.path, definition.valid);
        return {
          configPath: definition.path,
          assertions: [
            "Popup inline editor surfaced a validation/control message for the invalid input.",
            "The last valid numeric value remained active after the invalid edit."
          ],
          artifacts: {
            controlState: afterControlState,
            buttonText
          }
        };
      }
    }))
  );
}

function createBalancedCases() {
  return [
    ...createUiRoundtripCases(),
    ...createHostSyncCases(),
    ...createScopePrecedenceCases(),
    ...createStatusReflectionCases(),
    ...createSessionManagementCases(),
    ...createLegacyCompatExtraCases(),
    ...createPopupModalCases(),
    ...createScopeResetExtraCases(),
    ...createInvalidPatchShapeExtraCases(),
    ...createPopupModalStateExtraCases(),
    ...createPopupInlineInvalidExtraCases(),
    ...createNumericBoundaryCases(),
    ...createModelSelectionCases(),
    ...createTransportCases(),
    ...createCompactionCases(),
    ...createQueueCases(),
    ...createRecoveryCases()
  ];
}

function createFallbackCases() {
  return [
    {
      caseId: "fallback.popup.ui-paths-sorted",
      group: "fallback_pool",
      prepare: "baseline",
      execute: async (context) => {
        const { driver } = context.session;
        await openConfigTab(driver);
        const actualPaths = await getPopupAiConfigPaths(driver);
        assert.deepEqual(actualPaths, [...AI_UI_PATHS].sort(), "Fallback UI paths case did not match the expected AI path registry.");
        return {
          assertions: ["Popup AI path registry remained stable."],
          artifacts: { actualPaths }
        };
      }
    },
    {
      caseId: "fallback.popup.chat-model-empty-when-no-allowed",
      group: "fallback_pool",
      prepare: "baseline",
      execute: async (context) => {
        const { driver } = context.session;
        await patchConfig(driver, { ai: { allowedModels: [] } });
        await openConfigTab(driver);
        await openConfigPanel(driver, "ai.chat.model");
        const messages = await readOpenModelPanelMessages(driver);
        assert.ok(messages.length > 0, "Chat model panel did not render any placeholder message when ai.allowedModels was empty.");
        return {
          assertions: ["Chat model panel rendered an empty-state placeholder."],
          artifacts: { messages }
        };
      }
    },
    {
      caseId: "fallback.popup.compaction-model-empty-when-no-allowed",
      group: "fallback_pool",
      prepare: "baseline",
      execute: async (context) => {
        const { driver } = context.session;
        await patchConfig(driver, { ai: { allowedModels: [] } });
        await openConfigTab(driver);
        await openConfigPanel(driver, "ai.compaction.modelOverride");
        const messages = await readOpenModelPanelMessages(driver);
        assert.ok(messages.length > 0, "Compaction model panel did not render any placeholder message when ai.allowedModels was empty.");
        return {
          assertions: ["Compaction model panel rendered an empty-state placeholder."],
          artifacts: { messages }
        };
      }
    },
    {
      caseId: "fallback.popup.chat-model-warning-outside-allowed",
      group: "fallback_pool",
      prepare: "baseline",
      requiresSelectedModel: true,
      requiresAlternateModel: true,
      execute: async (context) => {
        const { driver } = context.session;
        await patchConfig(driver, {
          ai: {
            allowedModels: [context.state.selectedModel],
            chat: {
              model: context.state.alternateModel
            }
          }
        });
        await openConfigTab(driver);
        await openConfigPanel(driver, "ai.chat.model");
        const messages = await readOpenModelPanelMessages(driver);
        assert.ok(messages.some((message) => message.includes("ai.allowedModels")), "Chat model warning did not mention ai.allowedModels.");
        return {
          assertions: ["Chat model panel warned about a value outside ai.allowedModels."],
          artifacts: { messages }
        };
      }
    },
    {
      caseId: "fallback.popup.compaction-model-warning-outside-allowed",
      group: "fallback_pool",
      prepare: "baseline",
      requiresSelectedModel: true,
      requiresAlternateModel: true,
      execute: async (context) => {
        const { driver } = context.session;
        await patchConfig(driver, {
          ai: {
            allowedModels: [context.state.selectedModel],
            compaction: {
              modelOverride: context.state.alternateModel
            }
          }
        });
        await openConfigTab(driver);
        await openConfigPanel(driver, "ai.compaction.modelOverride");
        const messages = await readOpenModelPanelMessages(driver);
        assert.ok(messages.some((message) => message.includes("ai.allowedModels")), "Compaction model warning did not mention ai.allowedModels.");
        return {
          assertions: ["Compaction model panel warned about a value outside ai.allowedModels."],
          artifacts: { messages }
        };
      }
    },
    {
      caseId: "fallback.popup.inline-invalid-trigger",
      group: "fallback_pool",
      prepare: "baseline",
      execute: async (context) => {
        const { driver } = context.session;
        await openConfigTab(driver);
        await setInlineValue(driver, "ai.compaction.triggerPromptTokens", "31");
        const state = await readPopupControlState(driver);
        assert.ok(state.text.length > 0, "Invalid triggerPromptTokens edit did not produce a control message.");
        return {
          assertions: ["Invalid triggerPromptTokens edit produced a popup control message."],
          artifacts: { controlState: state }
        };
      }
    },
    {
      caseId: "fallback.popup.inline-invalid-page-queue",
      group: "fallback_pool",
      prepare: "baseline",
      execute: async (context) => {
        const { driver } = context.session;
        await openConfigTab(driver);
        await setInlineValue(driver, "ai.rateLimits.maxQueuedPerPage", "0");
        const state = await readPopupControlState(driver);
        assert.ok(state.text.length > 0, "Invalid maxQueuedPerPage edit did not produce a control message.");
        return {
          assertions: ["Invalid maxQueuedPerPage edit produced a popup control message."],
          artifacts: { controlState: state }
        };
      }
    },
    {
      caseId: "fallback.popup.api-key-masked-button",
      group: "fallback_pool",
      prepare: "baseline",
      execute: async (context) => {
        const { driver } = context.session;
        await openConfigTab(driver);
        await setModalTextValue(driver, "ai.openAiApiKey", TEMP_MANAGED_API_KEY);
        const buttonText = await readButtonText(driver, "ai.openAiApiKey");
        assert.equal(buttonText.includes(TEMP_MANAGED_API_KEY), false, "Popup button leaked the managed API key.");
        return {
          assertions: ["Managed API key remained masked in the popup button."],
          artifacts: { buttonText }
        };
      }
    },
    {
      caseId: "fallback.legacy.allowed-models-strings",
      group: "fallback_pool",
      prepare: "baseline",
      execute: async (context) => runLegacyNormalizationCase(context, { ai: { allowedModels: ["gpt-5", "gpt-4.1"] } }, (config) => {
        assert.deepEqual(config.ai.allowedModels, [
          { model: "gpt-4.1", tier: "standard" },
          { model: "gpt-5", tier: "standard" }
        ]);
      })
    },
    {
      caseId: "fallback.legacy.chat-model-string",
      group: "fallback_pool",
      prepare: "baseline",
      execute: async (context) => runLegacyNormalizationCase(context, { ai: { chat: { model: "gpt-5" } } }, (config) => {
        assert.deepEqual(config.ai.chat.model, { model: "gpt-5", tier: "standard" });
      })
    },
    {
      caseId: "fallback.legacy.chat-model-tiered",
      group: "fallback_pool",
      prepare: "baseline",
      execute: async (context) => runLegacyNormalizationCase(context, { ai: { model: "gpt-4.1", serviceTier: "priority" } }, (config) => {
        assert.deepEqual(config.ai.chat.model, { model: "gpt-4.1", tier: "priority" });
      })
    },
    {
      caseId: "fallback.legacy.compaction-model-string-tiered",
      group: "fallback_pool",
      prepare: "baseline",
      execute: async (context) => runLegacyNormalizationCase(context, { ai: { serviceTier: "flex", compaction: { modelOverride: "gpt-5-mini" } } }, (config) => {
        assert.deepEqual(config.ai.compaction.modelOverride, { model: "gpt-5-mini", tier: "flex" });
      })
    },
    {
      caseId: "fallback.legacy.ai-streaming-to-chat",
      group: "fallback_pool",
      prepare: "baseline",
      execute: async (context) => runLegacyNormalizationCase(context, { ai: { streamingEnabled: false } }, (config) => {
        assert.equal(config.ai.chat.streamingEnabled, false);
      })
    },
    {
      caseId: "fallback.legacy.ai-instructions-to-chat",
      group: "fallback_pool",
      prepare: "baseline",
      execute: async (context) => runLegacyNormalizationCase(context, { ai: { instructions: "legacy chat instructions" } }, (config) => {
        assert.equal(config.ai.chat.instructions, "legacy chat instructions");
      })
    },
    {
      caseId: "fallback.legacy.structured-partial-merge",
      group: "fallback_pool",
      prepare: "baseline",
      execute: async (context) => runLegacyNormalizationCase(context, { ai: { chat: { structuredOutput: { description: "legacy partial" } } } }, (config) => {
        assert.equal(config.ai.chat.structuredOutput.description, "legacy partial");
        assert.equal(config.ai.chat.structuredOutput.name.length > 0, true);
      })
    },
    {
      caseId: "fallback.legacy.rate-limit-unknown-fields-dropped",
      group: "fallback_pool",
      prepare: "baseline",
      execute: async (context) => runLegacyNormalizationCase(context, { ai: { rateLimits: { reserveOutputTokens: 4096, localRpmCap: 1, localTpmCap: 2 } } }, (config) => {
        assert.equal(config.ai.rateLimits.reserveOutputTokens, 4096);
        assert.equal("localRpmCap" in config.ai.rateLimits, false);
        assert.equal("localTpmCap" in config.ai.rateLimits, false);
      })
    },
    {
      caseId: "fallback.idle.status-initial",
      group: "fallback_pool",
      prepare: "baseline",
      execute: async (context) => {
        const pageUrl = createCaseUrl(context.session, "fallback-idle-initial");
        const status = await getAiStatus(context.session.driver, pageUrl);
        assert.equal(status.status.requestState, "idle", "Initial idle status case did not report idle.");
        return {
          pageUrl,
          pageKey: normalizePageKey(pageUrl),
          assertions: ["Fresh ai.chat.status reported idle."]
        };
      }
    },
    {
      caseId: "fallback.idle.list-array",
      group: "fallback_pool",
      prepare: "baseline",
      execute: async (context) => {
        const listResult = await sendCommand(context.session.driver, COMMANDS.aiChatList, {});
        assert.ok(Array.isArray(listResult.sessions), "Fallback ai.chat.list did not return an array.");
        return {
          assertions: ["Fallback ai.chat.list returned an array."],
          artifacts: { sessionCount: listResult.sessions.length }
        };
      }
    },
    {
      caseId: "fallback.idle.reset-all-no-crash",
      group: "fallback_pool",
      prepare: "baseline",
      execute: async (context) => {
        await resetAllSessions(context.session.driver);
        return {
          assertions: ["resetAllSessions completed without crashing."]
        };
      }
    },
    {
      caseId: "fallback.idle.status-after-reset-all",
      group: "fallback_pool",
      prepare: "baseline",
      execute: async (context) => {
        await resetAllSessions(context.session.driver);
        const pageUrl = createCaseUrl(context.session, "fallback-idle-after-reset");
        const status = await getAiStatus(context.session.driver, pageUrl);
        assert.equal(status.status.requestState, "idle", "Idle-after-reset case did not report idle.");
        return {
          pageUrl,
          pageKey: normalizePageKey(pageUrl),
          assertions: ["ai.chat.status remained idle after resetAllSessions."]
        };
      }
    },
    {
      caseId: "fallback.reporting.native-host-state-readable",
      group: "fallback_pool",
      prepare: "baseline",
      execute: async () => {
        const nativeState = await readNativeHostState();
        assert.ok(nativeState?.aiConfig, "Fallback native-host-state case could not read aiConfig.");
        return {
          assertions: ["native-host-state.json remained readable."],
          artifacts: { hasAiConfig: true }
        };
      }
    },
    {
      caseId: "fallback.reporting.control-message-valid",
      group: "fallback_pool",
      prepare: "baseline",
      execute: async (context) => {
        const { driver } = context.session;
        await openConfigTab(driver);
        await setInlineValue(driver, "ai.rateLimits.maxQueuedPerPage", "2");
        const state = await readPopupControlState(driver);
        assert.ok(state.text.length > 0, "Valid popup control message case did not produce text.");
        return {
          assertions: ["Valid popup edit produced a control message."],
          artifacts: { controlState: state }
        };
      }
    },
    {
      caseId: "fallback.reporting.control-message-invalid",
      group: "fallback_pool",
      prepare: "baseline",
      execute: async (context) => {
        const { driver } = context.session;
        await openConfigTab(driver);
        await setInlineValue(driver, "ai.compaction.maxPassesPerPage", "0");
        const state = await readPopupControlState(driver);
        assert.ok(state.text.length > 0, "Invalid popup control message case did not produce text.");
        return {
          assertions: ["Invalid popup edit produced a control message."],
          artifacts: { controlState: state }
        };
      }
    },
    {
      caseId: "fallback.reporting.config-get-shape",
      group: "fallback_pool",
      prepare: "baseline",
      execute: async (context) => {
        const snapshot = await getRuntimeSnapshot(context.session.driver);
        assert.ok(snapshot?.config?.ai, "config.get did not expose config.ai.");
        assert.ok(snapshot?.config?.logging, "config.get did not expose config.logging.");
        assert.ok(snapshot?.config?.runtime, "config.get did not expose config.runtime.");
        return {
          assertions: ["config.get returned the expected top-level shape."]
        };
      }
    }
  ];
}

async function applyUiPathValue(context, definition, value) {
  const { driver } = context.session;
  await openConfigTab(driver);

  if (definition.path === "ai.openAiApiKey") {
    await setModalTextValue(driver, definition.path, value);
    await waitFor(async () => {
      const currentValue = await getUserEnvironmentVariableAsync(OPENAI_API_KEY_ENV_VAR_NAME);
      return currentValue === value;
    }, 15000, "Saving ai.openAiApiKey did not update the user environment variable.");
    return;
  }

  if (definition.editor === "allowed-models") {
    await setAllowedModel(driver, context.state.selectedModel.model, context.state.selectedModel.tier);
    if (context.state.alternateModel) {
      await setAllowedModel(driver, context.state.alternateModel.model, context.state.alternateModel.tier);
    }
    return;
  }

  if (definition.editor === "model-select") {
    await ensureAllowedModelsForSelection(driver, context.state, value);
    await setModelPanelValue(driver, definition.path, value.model, value.tier);
    return;
  }

  if (definition.editor === "modal") {
    await setModalTextValue(driver, definition.path, value);
    return;
  }

  if (definition.editor === "select") {
    await setSelectValue(driver, definition.path, String(value));
    return;
  }

  if (definition.editor === "inline") {
    await setInlineValue(driver, definition.path, String(value));
    return;
  }

  throw new Error(`Unsupported editor type for ${definition.path}: ${definition.editor}`);
}

async function runUiRoundtripCase(context, definition) {
  const { driver } = context.session;
  const value = definition.getValue(context.state);

  if (popupModelCatalogUnavailable(context.state) && (definition.editor === "allowed-models" || definition.editor === "model-select")) {
    throwSkip("Catalog selection failed, so popup model catalog controls cannot be verified.");
  }

  await applyUiPathValue(context, definition, value);

  const snapshot = await getRuntimeSnapshot(driver);
  const actualValue = readValueAtPath(snapshot.config, definition.path);
  assertPathValueMatches(definition.path, actualValue, value, `${definition.path} did not persist after UI edit.`);
  const buttonText = await assertButtonReflectsValue(driver, definition.path, value);

  return {
    configPath: definition.path,
    configPatch: buildPatchFromPath(definition.path, value),
    assertions: [
      "UI editor applied the target value.",
      "config.get returned the same value.",
      "Popup button text reflected the updated state."
    ],
    artifacts: {
      buttonText
    }
  };
}

async function runHostSyncCase(context, definition) {
  const { driver } = context.session;
  const value = definition.getValue(context.state);

  if (definition.path === "ai.openAiApiKey") {
    await patchConfig(driver, buildPatchFromPath(definition.path, value));
    await waitFor(async () => {
      const currentValue = await getUserEnvironmentVariableAsync(OPENAI_API_KEY_ENV_VAR_NAME);
      return currentValue === value;
    }, 15000, "Managed OPENAI_API_KEY did not update after config.patch.");
  } else {
    if (definition.editor === "model-select") {
      await ensureAllowedModelsForSelection(driver, context.state, value);
    }
    await patchConfig(driver, buildPatchFromPath(definition.path, value));
  }

  const snapshot = await getRuntimeSnapshot(driver);
  const actualValue = readValueAtPath(snapshot.config, definition.path);
  assertPathValueMatches(definition.path, actualValue, value, `config.get did not reflect ${definition.path}.`);
  const buttonText = await assertButtonReflectsValue(driver, definition.path, value);
  const hostDetails = await verifyHostValue(definition.path, value, context.state);

  return {
    configPath: definition.path,
    configPatch: buildPatchFromPath(definition.path, value),
    assertions: [
      "config.patch accepted the payload.",
      "config.get reflected the patched value.",
      "Popup button text was refreshed.",
      "Native host state matched the expected value semantics."
    ],
    artifacts: {
      buttonText,
      hostDetails
    }
  };
}

async function runNumericBoundaryCase(context, boundarySpec) {
  const { driver } = context.session;
  const validPatch = buildPatchFromPath(boundarySpec.path, boundarySpec.valid);
  await patchConfig(driver, validPatch);
  const validSnapshot = await getRuntimeSnapshot(driver);
  assertPathValueMatches(
    boundarySpec.path,
    readValueAtPath(validSnapshot.config, boundarySpec.path),
    boundarySpec.valid,
    `${boundarySpec.path} did not accept the minimum valid value.`
  );

  const errorResult = await patchConfigExpectingError(driver, buildPatchFromPath(boundarySpec.path, boundarySpec.invalid));
  const finalSnapshot = await getRuntimeSnapshot(driver);
  assertPathValueMatches(
    boundarySpec.path,
    readValueAtPath(finalSnapshot.config, boundarySpec.path),
    boundarySpec.valid,
    `${boundarySpec.path} changed after an invalid boundary patch.`
  );

  return {
    configPath: boundarySpec.path,
    configPatch: {
      valid: validPatch,
      invalid: buildPatchFromPath(boundarySpec.path, boundarySpec.invalid)
    },
    assertions: [
      "Minimum valid numeric value was accepted.",
      "Below-min numeric value was rejected.",
      "The last valid value remained active after rejection."
    ],
    artifacts: {
      errorMessage: errorResult.message
    }
  };
}

function createUiRoundtripCases() {
  return getPathCaseDefinitions().map((definition) => ({
    caseId: `ui.roundtrip.${definition.path.replace(/^ai\./, "").replace(/\./g, "-")}`,
    group: "ui_roundtrip",
    prepare: "baseline",
    requiresSelectedModel: Boolean(definition.requiresSelectedModel),
    requiresAlternateModel: Boolean(definition.requiresAlternateModel),
    usesModelCatalog: Boolean(definition.usesModelCatalog),
    execute: (context) => runUiRoundtripCase(context, definition)
  }));
}

function createHostSyncCases() {
  return getPathCaseDefinitions().map((definition) => ({
    caseId: `host.sync.${definition.path.replace(/^ai\./, "").replace(/\./g, "-")}`,
    group: "host_sync",
    prepare: "baseline",
    requiresSelectedModel: Boolean(definition.requiresSelectedModel),
    requiresAlternateModel: Boolean(definition.requiresAlternateModel),
    usesModelCatalog: Boolean(definition.usesModelCatalog),
    execute: (context) => runHostSyncCase(context, definition)
  }));
}

function createScopePrecedenceCases() {
  const specs = [
    {
      path: "ai.chat.instructions",
      localValue: "Local scope chat instructions.\nKeep the local token exact.",
      sessionValue: "Session scope chat instructions.\nSession wins over local."
    },
    {
      path: "ai.chat.streamingEnabled",
      localValue: false,
      sessionValue: true
    },
    {
      path: "ai.chat.structuredOutput.strict",
      localValue: false,
      sessionValue: true
    },
    {
      path: "ai.compaction.enabled",
      localValue: false,
      sessionValue: true
    },
    {
      path: "ai.compaction.instructions",
      localValue: "Local scope compaction instructions.",
      sessionValue: "Session scope compaction instructions."
    },
    {
      path: "ai.rateLimits.maxQueuedGlobal",
      localValue: 1,
      sessionValue: 3
    }
  ];

  return specs.flatMap((spec) => {
    const caseSuffix = spec.path.replace(/^ai\./, "").replace(/\./g, "-");
    return [
      {
        caseId: `scope.precedence.${caseSuffix}.session-overrides-local`,
        group: "scope_precedence",
        prepare: "baseline",
        requiresSelectedModel: true,
        execute: async (context) => {
          const { driver } = context.session;
          await patchConfigForScope(driver, "local", buildPatchFromPath(spec.path, spec.localValue));
          await patchConfigForScope(driver, "session", buildPatchFromPath(spec.path, spec.sessionValue));
          const snapshot = await getRuntimeSnapshot(driver);
          const actualValue = readValueAtPath(snapshot.config, spec.path);
          assertPathValueMatches(spec.path, actualValue, spec.sessionValue, `${spec.path} session override did not win over local scope.`);
          const buttonText = await assertButtonReflectsValue(driver, spec.path, spec.sessionValue);
          return {
            configPath: spec.path,
            assertions: ["Session scope override won over the local scope value."],
            artifacts: {
              buttonText
            }
          };
        }
      },
      {
        caseId: `scope.precedence.${caseSuffix}.session-aligned-restores-effective-local`,
        group: "scope_precedence",
        prepare: "baseline",
        requiresSelectedModel: true,
        execute: async (context) => {
          const { driver } = context.session;
          await patchConfigForScope(driver, "local", buildPatchFromPath(spec.path, spec.localValue));
          await patchConfigForScope(driver, "session", buildPatchFromPath(spec.path, spec.sessionValue));
          await patchConfigForScope(driver, "session", buildPatchFromPath(spec.path, spec.localValue));
          const snapshot = await getRuntimeSnapshot(driver);
          const actualValue = readValueAtPath(snapshot.config, spec.path);
          assertPathValueMatches(spec.path, actualValue, spec.localValue, `${spec.path} effective value did not return to the local value after aligning the session scope.`);
          return {
            configPath: spec.path,
            assertions: ["Aligning the session scope with the local value restored the effective config."],
            artifacts: {
              effectiveValue: actualValue
            }
          };
        }
      }
    ];
  });
}

function createStatusReflectionCases() {
  return [
    {
      caseId: "status.reflection.baseline-can-send",
      group: "status_reflection",
      prepare: "baseline",
      requiresSelectedModel: true,
      execute: async (context) => {
        const pageUrl = createCaseUrl(context.session, "status-baseline-can-send");
        const status = await getAiStatus(context.session.driver, pageUrl);
        assert.equal(status.status.provider, "openai", "Baseline status provider was not openai.");
        assert.equal(status.status.requestState, "idle", "Baseline status was not idle.");
        assert.equal(status.status.availableActions.canSend, Boolean(context.state.originalUserApiKey), "Baseline canSend did not reflect API key availability.");
        return {
          pageUrl,
          pageKey: normalizePageKey(pageUrl),
          assertions: ["Baseline ai.chat.status remained idle and send availability matched the environment key state."]
        };
      }
    },
    {
      caseId: "status.reflection.streaming-off",
      group: "status_reflection",
      prepare: "baseline",
      requiresSelectedModel: true,
      execute: async (context) => {
        await patchConfig(context.session.driver, { ai: { chat: { streamingEnabled: false } } });
        const pageUrl = createCaseUrl(context.session, "status-streaming-off");
        const status = await getAiStatus(context.session.driver, pageUrl);
        assert.equal(status.status.streamingEnabled, false, "Status did not reflect ai.chat.streamingEnabled=false.");
        return {
          assertions: ["ai.chat.status reflected streamingEnabled=false."]
        };
      }
    },
    {
      caseId: "status.reflection.structured-on-strict-false",
      group: "status_reflection",
      prepare: "baseline",
      requiresSelectedModel: true,
      execute: async (context) => {
        await patchConfig(context.session.driver, {
          ai: {
            chat: {
              structuredOutput: {
                name: "status_structured_matrix",
                description: "Status reflection structured output case.",
                schema: STRUCTURED_SCHEMA,
                strict: false
              }
            }
          }
        });
        const pageUrl = createCaseUrl(context.session, "status-structured-on");
        const status = await getAiStatus(context.session.driver, pageUrl);
        assert.equal(status.status.structuredOutputEnabled, true, "Status did not enable structured output.");
        assert.equal(status.status.structuredOutputName, "status_structured_matrix", "Status did not expose the structured output name.");
        assert.equal(status.status.structuredOutputStrict, false, "Status did not expose structuredOutput.strict=false.");
        return {
          assertions: ["ai.chat.status reflected structured output enablement, name, and strict=false."]
        };
      }
    },
    {
      caseId: "status.reflection.structured-off",
      group: "status_reflection",
      prepare: "baseline",
      requiresSelectedModel: true,
      execute: async (context) => {
        await patchConfig(context.session.driver, {
          ai: {
            chat: {
              structuredOutput: {
                schema: ""
              }
            }
          }
        });
        const pageUrl = createCaseUrl(context.session, "status-structured-off");
        const status = await getAiStatus(context.session.driver, pageUrl);
        assert.equal(status.status.structuredOutputEnabled, false, "Status still reported structured output as enabled.");
        return {
          assertions: ["ai.chat.status disabled structured output after clearing the schema."]
        };
      }
    },
    {
      caseId: "status.reflection.model-alternate",
      group: "status_reflection",
      prepare: "baseline",
      requiresSelectedModel: true,
      requiresAlternateModel: true,
      execute: async (context) => {
        await patchConfig(context.session.driver, {
          ai: {
            allowedModels: sortModelRules([context.state.selectedModel, context.state.alternateModel]),
            chat: {
              model: context.state.alternateModel
            }
          }
        });
        const pageUrl = createCaseUrl(context.session, "status-model-alternate");
        const status = await getAiStatus(context.session.driver, pageUrl);
        assert.deepEqual(status.status.model, context.state.alternateModel, "Status did not expose the alternate chat model.");
        return {
          assertions: ["ai.chat.status reflected the alternate configured model."]
        };
      }
    },
    {
      caseId: "status.reflection.model-unset",
      group: "status_reflection",
      prepare: "baseline",
      requiresSelectedModel: true,
      execute: async (context) => {
        await patchConfig(context.session.driver, {
          ai: {
            chat: {
              model: null
            }
          }
        });
        const pageUrl = createCaseUrl(context.session, "status-model-unset");
        const status = await getAiStatus(context.session.driver, pageUrl);
        assert.equal(status.status.model, null, "Status model was not cleared.");
        assert.equal(status.status.availableActions.canSend, false, "Status still allowed sending with no model configured.");
        return {
          assertions: ["ai.chat.status disabled canSend when the model was unset."]
        };
      }
    },
    {
      caseId: "status.reflection.api-key-missing",
      group: "status_reflection",
      prepare: "baseline",
      requiresSelectedModel: true,
      execute: async (context) => {
        await patchConfig(context.session.driver, {
          ai: {
            openAiApiKey: ""
          }
        });
        const pageUrl = createCaseUrl(context.session, "status-api-key-missing");
        const status = await getAiStatus(context.session.driver, pageUrl);
        assert.equal(status.status.apiKeyPresent, false, "Status still reported an API key as present.");
        assert.equal(status.status.availableActions.canSend, false, "Status still allowed sending with no API key.");
        return {
          assertions: ["ai.chat.status disabled send availability when the API key was cleared."]
        };
      }
    },
    {
      caseId: "status.reflection.queue-count-zero",
      group: "status_reflection",
      prepare: "baseline",
      requiresSelectedModel: true,
      execute: async (context) => {
        const pageUrl = createCaseUrl(context.session, "status-queue-zero");
        const status = await getAiStatus(context.session.driver, pageUrl);
        assert.equal(status.status.queueCount, 0, "Fresh ai.chat.status did not start at queueCount=0.");
        return {
          assertions: ["Fresh ai.chat.status started with queueCount=0."]
        };
      }
    },
    {
      caseId: "status.reflection.current-budget-shape",
      group: "status_reflection",
      prepare: "baseline",
      requiresSelectedModel: true,
      execute: async (context) => {
        if (isProviderCatalogBlocked(context.state)) {
          throwSkip("OpenAI provider access is region-blocked, so current model budget telemetry cannot be verified.");
        }

        const pageUrl = createCaseUrl(context.session, "status-current-budget");
        const status = await getAiStatus(context.session.driver, pageUrl);
        assert.equal(status.status.currentModelBudget?.model, context.state.selectedModel.model, "Current model budget did not match the selected model.");
        assert.ok("serverRemainingTokens" in (status.status.currentModelBudget ?? {}), "Current model budget did not expose serverRemainingTokens.");
        return {
          assertions: ["ai.chat.status exposed currentModelBudget telemetry for the selected model."]
        };
      }
    },
    {
      caseId: "status.reflection.page-key-normalized",
      group: "status_reflection",
      prepare: "baseline",
      requiresSelectedModel: true,
      execute: async (context) => {
        const rawUrl = `${createCaseUrl(context.session, "status-page-key")}?variant=1#fragment`;
        const status = await getAiStatus(context.session.driver, rawUrl);
        assert.equal(status.pageKey, normalizePageKey(rawUrl), "Status did not expose the normalized pageKey.");
        return {
          assertions: ["ai.chat.status exposed a normalized pageKey for query/hash variants."]
        };
      }
    }
  ];
}

function createSessionManagementCases() {
  return [
    {
      caseId: "session.management.repeated-status-single-entry",
      group: "session_management",
      prepare: "baseline",
      execute: async (context) => {
        const pageUrl = createCaseUrl(context.session, "session-repeat-status");
        const pageKey = normalizePageKey(pageUrl);
        await getAiStatus(context.session.driver, pageUrl);
        await getAiStatus(context.session.driver, pageUrl);
        const listResult = await sendCommand(context.session.driver, COMMANDS.aiChatList, {});
        assert.equal(listResult.sessions.filter((item) => item.pageKey === pageKey).length, 1, "Repeated status calls created duplicate list entries.");
        return {
          assertions: ["Repeated ai.chat.status calls kept a single session entry for the page."]
        };
      }
    },
    {
      caseId: "session.management.normalized-variants-share-entry",
      group: "session_management",
      prepare: "baseline",
      execute: async (context) => {
        const baseUrl = createCaseUrl(context.session, "session-normalized");
        const variantA = `${baseUrl}?seed=1`;
        const variantB = `${baseUrl}?copy=1#fragment`;
        const pageKey = normalizePageKey(variantA);
        await getAiStatus(context.session.driver, variantA);
        await getAiStatus(context.session.driver, variantB);
        const listResult = await sendCommand(context.session.driver, COMMANDS.aiChatList, {});
        assert.equal(listResult.sessions.filter((item) => item.pageKey === pageKey).length, 1, "Normalized URL variants produced duplicate sessions.");
        return {
          assertions: ["Query/hash variants reused a single normalized page session."]
        };
      }
    },
    {
      caseId: "session.management.distinct-pages-create-distinct-entries",
      group: "session_management",
      prepare: "baseline",
      execute: async (context) => {
        const pageUrlA = createCaseUrl(context.session, "session-distinct-a");
        const pageUrlB = createCaseUrl(context.session, "session-distinct-b");
        await getAiStatus(context.session.driver, pageUrlA);
        await getAiStatus(context.session.driver, pageUrlB);
        const listResult = await sendCommand(context.session.driver, COMMANDS.aiChatList, {});
        const pageKeys = new Set(listResult.sessions.map((item) => item.pageKey));
        assert.ok(pageKeys.has(normalizePageKey(pageUrlA)) && pageKeys.has(normalizePageKey(pageUrlB)), "Distinct pages were not represented in ai.chat.list.");
        return {
          assertions: ["Distinct normalized pages produced distinct ai.chat.list entries."]
        };
      }
    },
    {
      caseId: "session.management.list-order-sorted",
      group: "session_management",
      prepare: "baseline",
      execute: async (context) => {
        const createdUrls = [
          createCaseUrl(context.session, "session-sort-c"),
          createCaseUrl(context.session, "session-sort-a"),
          createCaseUrl(context.session, "session-sort-b")
        ];
        for (const url of createdUrls) {
          await getAiStatus(context.session.driver, url);
        }
        const expectedOrder = createdUrls.map((url) => normalizePageKey(url)).sort();
        const listResult = await sendCommand(context.session.driver, COMMANDS.aiChatList, {});
        const actualOrder = listResult.sessions
          .map((item) => item.pageKey)
          .filter((pageKey) => expectedOrder.includes(pageKey));
        assert.deepEqual(actualOrder, expectedOrder, "ai.chat.list was not sorted by pageKey.");
        return {
          assertions: ["ai.chat.list remained sorted by pageKey."]
        };
      }
    },
    {
      caseId: "session.management.reset-idle-records-reset",
      group: "session_management",
      prepare: "baseline",
      execute: async (context) => {
        const pageUrl = createCaseUrl(context.session, "session-reset-idle");
        const pageKey = normalizePageKey(pageUrl);
        await getAiStatus(context.session.driver, pageUrl);
        await sendCommand(context.session.driver, COMMANDS.aiChatReset, { pageKey });
        const status = await getAiStatus(context.session.driver, pageUrl);
        assert.equal(status.status.requestState, "idle", "Reset idle session did not remain idle.");
        assert.equal(status.messages.length, 0, "Reset idle session did not clear the transcript.");
        return {
          assertions: ["Resetting an idle session cleared the transcript and left the page idle."]
        };
      }
    },
    {
      caseId: "session.management.double-reset-single-marker",
      group: "session_management",
      prepare: "baseline",
      execute: async (context) => {
        const pageUrl = createCaseUrl(context.session, "session-double-reset");
        const pageKey = normalizePageKey(pageUrl);
        await getAiStatus(context.session.driver, pageUrl);
        await sendCommand(context.session.driver, COMMANDS.aiChatReset, { pageKey });
        await sendCommand(context.session.driver, COMMANDS.aiChatReset, { pageKey });
        const status = await getAiStatus(context.session.driver, pageUrl);
        assert.equal(status.messages.length, 0, "Double reset did not preserve an empty transcript.");
        return {
          assertions: ["Repeated reset preserved an empty transcript."]
        };
      }
    },
    {
      caseId: "session.management.reset-one-page-keeps-sibling-untouched",
      group: "session_management",
      prepare: "baseline",
      execute: async (context) => {
        const pageUrlA = createCaseUrl(context.session, "session-reset-a");
        const pageUrlB = createCaseUrl(context.session, "session-reset-b");
        await getAiStatus(context.session.driver, pageUrlA);
        await getAiStatus(context.session.driver, pageUrlB);
        await sendCommand(context.session.driver, COMMANDS.aiChatReset, { pageKey: normalizePageKey(pageUrlA) });
        const siblingStatus = await getAiStatus(context.session.driver, pageUrlB);
        assert.equal(siblingStatus.messages.length, 0, "Resetting one page affected the sibling session history.");
        return {
          assertions: ["Resetting one page left an idle sibling session untouched."]
        };
      }
    },
    {
      caseId: "session.management.reset-all-after-idle-pages",
      group: "session_management",
      prepare: "baseline",
      execute: async (context) => {
        const pageUrlA = createCaseUrl(context.session, "session-reset-all-a");
        const pageUrlB = createCaseUrl(context.session, "session-reset-all-b");
        await getAiStatus(context.session.driver, pageUrlA);
        await getAiStatus(context.session.driver, pageUrlB);
        await resetAllSessions(context.session.driver);
        const statusA = await getAiStatus(context.session.driver, pageUrlA);
        const statusB = await getAiStatus(context.session.driver, pageUrlB);
        assert.equal(statusA.messages.length, 0, "resetAllSessions did not clear the transcript for page A.");
        assert.equal(statusB.messages.length, 0, "resetAllSessions did not clear the transcript for page B.");
        return {
          assertions: ["resetAllSessions reset multiple idle page sessions."]
        };
      }
    },
    {
      caseId: "session.management.page-url-sample-preserved",
      group: "session_management",
      prepare: "baseline",
      execute: async (context) => {
        const rawUrl = `${createCaseUrl(context.session, "session-page-url-sample")}?variant=1#fragment`;
        const status = await getAiStatus(context.session.driver, rawUrl);
        assert.equal(status.pageUrlSample, rawUrl, "ai.chat.status did not preserve the pageUrlSample.");
        return {
          assertions: ["ai.chat.status preserved the original pageUrlSample."]
        };
      }
    },
    {
      caseId: "session.management.status-after-reset-same-pagekey",
      group: "session_management",
      prepare: "baseline",
      execute: async (context) => {
        const pageUrl = createCaseUrl(context.session, "session-reset-same-pagekey");
        const pageKey = normalizePageKey(pageUrl);
        await getAiStatus(context.session.driver, pageUrl);
        await sendCommand(context.session.driver, COMMANDS.aiChatReset, { pageKey });
        const status = await getAiStatus(context.session.driver, pageUrl);
        assert.equal(status.pageKey, pageKey, "Status after reset changed the pageKey.");
        return {
          assertions: ["Status after reset preserved the normalized pageKey."]
        };
      }
    },
    {
      caseId: "session.management.reset-without-prior-status-creates-session",
      group: "session_management",
      prepare: "baseline",
      execute: async (context) => {
        const pageUrl = createCaseUrl(context.session, "session-reset-empty");
        const pageKey = normalizePageKey(pageUrl);
        await sendCommand(context.session.driver, COMMANDS.aiChatReset, { pageKey });
        const status = await getAiStatus(context.session.driver, pageUrl);
        assert.equal(status.status.requestState, "idle", "Reset without prior status did not create an idle session.");
        assert.equal(status.messages.length, 0, "Reset without prior status did not keep the transcript empty.");
        return {
          assertions: ["ai.chat.reset created an idle empty session even for a previously unseen page."]
        };
      }
    },
    {
      caseId: "session.management.count-grows-by-distinct-normalized-pages",
      group: "session_management",
      prepare: "baseline",
      execute: async (context) => {
        const baseUrl = createCaseUrl(context.session, "session-count-base");
        const distinctUrl = createCaseUrl(context.session, "session-count-distinct");
        await getAiStatus(context.session.driver, `${baseUrl}?a=1`);
        await getAiStatus(context.session.driver, `${baseUrl}?b=2#hash`);
        await getAiStatus(context.session.driver, distinctUrl);
        const listResult = await sendCommand(context.session.driver, COMMANDS.aiChatList, {});
        const relevantPageKeys = listResult.sessions
          .map((item) => item.pageKey)
          .filter((pageKey) => pageKey === normalizePageKey(baseUrl) || pageKey === normalizePageKey(distinctUrl));
        assert.equal(relevantPageKeys.length, 2, "Distinct normalized pages did not produce the expected session count.");
        return {
          assertions: ["Session count grew only for distinct normalized pages."]
        };
      }
    }
  ];
}

function createLegacyCompatExtraCases() {
  return [
    {
      caseId: "legacy.extra.allowed-model-priority-string",
      group: "legacy_compat_extra",
      prepare: "baseline",
      execute: async (context) => runLegacyNormalizationCase(context, { ai: { serviceTier: "priority", allowedModels: ["gpt-5-mini"] } }, (config) => {
        assert.deepEqual(config.ai.allowedModels, [{ model: "gpt-5-mini", tier: "standard" }]);
      })
    },
    {
      caseId: "legacy.extra.allowed-model-flex-string",
      group: "legacy_compat_extra",
      prepare: "baseline",
      execute: async (context) => runLegacyNormalizationCase(context, { ai: { serviceTier: "flex", allowedModels: ["gpt-4.1-mini"] } }, (config) => {
        assert.deepEqual(config.ai.allowedModels, [{ model: "gpt-4.1-mini", tier: "standard" }]);
      })
    },
    {
      caseId: "legacy.extra.allowed-model-object-preserved",
      group: "legacy_compat_extra",
      prepare: "baseline",
      execute: async (context) => runLegacyNormalizationCase(context, { ai: { allowedModels: [{ model: "gpt-4.1", tier: "flex" }] } }, (config) => {
        assert.deepEqual(config.ai.allowedModels, [{ model: "gpt-4.1", tier: "flex" }]);
      })
    },
    {
      caseId: "legacy.extra.chat-model-null-preserved",
      group: "legacy_compat_extra",
      prepare: "baseline",
      execute: async (context) => runLegacyNormalizationCase(context, { ai: { chat: { model: null } } }, (config) => {
        assert.equal(config.ai.chat.model, null);
      })
    },
    {
      caseId: "legacy.extra.compaction-model-null-preserved",
      group: "legacy_compat_extra",
      prepare: "baseline",
      execute: async (context) => runLegacyNormalizationCase(context, { ai: { compaction: { modelOverride: null } } }, (config) => {
        assert.equal(config.ai.compaction.modelOverride, null);
      })
    },
    {
      caseId: "legacy.extra.service-tier-does-not-clobber-chat-object",
      group: "legacy_compat_extra",
      prepare: "baseline",
      execute: async (context) => runLegacyNormalizationCase(context, { ai: { serviceTier: "priority", chat: { model: { model: "gpt-5", tier: "flex" } } } }, (config) => {
        assert.deepEqual(config.ai.chat.model, { model: "gpt-5", tier: "flex" });
      })
    },
    {
      caseId: "legacy.extra.service-tier-does-not-clobber-compaction-object",
      group: "legacy_compat_extra",
      prepare: "baseline",
      execute: async (context) => runLegacyNormalizationCase(context, { ai: { serviceTier: "priority", compaction: { modelOverride: { model: "gpt-5-mini", tier: "flex" } } } }, (config) => {
        assert.deepEqual(config.ai.compaction.modelOverride, { model: "gpt-5-mini", tier: "flex" });
      })
    },
    {
      caseId: "legacy.extra.structured-name-only",
      group: "legacy_compat_extra",
      prepare: "baseline",
      execute: async (context) => runLegacyNormalizationCase(context, { ai: { chat: { structuredOutput: { name: "legacy_name_only" } } } }, (config) => {
        assert.equal(config.ai.chat.structuredOutput.name, "legacy_name_only");
      })
    },
    {
      caseId: "legacy.extra.structured-strict-only",
      group: "legacy_compat_extra",
      prepare: "baseline",
      execute: async (context) => runLegacyNormalizationCase(context, { ai: { chat: { structuredOutput: { strict: false } } } }, (config) => {
        assert.equal(config.ai.chat.structuredOutput.strict, false);
      })
    },
    {
      caseId: "legacy.extra.structured-schema-only",
      group: "legacy_compat_extra",
      prepare: "baseline",
      execute: async (context) => runLegacyNormalizationCase(context, { ai: { chat: { structuredOutput: { schema: "{\"type\":\"object\"}" } } } }, (config) => {
        assert.equal(config.ai.chat.structuredOutput.schema, "{\"type\":\"object\"}");
      })
    },
    {
      caseId: "legacy.extra.compaction-enabled-only",
      group: "legacy_compat_extra",
      prepare: "baseline",
      execute: async (context) => runLegacyNormalizationCase(context, { ai: { compaction: { enabled: false } } }, (config) => {
        assert.equal(config.ai.compaction.enabled, false);
      })
    },
    {
      caseId: "legacy.extra.rate-limit-page-only",
      group: "legacy_compat_extra",
      prepare: "baseline",
      execute: async (context) => runLegacyNormalizationCase(context, { ai: { rateLimits: { maxQueuedPerPage: 5 } } }, (config) => {
        assert.equal(config.ai.rateLimits.maxQueuedPerPage, 5);
        assert.equal(config.ai.rateLimits.maxQueuedGlobal, 3);
      })
    }
  ];
}

function createPopupModalCases() {
  return [
    "ai.chat.instructions",
    "ai.chat.structuredOutput.description",
    "ai.chat.structuredOutput.schema",
    "ai.compaction.instructions"
  ].map((configPath) => ({
    caseId: `popup.modal.${configPath.replace(/^ai\./, "").replace(/\./g, "-")}.open-close`,
    group: "popup_modal",
    prepare: "baseline",
    execute: async (context) => {
      const { driver } = context.session;
      await openConfigTab(driver);
      await openConfigPanel(driver, configPath);
      await closePopupModal(driver);
      const buttonText = await readButtonText(driver, configPath);
      return {
        configPath,
        assertions: ["Popup modal opened and closed cleanly without losing the button state."],
        artifacts: {
          buttonText
        }
      };
    }
  }));
}

function createNumericBoundaryCases() {
  const boundaries = [
    { path: "ai.compaction.triggerPromptTokens", valid: 32, invalid: 31 },
    { path: "ai.compaction.preserveRecentTurns", valid: 0, invalid: -1 },
    { path: "ai.compaction.maxPassesPerPage", valid: 1, invalid: 0 },
    { path: "ai.rateLimits.reserveOutputTokens", valid: 1, invalid: 0 },
    { path: "ai.rateLimits.maxQueuedPerPage", valid: 1, invalid: 0 },
    { path: "ai.rateLimits.maxQueuedGlobal", valid: 1, invalid: 0 }
  ];

  return boundaries.flatMap((boundary) => ([
    {
      caseId: `numeric.boundary.${boundary.path.replace(/^ai\./, "").replace(/\./g, "-")}.min-valid`,
      group: "numeric_boundaries",
      prepare: "baseline",
      requiresSelectedModel: true,
      execute: async (context) => {
        const { driver } = context.session;
        const patch = buildPatchFromPath(boundary.path, boundary.valid);
        await patchConfig(driver, patch);
        const snapshot = await getRuntimeSnapshot(driver);
        assertPathValueMatches(
          boundary.path,
          readValueAtPath(snapshot.config, boundary.path),
          boundary.valid,
          `${boundary.path} minimum valid value was not applied.`
        );
        return {
          configPath: boundary.path,
          configPatch: patch,
          assertions: ["Minimum valid value was accepted."]
        };
      }
    },
    {
      caseId: `numeric.boundary.${boundary.path.replace(/^ai\./, "").replace(/\./g, "-")}.below-min-invalid`,
      group: "numeric_boundaries",
      prepare: "baseline",
      requiresSelectedModel: true,
      execute: (context) => runNumericBoundaryCase(context, boundary)
    }
  ]));
}

async function sendPromptAndWait(context, { caseId, origin, text, predicate, pageUrl = null }) {
  const { driver } = context.session;
  const resolvedPageUrl = pageUrl ?? createCaseUrl(context.session, caseId);
  const pageKey = normalizePageKey(resolvedPageUrl);

  await sendCommand(driver, COMMANDS.aiChatSend, {
    pageKey,
    pageUrl: resolvedPageUrl,
    origin,
    text
  });

  const sessionState = await waitForSession(driver, pageKey, resolvedPageUrl, predicate);
  return {
    pageUrl: resolvedPageUrl,
    pageKey,
    sessionState
  };
}

function createModelSelectionCases() {
  return [
    {
      caseId: "model.selection.allowed-single-selected",
      group: "model_selection",
      prepare: "baseline",
      requiresSelectedModel: true,
      execute: async (context) => {
        const { driver } = context.session;
        const expected = [context.state.selectedModel];
        await patchConfig(driver, {
          ai: {
            allowedModels: expected
          }
        });
        const snapshot = await getRuntimeSnapshot(driver);
        assertPathValueMatches("ai.allowedModels", snapshot.config.ai.allowedModels, expected, "Single allowed model set did not persist.");
        return {
          configPath: "ai.allowedModels",
          configPatch: { ai: { allowedModels: expected } },
          assertions: ["Single selected model persisted as ai.allowedModels."]
        };
      }
    },
    {
      caseId: "model.selection.allowed-multi-with-alternate",
      group: "model_selection",
      prepare: "baseline",
      requiresSelectedModel: true,
      requiresAlternateModel: true,
      execute: async (context) => {
        const { driver } = context.session;
        const expected = sortModelRules([context.state.selectedModel, context.state.alternateModel]);
        await patchConfig(driver, {
          ai: {
            allowedModels: expected
          }
        });
        const snapshot = await getRuntimeSnapshot(driver);
        assertPathValueMatches("ai.allowedModels", snapshot.config.ai.allowedModels, expected, "Multiple allowed models did not persist.");
        return {
          configPath: "ai.allowedModels",
          configPatch: { ai: { allowedModels: expected } },
          assertions: ["Selected and alternate models persisted as ai.allowedModels."]
        };
      }
    },
    {
      caseId: "model.selection.chat-selected",
      group: "model_selection",
      prepare: "baseline",
      requiresSelectedModel: true,
      execute: async (context) => {
        const { driver } = context.session;
        await patchConfig(driver, buildPatchFromPath("ai.chat.model", context.state.selectedModel));
        const snapshot = await getRuntimeSnapshot(driver);
        assert.deepEqual(snapshot.config.ai.chat.model, context.state.selectedModel, "Selected chat model did not persist.");
        return {
          configPath: "ai.chat.model",
          configPatch: buildPatchFromPath("ai.chat.model", context.state.selectedModel),
          assertions: ["Selected model persisted as ai.chat.model."]
        };
      }
    },
    {
      caseId: "model.selection.chat-alternate",
      group: "model_selection",
      prepare: "baseline",
      requiresSelectedModel: true,
      requiresAlternateModel: true,
      execute: async (context) => {
        const { driver } = context.session;
        await patchConfig(driver, {
          ai: {
            allowedModels: sortModelRules([context.state.selectedModel, context.state.alternateModel]),
            chat: {
              model: context.state.alternateModel
            }
          }
        });
        const snapshot = await getRuntimeSnapshot(driver);
        assert.deepEqual(snapshot.config.ai.chat.model, context.state.alternateModel, "Alternate chat model did not persist.");
        return {
          configPath: "ai.chat.model",
          configPatch: {
            ai: {
              allowedModels: sortModelRules([context.state.selectedModel, context.state.alternateModel]),
              chat: { model: context.state.alternateModel }
            }
          },
          assertions: ["Alternate model persisted as ai.chat.model."]
        };
      }
    },
    {
      caseId: "model.selection.compaction-null",
      group: "model_selection",
      prepare: "baseline",
      requiresSelectedModel: true,
      execute: async (context) => {
        const { driver } = context.session;
        await patchConfig(driver, {
          ai: {
            compaction: {
              modelOverride: null
            }
          }
        });
        const snapshot = await getRuntimeSnapshot(driver);
        assert.equal(snapshot.config.ai.compaction.modelOverride, null, "Compaction modelOverride did not accept null.");
        return {
          configPath: "ai.compaction.modelOverride",
          configPatch: { ai: { compaction: { modelOverride: null } } },
          assertions: ["Compaction modelOverride accepted null."]
        };
      }
    },
    {
      caseId: "model.selection.compaction-selected",
      group: "model_selection",
      prepare: "baseline",
      requiresSelectedModel: true,
      execute: async (context) => {
        const { driver } = context.session;
        await patchConfig(driver, {
          ai: {
            compaction: {
              modelOverride: context.state.selectedModel
            }
          }
        });
        const snapshot = await getRuntimeSnapshot(driver);
        assert.deepEqual(snapshot.config.ai.compaction.modelOverride, context.state.selectedModel, "Selected compaction modelOverride did not persist.");
        return {
          configPath: "ai.compaction.modelOverride",
          configPatch: { ai: { compaction: { modelOverride: context.state.selectedModel } } },
          assertions: ["Selected model persisted as ai.compaction.modelOverride."]
        };
      }
    },
    {
      caseId: "model.selection.compaction-alternate",
      group: "model_selection",
      prepare: "baseline",
      requiresSelectedModel: true,
      requiresAlternateModel: true,
      execute: async (context) => {
        const { driver } = context.session;
        await patchConfig(driver, {
          ai: {
            compaction: {
              modelOverride: context.state.alternateModel
            }
          }
        });
        const snapshot = await getRuntimeSnapshot(driver);
        assert.deepEqual(snapshot.config.ai.compaction.modelOverride, context.state.alternateModel, "Alternate compaction modelOverride did not persist.");
        return {
          configPath: "ai.compaction.modelOverride",
          configPatch: { ai: { compaction: { modelOverride: context.state.alternateModel } } },
          assertions: ["Alternate model persisted as ai.compaction.modelOverride."]
        };
      }
    },
    {
      caseId: "model.selection.chat-outside-allowed-warning",
      group: "model_selection",
      prepare: "baseline",
      requiresSelectedModel: true,
      requiresAlternateModel: true,
      execute: async (context) => {
        const { driver } = context.session;
        await patchConfig(driver, {
          ai: {
            allowedModels: [context.state.selectedModel],
            chat: {
              model: context.state.alternateModel
            }
          }
        });
        await openConfigTab(driver);
        await openConfigPanel(driver, "ai.chat.model");
        const messages = await readOpenModelPanelMessages(driver);
        assert.ok(
          messages.some((message) => message.includes("Текущее значение вне ai.allowedModels")),
          "Out-of-allowed model warning did not appear."
        );
        return {
          configPath: "ai.chat.model",
          configPatch: {
            ai: {
              allowedModels: [context.state.selectedModel],
              chat: {
                model: context.state.alternateModel
              }
            }
          },
          assertions: ["Out-of-allowed chat model produced a popup warning."],
          artifacts: {
            messages
          }
        };
      }
    }
  ];
}

function createTransportCases() {
  const variants = [];
  for (const origin of ["user", "code"]) {
    for (const streamingEnabled of [true, false]) {
      for (const structured of [false, true]) {
        variants.push({
          caseId: `transport.${origin}.stream-${streamingEnabled ? "on" : "off"}.structured-${structured ? "on" : "off"}`,
          group: "transport_output",
          prepare: "baseline",
          requiresSelectedModel: true,
          liveDependent: true,
          providerSuccessRequired: true,
          execute: async (context) => {
            const { driver } = context.session;
            const patch = {
              ai: {
                chat: {
                  streamingEnabled,
                  structuredOutput: structured
                    ? {
                        name: STRUCTURED_NAME,
                        description: STRUCTURED_DESCRIPTION,
                        schema: STRUCTURED_SCHEMA,
                        strict: true
                      }
                    : {
                        schema: ""
                      }
                }
              }
            };
            await patchConfig(driver, patch);

            const token = `EDGE_${origin.toUpperCase()}_${streamingEnabled ? "STREAM" : "NONSTREAM"}_${structured ? "JSON" : "TEXT"}_OK`;
            const prompt = structured
              ? `Return token ${token} and variant edge.`
              : `Reply with exact token ${token} and nothing else.`;
            const { pageUrl, pageKey, sessionState } = await sendPromptAndWait(context, {
              caseId: `transport-${origin}-${streamingEnabled}-${structured}`,
              origin,
              text: prompt,
              predicate: (candidate) =>
                structured
                  ? candidate.status.requestState === "idle" &&
                    sessionHasAssistantJson(candidate, (parsed) => parsed?.token === token)
                  : candidate.status.requestState === "idle" &&
                    sessionHasAssistantText(candidate, token)
            });

            const assistantMessage = findLatestAssistantMessage(sessionState);
            assert.ok(assistantMessage, "Assistant response message is missing.");

            if (structured) {
              const parsed = JSON.parse(assistantMessage.text);
              assert.equal(parsed.token, token, "Structured token did not match.");
              assert.equal(parsed.variant, "edge", "Structured variant did not match.");
              assert.equal(sessionState.status.structuredOutputEnabled, true, "Structured output status was not enabled.");
              assert.equal(sessionState.status.structuredOutputStrict, true, "Structured output strict mode was not preserved.");
            } else {
              assert.ok(assistantMessage.text.includes(token), "Plain text response token did not match.");
              assert.equal(sessionState.status.structuredOutputEnabled, false, "Structured output unexpectedly remained enabled.");
            }

            assert.equal(sessionState.status.streamingEnabled, streamingEnabled, "Streaming status did not match the configured value.");
            return {
              pageUrl,
              pageKey,
              configPatch: patch,
              assertions: [
                `AI request completed for origin=${origin}.`,
                `Streaming status matched ${streamingEnabled}.`,
                structured ? "Structured JSON output was parseable." : "Plain text output matched the token."
              ]
            };
          }
        });
      }
    }
  }

  return variants;
}

function createCompactionCases() {
  const cases = [];
  for (const enabled of [true, false]) {
    for (const streamingEnabled of [true, false]) {
      for (const preserveRecentTurns of [0, 1]) {
        cases.push({
          caseId: `compaction.enabled-${enabled ? "on" : "off"}.stream-${streamingEnabled ? "on" : "off"}.preserve-${preserveRecentTurns}`,
          group: "compaction_matrix",
          prepare: "baseline",
          requiresSelectedModel: true,
          liveDependent: true,
          providerSuccessRequired: true,
          execute: async (context) => {
            const { driver } = context.session;
            const patch = {
              ai: {
                compaction: {
                  enabled,
                  streamingEnabled,
                  triggerPromptTokens: 64,
                  preserveRecentTurns,
                  maxPassesPerPage: 2
                }
              }
            };
            await patchConfig(driver, patch);

            const caseToken = `EDGE_COMPACTION_${enabled ? "ON" : "OFF"}_${streamingEnabled ? "STREAM" : "NONSTREAM"}_${preserveRecentTurns}`;
            const pageUrl = createCaseUrl(context.session, caseToken);
            const pageKey = normalizePageKey(pageUrl);
            await sendCommand(driver, COMMANDS.aiChatSend, {
              pageKey,
              pageUrl,
              origin: "user",
              text: "Reply with exact token EDGE_COMPACTION_SEED and nothing else."
            });
            await waitForSession(driver, pageKey, pageUrl, (candidate) =>
              candidate.status.requestState === "idle" &&
              sessionHasAssistantText(candidate, "EDGE_COMPACTION_SEED")
            );

            await sendCommand(driver, COMMANDS.aiChatSend, {
              pageKey,
              pageUrl,
              origin: "user",
              text: `Reply with exact token ${caseToken} and nothing else.`
            });
            const sessionState = await waitForSession(driver, pageKey, pageUrl, (candidate) =>
              candidate.status.requestState === "idle" &&
              sessionHasAssistantText(candidate, caseToken)
            );

            const compactionMessages = sessionState.messages.filter((message) =>
              message.kind === "compaction-request" || message.kind === "compaction-result"
            );
            if (enabled) {
              assert.ok(compactionMessages.length > 0, "Compaction was enabled but no compaction event was emitted.");
            } else {
              assert.equal(compactionMessages.length, 0, "Compaction was disabled but compaction events were emitted.");
            }

            return {
              pageUrl,
              pageKey,
              configPatch: patch,
              assertions: [
                `Compaction enabled flag matched ${enabled}.`,
                `Compaction streaming flag matched ${streamingEnabled}.`,
                `Preserve recent turns matched ${preserveRecentTurns}.`
              ],
              artifacts: {
                compactionMessageCount: compactionMessages.length
              }
            };
          }
        });
      }
    }
  }

  return cases;
}

function createQueueCases() {
  const cases = [];
  for (const reserveMode of ["normal", "blocked"]) {
    for (const maxQueuedPerPage of [1, 2]) {
      for (const maxQueuedGlobal of [1, 2]) {
        cases.push({
          caseId: `queue.reserve-${reserveMode}.page-${maxQueuedPerPage}.global-${maxQueuedGlobal}`,
          group: "queue_rate_limits",
          prepare: "baseline",
          requiresSelectedModel: true,
          liveDependent: true,
          providerSuccessRequired: true,
          execute: async (context) => {
            const { driver } = context.session;
            const reserveOutputTokens =
              reserveMode === "normal"
                ? 1
                : (await ensureBudgetRemainingTokens(context.session, context.state, `queue-${reserveMode}-${maxQueuedPerPage}-${maxQueuedGlobal}`)) + 1;
            const patch = {
              ai: {
                rateLimits: {
                  reserveOutputTokens,
                  maxQueuedPerPage,
                  maxQueuedGlobal
                }
              }
            };
            await patchConfig(driver, patch);

            const pageUrlA = createCaseUrl(context.session, `queue-a-${reserveMode}-${maxQueuedPerPage}-${maxQueuedGlobal}`);
            const pageKeyA = normalizePageKey(pageUrlA);
            const primaryToken = `EDGE_QUEUE_PRIMARY_${reserveMode}_${maxQueuedPerPage}_${maxQueuedGlobal}`;
            await sendCommand(driver, COMMANDS.aiChatSend, {
              pageKey: pageKeyA,
              pageUrl: pageUrlA,
              origin: "user",
              text: `Reply with exact token ${primaryToken} and nothing else.`
            });

            if (reserveMode === "blocked") {
              const blockedSession = await waitForSession(driver, pageKeyA, pageUrlA, (candidate) =>
                candidate.status.requestState === "blocked" && candidate.status.availableActions.canResume
              );
              assert.equal(blockedSession.status.lastError, "rate_limit_blocked", "Blocked queue case did not report rate_limit_blocked.");

              await patchConfig(driver, {
                ai: {
                  rateLimits: {
                    reserveOutputTokens: 1,
                    maxQueuedPerPage,
                    maxQueuedGlobal
                  }
                }
              });
              await sendCommand(driver, COMMANDS.aiChatResume, {
                pageKey: pageKeyA
              });
              const resumedSession = await waitForSession(driver, pageKeyA, pageUrlA, (candidate) =>
                candidate.status.requestState === "idle" &&
                sessionHasAssistantText(candidate, primaryToken)
              );
              assert.equal(resumedSession.status.requestState, "idle", "Blocked queue case did not settle back to idle after resume.");
              return {
                pageUrl: pageUrlA,
                pageKey: pageKeyA,
                configPatch: patch,
                assertions: [
                  "High reserveOutputTokens blocked the request.",
                  "The request resumed successfully after lowering the reserve."
                ]
              };
            }

            if (maxQueuedGlobal === 1) {
              const pageUrlB = createCaseUrl(context.session, `queue-b-${reserveMode}-${maxQueuedPerPage}-${maxQueuedGlobal}`);
              const pageKeyB = normalizePageKey(pageUrlB);
              const errorResult = await sendCommandExpectingError(driver, COMMANDS.aiChatSend, {
                pageKey: pageKeyB,
                pageUrl: pageUrlB,
                origin: "user",
                text: "Reply with exact token EDGE_QUEUE_GLOBAL_SECONDARY and nothing else."
              });
              assert.match(errorResult.message, /Global AI queue limit has been reached/i, "Global queue limit case did not match.");
              return {
                pageUrl: pageUrlA,
                pageKey: pageKeyA,
                configPatch: patch,
                assertions: ["Global queue limit blocked a secondary page request."],
                artifacts: {
                  errorMessage: errorResult.message
                }
              };
            }

            if (maxQueuedPerPage === 1) {
              const errorResult = await sendCommandExpectingError(driver, COMMANDS.aiChatSend, {
                pageKey: pageKeyA,
                pageUrl: pageUrlA,
                origin: "user",
                text: "Reply with exact token EDGE_QUEUE_SECONDARY and nothing else."
              });
              assert.match(errorResult.message, /Page AI queue limit has been reached/i, "Per-page queue limit case did not match.");
              return {
                pageUrl: pageUrlA,
                pageKey: pageKeyA,
                configPatch: patch,
                assertions: ["Per-page queue limit blocked the secondary request."],
                artifacts: {
                  errorMessage: errorResult.message
                }
              };
            }

            const secondaryToken = `EDGE_QUEUE_SECONDARY_${maxQueuedPerPage}_${maxQueuedGlobal}`;
            await sendCommand(driver, COMMANDS.aiChatSend, {
              pageKey: pageKeyA,
              pageUrl: pageUrlA,
              origin: "user",
              text: `Reply with exact token ${secondaryToken} and nothing else.`
            });
            const queuedSession = await waitForSession(driver, pageKeyA, pageUrlA, (candidate) =>
              candidate.status.requestState === "idle" &&
              sessionHasAssistantText(candidate, primaryToken) &&
              sessionHasAssistantText(candidate, secondaryToken)
            );
            return {
              pageUrl: pageUrlA,
              pageKey: pageKeyA,
              configPatch: patch,
              assertions: ["Two requests completed successfully under the configured queue limits."],
              artifacts: {
                messageCount: queuedSession.messages.length
              }
            };
          }
        });
      }
    }
  }

  return cases;
}

function createRecoveryCases() {
  return [
    {
      caseId: "recovery.retry-resume-invalid-key",
      group: "recovery_stability",
      prepare: "baseline",
      requiresSelectedModel: true,
      liveDependent: true,
      providerSuccessRequired: true,
      execute: async (context) => {
        const { driver } = context.session;
        await patchConfig(driver, {
          ai: {
            openAiApiKey: "sk-test-edge-invalid-key"
          }
        });

        const pageUrl = createCaseUrl(context.session, "recovery-retry-invalid");
        const pageKey = normalizePageKey(pageUrl);
        await sendCommand(driver, COMMANDS.aiChatSend, {
          pageKey,
          pageUrl,
          origin: "user",
          text: "Reply with exact token EDGE_RECOVERY_RESUME_OK and nothing else."
        });
        const pausedSession = await waitForSession(driver, pageKey, pageUrl, (candidate) =>
          candidate.status.requestState === "paused" && candidate.status.availableActions.canResume
        );
        assert.ok(pausedSession.status.lastError?.includes("OpenAI HTTP"), "Recovery invalid-key case did not capture the HTTP error.");

        await patchConfig(driver, {
          ai: {
            openAiApiKey: context.state.originalUserApiKey
          }
        });
        await patchConfig(driver, {
          ai: {
            openAiApiKey: null
          }
        });

        await sendCommand(driver, COMMANDS.aiChatResume, {
          pageKey
        });
        const resumedSession = await waitForSession(driver, pageKey, pageUrl, (candidate) =>
          candidate.status.requestState === "idle" &&
          sessionHasAssistantText(candidate, "EDGE_RECOVERY_RESUME_OK")
        );
        assert.equal(resumedSession.status.requestState, "idle", "Recovery resume case did not settle back to idle.");
        return {
          pageUrl,
          pageKey,
          assertions: ["Paused request resumed successfully after restoring the managed API key."]
        };
      }
    },
    {
      caseId: "recovery.reset-after-success",
      group: "recovery_stability",
      prepare: "baseline",
      requiresSelectedModel: true,
      liveDependent: true,
      providerSuccessRequired: true,
      execute: async (context) => {
        const { driver } = context.session;
        const pageUrl = createCaseUrl(context.session, "recovery-reset-success");
        const pageKey = normalizePageKey(pageUrl);
        await sendCommand(driver, COMMANDS.aiChatSend, {
          pageKey,
          pageUrl,
          origin: "user",
          text: "Reply with exact token EDGE_RESET_SUCCESS_OK and nothing else."
        });
        await waitForSession(driver, pageKey, pageUrl, (candidate) =>
          candidate.status.requestState === "idle" &&
          sessionHasAssistantText(candidate, "EDGE_RESET_SUCCESS_OK")
        );
        await sendCommand(driver, COMMANDS.aiChatReset, {
          pageKey
        });
        const resetSession = await getAiStatus(driver, pageUrl);
        assert.equal(resetSession.status.requestState, "idle", "Reset-after-success case did not return to idle.");
        return {
          pageUrl,
          pageKey,
          assertions: ["Successful session reset returned the page to idle."]
        };
      }
    },
    {
      caseId: "recovery.reset-after-blocked",
      group: "recovery_stability",
      prepare: "baseline",
      requiresSelectedModel: true,
      liveDependent: true,
      providerSuccessRequired: true,
      execute: async (context) => {
        const { driver } = context.session;
        const reserveOutputTokens = (await ensureBudgetRemainingTokens(context.session, context.state, "recovery-reset-blocked")) + 1;
        await patchConfig(driver, {
          ai: {
            rateLimits: {
              reserveOutputTokens
            }
          }
        });

        const pageUrl = createCaseUrl(context.session, "recovery-reset-blocked");
        const pageKey = normalizePageKey(pageUrl);
        await sendCommand(driver, COMMANDS.aiChatSend, {
          pageKey,
          pageUrl,
          origin: "user",
          text: "Reply with exact token EDGE_RESET_BLOCKED_OK and nothing else."
        });
        await waitForSession(driver, pageKey, pageUrl, (candidate) =>
          candidate.status.requestState === "blocked"
        );
        await sendCommand(driver, COMMANDS.aiChatReset, {
          pageKey
        });
        const resetSession = await getAiStatus(driver, pageUrl);
        assert.equal(resetSession.status.requestState, "idle", "Reset-after-blocked case did not return to idle.");
        return {
          pageUrl,
          pageKey,
          assertions: ["Blocked session reset returned the page to idle."]
        };
      }
    },
    {
      caseId: "recovery.shared-session-reuse",
      group: "recovery_stability",
      prepare: "baseline",
      requiresSelectedModel: true,
      liveDependent: true,
      providerSuccessRequired: true,
      execute: async (context) => {
        const { driver } = context.session;
        const sharedBaseUrl = createCaseUrl(context.session, "recovery-shared");
        const seedUrl = `${sharedBaseUrl}?seed=1`;
        const sharedUrl = `${sharedBaseUrl}?copy=1#fragment`;
        const pageKey = normalizePageKey(seedUrl);
        await sendCommand(driver, COMMANDS.aiChatSend, {
          pageKey,
          pageUrl: seedUrl,
          origin: "user",
          text: "Reply with exact token EDGE_RECOVERY_SHARED_OK and nothing else."
        });
        await waitForSession(driver, pageKey, seedUrl, (candidate) =>
          candidate.status.requestState === "idle" &&
          sessionHasAssistantText(candidate, "EDGE_RECOVERY_SHARED_OK")
        );
        await openBrowserTab(driver, sharedUrl);
        const sharedSession = await getAiStatus(driver, sharedUrl);
        assert.equal(sharedSession.pageKey, pageKey, "Shared-session case did not reuse the normalized pageKey.");
        assert.ok(
          sessionHasAssistantText(sharedSession, "EDGE_RECOVERY_SHARED_OK"),
          "Shared-session case did not expose the seeded assistant response in the secondary tab."
        );
        return {
          pageUrl: seedUrl,
          pageKey,
          assertions: ["Shared-session state was reused for a second normalized page URL."]
        };
      }
    },
    {
      caseId: "recovery.multi-turn-streaming-on",
      group: "recovery_stability",
      prepare: "baseline",
      requiresSelectedModel: true,
      liveDependent: true,
      providerSuccessRequired: true,
      execute: (context) => runMultiTurnCase(context, true, "EDGE_MULTI_STREAM_ON"),
    },
    {
      caseId: "recovery.multi-turn-streaming-off",
      group: "recovery_stability",
      prepare: "baseline",
      requiresSelectedModel: true,
      liveDependent: true,
      providerSuccessRequired: true,
      execute: (context) => runMultiTurnCase(context, false, "EDGE_MULTI_STREAM_OFF"),
    },
    {
      caseId: "recovery.compaction-loop",
      group: "recovery_stability",
      prepare: "baseline",
      requiresSelectedModel: true,
      liveDependent: true,
      providerSuccessRequired: true,
      execute: async (context) => {
        const { driver } = context.session;
        await patchConfig(driver, {
          ai: {
            compaction: {
              enabled: true,
              triggerPromptTokens: 64,
              preserveRecentTurns: 1,
              maxPassesPerPage: 2
            }
          }
        });

        const pageUrl = createCaseUrl(context.session, "recovery-compaction-loop");
        const pageKey = normalizePageKey(pageUrl);
        for (const token of ["EDGE_LOOP_A", "EDGE_LOOP_B", "EDGE_LOOP_C"]) {
          await sendCommand(driver, COMMANDS.aiChatSend, {
            pageKey,
            pageUrl,
            origin: "user",
            text: `Reply with exact token ${token} and nothing else.`
          });
          await waitForSession(driver, pageKey, pageUrl, (candidate) =>
            candidate.status.requestState === "idle" &&
            sessionHasAssistantText(candidate, token)
          );
        }
        const sessionState = await getAiStatus(driver, pageUrl);
        assert.ok(
          sessionState.messages.some((message) => message.kind === "compaction-result"),
          "Compaction loop case did not emit compaction result messages."
        );
        return {
          pageUrl,
          pageKey,
          assertions: ["Repeated turns triggered compaction events."]
        };
      }
    },
    {
      caseId: "recovery.chat-list",
      group: "recovery_stability",
      prepare: "baseline",
      requiresSelectedModel: true,
      liveDependent: true,
      providerSuccessRequired: true,
      execute: async (context) => {
        const { driver } = context.session;
        const listResult = await sendCommand(driver, COMMANDS.aiChatList, {});
        assert.ok(Array.isArray(listResult.sessions), "ai.chat.list did not return a sessions array.");
        return {
          assertions: ["ai.chat.list returned a sessions array."],
          artifacts: {
            sessionCount: listResult.sessions.length
          }
        };
      }
    },
    {
      caseId: "recovery.reset-all-sessions",
      group: "recovery_stability",
      prepare: "baseline",
      requiresSelectedModel: true,
      liveDependent: true,
      providerSuccessRequired: true,
      execute: async (context) => {
        const { driver } = context.session;
        const pageUrl = createCaseUrl(context.session, "recovery-reset-all");
        const pageKey = normalizePageKey(pageUrl);
        await sendCommand(driver, COMMANDS.aiChatSend, {
          pageKey,
          pageUrl,
          origin: "user",
          text: "Reply with exact token EDGE_RESET_ALL_OK and nothing else."
        });
        await waitForSession(driver, pageKey, pageUrl, (candidate) =>
          candidate.status.requestState === "idle" &&
          sessionHasAssistantText(candidate, "EDGE_RESET_ALL_OK")
        );
        await resetAllSessions(driver);
        const sessionState = await getAiStatus(driver, pageUrl);
        assert.equal(sessionState.status.requestState, "idle", "resetAllSessions did not return the session to idle.");
        return {
          pageUrl,
          pageKey,
          assertions: ["resetAllSessions returned known sessions to idle."]
        };
      }
    },
    {
      caseId: "recovery.post-cleanup-idle-verification",
      group: "recovery_stability",
      prepare: "baseline",
      requiresSelectedModel: true,
      execute: async (context) => {
        const { driver } = context.session;
        await resetAllSessions(driver);
        const pageUrl = createCaseUrl(context.session, "recovery-idle-status");
        const sessionState = await getAiStatus(driver, pageUrl);
        assert.equal(sessionState.status.requestState, "idle", "Idle verification did not report idle.");
        assert.equal(sessionState.status.availableActions.canSend, Boolean(context.state.originalUserApiKey), "Idle verification did not reflect send availability.");
        return {
          pageUrl,
          pageKey: normalizePageKey(pageUrl),
          assertions: ["Idle status remained healthy after cleanup."]
        };
      }
    }
  ];
}

async function runMultiTurnCase(context, streamingEnabled, prefix) {
  const { driver } = context.session;
  await patchConfig(driver, {
    ai: {
      chat: {
        streamingEnabled
      }
    }
  });
  const pageUrl = createCaseUrl(context.session, `${prefix}-page`);
  const pageKey = normalizePageKey(pageUrl);
  for (const suffix of ["A", "B"]) {
    const token = `${prefix}_${suffix}`;
    await sendCommand(driver, COMMANDS.aiChatSend, {
      pageKey,
      pageUrl,
      origin: "user",
      text: `Reply with exact token ${token} and nothing else.`
    });
    await waitForSession(driver, pageKey, pageUrl, (candidate) =>
      candidate.status.requestState === "idle" &&
      sessionHasAssistantText(candidate, token)
    );
  }
  const sessionState = await getAiStatus(driver, pageUrl);
  assert.equal(sessionState.status.streamingEnabled, streamingEnabled, "Multi-turn case did not preserve the configured streaming mode.");
  return {
    pageUrl,
    pageKey,
    assertions: [`Two turns completed with streaming=${streamingEnabled}.`],
    artifacts: {
      messageCount: sessionState.messages.length
    }
  };
}

async function runLegacyNormalizationCase(context, patch, verify) {
  const { driver } = context.session;
  await ensureCatalogState(driver, context.state);
  if (context.state.selectedModel) {
    await restoreBaselineAiConfig(driver, context.state.selectedModel, context.state.originalUserApiKey, {
      verifyApiKeyPresent: Boolean(context.state.originalUserApiKey)
    });
  }
  await patchConfig(driver, patch);
  const snapshot = await getRuntimeSnapshot(driver);
  verify(snapshot.config);
  return {
    configPatch: patch,
    assertions: ["Legacy-shaped patch was normalized into the effective config."]
  };
}

await main();
