# AUDIT_COMPLIANCE.md

Дата аудита: 2026-03-04
Источник требований (SoT): `Neuro Translate улучшения.txt`

Итоговый статус матрицы: **PASS 101 / FAIL 0 / UNKNOWN 0**

## Матрица соответствия
| ID | Requirement | Status | Evidence | Tests | Notes |
|---|---|---|---|---|---|
| R001 | Платформа: Manifest V3 | PASS | `src/manifest.json:2` | `npm run build` | MV3 declared |
| R002 | Контексты: Popup + SW + Offscreen + Content | PASS | `src/manifest.json:20-41`, `src/offscreen/offscreen.js:8-31` | E2E C1..C7 | All contexts active |
| R003 | Максимум модульности/OOP | PASS | `src/sw/pipeline-orchestrator.js:18`, `src/shared/*` | Unit suite | Responsibilities split by modules/classes |
| R004 | Межконтекстный обмен только messaging/ports | PASS | `src/shared/runtime-api.js:1-18`, `src/sw/worker.js:53-79` | E2E C1..C7 | No local cross-context hacks |
| R005 | Секреты не логируются открыто | PASS | `src/shared/redact.js:1-28`, `src/shared/event-log-store.js:51-53` | Unit `event-log-store` | Redaction is centralized |
| R006 | Popup стиль ч/б flat | PASS | `src/popup/popup.css:1-371` | Manual Runbook §3 | White/black palette with flat borders |
| R007 | Компактность + tooltips вместо лишних лейблов | PASS | `src/popup/popup.js:263-282,351-399,752-760` | E2E C2/C7 + Manual §3 | Tooltip attributes on controls |
| R008 | Кнопки-иконки в popup | PASS | `src/popup/popup.js:273-282,354-355,395,759-761` | E2E C2/C3/C7 | Icon-glyph controls used |
| R009 | Ровно 3 вкладки: Статус/Настройки/События | PASS | `src/popup/popup.js:122-129` | E2E C7 + Manual §3.1 | Exactly three tabs |
| R010 | Статус: progress + done/pending/failed | PASS | `src/popup/popup.js:258-269` | E2E C1 | Live counters rendered |
| R011 | Счётчик ошибок кликабелен -> Events + error filter | PASS | `src/popup/popup.js:264,293-299` | E2E C4 | `onlyErrors=true` on click |
| R012 | Кнопка запуска перевода | PASS | `src/popup/popup.js:273,286,302-317` | E2E C1 | `ui.start` flow wired |
| R013 | Кнопка hard cancel | PASS | `src/popup/popup.js:274,287,302-317` + `src/sw/pipeline-orchestrator.js:799-838` | E2E C3 | Hard cancel path implemented |
| R014 | Кнопка «Стереть всё» | PASS | `src/popup/popup.js:275,288,302-317` + `src/sw/pipeline-orchestrator.js:860-887` | E2E C2/C3 | Clears state + logs |
| R015 | Переключение вида (translation/original/diff) | PASS | `src/popup/popup.js:279-291,319-331` | E2E C2 | Three-view switching works |
| R016 | Disabled: нет перевода -> Translation/Diff disabled | PASS | `src/popup/popup.js:248-283` | E2E C2 | Checked before/after translation |
| R017 | Disabled: перевод не идёт -> Cancel disabled | PASS | `src/popup/popup.js:249-276` | E2E C2/C6 | `isRunning` gate |
| R018 | Disabled: нет данных -> Clear disabled | PASS | `src/popup/popup.js:250-277` + `src/sw/pipeline-orchestrator.js:948-957` | E2E C2/C6 | `canClear` gate |
| R019 | Настройки: сохранение профиля | PASS | `src/popup/popup.js:429-439` + `src/shared/settings-store.js:53-58` | E2E C7 | Profile save roundtrip |
| R020 | JSON viewer вертикально растягивается | PASS | `src/popup/popup.css:213-219` | E2E C7 + Manual §3.3 | `resize: vertical` |
| R021 | Редактирование значений по клику параметра | PASS | `src/popup/popup.js:521-538,557-604` | E2E C7 | Click -> editor open |
| R022 | Enum через реальный выпадающий список | PASS | `src/popup/popup.js:571-574,362-367` | E2E C7 | `datalist` options for enums |
| R023 | Free-text в том же combobox input | PASS | `src/popup/popup.js:362-367,576-587` | E2E C7 | Single input for list + text |
| R024 | Выбор активного профиля из списка | PASS | `src/popup/popup.js:344-353,414-423` | E2E C7 + Manual §3.3 | Profile select wired |
| R025 | Параметры профиля подсвечиваются | PASS | `src/popup/popup.js:523-531`, `src/popup/popup.css:248-251` | E2E C7 | `changed` highlight class |
| R026 | Изменения переводят профиль в `*` | PASS | `src/popup/popup.js:341-357,545-554` | E2E C7 | Dirty marker + select `*` |
| R027 | Блок доступа: BYOK/PROXY | PASS | `src/popup/popup.js:370-390,461-469` | E2E C6 + Manual §3.4 | Access mode switch |
| R028 | Ключи/токены: password, show/hide, autocomplete off | PASS | `src/popup/popup.js:378-389,484-509` | Manual §3.4 | Protected inputs |
| R029 | Events: автообновляемый подробный лог | PASS | `src/popup/popup.js:72-75,809-819` | E2E C4 | Poll-based refresh + full payload |
| R030 | Каждая запись лога со сворачиваемыми секциями | PASS | `src/popup/popup.js:789-805`, `src/debug/debug.js:58-75` | E2E C4 + Manual §3.5 | `<details><summary>` rendering |
| R031 | Фильтр по категориям событий | PASS | `src/popup/popup.js:752-770`, `src/debug/debug.js:19-35` | Manual §3.5 | Category select in popup/debug |
| R032 | Скачать лог файлом | PASS | `src/popup/popup.js:821-836`, `src/debug/debug.js:78-88` | Manual §3.5 | download API used |
| R033 | Копировать лог кнопкой | PASS | `src/popup/popup.js:838-846`, `src/debug/debug.js:90-93` | Manual §3.5 | clipboard export |
| R034 | Debug page читает тот же лог + экспорт | PASS | `src/debug/debug.js:47-53,79,91`; `src/sw/pipeline-orchestrator.js:960-966` | Manual §4 | Shared `log.query/log.export` path |
| R035 | Старт из popup на активной странице | PASS | `src/popup/popup.js:92-111,304-305`; `src/sw/pipeline-orchestrator.js:56-95` | E2E C1 | `tabId`/URL resolved from active tab |
| R036 | Этап 1: поиск всех текстовых узлов | PASS | `src/content/dom-indexer.js:95-128` | Unit `dom-modules` | TreeWalker-based scan |
| R037 | Этап 1: классификация по категориям | PASS | `src/content/dom-classifier.js:16-35`; `src/content/content.js:38` | Unit `dom-modules` | Category assignment present |
| R038 | Этап 1: устойчивые anchor/идентификаторы | PASS | `src/content/dom-indexer.js:106-121,130-189` | Unit `dom-modules` | path + parentAnchor + textHash |
| R039 | Этап 1: упорядочивание для контекста | PASS | `src/content/content.js:38` (`sort by order`) | Unit `dom-modules` | Stable reading order preserved |
| R040 | Этап 2: ordered элементы в Context AI | PASS | `src/sw/pipeline-orchestrator.js:585-606` | E2E C1/C5 | Ordered chunked block payload |
| R041 | Этап 2: подробный prompt контекста | PASS | `src/offscreen/offscreen.js:134-148` | Manual + logs | Expanded system prompt |
| R042 | Этап 2: target >=15000 + max_output_tokens + chunking | PASS | `src/sw/pipeline-orchestrator.js:569-573,579-773`; `src/offscreen/offscreen.js:119-133` | Unit/Manual + E2E C5 | Multi-pass context generation |
| R043 | Этап 3: deterministic batching для снижения запросов | PASS | `src/shared/batching.js:3-51` | Unit `batching`, `batching-boundaries` | Stable batch IDs and limits |
| R044 | Этап 4: инкрементальная подстановка по готовности батча | PASS | `src/sw/pipeline-orchestrator.js:315-333,504-515`; `src/content/dom-applier.js:28-40` | E2E C1 | Apply immediately after each batch |
| R045 | Этап 4: перевод получает global context | PASS | `src/sw/pipeline-orchestrator.js:381` | E2E C1 | `input.globalContext` passed |
| R046 | Этап 4: окно предыдущих батчей | PASS | `src/shared/batch-window.js:10-13`; `src/sw/pipeline-orchestrator.js:370-383` | Unit `window-compaction` | Rolling previous window |
| R047 | Этап 4: компакции вне окна + compaction chain | PASS | `src/shared/batch-window.js:15-66`; `src/sw/pipeline-orchestrator.js:382` | Unit `window-compaction-chain` | Previous compactions merged |
| R048 | Этап 4: structured output обязателен | PASS | `src/offscreen/offscreen.js:167-173,212`; `src/sw/pipeline-orchestrator.js:498-502` | Unit `translation-schema` | Strict JSON response required |
| R049 | Этап 4: TPM/RPM контроль | PASS | `src/shared/rate-limit-controller.js:42-191`; `src/sw/pipeline-orchestrator.js:416-491` | Unit `rate-limit-controller` | Budget + retries + backoff |
| R050 | Отмена в любой момент согласует состояние UI | PASS | `src/sw/pipeline-orchestrator.js:799-838,982-1018` | E2E C3 | Stage transitions to `cancelled` |
| R051 | JSON profile: `promptCaching` поля | PASS | `src/shared/constants.js:85-88,145` | E2E C7 | Field exists and editable |
| R052 | JSON profile: `globalContext` поля | PASS | `src/shared/constants.js:89-93,146` | Manual §3.3 | Includes token/limit/model |
| R053 | JSON profile: `batching` поля | PASS | `src/shared/constants.js:94-101,147` | Unit batching tests | Included and used |
| R054 | JSON profile: `batchWindow` поля | PASS | `src/shared/constants.js:102-106,148` | Unit window tests | Included and used |
| R055 | Out-of-window авто-компакция учитывает прошлые | PASS | `src/shared/batch-window.js:24-66` | Unit `window-compaction-chain` | Chain-aware compaction |
| R056 | `compaction` settings присутствуют и участвуют | PASS | `src/shared/constants.js:107-114,149`; `src/sw/pipeline-orchestrator.js:382` | Unit window tests | Passed in translation input |
| R057 | `storagePolicy` поля + лимиты | PASS | `src/shared/constants.js:115-121,150`; `src/sw/pipeline-orchestrator.js:42-54` | Unit `event-log-store` | GC uses policy limits |
| R058 | Выбор нескольких моделей из OpenAI list models | PASS | `src/sw/pipeline-orchestrator.js:1184-1209`; `src/offscreen/offscreen.js:304-332`; `src/popup/popup.js:680-696` | Manual §3.3 | Model list from API + multi-select |
| R059 | Сортировка по цене input+output и показ cached input | PASS | `src/offscreen/offscreen.js:306-317`; `src/popup/popup.js:651-670` | Manual §3.3 | Displays i/o/c; sorted by total |
| R060 | Приоритет модели отдельно context/translation | PASS | `src/shared/constants.js:126-129`; `src/popup/popup.js:395-398,710-716`; `src/sw/pipeline-orchestrator.js:368,568` | Manual §3.3 | Separate priority selectors used |
| R061 | SW unload: не ломает пайплайн (persist + resume) | PASS | `src/sw/pipeline-orchestrator.js:889-946`; `src/sw/worker.js:39-51,81-93` | E2E C5 | Orphan detection/restart path |
| R062 | Offscreen только runtime API + messaging | PASS | `src/offscreen/offscreen.js:8-31`, `src/sw/offscreen-client.js:33-56` | Manual + code audit | No background-API misuse |
| R063 | Content scripts не ограничены localhost | PASS | `src/manifest.json:31-33` | E2E C1..C7 | `<all_urls>` matches |
| R064 | Popup anti-regression: строго 3 вкладки + compact controls | PASS | `src/popup/popup.js:122-129,258-283` | E2E C2/C7 | No extra panel mode |
| R065 | JSON editor anti-regression: один combobox input | PASS | `src/popup/popup.js:362-367,557-604` | E2E C7 | Single input control |
| R066 | Popup и debug читают один EventLogStore | PASS | `src/sw/worker.js:10,15-23`; `src/sw/pipeline-orchestrator.js:960-966`; `src/popup/popup.js:809-819`; `src/debug/debug.js:47-53` | E2E C4 + Manual §4 | Single source of truth |
| R067 | Hard cancel отменяет queue + inflight + offscreen операции | PASS | `src/sw/pipeline-orchestrator.js:806-813`; `src/offscreen/offscreen.js:337-362` | E2E C3 | Request+session cancellation covered |
| R068 | Structured output anti-regression: strict schema only | PASS | `src/shared/translation-schema.js:31-99`; `src/offscreen/offscreen.js:247-255` | Unit `translation-schema` | Raw non-JSON rejected |
| R069 | OpenAI базовый путь: Responses API | PASS | `src/offscreen/offscreen.js:39,82-90` | E2E C1(mock)/Manual(real) | `/responses` used |
| R070 | JSON Schema содержит translations + расширенные поля | PASS | `src/shared/translation-schema.js:5-27` | Unit `translation-schema` | `batchId/sourceLang/targetLang/...` |
| R071 | Валидатор строгий, без «на глаз» парсинга | PASS | `src/shared/translation-schema.js:31-99`; `src/offscreen/offscreen.js:247-255` | Unit `translation-schema` | Unsupported keys fail |
| R072 | Учёт токенов на запрос (prompt+output estimate) | PASS | `src/sw/pipeline-orchestrator.js:394,635`; `src/shared/utils.js:9-14` | Unit rate-limit | Estimate used in budget calls |
| R073 | Limiter учитывает лимиты по модели и роли | PASS | `src/shared/rate-limit-controller.js:13-38,159-176` | Unit `rate-limit-controller` | Role-specific state key |
| R074 | Ограничение параллелизма и динамическая адаптация | PASS | `src/shared/rate-limit-controller.js:97-124`; `src/sw/pipeline-orchestrator.js:1079-1093` | Unit `rate-limit-controller` | Concurrency down/up + sync queue |
| R075 | 429: retry-after + random exponential backoff | PASS | `src/offscreen/offscreen.js:92-98`; `src/shared/rate-limit-controller.js:178-186`; `src/sw/pipeline-orchestrator.js:466-490,665-689` | Unit rate-limit + E2E C4 | Retry with jitter and retry-after |
| R076 | Prompt caching настройки есть и отражаются в логах/статусе | PASS | `src/shared/constants.js:85-88`; `src/sw/pipeline-orchestrator.js:410,1103-1108` | Manual logs | `promptCachingEnabled` logged |
| R077 | Models list из OpenAI API `/models` | PASS | `src/offscreen/offscreen.js:324-332`; `src/sw/pipeline-orchestrator.js:1184-1209` | Manual §3.3 | Real list API path |
| R078 | Формат события: `{ts, level, category, name, pageSessionId, tabId, batchId?, blockId?, data, error?}` | PASS | `src/shared/event-log-store.js:41-55`; `src/sw/pipeline-orchestrator.js:972-984` | Unit `event-log-store` | Standard event envelope |
| R079 | Категории событий (ui/pipeline/dom/context/batch/openai/cancellation/storage/error) | PASS | `src/shared/constants.js:52-68` | Manual event filters | Full minimum taxonomy present |
| R080 | Секреты редактируются как `***REDACTED***` | PASS | `src/shared/redact.js:14-17`; `src/shared/event-log-store.js:51-53` | Unit event-log | Redaction before persistence |
| R081 | Ограничение роста логов: maxRecords/maxAge/maxBytes + GC | PASS | `src/shared/event-log-store.js:12-19,128-182` | Unit `event-log-store` | Three-axis GC policy |
| R082 | GC логируется в событиях | PASS | `src/sw/pipeline-orchestrator.js:42-54` | Manual + logs | `storage.gc` always emitted |
| R083 | Unit: DOM scan/classifier/applier anchors/order | PASS | `tests/unit/dom-modules.test.js:8-65` | `npm run test:unit` | Includes stale-path anchor fallback |
| R084 | Unit: batching deterministic + boundaries | PASS | `tests/unit/batching.test.js:4-27`; `tests/unit/batching-boundaries.test.js:4-53` | `npm run test:unit` | Determinism and limits |
| R085 | Unit: window+compaction chain | PASS | `tests/unit/window-compaction.test.js:4-28`; `tests/unit/window-compaction-chain.test.js:4-32` | `npm run test:unit` | Chain + token budget checks |
| R086 | Unit: rate limit backoff + concurrency | PASS | `tests/unit/rate-limit-controller.test.js:4-112` | `npm run test:unit` | Retries, concurrency, role split |
| R087 | Unit: cancellation | PASS | `tests/unit/cancellation.test.js:4-17`; `tests/unit/job-queue-cancel.test.js:4-27` | `npm run test:unit` | Session cancel + queue stop |
| R088 | E2E: хаотичная вёрстка + C1 | PASS | `tests/e2e/neuro-translate.spec.js:309-348,37-63` | `npm run test:e2e` | Incremental apply proven |
| R089 | E2E: C2 view toggles + disabled rules | PASS | `tests/e2e/neuro-translate.spec.js:65-92` | `npm run test:e2e` | Disabled state assertions included |
| R090 | E2E: C3 cancel mid-flight | PASS | `tests/e2e/neuro-translate.spec.js:94-123` | `npm run test:e2e` | Queue drain and no post-cancel progress |
| R091 | E2E: C4 API error -> log/filter | PASS | `tests/e2e/neuro-translate.spec.js:125-154` | `npm run test:e2e` | Error routed to Events |
| R092 | E2E: C5 SW restart/resume consistency | PASS | `tests/e2e/neuro-translate.spec.js:156-183` | `npm run test:e2e` | Resume path exercised |
| R093 | Воспроизводимость mock/real режимов | PASS | Mock: `tests/e2e/neuro-translate.spec.js:43,71,163`; Real path: `src/offscreen/offscreen.js:81-108` | E2E mock + Runbook real BYOK/PROXY | Both execution paths are present |
| R094 | Шаг 0: архивы распакованы и карта модулей составлена | PASS | `_legacy/nt1`, `_legacy/nt2`, `AUDIT_REUSE.md` | Manual repo check | Done in this audit cycle |
| R095 | Шаг 1: атомарная декомпозиция требований | PASS | `AUDIT_COMPLIANCE.md` (this file) | N/A | One row per atomic requirement |
| R096 | Шаг 2: статический аудит по требованиям | PASS | `AUDIT_COMPLIANCE.md` evidence column | N/A | Completed, no UNKNOWN left |
| R097 | Шаг 3: динамический аудит (build/run/manual) | PASS | `AUDIT_E2E_RESULTS.md`, `AUDIT_RUNBOOK.md` | build/unit/e2e commands | Execution evidence recorded |
| R098 | Шаг 4: аудит пайплайна по этапам 1..4 | PASS | `src/sw/pipeline-orchestrator.js:56-773`; content modules | E2E C1/C3/C5 | Entrypoints/stages/state/cancel/log covered |
| R099 | Шаг 5: OpenAI контроль (schema/limits/models/pricing) | PASS | `src/offscreen/offscreen.js`, `src/shared/translation-schema.js`, `src/shared/rate-limit-controller.js`, `src/popup/popup.js` | Unit + Manual | Full checklist covered |
| R100 | Шаг 6: Unit + E2E прогнаны | PASS | `AUDIT_E2E_RESULTS.md` | `npm run test:unit`, `npm run test:e2e` | Green runs recorded |
| R101 | Шаг 7: FAIL->FIX->RECHECK до полного PASS | PASS | `AUDIT_E2E_RESULTS.md` (фикс+повторный прогон) | repeated unit/e2e | Final matrix has no FAIL/UNKNOWN |

## Результат цикла FAIL -> FIX -> RECHECK
- Выявленный FAIL в процессе: `window-compaction-chain` unit после усиления compaction-chain.
- Фикс: `src/shared/batch-window.js` (коррекция нижней границы token target).
- Повторные прогоны: `build PASS`, `unit PASS`, `e2e PASS`.
