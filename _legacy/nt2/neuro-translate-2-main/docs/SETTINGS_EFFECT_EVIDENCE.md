# Доказательства влияния параметров (popup settings)

Дата проверки: 2026-03-01

## 1) Что проверено

Проверен фактический путь параметров:

1. Редактирование в popup JSON viewer (`extension/ui/popup.js`).
2. Отправка patch в background (`SET_SETTINGS` через ui protocol).
3. Нормализация/валидация и запись в `chrome.storage.local` (`extension/core/settings-store.js`, `extension/core/agent-settings-policy.js`).
4. Реальное чтение параметров в рантайме агента/оркестратора/LLM-клиента.

## 2) Внешние API (MV3 / OpenAI) — что реально используется

- MV3 storage/state:
  - `chrome.storage.local` и `chrome.storage.session` (см. `extension/core/chrome-local-store-base.js`, `extension/bg/credentials-store.js:81-88`, `extension/ui/ui-state-store.js:180-182`).
- MV3 page integration:
  - `chrome.scripting.executeScript` (`extension/ui/popup.js:2312-2317`, `extension/bg/translation-orchestrator.js:4735-4763`).
- MV3 tab routing/context:
  - `chrome.tabs.query/get` (`extension/ui/popup.js:1413-1418,1479-1484`, `extension/bg/background-app.js:586-589,4113-4118`).
- OpenAI Responses request options:
  - `reasoning`, `parallel_tool_calls`, `truncation`, `prompt_cache_key`, `prompt_cache_retention` (см. `extension/bg/background-app.js:1800-1836`, `extension/ai/llm-client.js:590-663`).

## 3) Параметры приоритета моделей и где они влияют

### 3.1 `modelSelection.*` (глобальная селекция)

- Параметры: `modelSelection.speed`, `modelSelection.preference`.
- Чтение/нормализация:
  - `extension/ai/model-selection-policy.js:28-41`
  - `extension/bg/background-app.js:2090-2096,2211-2269`
- Эффект:
  - Меняет effective model selection в `_resolveEffectiveModelSelection(...)` и затем влияет на выбор модели при `_runLlmRequest(...)` (`extension/bg/background-app.js:1509-1521,1354-1394`).

### 3.2 `translationAgentModelPolicy.*` (политика агента)

- Параметры: `mode`, `speed`, `preference`, `allowRouteOverride`.
- Чтение/нормализация:
  - `extension/bg/background-app.js:2210-2223`
  - `extension/ai/translation-agent.js:1340-1359`
- Эффект:
  - Участвует в route/mode разрешениях и route override (`extension/bg/background-app.js:2240-2269`).
  - Влияет на routeHint в переводе/вычитке и policy в `agentContext` (`extension/ai/translation-call.js:576-588`, `extension/ai/agent-tool-registry.js:3216-3221,3800-3802`).

### 3.3 `userSettings.models.modelRoutingMode` + `userSettings.models.modelUserPriority`

- Политика и effective:
  - `extension/core/agent-settings-policy.js:476-484,551-554`
- Эффект:
  - Переставляет allowlist при разрешении моделей в инструментальном пайплайне (`extension/ai/agent-tool-registry.js:4819-4849`).
  - Попадает в run settings (`extension/ai/run-settings.js:66-68`) и в tool context для агента (`extension/ai/agent-tool-registry.js:1495-1499`).

## 4) Параметры контекста/компакции/вычитки и где влияют

### 4.1 `translationAgentTuning.*`

- Нормализация:
  - `extension/ai/translation-agent.js:1399-1407`
- Эффект:
  - `plannerTemperature`, `plannerMaxOutputTokens` в planner LLM-запросе (`extension/ai/translation-agent.js:1928-1929`).
  - `auditIntervalMs`, `mandatoryAuditIntervalMs` в аудите (`extension/ai/translation-agent.js:1041-1042,1433-1437`).
  - `compressionThreshold`, `contextFootprintLimit`, `compressionCooldownMs` в compaction-логике (`extension/ai/translation-agent.js:1116-1124,1438-1440`; `extension/ai/agent-tool-registry.js:2650-2668`).
  - `proofreadingPassesOverride` в количестве проходов вычитки (`extension/ai/translation-agent.js:1422-1423,2170-2171`).

### 4.2 Ролевые пресеты в popup (`modelPriorityRoles.*`)

- Редактируемые поля JSON viewer: `modelPriorityRoles.agent|translation|context|compaction|proofreading`.
- Реализация маппинга на реальные patch-поля:
  - `extension/ui/popup.js:2060-2158` (`_buildRolePresetPatch`, `_applyRolePresetFromEditor`).
- Важно:
  - Это не «фейковые» storage-ключи: каждый preset раскладывается в рабочие параметры (`modelSelection`, `translationAgentModelPolicy`, `userSettings.models.*`, `translationAgentTuning.*`).

## 5) Кэш/перф/классификация — где реально читается

- `translationPageCacheEnabled`:
  - `extension/bg/translation-orchestrator.js:6147,6982,7136,7427`
- `translationApiCacheEnabled`:
  - `extension/bg/translation-orchestrator.js:1715,2050-2051,7233`
- `translationClassifierObserveDomChanges`:
  - `extension/bg/translation-orchestrator.js:5649,6431-6433`
- `translationPerf*`:
  - `extension/bg/translation-orchestrator.js:6435-6455`
- `translationCompareRendering`:
  - `extension/bg/translation-orchestrator.js:3841-3843,6458-6463`

## 6) Что сделано в UI сейчас

- Убран отдельный селектор профиля из popup-разметки; профиль выбирается в JSON viewer (`userSettings.profile`).
- Добавлены editable meta/tooltip для дополнительных реальных параметров:
  - `modelSelection.*`
  - `translationAgentModelPolicy.*`
  - `translationAgentTuning.*`
  - `translationPipelineEnabled`, `translationCategoryMode`
  - `translationPageCacheEnabled`, `translationApiCacheEnabled`, `translationClassifierObserveDomChanges`
  - `translationPerf*`, `translationCompareRendering`, `debugAllowTestCommands`
- В JSON snapshot оставлены только недублирующие значения и явные пары requested/applied/rejected allowlist.

## 7) Ограничения (честно)

- В текущем backend нет отдельных persistent model-policy ключей строго по ролям `context_generation` и `compaction` как самостоятельных model selectors.
- Для этих ролей popup использует ролевые пресеты, которые маппятся на реально работающие tuning/policy параметры, применяемые рантаймом.


## 8) Матрица: параметр → реальное влияние

| Параметр (JSON viewer) | Patch-ключ | Где применяется в рантайме |
|---|---|---|
| `userSettings.profile` | `userSettings.profile` | `extension/core/agent-settings-policy.js:439-447` (профильные default-ы), `extension/ai/translation-agent.js:370-405` |
| `userSettings.models.modelRoutingMode` | `userSettings.models.modelRoutingMode` | `extension/core/agent-settings-policy.js:470-484`, `extension/ai/agent-tool-registry.js:4819-4849` |
| `userSettings.models.modelUserPriority` (через ролевой preset) | `userSettings.models.modelUserPriority` | `extension/core/agent-settings-policy.js:482-484`, `extension/ai/agent-tool-registry.js:4837-4849` |
| `modelSelection.speed` | `modelSelection.speed` | `extension/bg/background-app.js:2226-2269` |
| `modelSelection.preference` | `modelSelection.preference` | `extension/bg/background-app.js:2226-2269`, `extension/ai/model-selection-policy.js:28-41` |
| `translationAgentModelPolicy.mode` | `translationAgentModelPolicy.mode` | `extension/bg/background-app.js:2210-2223,2240-2269` |
| `translationAgentModelPolicy.speed` | `translationAgentModelPolicy.speed` | `extension/bg/background-app.js:2240-2269`, `extension/ai/translation-call.js:576-588` |
| `translationAgentModelPolicy.preference` | `translationAgentModelPolicy.preference` | `extension/bg/background-app.js:2240-2269`, `extension/ai/translation-agent.js:1340-1359` |
| `translationAgentModelPolicy.allowRouteOverride` | `translationAgentModelPolicy.allowRouteOverride` | `extension/bg/background-app.js:2263-2267`, `extension/ai/translation-call.js:579-586` |
| `translationAgentTuning.styleOverride` | `translationAgentTuning.styleOverride` | `extension/ai/translation-agent.js:1418-1421` |
| `translationAgentTuning.maxBatchSizeOverride` | `translationAgentTuning.maxBatchSizeOverride` | `extension/ai/translation-agent.js:1862-1886` (batch planning/merge) |
| `translationAgentTuning.proofreadingPassesOverride` | `translationAgentTuning.proofreadingPassesOverride` | `extension/ai/translation-agent.js:1422-1423,2170-2171` |
| `translationAgentTuning.parallelismOverride` | `translationAgentTuning.parallelismOverride` | `extension/ai/translation-agent.js:1425-1426` |
| `translationAgentTuning.plannerTemperature` | `translationAgentTuning.plannerTemperature` | `extension/ai/translation-agent.js:1929` |
| `translationAgentTuning.plannerMaxOutputTokens` | `translationAgentTuning.plannerMaxOutputTokens` | `extension/ai/translation-agent.js:1928` |
| `translationAgentTuning.auditIntervalMs` | `translationAgentTuning.auditIntervalMs` | `extension/ai/translation-agent.js:1041-1042,1433-1437` |
| `translationAgentTuning.mandatoryAuditIntervalMs` | `translationAgentTuning.mandatoryAuditIntervalMs` | `extension/ai/translation-agent.js:1041-1042,1433-1437` |
| `translationAgentTuning.compressionThreshold` | `translationAgentTuning.compressionThreshold` | `extension/ai/translation-agent.js:1124,1438`, `extension/ai/agent-tool-registry.js:2650-2651` |
| `translationAgentTuning.contextFootprintLimit` | `translationAgentTuning.contextFootprintLimit` | `extension/ai/translation-agent.js:1123,1439` |
| `translationAgentTuning.compressionCooldownMs` | `translationAgentTuning.compressionCooldownMs` | `extension/ai/translation-agent.js:1116,1440` |
| `translationPipelineEnabled` | `translationPipelineEnabled` | `extension/core/settings-store.js:369`, `extension/bg/background-app.js:410-411` |
| `translationCategoryMode` | `translationCategoryMode` | `extension/ai/translation-agent.js:1443-1464` (normalization), `extension/bg/translation-orchestrator.js:4397-4406` |
| `translationPageCacheEnabled` | `translationPageCacheEnabled` | `extension/bg/translation-orchestrator.js:6147,6982,7136,7427` |
| `translationApiCacheEnabled` | `translationApiCacheEnabled` | `extension/bg/translation-orchestrator.js:1715,2050-2051,7233` |
| `translationClassifierObserveDomChanges` | `translationClassifierObserveDomChanges` | `extension/bg/translation-orchestrator.js:5649,6431-6433` |
| `translationPerfMaxTextNodesPerScan` | `translationPerfMaxTextNodesPerScan` | `extension/bg/translation-orchestrator.js:6435-6437,6446-6448` |
| `translationPerfYieldEveryNNodes` | `translationPerfYieldEveryNNodes` | `extension/bg/translation-orchestrator.js:6438-6440,6449-6451` |
| `translationPerfAbortScanIfOverMs` | `translationPerfAbortScanIfOverMs` | `extension/bg/translation-orchestrator.js:6441-6443,6452-6454` |
| `translationPerfDegradedScanOnHeavy` | `translationPerfDegradedScanOnHeavy` | `extension/bg/translation-orchestrator.js:6444-6445,6455` |
| `translationCompareRendering` | `translationCompareRendering` | `extension/bg/translation-orchestrator.js:3841-3843,6458-6463` |
| `debugAllowTestCommands` | `debugAllowTestCommands` | `extension/core/settings-store.js:419,544-546`, `extension/bg/background-app.js:438-439` |
| `modelPriorityRoles.agent` | synthetic → `modelSelection.*`, `translationAgentModelPolicy.*` | маппинг `extension/ui/popup.js:2060-2158`, далее см. строки выше |
| `modelPriorityRoles.translation` | synthetic → `userSettings.models.*`, `translationAgentModelPolicy.*` | маппинг `extension/ui/popup.js:2060-2158`, далее `agent-settings-policy` + `agent-tool-registry` |
| `modelPriorityRoles.context` | synthetic → `translationAgentTuning.(parallelism/planner/audit)` | маппинг `extension/ui/popup.js:2060-2158`, далее `translation-agent` |
| `modelPriorityRoles.compaction` | synthetic → `translationAgentTuning.(compression*)` | маппинг `extension/ui/popup.js:2060-2158`, далее `translation-agent`/`agent-tool-registry` |
| `modelPriorityRoles.proofreading` | synthetic → `translationAgentTuning.proofreadingPassesOverride` + `translationAgentModelPolicy.*` | маппинг `extension/ui/popup.js:2060-2158`, далее `translation-agent` |

