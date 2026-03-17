import assert from "node:assert/strict";

import {
  AI_UI_PATHS,
  BASE_CHAT_INSTRUCTIONS,
  BASE_COMPACTION_INSTRUCTIONS,
  COMMANDS,
  INVALID_MANAGED_API_KEY,
  OPENAI_API_KEY_ENV_VAR_NAME,
  STRUCTURED_DESCRIPTION,
  STRUCTURED_NAME,
  STRUCTURED_SCHEMA,
  TEMP_MANAGED_API_KEY,
  buildBaselineAiPatch,
  chooseAlternateModelFromCatalog,
  chooseModelFromCatalog,
  findLatestAssistantMessage,
  getAiStatus,
  getOverlayChatFeedText,
  getOverlayChatStatusText,
  getPopupAiConfigPaths,
  getRuntimeSnapshot,
  getTabIdByUrl,
  getUserEnvironmentVariable,
  getUserEnvironmentVariableAsync,
  normalizePageKey,
  openBrowserTab,
  openConfigTab,
  patchConfig,
  pruneBrowserTabs,
  readButtonText,
  readNativeHostState,
  resetAllSessions,
  restoreBaselineAiConfig,
  sessionHasAssistantJson,
  sessionHasAssistantText,
  selectOverlayTab,
  sendCommand,
  sendCommandExpectingError,
  sendOverlayChat,
  setAllowedModel,
  setInlineValue,
  setModalTextValue,
  setModelPanelValue,
  setSelectValue,
  switchToHandle,
  waitFor,
  waitForOverlay,
  waitForSession,
  waitForTabIdByUrl
} from "./edge-ai-harness.mjs";

export const BASELINE_SCENARIO_ORDER = [
  "ai.catalog",
  "ai.ui.paths",
  "ai.config.sync",
  "ai.status",
  "ai.overlay.user-chat",
  "ai.shared-session",
  "ai.code-origin",
  "ai.structured-output",
  "ai.page-queue-limit",
  "ai.global-queue-limit",
  "ai.retry-resume",
  "ai.reset",
  "ai.model-unset",
  "ai.api-key-missing",
  "ai.rate-limit-blocked",
  "ai.compaction",
  "ai.list",
  "ai.api-key-editor"
];

export function createBaselineAiState(overrides = {}) {
  const originalUserApiKey = getUserEnvironmentVariable(OPENAI_API_KEY_ENV_VAR_NAME);
  return {
    originalUserApiKey,
    selectedModel: null,
    alternateModel: null,
    catalogModels: [],
    providerRegionBlocked: false,
    catalogError: null,
    ...overrides
  };
}

export function createBaselineAiReport(extensionId = null, state = createBaselineAiState()) {
  return {
    startedAt: new Date().toISOString(),
    environment: {
      browser: "Microsoft Edge",
      manifestVersion: 3,
      extensionId,
      originalUserApiKeyPresent: Boolean(state.originalUserApiKey)
    },
    coverage: {
      expectedAiUiPaths: AI_UI_PATHS
    },
    scenarios: []
  };
}

export async function runBaselineAiSuite(session, options = {}) {
  const report = options.report ?? createBaselineAiReport(session.extensionId, options.state);
  const state = options.state ?? createBaselineAiState();
  const { driver, server, popupHandle, mainHandle } = session;
  const selectedScenarioNames =
    Array.isArray(options.scenarioNames)
      ? new Set(options.scenarioNames)
      : null;
  const shouldRunScenario = (name) => selectedScenarioNames === null || selectedScenarioNames.has(name);
  const selectedLiveScenarioNames = BASELINE_SCENARIO_ORDER.slice(3).filter((name) => shouldRunScenario(name));
  const cleanupScenarioArtifacts = async () => {
    await pruneBrowserTabs(driver, [mainHandle, popupHandle]);
    await switchToHandle(driver, popupHandle).catch(() => {});
  };
  const recordManagedSkip = (name, reason, details) => {
    if (shouldRunScenario(name)) {
      skipScenario(report, name, reason, details);
    }
  };
  const runManagedScenario = async (name, execute) => {
    if (!shouldRunScenario(name)) {
      return null;
    }

    try {
      return await runScenario(report, name, execute);
    } finally {
      await cleanupScenarioArtifacts();
    }
  };
  const runPreparedScenario = async (name, execute) => {
    if (!shouldRunScenario(name)) {
      return null;
    }
    const entry = {
      name,
      status: "running",
      startedAt: new Date().toISOString(),
      attempts: 0
    };
    const retryErrors = [];
    report.scenarios.push(entry);

    try {
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        entry.attempts = attempt;
        try {
          await restoreBaselineAiConfig(driver, state.selectedModel, state.originalUserApiKey);
          const details = await execute();
          entry.status = "passed";
          if (details !== undefined) {
            entry.details = details;
          }
          if (retryErrors.length > 0) {
            entry.retryErrors = retryErrors;
          }
          return details;
        } catch (error) {
          if (error?.name === "SkipCaseError") {
            entry.status = "skipped";
            entry.reason = error.reason;
            if (error.details !== undefined) {
              entry.details = error.details;
            }
            if (retryErrors.length > 0) {
              entry.retryErrors = retryErrors;
            }
            return null;
          }

          const errorDetails = serializeError(error);
          if (attempt < 2 && isRetryableScenarioError(error)) {
            retryErrors.push(errorDetails);
            await cleanupScenarioArtifacts();
            continue;
          }

          entry.status = "failed";
          entry.error = error instanceof Error ? error.message : String(error);
          entry.errorDetails = errorDetails;
          if (retryErrors.length > 0) {
            entry.retryErrors = retryErrors;
          }
          return null;
        }
      }
    } finally {
      await cleanupScenarioArtifacts();
      entry.finishedAt = new Date().toISOString();
    }
  };
  const runSilentSetup = async (execute) => {
    try {
      return await execute();
    } catch {
      return null;
    } finally {
      await cleanupScenarioArtifacts();
    }
  };
  const runCatalogScenario = async () => {
    try {
      const result = await sendCommand(driver, COMMANDS.aiModelsCatalog, {});
      assert.ok(Array.isArray(result.models) && result.models.length > 0, "OpenAI model catalog is empty.");
      const model = chooseModelFromCatalog(result.models);
      assert.ok(model, "No usable OpenAI model was found in the catalog.");

      state.catalogModels = result.models;
      state.selectedModel = model;
      state.alternateModel = chooseAlternateModelFromCatalog(result.models, model);
      state.catalogError = null;
      state.providerRegionBlocked = false;

      return {
        modelCount: result.models.length,
        selectedModel: model,
        alternateModel: state.alternateModel
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.catalogError = message;
      state.providerRegionBlocked = /unsupported_country_region_territory|Country, region, or territory not supported/i.test(message);
      if (state.providerRegionBlocked) {
        state.selectedModel = {
          model: "gpt-5",
          tier: "standard"
        };
        report.environment.providerRegionBlocked = true;
        report.environment.catalogFallbackModel = state.selectedModel;
        throwSkip("OpenAI provider access is region-blocked.", {
          fallbackModel: state.selectedModel
        });
      }
      throw error;
    }
  };
  const runUiPathsScenario = async () => {
    await openConfigTab(driver);
    const actualPaths = await getPopupAiConfigPaths(driver);
    assert.deepEqual(actualPaths, [...AI_UI_PATHS].sort(), "AI config paths exposed in popup differ from the expected registry.");
    return {
      actualAiUiPaths: actualPaths
    };
  };
  const runConfigSyncScenario = async () => {
    await openConfigTab(driver);
    await setModalTextValue(driver, "ai.chat.instructions", BASE_CHAT_INSTRUCTIONS);
    await setModalTextValue(driver, "ai.compaction.instructions", BASE_COMPACTION_INSTRUCTIONS);
    await setSelectValue(driver, "ai.chat.streamingEnabled", "false");
    await setSelectValue(driver, "ai.chat.streamingEnabled", "true");
    await setSelectValue(driver, "ai.compaction.enabled", "false");
    await setSelectValue(driver, "ai.compaction.enabled", "true");
    await setInlineValue(driver, "ai.rateLimits.maxQueuedPerPage", "2");
    if (!state.providerRegionBlocked) {
      await setAllowedModel(driver, state.selectedModel.model, state.selectedModel.tier);
      await setModelPanelValue(driver, "ai.chat.model", state.selectedModel.model, state.selectedModel.tier);
    }

    await patchConfig(driver, buildBaselineAiPatch(state.selectedModel));

    const snapshot = await getRuntimeSnapshot(driver);
    const config = snapshot.config;
    assert.deepEqual(config.ai.allowedModels, [state.selectedModel], "ai.allowedModels did not persist.");
    assert.deepEqual(config.ai.chat.model, state.selectedModel, "ai.chat.model did not persist.");
    assert.equal(config.ai.chat.streamingEnabled, true, "ai.chat.streamingEnabled did not persist.");
    assert.equal(config.ai.chat.instructions, BASE_CHAT_INSTRUCTIONS, "ai.chat.instructions did not persist.");
    assert.equal(config.ai.chat.structuredOutput.name, STRUCTURED_NAME, "ai.chat.structuredOutput.name did not persist.");
    assert.equal(config.ai.chat.structuredOutput.description, STRUCTURED_DESCRIPTION, "ai.chat.structuredOutput.description did not persist.");
    assert.equal(config.ai.chat.structuredOutput.schema, "", "ai.chat.structuredOutput.schema baseline must stay empty.");
    assert.equal(config.ai.chat.structuredOutput.strict, true, "ai.chat.structuredOutput.strict did not persist.");
    assert.equal(config.ai.compaction.enabled, true, "ai.compaction.enabled did not persist.");
    assert.equal(config.ai.compaction.streamingEnabled, true, "ai.compaction.streamingEnabled did not persist.");
    assert.deepEqual(config.ai.compaction.modelOverride, state.selectedModel, "ai.compaction.modelOverride did not persist.");
    assert.equal(config.ai.compaction.instructions, BASE_COMPACTION_INSTRUCTIONS, "ai.compaction.instructions did not persist.");
    assert.equal(config.ai.compaction.triggerPromptTokens, 64, "ai.compaction.triggerPromptTokens did not persist.");
    assert.equal(config.ai.compaction.preserveRecentTurns, 1, "ai.compaction.preserveRecentTurns did not persist.");
    assert.equal(config.ai.compaction.maxPassesPerPage, 2, "ai.compaction.maxPassesPerPage did not persist.");
    assert.equal(config.ai.rateLimits.reserveOutputTokens, 512, "ai.rateLimits.reserveOutputTokens did not persist.");
    assert.equal(config.ai.rateLimits.maxQueuedPerPage, 2, "ai.rateLimits.maxQueuedPerPage did not persist.");
    assert.equal(config.ai.rateLimits.maxQueuedGlobal, 3, "ai.rateLimits.maxQueuedGlobal did not persist.");
    assert.equal(config.ai.openAiApiKey, null, "ai.openAiApiKey baseline must stay null.");

    await waitFor(async () => {
      const nativeState = await readNativeHostState();
      return (
        nativeState?.aiConfig?.chat?.model?.model === state.selectedModel.model &&
        nativeState?.aiConfig?.chat?.model?.tier === state.selectedModel.tier &&
        nativeState?.aiConfig?.chat?.streamingEnabled === true &&
        nativeState?.aiConfig?.chat?.instructions === BASE_CHAT_INSTRUCTIONS &&
        nativeState?.aiConfig?.chat?.structuredOutput?.name === STRUCTURED_NAME &&
        nativeState?.aiConfig?.chat?.structuredOutput?.description === STRUCTURED_DESCRIPTION &&
        nativeState?.aiConfig?.chat?.structuredOutput?.schema === "" &&
        nativeState?.aiConfig?.chat?.structuredOutput?.strict === true &&
        nativeState?.aiConfig?.compaction?.enabled === true &&
        nativeState?.aiConfig?.compaction?.streamingEnabled === true &&
        nativeState?.aiConfig?.compaction?.modelOverride?.model === state.selectedModel.model &&
        nativeState?.aiConfig?.compaction?.modelOverride?.tier === state.selectedModel.tier &&
        nativeState?.aiConfig?.compaction?.instructions === BASE_COMPACTION_INSTRUCTIONS &&
        nativeState?.aiConfig?.compaction?.triggerPromptTokens === 64 &&
        nativeState?.aiConfig?.compaction?.preserveRecentTurns === 1 &&
        nativeState?.aiConfig?.compaction?.maxPassesPerPage === 2 &&
        nativeState?.aiConfig?.rateLimits?.reserveOutputTokens === 512 &&
        nativeState?.aiConfig?.rateLimits?.maxQueuedPerPage === 2 &&
        nativeState?.aiConfig?.rateLimits?.maxQueuedGlobal === 3
      );
    }, 15000, "Native host did not receive the expected AI config.");

    return {
      selectedModel: state.selectedModel,
      alternateModel: state.alternateModel,
      hostSyncVerified: true,
      catalogBlockedByProvider: state.providerRegionBlocked
    };
  };

  report.environment.extensionId = session.extensionId;
  report.environment.originalUserApiKeyPresent = Boolean(state.originalUserApiKey);

  try {
    const needsCatalog =
      shouldRunScenario("ai.catalog") ||
      shouldRunScenario("ai.ui.paths") ||
      shouldRunScenario("ai.config.sync") ||
      selectedLiveScenarioNames.length > 0;
    const catalogResult = !needsCatalog
      ? null
      : shouldRunScenario("ai.catalog")
        ? await runManagedScenario("ai.catalog", runCatalogScenario)
        : await runSilentSetup(runCatalogScenario);

    if (catalogResult?.selectedModel) {
      state.selectedModel = catalogResult.selectedModel;
      state.alternateModel = catalogResult.alternateModel ?? state.alternateModel;
    }

    if (!state.selectedModel) {
      recordManagedSkip("ai.ui.paths", "Catalog selection failed, so popup AI fields could not be exercised.");
      recordManagedSkip("ai.config.sync", "Catalog selection failed, so baseline AI config could not be applied.");
    } else {
      await runManagedScenario("ai.ui.paths", runUiPathsScenario);
      await runManagedScenario("ai.config.sync", runConfigSyncScenario);
    }

    if (selectedLiveScenarioNames.length === 0) {
      return {
        report,
        state
      };
    }

    const edgeAiTestsEnabled = Boolean(state.selectedModel && state.originalUserApiKey);
    if (!edgeAiTestsEnabled) {
      for (const name of selectedLiveScenarioNames) {
        skipScenario(report, name, "A usable model or a user OpenAI API key is unavailable.");
      }
      return {
        report,
        state
      };
    }

    await runPreparedScenario("ai.status", async () => {
      const pageUrl = server.makeUrl("/status");
      const sessionState = await getAiStatus(driver, pageUrl);
      assert.equal(sessionState.status.provider, "openai", "AI status provider must be openai.");
      assert.equal(sessionState.status.apiKeyPresent, true, "AI status must report an OpenAI API key.");
      assert.deepEqual(sessionState.status.model, state.selectedModel, "AI status model does not match the selected model.");
      assert.equal(sessionState.status.streamingEnabled, true, "AI status must reflect streaming mode.");
      assert.equal(sessionState.status.structuredOutputEnabled, false, "Baseline structured output must be disabled.");
      assert.equal(sessionState.status.availableActions.canSend, true, "AI status must allow sending requests.");
      return {
        requestState: sessionState.status.requestState,
        canSend: sessionState.status.availableActions.canSend
      };
    });

    if (state.providerRegionBlocked) {
      recordManagedSkip("ai.overlay.user-chat", "OpenAI provider access is region-blocked, so live overlay chat completion cannot be verified.");
    } else {
      await runPreparedScenario("ai.overlay.user-chat", async () => {
        const pageUrl = server.makeUrl("/overlay-user");
        const pageKey = normalizePageKey(pageUrl);
        const tabId = await getTabIdByUrl(driver, pageUrl);
        assert.ok(typeof tabId === "number", "Unable to resolve the Edge tab for overlay user chat.");

        await switchToHandle(driver, mainHandle);
        await driver.get(pageUrl);
        await switchToHandle(driver, popupHandle);
        await sendCommand(driver, COMMANDS.overlayOpen, {
          tabId,
          expectedUrl: pageUrl
        });

        await switchToHandle(driver, mainHandle);
        await waitForOverlay(driver);
        await selectOverlayTab(driver, "chat");
        await sendOverlayChat(driver, "Reply with exact token EDGE_AI_USER_OK and nothing else.");
        const sessionState = await waitForSession(driver, pageKey, pageUrl, (candidate) =>
          candidate.status.requestState === "idle" &&
          sessionHasAssistantText(candidate, "EDGE_AI_USER_OK")
        );

        await switchToHandle(driver, mainHandle);
        await waitFor(async () => /provider\s*:\s*openai/i.test(await getOverlayChatStatusText(driver)), 15000, "Overlay chat status must show the OpenAI provider.");
        const statusText = await getOverlayChatStatusText(driver);
        assert.equal(sessionState.status.availableActions.canReset, true, "Overlay chat session must be resettable.");
        return {
          pageKey,
          messageCount: sessionState.messages.length,
          requestState: sessionState.status.requestState
        };
      });
    }

    if (state.providerRegionBlocked) {
      recordManagedSkip("ai.shared-session", "OpenAI provider access is region-blocked, so live shared-session reuse cannot be verified in overlay.");
    } else {
      await runPreparedScenario("ai.shared-session", async () => {
        const seedUrl = server.makeUrl("/shared?seed=1");
        const copyUrl = server.makeUrl("/shared?copy=1#fragment");
        const pageKey = normalizePageKey(seedUrl);
        await sendCommand(driver, COMMANDS.aiChatSend, {
          pageKey,
          pageUrl: seedUrl,
          origin: "user",
          text: "Reply with exact token EDGE_SHARED_OK and nothing else."
        });
        await waitForSession(driver, pageKey, seedUrl, (candidate) =>
          candidate.status.requestState === "idle" &&
          sessionHasAssistantText(candidate, "EDGE_SHARED_OK")
        );

        const sharedHandle = await openBrowserTab(driver, copyUrl);
        const sharedTabId = await waitForTabIdByUrl(driver, copyUrl);
        await switchToHandle(driver, popupHandle);
        await sendCommand(driver, COMMANDS.overlayOpen, {
          tabId: sharedTabId,
          expectedUrl: copyUrl
        });

        await switchToHandle(driver, sharedHandle);
        await waitForOverlay(driver);
        await selectOverlayTab(driver, "chat");
        await waitFor(async () => {
          const feedText = await getOverlayChatFeedText(driver);
          return feedText.includes("EDGE_SHARED_OK");
        }, 30000, "Shared Edge page did not reuse the existing AI session.");

        return {
          pageKey,
          sharedTabId
        };
      });
    }

    await runPreparedScenario("ai.code-origin", async () => {
      const pageUrl = server.makeUrl("/code");
      const pageKey = normalizePageKey(pageUrl);
      await sendCommand(driver, COMMANDS.aiChatSend, {
        pageKey,
        pageUrl,
        origin: "code",
        text: "Reply with exact token EDGE_CODE_OK and nothing else."
      });
      const sessionState = await waitForSession(driver, pageKey, pageUrl, (candidate) =>
        state.providerRegionBlocked
          ? candidate.status.requestState === "paused" &&
            candidate.messages.some((message) => message.origin === "code")
          : candidate.status.requestState === "idle" &&
            sessionHasAssistantText(candidate, "EDGE_CODE_OK") &&
            candidate.messages.some((message) => message.origin === "code")
      );
      assert.ok(sessionState.messages.some((message) => message.kind === "code"), "Code-origin prompt was not persisted as a code message.");
      return {
        pageKey,
        messageKinds: sessionState.messages.map((message) => message.kind),
        requestState: sessionState.status.requestState
      };
    });

    await runPreparedScenario("ai.structured-output", async () => {
      await openConfigTab(driver);
      await setModalTextValue(driver, "ai.chat.structuredOutput.schema", STRUCTURED_SCHEMA);
      await patchConfig(driver, {
        ai: {
          chat: {
            structuredOutput: {
              name: STRUCTURED_NAME,
              description: STRUCTURED_DESCRIPTION,
              strict: true
            }
          }
        }
      });

      const pageUrl = server.makeUrl("/structured");
      const pageKey = normalizePageKey(pageUrl);
      await sendCommand(driver, COMMANDS.aiChatSend, {
        pageKey,
        pageUrl,
        origin: "user",
        text: "Return token EDGE_JSON_OK and variant edge."
      });
      const sessionState = await waitForSession(driver, pageKey, pageUrl, (candidate) =>
        state.providerRegionBlocked
          ? candidate.status.requestState === "paused"
          : candidate.status.requestState === "idle" &&
            sessionHasAssistantJson(candidate, (parsed) => parsed?.token === "EDGE_JSON_OK")
      );

      assert.equal(sessionState.status.structuredOutputEnabled, true, "Structured output must be enabled in status.");
      assert.equal(sessionState.status.structuredOutputName, STRUCTURED_NAME, "Structured output name must match the configured name.");

      let parsed = null;
      if (!state.providerRegionBlocked) {
        const assistantMessage = findLatestAssistantMessage(sessionState);
        assert.ok(assistantMessage, "Structured output response is missing the assistant message.");
        parsed = JSON.parse(assistantMessage.text);
        assert.equal(parsed.token, "EDGE_JSON_OK", "Structured output token is incorrect.");
        assert.equal(parsed.variant, "edge", "Structured output variant is incorrect.");
      }

      await patchConfig(driver, {
        ai: {
          chat: {
            structuredOutput: {
              schema: ""
            }
          }
        }
      });

      return {
        pageKey,
        parsed
      };
    });

    await restoreBaselineAiConfig(driver, state.selectedModel, state.originalUserApiKey);

    await runPreparedScenario("ai.page-queue-limit", async () => {
      await patchConfig(driver, {
        ai: {
          rateLimits: {
            maxQueuedPerPage: 1,
            maxQueuedGlobal: 3
          }
        }
      });

      const pageUrl = server.makeUrl("/queue-page");
      const pageKey = normalizePageKey(pageUrl);
      await sendCommand(driver, COMMANDS.aiChatSend, {
        pageKey,
        pageUrl,
        origin: "user",
        text: "Reply with exact token EDGE_QUEUE_PAGE_PRIMARY and nothing else."
      });

      const response = await sendCommandExpectingError(driver, COMMANDS.aiChatSend, {
        pageKey,
        pageUrl,
        origin: "user",
        text: "Reply with exact token EDGE_QUEUE_PAGE_SECONDARY and nothing else."
      });
      assert.match(response.message, /Page AI queue limit has been reached/i, "Per-page queue limit error did not match.");

      await sendCommand(driver, COMMANDS.aiChatReset, {
        pageKey
      });
      await restoreBaselineAiConfig(driver, state.selectedModel, state.originalUserApiKey);

      return {
        pageKey,
        error: response.message
      };
    });

    await runPreparedScenario("ai.global-queue-limit", async () => {
      await patchConfig(driver, {
        ai: {
          rateLimits: {
            maxQueuedPerPage: 3,
            maxQueuedGlobal: 1
          }
        }
      });

      const pageUrlA = server.makeUrl("/queue-global-a");
      const pageKeyA = normalizePageKey(pageUrlA);
      const pageUrlB = server.makeUrl("/queue-global-b");
      const pageKeyB = normalizePageKey(pageUrlB);

      await sendCommand(driver, COMMANDS.aiChatSend, {
        pageKey: pageKeyA,
        pageUrl: pageUrlA,
        origin: "user",
        text: "Reply with exact token EDGE_QUEUE_GLOBAL_PRIMARY and nothing else."
      });

      const response = await sendCommandExpectingError(driver, COMMANDS.aiChatSend, {
        pageKey: pageKeyB,
        pageUrl: pageUrlB,
        origin: "user",
        text: "Reply with exact token EDGE_QUEUE_GLOBAL_SECONDARY and nothing else."
      });
      assert.match(response.message, /Global AI queue limit has been reached/i, "Global queue limit error did not match.");

      await sendCommand(driver, COMMANDS.aiChatReset, {
        pageKey: pageKeyA
      });
      await sendCommand(driver, COMMANDS.aiChatReset, {
        pageKey: pageKeyB
      });
      await restoreBaselineAiConfig(driver, state.selectedModel, state.originalUserApiKey);

      return {
        pageKeyA,
        pageKeyB,
        error: response.message
      };
    });

    await runPreparedScenario("ai.retry-resume", async () => {
      await patchConfig(driver, {
        ai: {
          openAiApiKey: INVALID_MANAGED_API_KEY
        }
      });

      const pageUrl = server.makeUrl("/resume-invalid");
      const pageKey = normalizePageKey(pageUrl);
      await sendCommand(driver, COMMANDS.aiChatSend, {
        pageKey,
        pageUrl,
        origin: "user",
        text: "Reply with exact token EDGE_RESUME_OK and nothing else."
      });

      const pausedSession = await waitForSession(driver, pageKey, pageUrl, (candidate) =>
        candidate.status.requestState === "paused" &&
        candidate.status.availableActions.canResume &&
        typeof candidate.status.lastError === "string"
      );
      assert.ok(
        typeof pausedSession.status.lastError === "string" && pausedSession.status.lastError.trim().length > 0,
        "Retryable AI request did not capture an error message."
      );

      await patchConfig(driver, {
        ai: {
          openAiApiKey: state.originalUserApiKey
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
        state.providerRegionBlocked
          ? candidate.status.requestState === "paused" &&
            typeof candidate.status.lastError === "string" &&
            candidate.status.lastError.includes("unsupported_country_region_territory")
          : candidate.status.requestState === "idle" &&
            sessionHasAssistantText(candidate, "EDGE_RESUME_OK")
      );
      if (state.providerRegionBlocked) {
        assert.ok(
          typeof resumedSession.status.lastError === "string" &&
            resumedSession.status.lastError.includes("unsupported_country_region_territory"),
          "Resumed AI request did not transition from the invalid-key error to the provider-region error."
        );
      } else {
        assert.equal(resumedSession.status.requestState, "idle", "Resumed AI request did not settle back to idle.");
      }

      return {
        pageKey,
        pausedError: pausedSession.status.lastError,
        resumedError: resumedSession.status.lastError
      };
    });

    await runPreparedScenario("ai.reset", async () => {
      const pageUrl = server.makeUrl("/reset");
      const pageKey = normalizePageKey(pageUrl);
      await sendCommand(driver, COMMANDS.aiChatSend, {
        pageKey,
        pageUrl,
        origin: "user",
        text: "Reply with exact token EDGE_RESET_OK and nothing else."
      });
      await waitForSession(driver, pageKey, pageUrl, (candidate) =>
        state.providerRegionBlocked
          ? candidate.status.requestState === "paused"
          : candidate.status.requestState === "idle" &&
            sessionHasAssistantText(candidate, "EDGE_RESET_OK")
      );

      const resetResult = await sendCommand(driver, COMMANDS.aiChatReset, {
        pageKey
      });
      assert.ok(resetResult.session, "ai.chat.reset did not return the session payload.");
      const resetSession = await getAiStatus(driver, pageUrl);
      assert.equal(resetSession.status.requestState, "idle", "Reset AI session must return to idle.");
      assert.ok(resetSession.messages.some((message) => message.kind === "reset"), "Reset AI session must record a reset message.");
      return {
        pageKey,
        messageCountAfterReset: resetSession.messages.length
      };
    });

    await runPreparedScenario("ai.model-unset", async () => {
      await patchConfig(driver, {
        ai: {
          chat: {
            model: null
          }
        }
      });

      const pageUrl = server.makeUrl("/model-unset");
      const response = await sendCommandExpectingError(driver, COMMANDS.aiChatSend, {
        pageKey: normalizePageKey(pageUrl),
        pageUrl,
        origin: "user",
        text: "Reply with exact token EDGE_MODEL_UNSET_OK and nothing else."
      });
      assert.match(response.message, /AI model is unset in config/i, "Unset model error did not match.");
      await restoreBaselineAiConfig(driver, state.selectedModel, state.originalUserApiKey);
      return {
        error: response.message
      };
    });

    await runPreparedScenario("ai.api-key-missing", async () => {
      await patchConfig(driver, {
        ai: {
          openAiApiKey: ""
        }
      });

      const pageUrl = server.makeUrl("/missing-key");
      const response = await sendCommandExpectingError(driver, COMMANDS.aiChatSend, {
        pageKey: normalizePageKey(pageUrl),
        pageUrl,
        origin: "user",
        text: "Reply with exact token EDGE_MISSING_KEY_OK and nothing else."
      });
      assert.match(response.message, /OPENAI_API_KEY environment variable is missing/i, "Missing API key error did not match.");

      await patchConfig(driver, {
        ai: {
          openAiApiKey: state.originalUserApiKey
        }
      });
      await patchConfig(driver, {
        ai: {
          openAiApiKey: null
        }
      });

      return {
        error: response.message
      };
    });

    if (state.providerRegionBlocked) {
      recordManagedSkip("ai.rate-limit-blocked", "OpenAI provider access is region-blocked, so rate-limit telemetry cannot be verified.");
    } else {
      await runPreparedScenario("ai.rate-limit-blocked", async () => {
        const budgetPageUrl = server.makeUrl("/rate-limit-budget");
        const budgetStatus = await getAiStatus(driver, budgetPageUrl);
        const remainingTokens =
          budgetStatus.status.currentModelBudget?.serverRemainingTokens ??
          budgetStatus.status.rateLimits?.serverRemainingTokens ??
          null;
        if (remainingTokens === null) {
          throw new Error("Current model budget telemetry did not expose remaining token data.");
        }

        await patchConfig(driver, {
          ai: {
            rateLimits: {
              reserveOutputTokens: remainingTokens + 1024
            }
          }
        });

        const pageUrl = server.makeUrl("/rate-limit-blocked");
        const pageKey = normalizePageKey(pageUrl);
        await sendCommand(driver, COMMANDS.aiChatSend, {
          pageKey,
          pageUrl,
          origin: "user",
          text: "Reply with exact token EDGE_BLOCKED_OK and nothing else."
        });
        const blockedSession = await waitForSession(driver, pageKey, pageUrl, (candidate) =>
          candidate.status.requestState === "blocked" && candidate.status.availableActions.canResume
        );
        assert.equal(blockedSession.status.lastError, "rate_limit_blocked", "Blocked AI request did not report the rate-limit marker.");

        await patchConfig(driver, {
          ai: {
            rateLimits: {
              reserveOutputTokens: 512
            }
          }
        });
        await sendCommand(driver, COMMANDS.aiChatResume, {
          pageKey
        });
        const resumedSession = await waitForSession(driver, pageKey, pageUrl, (candidate) =>
          candidate.status.requestState === "idle" &&
          sessionHasAssistantText(candidate, "EDGE_BLOCKED_OK")
        );
        assert.equal(resumedSession.status.requestState, "idle", "Rate-limit-resumed AI request did not settle back to idle.");

        return {
          pageKey,
          remainingTokens
        };
      });
    }

    if (state.providerRegionBlocked) {
      recordManagedSkip("ai.compaction", "OpenAI provider access is region-blocked, so successful context compaction cannot be verified.");
    } else {
      await runPreparedScenario("ai.compaction", async () => {
        const pageUrl = server.makeUrl("/compaction");
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
          text: "Reply with exact token EDGE_COMPACTION_OK and nothing else."
        });
        const compactedSession = await waitForSession(driver, pageKey, pageUrl, (candidate) =>
          candidate.messages.some((message) => message.kind === "compaction" && message.text.includes("completed")) &&
          candidate.status.requestState === "idle" &&
          sessionHasAssistantText(candidate, "EDGE_COMPACTION_OK")
        );
        assert.ok(compactedSession.messages.some((message) => message.kind === "compaction"), "Compaction message was not emitted.");
        return {
          pageKey,
          compactionMessages: compactedSession.messages.filter((message) => message.kind === "compaction").length
        };
      });
    }

    await runPreparedScenario("ai.list", async () => {
      const listResult = await sendCommand(driver, COMMANDS.aiChatList, {});
      assert.ok(Array.isArray(listResult.sessions) && listResult.sessions.length >= 5, "ai.chat.list returned too few sessions after the test run.");
      return {
        sessionCount: listResult.sessions.length,
        pageKeys: listResult.sessions.map((item) => item.pageKey).slice(0, 8)
      };
    });

    await runPreparedScenario("ai.api-key-editor", async () => {
      await openConfigTab(driver);
      await setModalTextValue(driver, "ai.openAiApiKey", TEMP_MANAGED_API_KEY);
      await waitFor(async () => {
        const currentValue = await getUserEnvironmentVariableAsync(OPENAI_API_KEY_ENV_VAR_NAME);
        return currentValue === TEMP_MANAGED_API_KEY;
      }, 15000, "Saving ai.openAiApiKey in the popup did not update the user environment variable.");

      const buttonText = await readButtonText(driver, "ai.openAiApiKey");
      assert.equal(buttonText.includes(TEMP_MANAGED_API_KEY), false, "Sensitive API key text leaked into the popup button.");

      await setModalTextValue(driver, "ai.openAiApiKey", "");
      await waitFor(async () => {
        const currentValue = await getUserEnvironmentVariableAsync(OPENAI_API_KEY_ENV_VAR_NAME);
        return !currentValue;
      }, 15000, "Clearing ai.openAiApiKey in the popup did not remove the user environment variable.");

      await patchConfig(driver, {
        ai: {
          openAiApiKey: state.originalUserApiKey
        }
      });
      await patchConfig(driver, {
        ai: {
          openAiApiKey: null
        }
      });

      return {
        buttonMasked: true,
        envCreateRemoveVerified: true
      };
    });
  } finally {
    if (state.selectedModel && state.originalUserApiKey) {
      try {
        await restoreBaselineAiConfig(driver, state.selectedModel, state.originalUserApiKey);
      } catch {
        // Best-effort cleanup.
      }
    } else {
      try {
        await resetAllSessions(driver);
      } catch {
        // Best-effort cleanup.
      }
    }

    report.finishedAt = new Date().toISOString();
  }

  return {
    report,
    state
  };
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
    if (details !== undefined) {
      entry.details = details;
    }
    return details;
  } catch (error) {
    if (error?.name === "SkipCaseError") {
      entry.status = "skipped";
      entry.reason = error.reason;
      if (error.details !== undefined) {
        entry.details = error.details;
      }
      return null;
    }

    entry.status = "failed";
    entry.error = error instanceof Error ? error.message : String(error);
    entry.errorDetails = serializeError(error);
    return null;
  } finally {
    entry.finishedAt = new Date().toISOString();
  }
}

function skipScenario(report, name, reason, details) {
  report.scenarios.push({
    name,
    status: "skipped",
    reason,
    ...(details === undefined ? {} : { details }),
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString()
  });
}

function throwSkip(reason, details) {
  const error = new Error(reason);
  error.name = "SkipCaseError";
  error.reason = reason;
  error.details = details;
  throw error;
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

function isRetryableScenarioError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /Object reference not set to an instance of an object|Native host request timed out|did not reach the expected state/i.test(message);
}
