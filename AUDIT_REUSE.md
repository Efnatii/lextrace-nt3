# AUDIT_REUSE.md

Дата аудита: 2026-03-04

## Шаг 0: Инвентаризация
- Рабочее дерево на момент старта: есть незафиксированные артефакты `Neuro Translate улучшения.txt` и `_legacy/` (ожидаемо для аудита).
- Архивы распакованы в:
  - `_legacy/nt1/neuro-translate-main`
  - `_legacy/nt2/neuro-translate-2-main`

## Карта модулей NT1/NT2
| Категория | NT1 (neuro-translate-main) | NT2 (neuro-translate-2-main) |
|---|---|---|
| MV3 background/SW оркестрация | `extension/background.js` | `extension/bg/background.js`, `extension/bg/translation-orchestrator.js`, `extension/bg/job-runner.js` |
| Offscreen | (нет отдельного устойчивого offscreen-исполнителя уровня NT2) | `extension/offscreen/offscreen.js`, `extension/bg/offscreen-executor.js`, `extension/bg/offscreen-llm-executor.js` |
| Content DOM scan/apply | `extension/content-script.js` | `extension/content/dom-indexer.js`, `extension/content/dom-classifier.js`, `extension/content/dom-applier.js` |
| Storage/state | `extension/settings.js` + локальные структуры | `extension/bg/tab-state-store.js`, `extension/bg/inflight-request-store.js`, `extension/bg/translation-job-store.js` |
| Event logging | `extension/debug.js` + фоновые события | `extension/bg/event-log-store.js`, `extension/core/event-factory.js` |
| OpenAI integration / limits | `extension/throughput-controller.js`, `extension/llm/RequestRunner.js` | `extension/ai/llm-client.js`, `extension/ai/llm-engine.js`, `extension/bg/rate-limit-budget-store.js`, `extension/core/json-schema-validator.js` |
| Popup / Debug UI | `extension/popup.*`, `extension/debug.*` | `extension/ui/popup.*`, `extension/ui/debug.*`, `extension/ui/popup-view-model.js` |
| Тестовый контур | `tools/smoke-check.js` + точечные тесты | `tests/e2e/*`, `tools/test-*`, mock OpenAI сервер |

## Что заимствовано как best practice
| Source Project | Module/Pattern | Как использовано в текущем проекте | Где в коде | Почему это best practice |
|---|---|---|---|---|
| NT2 | Разделение контекстов MV3 (Popup/SW/Offscreen/Content/Debug) | Полная декомпозиция по ролям и обмену через messaging/ports | `src/manifest.json`, `src/sw/worker.js`, `src/offscreen/offscreen.js`, `src/content/content.js`, `src/popup/popup.js`, `src/debug/debug.js` | Убирает скрытую связанность, облегчает анти-регрессию MV3 |
| NT2 | Orchestrator + job queue | Единая оркестрация пайплайна, очередь батчей, управление стадиями | `src/sw/pipeline-orchestrator.js`, `src/shared/job-queue.js` | Контролируемое выполнение, меньше гонок |
| NT2 | Offscreen executor boundary | Все LLM-вызовы/модели вынесены в offscreen, SW только оркеструет | `src/sw/offscreen-client.js`, `src/offscreen/offscreen.js` | Устойчивость к unload SW при длинных запросах |
| NT2 | Persistent tab/session state | Состояние по `pageSessionId` и `tabId` в persistent store | `src/shared/tab-state-store.js`, `src/sw/pipeline-orchestrator.js` | Восстановление/дозавершение без потери контекста |
| NT2 | Inflight metadata store | Трекинг активных запросов (in-memory + persisted metadata) | `src/shared/inflight-request-store.js`, `src/sw/pipeline-orchestrator.js` | Корректная hard-cancel и диагностика |
| NT2 | Unified EventLog store for popup/debug | Popup и debug читают/экспортируют один лог | `src/shared/event-log-store.js`, `src/popup/popup.js`, `src/debug/debug.js` | Один source of truth, без расхождений |
| NT2 | DOM module split (index/classify/apply) | Разделение scan/classify/apply с устойчивыми anchor | `src/content/dom-indexer.js`, `src/content/dom-classifier.js`, `src/content/dom-applier.js` | Точечная тестируемость и стабильность подстановки |
| NT2 | Popup compact cards + strict control state | Компактный popup и строгие disabled-правила | `src/popup/popup.js`, `src/popup/popup.css` | Снижает UX-регрессии и ошибки пользователя |
| NT2 | E2E on chaotic layout | Хаотичная страница + сценарии C1..C7 | `tests/e2e/neuro-translate.spec.js` | Ловит реальные DOM/async проблемы |
| NT1 | Throughput controller (TPM/RPM + retry/backoff) | BudgetThroughputController + dynamic concurrency + retries | `src/shared/rate-limit-controller.js`, `src/sw/pipeline-orchestrator.js` | Контролируемая деградация под 429 |
| NT1 | Retry discipline around LLM requests | Единый retry path вокруг offscreen calls | `src/sw/pipeline-orchestrator.js` | Нет дублированной и расходящейся retry-логики |
| NT1 | Event discipline and redaction mindset | Централизованная редактировка секретов перед записью | `src/shared/redact.js`, `src/shared/event-log-store.js` | Снижает риск утечек ключей |
| NT1+NT2 | Deterministic IDs | `pageSessionId`, `batchId`, `blockId` стабильно строятся через hash | `src/shared/utils.js`, `src/content/dom-indexer.js`, `src/shared/batching.js` | Устойчивое связывание стадий пайплайна |
| NT2 | Strict JSON schema validation | Усиленная валидация structured output | `src/shared/translation-schema.js`, `src/offscreen/offscreen.js` | Защита от «сырого текста» и формат-дрифта |
| NT2 | Resume logic for orphan sessions | Обнаружение и корректная перезапуск/завершение orphan state | `src/sw/pipeline-orchestrator.js` (`resumePending`) | Анти-регрессия SW lifecycle |

## Что не заимствовано (и почему)
| Source Project | Module/Pattern | Почему не заимствовано напрямую |
|---|---|---|
| NT2 | Монолитный сложный popup-view-model с 4+ вкладками и большой surface area | В текущей спецификации строго 3 вкладки и компактный scope; прямой перенос добавил бы лишние режимы |
| NT2 | Широкий набор агентных tool-режимов и policy overlays | Вне текущей идеи/ТЗ, повышает сложность без закрытия обязательных требований |
| NT1 | Legacy объединённый content runtime | Риск повторения старой связности; оставлена модульная split-архитектура NT2-стиля |
| NT1 | Часть legacy guardrails, не связанных с текущей спецификацией popup/pipeline | Не влияет на обязательные критерии PASS по текущей спеки |

## Ключевые прежние причины провалов и контрмеры
| Причина провалов | Контрмера в текущей реализации |
|---|---|
| Зависимость от «вечного» SW | Persisted state + `resumePending` + offscreen boundary |
| Мягкая/неполная отмена | `hardCancel` отменяет queue + session signal + offscreen requests |
| Разная логика в popup/debug | Единый `EventLogStore` и единые `log.query`/`log.export` |
| Несогласованный structured output | Жёсткая schema + validator + strict parse |
| Нет адаптации под 429 | Throughput controller + retry/backoff + dynamic concurrency |
| Недетерминированные ID блоков/батчей | Stable hash-based IDs |
| Хрупкая DOM-подстановка | Anchor path + parent anchor + text hash fallback |
| Неполный контроль роста логов | GC по age/records/bytes + событие `storage.gc` |
| Потеря контекста при длинной генерации | Multi-pass global context с `targetTokens>=15000` и `maxOutputTokens` |
| Слабый compaction chain | Учитывание предыдущих компакций + ограничение token budget |
