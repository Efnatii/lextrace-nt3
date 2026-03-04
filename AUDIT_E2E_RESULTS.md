# AUDIT_E2E_RESULTS.md

Дата: 2026-03-04

## Команды запуска
```bash
npm run build
npm run test:unit
npm run test:e2e
```

## Результаты
- `build`: PASS
- `unit`: PASS (`11` test files, `18` tests)
- `e2e`: PASS (`7` tests)

## Детализация e2e
- `C1 incremental apply before final completion` — PASS
- `C2 view switches and strict disabled rules` — PASS
- `C3 hard cancel mid-flight keeps queue drained` — PASS
- `C4 API error is logged and reachable from error counter` — PASS
- `C5 simulated SW restart does not leave pipeline stuck running` — PASS
- `C6 start is blocked without credentials in non-mock mode` — PASS
- `C7 profile editor uses one combobox input and switches profile to star` — PASS

## Детализация unit
Покрыты ключевые зоны:
- DOM scan/anchors/order
- batching deterministic + boundaries
- window+compaction chain
- rate-limit controller backoff/concurrency (+ role separation)
- cancellation registry
- inflight request persistence
- event log GC
- structured output schema strict validation

## Падения и фиксы в этом цикле
- Было падение unit `window-compaction-chain` после ужесточения compaction-chain.
- Причина: нижняя граница `compactionTokenTarget` была выше тестового ожидания.
- Фикс: скорректирована минимальная граница в `src/shared/batch-window.js`.
- Повторный прогон: PASS.

## Артефакты Playwright
- Папка: `test-results/`
- На итоговом прогоне дополнительных trace/screenshots не требовалось (все тесты зелёные).
