import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { Builder, Browser } from "selenium-webdriver";
import edge from "selenium-webdriver/edge.js";

import {
  cleanDir,
  ensureDir,
  ensureExtensionKeyMetadata,
  fileExists,
  getNativeHostExePath,
  paths,
  run,
  writeJson
} from "./lib/common.mjs";

const COMMANDS = {
  overlayOpen: "overlay.open",
  configGet: "config.get",
  configPatch: "config.patch",
  aiModelsCatalog: "ai.models.catalog",
  aiChatStatus: "ai.chat.status",
  aiChatSend: "ai.chat.send",
  aiChatResume: "ai.chat.resume",
  aiChatReset: "ai.chat.reset",
  aiChatList: "ai.chat.list"
};

const OPENAI_API_KEY_ENV_VAR_NAME = "OPENAI_API_KEY";
const TEMP_MANAGED_API_KEY = "sk-test-edge-managed-key";
const INVALID_MANAGED_API_KEY = "sk-test-edge-invalid-key";
const AI_UI_PATHS = [
  "ai.openAiApiKey",
  "ai.allowedModels",
  "ai.chat.model",
  "ai.chat.streamingEnabled",
  "ai.chat.instructions",
  "ai.chat.structuredOutput.name",
  "ai.chat.structuredOutput.description",
  "ai.chat.structuredOutput.schema",
  "ai.chat.structuredOutput.strict",
  "ai.compaction.enabled",
  "ai.compaction.streamingEnabled",
  "ai.compaction.modelOverride",
  "ai.compaction.instructions",
  "ai.compaction.triggerPromptTokens",
  "ai.compaction.preserveRecentTurns",
  "ai.compaction.maxPassesPerPage",
  "ai.rateLimits.reserveOutputTokens",
  "ai.rateLimits.maxQueuedPerPage",
  "ai.rateLimits.maxQueuedGlobal"
];

const BASE_CHAT_INSTRUCTIONS = "Reply tersely and follow the requested token exactly.";
const BASE_COMPACTION_INSTRUCTIONS = "Compress prior completed turns into the smallest faithful reusable context.";
const STRUCTURED_NAME = "edge_structured_reply";
const STRUCTURED_DESCRIPTION = "Return a compact JSON object with token and variant.";
const STRUCTURED_SCHEMA = JSON.stringify(
  {
    type: "object",
    properties: {
      token: { type: "string" },
      variant: { type: "string" }
    },
    required: ["token", "variant"],
    additionalProperties: false
  },
  null,
  2
);

let popupRuntimeHandle = null;

async function main() {
  const report = {
    startedAt: new Date().toISOString(),
    environment: {
      browser: "Microsoft Edge",
      manifestVersion: 3,
      originalUserApiKeyPresent: false
    },
    coverage: {
      expectedAiUiPaths: AI_UI_PATHS
    },
    scenarios: []
  };

  let driver = null;
  let server = null;
  let popupHandle = null;
  let mainHandle = null;
  let popupUrl = null;
  let selectedModel = null;
  let providerRegionBlocked = false;
  const originalUserApiKey = getUserEnvironmentVariable(OPENAI_API_KEY_ENV_VAR_NAME);
  report.environment.originalUserApiKeyPresent = Boolean(originalUserApiKey);

  try {
    await prepareArtifacts();

    const extensionMetadata = await ensureExtensionKeyMetadata();
    const extensionBaseUrl = `chrome-extension://${extensionMetadata.extensionId}`;
    popupUrl = `${extensionBaseUrl}/popup.html`;
    report.environment.extensionId = extensionMetadata.extensionId;

    server = await startLocalServer();
    driver = await launchEdgeWithExtension();
    await driver.manage().setTimeouts({
      script: 120000,
      pageLoad: 120000,
      implicit: 0
    });

    await driver.get(server.makeUrl("/overlay-user"));
    mainHandle = await driver.getWindowHandle();
    popupHandle = await openBrowserTab(driver, popupUrl);
    popupRuntimeHandle = popupHandle;
    await ensurePopupReady(driver);

    const catalogResult = await runScenario(report, "ai.catalog", async () => {
      const result = await sendCommand(driver, COMMANDS.aiModelsCatalog, {});
      assert.ok(Array.isArray(result.models) && result.models.length > 0, "OpenAI model catalog is empty.");
      const model = chooseModelFromCatalog(result.models);
      assert.ok(model, "No usable OpenAI model was found in the catalog.");
      return {
        modelCount: result.models.length,
        selectedModel: model
      };
    });
    selectedModel = catalogResult?.selectedModel ?? null;
    if (!selectedModel) {
      const catalogFailure = report.scenarios.find((scenario) => scenario.name === "ai.catalog")?.error ?? "";
      providerRegionBlocked = /unsupported_country_region_territory|Country, region, or territory not supported/i.test(catalogFailure);
      if (providerRegionBlocked) {
        selectedModel = {
          model: "gpt-5",
          tier: "standard"
        };
        report.environment.providerRegionBlocked = true;
        report.environment.catalogFallbackModel = selectedModel;
      }
    }
    if (!selectedModel) {
      skipScenario(report, "ai.ui.paths", "Catalog selection failed, so popup AI fields could not be exercised.");
      skipScenario(report, "ai.config.sync", "Catalog selection failed, so baseline AI config could not be applied.");
    } else {
      await runScenario(report, "ai.ui.paths", async () => {
        await openConfigTab(driver);
        const actualPaths = await getPopupAiConfigPaths(driver);
        assert.deepEqual(actualPaths, [...AI_UI_PATHS].sort(), "AI config paths exposed in popup differ from the expected registry.");
        return {
          actualAiUiPaths: actualPaths
        };
      });

      await runScenario(report, "ai.config.sync", async () => {
        await openConfigTab(driver);
        await setModalTextValue(driver, "ai.chat.instructions", BASE_CHAT_INSTRUCTIONS);
        await setModalTextValue(driver, "ai.compaction.instructions", BASE_COMPACTION_INSTRUCTIONS);
        await setSelectValue(driver, "ai.chat.streamingEnabled", "false");
        await setSelectValue(driver, "ai.chat.streamingEnabled", "true");
        await setSelectValue(driver, "ai.compaction.enabled", "false");
        await setSelectValue(driver, "ai.compaction.enabled", "true");
        await setInlineValue(driver, "ai.rateLimits.maxQueuedPerPage", "2");
        if (!providerRegionBlocked) {
          await setAllowedModel(driver, selectedModel.model, selectedModel.tier);
          await setModelPanelValue(driver, "ai.chat.model", selectedModel.model, selectedModel.tier);
        }

        await patchConfig(driver, {
          ai: {
            openAiApiKey: null,
            allowedModels: [selectedModel],
            chat: {
              model: selectedModel,
              streamingEnabled: true,
              instructions: BASE_CHAT_INSTRUCTIONS,
              structuredOutput: {
                name: STRUCTURED_NAME,
                description: STRUCTURED_DESCRIPTION,
                schema: "",
                strict: true
              }
            },
            compaction: {
              enabled: true,
              streamingEnabled: true,
              modelOverride: selectedModel,
              instructions: BASE_COMPACTION_INSTRUCTIONS,
              triggerPromptTokens: 64,
              preserveRecentTurns: 1,
              maxPassesPerPage: 2
            },
            rateLimits: {
              reserveOutputTokens: 512,
              maxQueuedPerPage: 2,
              maxQueuedGlobal: 3
            }
          }
        });

        const snapshot = await getRuntimeSnapshot(driver);
        const config = snapshot.config;
        assert.deepEqual(config.ai.allowedModels, [selectedModel], "ai.allowedModels did not persist.");
        assert.deepEqual(config.ai.chat.model, selectedModel, "ai.chat.model did not persist.");
        assert.equal(config.ai.chat.streamingEnabled, true, "ai.chat.streamingEnabled did not persist.");
        assert.equal(config.ai.chat.instructions, BASE_CHAT_INSTRUCTIONS, "ai.chat.instructions did not persist.");
        assert.equal(config.ai.chat.structuredOutput.name, STRUCTURED_NAME, "ai.chat.structuredOutput.name did not persist.");
        assert.equal(config.ai.chat.structuredOutput.description, STRUCTURED_DESCRIPTION, "ai.chat.structuredOutput.description did not persist.");
        assert.equal(config.ai.chat.structuredOutput.schema, "", "ai.chat.structuredOutput.schema baseline must stay empty.");
        assert.equal(config.ai.chat.structuredOutput.strict, true, "ai.chat.structuredOutput.strict did not persist.");
        assert.equal(config.ai.compaction.enabled, true, "ai.compaction.enabled did not persist.");
        assert.equal(config.ai.compaction.streamingEnabled, true, "ai.compaction.streamingEnabled did not persist.");
        assert.deepEqual(config.ai.compaction.modelOverride, selectedModel, "ai.compaction.modelOverride did not persist.");
        assert.equal(config.ai.compaction.instructions, BASE_COMPACTION_INSTRUCTIONS, "ai.compaction.instructions did not persist.");
        assert.equal(config.ai.compaction.triggerPromptTokens, 64, "ai.compaction.triggerPromptTokens did not persist.");
        assert.equal(config.ai.compaction.preserveRecentTurns, 1, "ai.compaction.preserveRecentTurns did not persist.");
        assert.equal(config.ai.compaction.maxPassesPerPage, 2, "ai.compaction.maxPassesPerPage did not persist.");
        assert.equal(config.ai.rateLimits.reserveOutputTokens, 512, "ai.rateLimits.reserveOutputTokens did not persist.");
        assert.equal(config.ai.rateLimits.maxQueuedPerPage, 2, "ai.rateLimits.maxQueuedPerPage did not persist.");
        assert.equal(config.ai.rateLimits.maxQueuedGlobal, 3, "ai.rateLimits.maxQueuedGlobal did not persist.");
        assert.equal(config.ai.openAiApiKey, null, "ai.openAiApiKey baseline must stay null.");

        await waitFor(async () => {
          const state = await readNativeHostState();
          return (
            state?.aiConfig?.chat?.model?.model === selectedModel.model &&
            state?.aiConfig?.chat?.model?.tier === selectedModel.tier &&
            state?.aiConfig?.chat?.streamingEnabled === true &&
            state?.aiConfig?.chat?.instructions === BASE_CHAT_INSTRUCTIONS &&
            state?.aiConfig?.chat?.structuredOutput?.name === STRUCTURED_NAME &&
            state?.aiConfig?.chat?.structuredOutput?.description === STRUCTURED_DESCRIPTION &&
            state?.aiConfig?.chat?.structuredOutput?.schema === "" &&
            state?.aiConfig?.chat?.structuredOutput?.strict === true &&
            state?.aiConfig?.compaction?.enabled === true &&
            state?.aiConfig?.compaction?.streamingEnabled === true &&
            state?.aiConfig?.compaction?.modelOverride?.model === selectedModel.model &&
            state?.aiConfig?.compaction?.modelOverride?.tier === selectedModel.tier &&
            state?.aiConfig?.compaction?.instructions === BASE_COMPACTION_INSTRUCTIONS &&
            state?.aiConfig?.compaction?.triggerPromptTokens === 64 &&
            state?.aiConfig?.compaction?.preserveRecentTurns === 1 &&
            state?.aiConfig?.compaction?.maxPassesPerPage === 2 &&
            state?.aiConfig?.rateLimits?.reserveOutputTokens === 512 &&
            state?.aiConfig?.rateLimits?.maxQueuedPerPage === 2 &&
            state?.aiConfig?.rateLimits?.maxQueuedGlobal === 3
          );
        }, 15000, "Native host did not receive the expected AI config.");

        return {
          selectedModel,
          hostSyncVerified: true,
          catalogBlockedByProvider: providerRegionBlocked
        };
      });
    }

    const edgeAiTestsEnabled = Boolean(selectedModel && originalUserApiKey);
    if (!edgeAiTestsEnabled) {
      skipScenario(report, "ai.status", "A usable model or a user OpenAI API key is unavailable.");
      skipScenario(report, "ai.overlay.user-chat", "A usable model or a user OpenAI API key is unavailable.");
      skipScenario(report, "ai.shared-session", "A usable model or a user OpenAI API key is unavailable.");
      skipScenario(report, "ai.code-origin", "A usable model or a user OpenAI API key is unavailable.");
      skipScenario(report, "ai.structured-output", "A usable model or a user OpenAI API key is unavailable.");
      skipScenario(report, "ai.page-queue-limit", "A usable model or a user OpenAI API key is unavailable.");
      skipScenario(report, "ai.global-queue-limit", "A usable model or a user OpenAI API key is unavailable.");
      skipScenario(report, "ai.retry-resume", "A usable model or a user OpenAI API key is unavailable.");
      skipScenario(report, "ai.reset", "A usable model or a user OpenAI API key is unavailable.");
      skipScenario(report, "ai.model-unset", "A usable model or a user OpenAI API key is unavailable.");
      skipScenario(report, "ai.api-key-missing", "A usable model or a user OpenAI API key is unavailable.");
      skipScenario(report, "ai.rate-limit-blocked", "A usable model or a user OpenAI API key is unavailable.");
      skipScenario(report, "ai.compaction", "A usable model or a user OpenAI API key is unavailable.");
      skipScenario(report, "ai.list", "A usable model or a user OpenAI API key is unavailable.");
      skipScenario(report, "ai.api-key-editor", "A usable model or a user OpenAI API key is unavailable.");
    } else {
      await restoreBaselineAiConfig(driver, selectedModel, originalUserApiKey);

      await runScenario(report, "ai.status", async () => {
        const pageUrl = server.makeUrl("/status");
        const session = await getAiStatus(driver, pageUrl);
        assert.equal(session.status.provider, "openai", "AI status provider must be openai.");
        assert.equal(session.status.apiKeyPresent, true, "AI status must report an OpenAI API key.");
        assert.deepEqual(session.status.model, selectedModel, "AI status model does not match the selected model.");
        assert.equal(session.status.streamingEnabled, true, "AI status must reflect streaming mode.");
        assert.equal(session.status.structuredOutputEnabled, false, "Baseline structured output must be disabled.");
        assert.equal(session.status.availableActions.canSend, true, "AI status must allow sending requests.");
        return {
          requestState: session.status.requestState,
          canSend: session.status.availableActions.canSend
        };
      });

      if (providerRegionBlocked) {
        skipScenario(report, "ai.overlay.user-chat", "OpenAI provider access is region-blocked, so live overlay chat completion cannot be verified.");
      } else {
        await runScenario(report, "ai.overlay.user-chat", async () => {
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
        const session = providerRegionBlocked
          ? await waitForSession(driver, pageKey, pageUrl, (candidate) =>
            candidate.status.requestState === "paused" &&
            typeof candidate.status.lastError === "string" &&
            candidate.status.lastError.includes("unsupported_country_region_territory")
          )
          : await waitForSession(driver, pageKey, pageUrl, (candidate) =>
            candidate.messages.some((message) => message.text.includes("EDGE_AI_USER_OK"))
          );

        const statusText = await getOverlayChatStatusText(driver);
        assert.ok(statusText.includes("provider: openai"), "Overlay chat status must show the OpenAI provider.");
        assert.equal(session.status.availableActions.canReset, true, "Overlay chat session must be resettable.");
        return {
          pageKey,
          messageCount: session.messages.length,
          requestState: session.status.requestState
        };
        });
      }

      if (providerRegionBlocked) {
        skipScenario(report, "ai.shared-session", "OpenAI provider access is region-blocked, so live shared-session reuse cannot be verified in overlay.");
      } else {
        await runScenario(report, "ai.shared-session", async () => {
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
          providerRegionBlocked
            ? candidate.status.requestState === "paused"
            : candidate.messages.some((message) => message.text.includes("EDGE_SHARED_OK"))
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
          return providerRegionBlocked
            ? feedText.includes("unsupported_country_region_territory")
            : feedText.includes("EDGE_SHARED_OK");
        }, 30000, "Shared Edge page did not reuse the existing AI session.");

        return {
          pageKey,
          sharedTabId
        };
        });
      }

      await runScenario(report, "ai.code-origin", async () => {
        const pageUrl = server.makeUrl("/code");
        const pageKey = normalizePageKey(pageUrl);
        await sendCommand(driver, COMMANDS.aiChatSend, {
          pageKey,
          pageUrl,
          origin: "code",
          text: "Reply with exact token EDGE_CODE_OK and nothing else."
        });
        const session = await waitForSession(driver, pageKey, pageUrl, (candidate) =>
          providerRegionBlocked
            ? candidate.status.requestState === "paused" &&
              candidate.messages.some((message) => message.origin === "code")
            : candidate.messages.some((message) => message.text.includes("EDGE_CODE_OK")) &&
              candidate.messages.some((message) => message.origin === "code")
        );
        assert.ok(session.messages.some((message) => message.kind === "code"), "Code-origin prompt was not persisted as a code message.");
        return {
          pageKey,
          messageKinds: session.messages.map((message) => message.kind),
          requestState: session.status.requestState
        };
      });

      await runScenario(report, "ai.structured-output", async () => {
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
        const session = await waitForSession(driver, pageKey, pageUrl, (candidate) =>
          providerRegionBlocked
            ? candidate.status.requestState === "paused"
            : candidate.messages.some((message) => {
              try {
                const parsed = JSON.parse(message.text);
                return parsed?.token === "EDGE_JSON_OK";
              } catch {
                return false;
              }
            })
        );

        assert.equal(session.status.structuredOutputEnabled, true, "Structured output must be enabled in status.");
        assert.equal(session.status.structuredOutputName, STRUCTURED_NAME, "Structured output name must match the configured name.");

        let parsed = null;
        if (!providerRegionBlocked) {
          const assistantMessage = [...session.messages]
            .reverse()
            .find((message) => message.origin === "assistant" && message.state === "completed");
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

      await restoreBaselineAiConfig(driver, selectedModel, originalUserApiKey);

      await runScenario(report, "ai.page-queue-limit", async () => {
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
        await restoreBaselineAiConfig(driver, selectedModel, originalUserApiKey);

        return {
          pageKey,
          error: response.message
        };
      });

      await runScenario(report, "ai.global-queue-limit", async () => {
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
        await restoreBaselineAiConfig(driver, selectedModel, originalUserApiKey);

        return {
          pageKeyA,
          pageKeyB,
          error: response.message
        };
      });

      await runScenario(report, "ai.retry-resume", async () => {
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
          candidate.status.requestState === "paused" && candidate.status.availableActions.canResume
        );
        assert.ok(
          typeof pausedSession.status.lastError === "string" && pausedSession.status.lastError.includes("OpenAI HTTP"),
          "Retryable AI request did not capture the OpenAI error."
        );

        await patchConfig(driver, {
          ai: {
            openAiApiKey: originalUserApiKey
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
          providerRegionBlocked
            ? candidate.status.requestState === "paused" &&
              typeof candidate.status.lastError === "string" &&
              candidate.status.lastError.includes("unsupported_country_region_territory")
            : candidate.messages.some((message) => message.text.includes("EDGE_RESUME_OK"))
        );
        if (providerRegionBlocked) {
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

      await runScenario(report, "ai.reset", async () => {
        const pageUrl = server.makeUrl("/reset");
        const pageKey = normalizePageKey(pageUrl);
        await sendCommand(driver, COMMANDS.aiChatSend, {
          pageKey,
          pageUrl,
          origin: "user",
          text: "Reply with exact token EDGE_RESET_OK and nothing else."
        });
        await waitForSession(driver, pageKey, pageUrl, (candidate) =>
          providerRegionBlocked
            ? candidate.status.requestState === "paused"
            : candidate.messages.some((message) => message.text.includes("EDGE_RESET_OK"))
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

      await runScenario(report, "ai.model-unset", async () => {
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
        await restoreBaselineAiConfig(driver, selectedModel, originalUserApiKey);
        return {
          error: response.message
        };
      });

      await runScenario(report, "ai.api-key-missing", async () => {
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
            openAiApiKey: originalUserApiKey
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

      if (providerRegionBlocked) {
        skipScenario(report, "ai.rate-limit-blocked", "OpenAI provider access is region-blocked, so rate-limit telemetry cannot be verified.");
      } else {
        await runScenario(report, "ai.rate-limit-blocked", async () => {
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
          candidate.messages.some((message) => message.text.includes("EDGE_BLOCKED_OK"))
        );
        assert.equal(resumedSession.status.requestState, "idle", "Rate-limit-resumed AI request did not settle back to idle.");

        return {
          pageKey,
          remainingTokens
        };
        });
      }

      if (providerRegionBlocked) {
        skipScenario(report, "ai.compaction", "OpenAI provider access is region-blocked, so successful context compaction cannot be verified.");
      } else {
        await runScenario(report, "ai.compaction", async () => {
        const pageUrl = server.makeUrl("/compaction");
        const pageKey = normalizePageKey(pageUrl);
        await sendCommand(driver, COMMANDS.aiChatSend, {
          pageKey,
          pageUrl,
          origin: "user",
          text: "Reply with exact token EDGE_COMPACTION_SEED and nothing else."
        });
        await waitForSession(driver, pageKey, pageUrl, (candidate) =>
          candidate.messages.some((message) => message.text.includes("EDGE_COMPACTION_SEED"))
        );

        await sendCommand(driver, COMMANDS.aiChatSend, {
          pageKey,
          pageUrl,
          origin: "user",
          text: "Repeat exact token EDGE_COMPACTION_OK and add a short explanation so the prompt is not empty."
        });
        const compactedSession = await waitForSession(driver, pageKey, pageUrl, (candidate) =>
          candidate.messages.some((message) => message.kind === "compaction" && message.text.includes("completed")) &&
          candidate.messages.some((message) => message.text.includes("EDGE_COMPACTION_OK"))
        );
        assert.ok(compactedSession.messages.some((message) => message.kind === "compaction"), "Compaction message was not emitted.");
        return {
          pageKey,
          compactionMessages: compactedSession.messages.filter((message) => message.kind === "compaction").length
        };
        });
      }

      await runScenario(report, "ai.list", async () => {
        const listResult = await sendCommand(driver, COMMANDS.aiChatList, {});
        assert.ok(Array.isArray(listResult.sessions) && listResult.sessions.length >= 5, "ai.chat.list returned too few sessions after the test run.");
        return {
          sessionCount: listResult.sessions.length,
          pageKeys: listResult.sessions.map((session) => session.pageKey).slice(0, 8)
        };
      });

      await runScenario(report, "ai.api-key-editor", async () => {
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
            openAiApiKey: originalUserApiKey
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
    }
  } finally {
    if (driver && selectedModel && originalUserApiKey) {
      try {
        await restoreBaselineAiConfig(driver, selectedModel, originalUserApiKey);
      } catch {
        // Best-effort cleanup.
      }
    }

    report.finishedAt = new Date().toISOString();
    await ensureDir(path.dirname(getReportPath()));
    await writeJson(getReportPath(), report);

    if (driver) {
      await driver.quit().catch(() => {});
    }
    if (server) {
      await server.close().catch(() => {});
    }
  }

  const failedScenarios = report.scenarios.filter((scenario) => scenario.status === "failed");
  if (failedScenarios.length > 0) {
    throw new Error(`Edge AI test suite finished with ${failedScenarios.length} failed scenario(s). Report: ${getReportPath()}`);
  }

  console.log(`Edge AI test suite passed. Report: ${getReportPath()}`);
}

async function prepareArtifacts() {
  await fs.rm(getNativeHostStatePath(), { force: true });
  await run(process.execPath, ["scripts/build-extension.mjs"]);
  await run(process.execPath, ["scripts/build-native-host.mjs"]);
  await run(process.execPath, ["scripts/pack-extension.mjs"]);
  await run(process.execPath, ["scripts/register-native-host.mjs"]);

  assert.equal(await fileExists(paths.packagedCrx), true, "Packed CRX is missing.");
  assert.equal(await fileExists(getNativeHostExePath()), true, "Native host executable is missing.");
}

async function launchEdgeWithExtension() {
  await cleanDir(paths.edgeUserData);

  const options = createEdgeOptions(paths.edgeUserData);
  options.addExtensions(paths.packagedCrx);

  return new Builder()
    .forBrowser(Browser.EDGE)
    .setEdgeOptions(options)
    .build();
}

function createEdgeOptions(userDataDir) {
  const options = new edge.Options();
  options.addArguments(
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-search-engine-choice-screen",
    "--disable-features=msEdgeAccountConsistency"
  );
  return options;
}

async function openBrowserTab(driver, url) {
  await driver.switchTo().newWindow("tab");
  const handle = await driver.getWindowHandle();
  await driver.get(url);
  return handle;
}

async function switchToHandle(driver, handle) {
  await driver.switchTo().window(handle);
}

async function ensurePopupContext(driver) {
  if (popupRuntimeHandle) {
    await switchToHandle(driver, popupRuntimeHandle);
  }
}

async function ensurePopupReady(driver) {
  await ensurePopupContext(driver);
  await waitFor(async () => {
    const state = await driver.executeScript(`
      return {
        readyState: document.readyState,
        badge: document.querySelector('#status-badge')?.textContent ?? null,
        configTab: !!document.querySelector(".tab-button[data-tab='config']")
      };
    `);
    return state.readyState === "complete" && state.badge !== null && state.configTab === true;
  }, 20000, "Popup did not finish loading.");
}

async function openConfigTab(driver) {
  await ensurePopupContext(driver);
  await driver.executeScript(`
    document.querySelector(".tab-button[data-tab='config']")?.click();
  `);
  await waitFor(async () => {
    const activeTab = await driver.executeScript(`
      return document.querySelector('.tab-button.is-active')?.getAttribute('data-tab') ?? null;
    `);
    return activeTab === "config";
  }, 10000, "Popup did not switch to the config tab.");
}

async function getPopupAiConfigPaths(driver) {
  await ensurePopupContext(driver);
  const actualPaths = await driver.executeScript(`
    return [...document.querySelectorAll("button[data-config-path^='ai.']")]
      .map((button) => button.getAttribute('data-config-path'))
      .filter((value) => typeof value === 'string')
      .sort();
  `);
  return Array.isArray(actualPaths) ? actualPaths : [];
}

async function readButtonText(driver, path) {
  await ensurePopupContext(driver);
  return driver.executeScript(
    `
      return document.querySelector("button[data-config-path='" + arguments[0] + "']")?.textContent?.trim() ?? "";
    `,
    path
  );
}

async function setSelectValue(driver, path, value) {
  await ensurePopupContext(driver);
  await driver.executeScript(
    `
      const button = document.querySelector("button[data-config-path='" + arguments[0] + "']");
      button?.click();
      const select = document.querySelector("[data-editor-path='" + arguments[0] + "']");
      if (!(select instanceof HTMLSelectElement)) {
        throw new Error("Select editor is unavailable for " + arguments[0]);
      }
      select.value = arguments[1];
      select.dispatchEvent(new Event('change', { bubbles: true }));
      select.blur();
    `,
    path,
    value
  );
  await delay(300);
}

async function setInlineValue(driver, path, value) {
  await ensurePopupContext(driver);
  await driver.executeScript(
    `
      const button = document.querySelector("button[data-config-path='" + arguments[0] + "']");
      button?.click();
      const input = document.querySelector("[data-editor-path='" + arguments[0] + "']");
      if (!(input instanceof HTMLInputElement)) {
        throw new Error("Input editor is unavailable for " + arguments[0]);
      }
      input.value = arguments[1];
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      input.blur();
    `,
    path,
    value
  );
  await delay(300);
}

async function setModalTextValue(driver, path, value) {
  await ensurePopupContext(driver);
  await driver.executeScript(
    `
      const button = document.querySelector("button[data-config-path='" + arguments[0] + "']");
      if (!(button instanceof HTMLButtonElement)) {
        throw new Error("Config button is unavailable for " + arguments[0]);
      }
      button.click();
    `,
    path
  );
  await waitFor(async () => {
    const ready = await driver.executeScript(`
      return document.querySelector('.popup-modal-textarea') instanceof HTMLTextAreaElement &&
        document.querySelector('.popup-modal-button.is-primary') instanceof HTMLButtonElement;
    `);
    return ready === true;
  }, 10000, `Modal editor did not open for ${path}.`);

  await driver.executeScript(
    `
      const textarea = document.querySelector('.popup-modal-textarea');
      if (!(textarea instanceof HTMLTextAreaElement)) {
        throw new Error("Modal textarea is unavailable for " + arguments[0]);
      }
      textarea.value = arguments[1];
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      const saveButton = document.querySelector('.popup-modal-button.is-primary');
      if (!(saveButton instanceof HTMLButtonElement)) {
        throw new Error("Modal save button is unavailable for " + arguments[0]);
      }
      saveButton.click();
    `,
    path,
    value
  );
  await delay(500);
}

async function setAllowedModel(driver, modelId, tier) {
  await ensurePopupContext(driver);
  await waitFor(async () => {
    return driver.executeScript(
      `
        const button = document.querySelector("button[data-config-path='ai.allowedModels']");
        const panel = document.querySelector('.popup-modal-root .json-model-panel');
        if (!(panel instanceof HTMLElement)) {
          button?.click();
        }
        const sections = [...document.querySelectorAll('.popup-modal-root .json-model-section')];
        const section = sections.find((element) => element.querySelector('.json-model-section-title')?.textContent?.trim() === arguments[1]);
        return [...(section?.querySelectorAll('.json-model-option') ?? [])].some(
          (element) => element.querySelector('.json-model-name')?.textContent?.trim() === arguments[0]
        );
      `,
      modelId,
      tier
    );
  }, 30000, `Allowed model checkbox ${tier}/${modelId} did not load.`);

  await driver.executeScript(
    `
      const sections = [...document.querySelectorAll('.popup-modal-root .json-model-section')];
      const section = sections.find((element) => element.querySelector('.json-model-section-title')?.textContent?.trim() === arguments[1]);
      const option = [...(section?.querySelectorAll('.json-model-option') ?? [])].find(
        (element) => element.querySelector('.json-model-name')?.textContent?.trim() === arguments[0]
      );
      const checkbox = option?.querySelector('.json-model-checkbox');
      if (!(checkbox instanceof HTMLInputElement)) {
        throw new Error("Allowed model checkbox is unavailable for " + arguments[1] + "/" + arguments[0]);
      }
      if (!checkbox.checked) {
        checkbox.click();
      }
    `,
    modelId,
    tier
  );
  await driver.executeScript(`
    document.querySelector("button[data-config-path='ai.allowedModels']")?.click();
  `);
  await delay(500);
}

async function setModelPanelValue(driver, path, modelId, tier) {
  await ensurePopupContext(driver);
  await waitFor(async () => {
    return driver.executeScript(
      `
        const button = document.querySelector("button[data-config-path='" + arguments[0] + "']");
        let panel = document.querySelector('.popup-modal-root .json-model-panel.is-single-select');
        if (!(panel instanceof HTMLElement)) {
          button?.click();
          panel = document.querySelector('.popup-modal-root .json-model-panel.is-single-select');
        }
        const sections = [...(panel?.querySelectorAll('.json-model-section') ?? [])];
        const section = sections.find((element) => element.querySelector('.json-model-section-title')?.textContent?.trim() === arguments[2]);
        return [...(section?.querySelectorAll('.json-model-option.is-single-select') ?? [])].some(
          (element) => element.querySelector('.json-model-name')?.textContent?.trim() === arguments[1]
        );
      `,
      path,
      modelId,
      tier
    );
  }, 30000, `Model option ${tier}/${modelId} did not load for ${path}.`);

  await driver.executeScript(
    `
      const panel = document.querySelector('.popup-modal-root .json-model-panel.is-single-select');
      if (!(panel instanceof HTMLElement)) {
        throw new Error("Model panel is unavailable for " + arguments[0]);
      }
      const sections = [...panel.querySelectorAll('.json-model-section')];
      const section = sections.find((element) => element.querySelector('.json-model-section-title')?.textContent?.trim() === arguments[2]);
      const option = [...(section?.querySelectorAll('.json-model-option.is-single-select') ?? [])].find(
        (element) => element.querySelector('.json-model-name')?.textContent?.trim() === arguments[1]
      );
      if (!(option instanceof HTMLButtonElement)) {
        throw new Error("Model option is unavailable for " + arguments[2] + "/" + arguments[1] + " in " + arguments[0]);
      }
      option.click();
    `,
    path,
    modelId,
    tier
  );
  await delay(500);
}

async function getRuntimeSnapshot(driver) {
  return sendCommand(driver, COMMANDS.configGet, {});
}

async function patchConfig(driver, patch) {
  await sendCommand(driver, COMMANDS.configPatch, {
    scope: "local",
    patch
  });
  await delay(300);
}

async function sendCommand(driver, action, payload) {
  const response = await sendRawCommand(driver, action, payload);
  if (!response?.ok) {
    throw new Error(response?.error?.message ?? `${action} failed.`);
  }
  return response.result;
}

async function sendCommandExpectingError(driver, action, payload) {
  const response = await sendRawCommand(driver, action, payload);
  assert.equal(response?.ok, false, `${action} unexpectedly succeeded.`);
  return {
    code: response?.error?.code ?? "unknown",
    message: response?.error?.message ?? "Unknown error"
  };
}

async function sendRawCommand(driver, action, payload) {
  await ensurePopupContext(driver);
  return driver.executeAsyncScript(
    `
      const done = arguments[arguments.length - 1];
      chrome.runtime.sendMessage({
        id: crypto.randomUUID(),
        version: 1,
        scope: 'command',
        action: arguments[0],
        source: 'tests',
        target: 'background',
        ts: new Date().toISOString(),
        payload: arguments[1] ?? {},
        correlationId: null
      }, (response) => done(response));
    `,
    action,
    payload
  );
}

async function getAiStatus(driver, pageUrl) {
  const pageKey = normalizePageKey(pageUrl);
  const result = await sendCommand(driver, COMMANDS.aiChatStatus, {
    pageKey,
    pageUrl
  });
  return result.session;
}

async function waitForSession(driver, pageKey, pageUrl, predicate, timeoutMs = 120000) {
  let latestSession = null;
  await waitFor(async () => {
    latestSession = await getAiStatus(driver, pageUrl);
    return predicate(latestSession);
  }, timeoutMs, `AI session ${pageKey} did not reach the expected state.`);
  return latestSession;
}

async function waitForOverlay(driver) {
  await waitFor(async () => {
    const present = await driver.executeScript(`
      return !!document.querySelector('#lextrace-overlay-root')?.shadowRoot?.querySelector('.panel-shell');
    `);
    return present === true;
  }, 15000, "Overlay did not appear on the Edge page.");
}

async function selectOverlayTab(driver, tab) {
  await driver.executeScript(
    `
      document
        .querySelector('#lextrace-overlay-root')
        ?.shadowRoot
        ?.querySelector(".overlay-tab-button[data-tab='" + arguments[0] + "']")
        ?.click();
    `,
    tab
  );
  await delay(300);
}

async function sendOverlayChat(driver, text) {
  await driver.executeScript(
    `
      const root = document.querySelector('#lextrace-overlay-root')?.shadowRoot;
      const input = root?.querySelector('[data-role="chat-input"]');
      const sendButton = root?.querySelector('[data-role="chat-send"]');
      if (!(input instanceof HTMLInputElement)) {
        throw new Error("Overlay chat input is unavailable.");
      }
      if (!(sendButton instanceof HTMLButtonElement)) {
        throw new Error("Overlay chat send button is unavailable.");
      }
      input.focus();
      input.value = arguments[0];
      input.dispatchEvent(new Event('input', { bubbles: true }));
      sendButton.click();
    `,
    text
  );
}

async function getOverlayChatFeedText(driver) {
  const text = await driver.executeScript(`
    return document
      .querySelector('#lextrace-overlay-root')
      ?.shadowRoot
      ?.querySelector('[data-role="chat-feed"]')
      ?.textContent ?? '';
  `);
  return typeof text === "string" ? text : "";
}

async function getOverlayChatStatusText(driver) {
  const text = await driver.executeScript(`
    return document
      .querySelector('#lextrace-overlay-root')
      ?.shadowRoot
      ?.querySelector('[data-role="chat-status-row"]')
      ?.textContent ?? '';
  `);
  return typeof text === "string" ? text : "";
}

async function getTabIdByUrl(driver, targetUrl) {
  await ensurePopupContext(driver);
  const targetPageKey = normalizePageKey(targetUrl);
  return driver.executeAsyncScript(
    `
      var expectedUrl = arguments[0];
      var expectedPageKey = arguments[1];
      var done = arguments[arguments.length - 1];
      var normalizePageKey = function (rawUrl) {
        try {
          var url = new URL(rawUrl);
          if (url.protocol !== "http:" && url.protocol !== "https:") {
            return null;
          }
          var normalizedPath = !url.pathname || url.pathname === "/"
            ? "/"
            : url.pathname.replace(/\/{2,}/g, "/").replace(/\/$/, "") || "/";
          var normalizedPort =
            (url.protocol === "http:" && url.port === "80") ||
            (url.protocol === "https:" && url.port === "443") ||
            url.port === ""
              ? ""
              : ":" + url.port;
          return url.protocol + "//" + url.hostname.toLowerCase() + normalizedPort + normalizedPath;
        } catch {
          return null;
        }
      };
      chrome.tabs.query({}, function (tabs) {
        var found = null;
        for (var index = 0; index < tabs.length; index += 1) {
          var tab = tabs[index];
          if (
            tab.url === expectedUrl ||
            tab.pendingUrl === expectedUrl ||
            normalizePageKey(tab.url) === expectedPageKey ||
            normalizePageKey(tab.pendingUrl) === expectedPageKey
          ) {
            found = tab;
            break;
          }
        }
        done(found && typeof found.id === "number" ? found.id : null);
      });
    `,
    targetUrl,
    targetPageKey
  );
}

async function waitForTabIdByUrl(driver, targetUrl) {
  let tabId = null;
  await waitFor(async () => {
    tabId = await getTabIdByUrl(driver, targetUrl);
    return typeof tabId === "number";
  }, 15000, `Edge tab for ${targetUrl} was not discovered.`);
  return tabId;
}

async function resetAllSessions(driver) {
  const listResult = await sendCommand(driver, COMMANDS.aiChatList, {});
  if (!Array.isArray(listResult.sessions)) {
    return;
  }

  for (const session of listResult.sessions) {
    if (typeof session?.pageKey !== "string" || session.pageKey.length === 0) {
      continue;
    }

    try {
      await sendCommand(driver, COMMANDS.aiChatReset, {
        pageKey: session.pageKey
      });
    } catch {
      // Best-effort cleanup.
    }
  }
}

async function restoreBaselineAiConfig(driver, selectedModel, originalUserApiKey) {
  await patchConfig(driver, {
    ai: {
      openAiApiKey: originalUserApiKey
    }
  });

  await patchConfig(driver, {
    ai: {
      openAiApiKey: null,
      allowedModels: [selectedModel],
      chat: {
        model: selectedModel,
        streamingEnabled: true,
        instructions: BASE_CHAT_INSTRUCTIONS,
        structuredOutput: {
          name: STRUCTURED_NAME,
          description: STRUCTURED_DESCRIPTION,
          schema: "",
          strict: true
        }
      },
      compaction: {
        enabled: true,
        streamingEnabled: true,
        modelOverride: selectedModel,
        instructions: BASE_COMPACTION_INSTRUCTIONS,
        triggerPromptTokens: 64,
        preserveRecentTurns: 1,
        maxPassesPerPage: 2
      },
      rateLimits: {
        reserveOutputTokens: 512,
        maxQueuedPerPage: 2,
        maxQueuedGlobal: 3
      }
    }
  });
  await resetAllSessions(driver);

  const session = await waitForSession(
    driver,
    normalizePageKey("http://127.0.0.1/status-probe"),
    "http://127.0.0.1/status-probe",
    (candidate) => candidate.status.apiKeyPresent === true && candidate.status.model?.model === selectedModel.model,
    30000
  );
  assert.equal(session.status.apiKeyPresent, true, "Baseline AI config restore did not recover the API key.");
}

function chooseModelFromCatalog(models) {
  const preferredIds = ["gpt-5", "gpt-5-mini", "gpt-4.1", "gpt-4.1-mini"];
  for (const modelId of preferredIds) {
    const match = models.find((item) => item?.id === modelId && getAvailableTiers(item).includes("standard"));
    if (match) {
      return {
        model: match.id,
        tier: "standard"
      };
    }
  }

  for (const item of models) {
    const tiers = getAvailableTiers(item);
    if (tiers.length > 0) {
      return {
        model: item.id,
        tier: tiers[0]
      };
    }
  }

  return null;
}

function getAvailableTiers(item) {
  const tiers = [];
  for (const tier of ["standard", "flex", "priority"]) {
    const pricing = item?.pricing?.[tier];
    if (!pricing) {
      continue;
    }

    if (
      pricing.pricingModelId !== null ||
      pricing.inputUsdPer1M !== null ||
      pricing.outputUsdPer1M !== null ||
      pricing.summaryUsdPer1M !== null
    ) {
      tiers.push(tier);
    }
  }
  return tiers;
}

function normalizePageKey(rawUrl) {
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported page URL for AI test: ${rawUrl}`);
  }

  const normalizedPath = !url.pathname || url.pathname === "/"
    ? "/"
    : url.pathname.replace(/\/{2,}/g, "/").replace(/\/$/, "") || "/";
  const normalizedPort =
    (url.protocol === "http:" && url.port === "80") ||
    (url.protocol === "https:" && url.port === "443") ||
    url.port === ""
      ? ""
      : `:${url.port}`;

  return `${url.protocol}//${url.hostname.toLowerCase()}${normalizedPort}${normalizedPath}`;
}

async function readNativeHostState() {
  const statePath = getNativeHostStatePath();
  try {
    return JSON.parse(await fs.readFile(statePath, "utf8"));
  } catch {
    return null;
  }
}

function getNativeHostStatePath() {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) {
    throw new Error("LOCALAPPDATA is unavailable.");
  }

  return path.join(localAppData, "LexTraceNt3", "native-host-state.json");
}

function getUserEnvironmentVariable(name) {
  const result = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::UTF8; $value = [Environment]::GetEnvironmentVariable($env:TARGET_ENV_NAME, 'User'); if ($null -ne $value) { [Console]::Write($value) }"
    ],
    {
      encoding: "utf8",
      windowsHide: true,
      env: {
        ...process.env,
        TARGET_ENV_NAME: name
      }
    }
  );

  if (result.status !== 0) {
    throw new Error(`Failed to read user environment variable ${name}: ${result.stderr || result.stdout}`.trim());
  }

  const value = result.stdout ?? "";
  return value.length > 0 ? value : null;
}

async function getUserEnvironmentVariableAsync(name) {
  return getUserEnvironmentVariable(name);
}

async function startLocalServer() {
  const server = http.createServer(async (request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(`<!doctype html>
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <title>LexTrace Edge AI Harness</title>
        </head>
        <body>
          <main>
            <h1>LexTrace Edge AI Harness</h1>
            <p>Current path: ${request.url ?? "/"}</p>
          </main>
        </body>
      </html>`);
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to determine the local test server address.");
  }

  const origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    makeUrl: (pathname) => new URL(pathname, origin).toString(),
    close: async () => {
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  };
}

async function waitFor(predicate, timeoutMs, message) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await delay(500);
  }

  throw new Error(message);
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
    entry.status = "failed";
    entry.error = error instanceof Error ? error.message : String(error);
    return null;
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

function getReportPath() {
  return path.join(paths.artifacts, "test-results", "edge-ai-report.json");
}

await main();
