# Legacy Analysis: neuro-translate-main + neuro-translate-2-main

Date: 2026-03-03

## Archive Availability
- Found: `neuro-translate-main.zip`
- Found: `neuro-translate-2-main.zip`

## Module Map

### Archive #1 (`neuro-translate-main`)
- `extension/background.js`
  - Message hub, scheduler tick, progress updates.
- `extension/content-script.js`
  - Full page translation runtime in one script.
- `extension/throughput-controller.js` + `scheduler/task-scheduler.js`
  - Adaptive concurrency + RPM/TPM windows + backoff.
- `extension/llm/RequestRunner.js`
  - Unified LLM request execution and retries.
- `extension/context-service.js` + `translation-service.js`
  - Context generation + translation requests.
- `extension/popup.*`
  - Popup controls and model settings.
- `extension/debug.*`
  - Debug view and exported telemetry.

### Archive #2 (`neuro-translate-2-main`)
- `extension/bg/translation-orchestrator.js`
  - Modular orchestrator with explicit stores and runner.
- `extension/bg/job-queue.js` + `job-runner.js`
  - Queue orchestration, dispatch, cancellation points.
- `extension/bg/offscreen-executor.js` + `offscreen-llm-executor.js`
  - Dedicated offscreen request execution.
- `extension/bg/event-log-store.js` + `inflight-request-store.js` + `tab-state-store.js`
  - Persistent event/state stores and inflight metadata.
- `extension/content/dom-*.js`
  - DOM index/classify/apply split by responsibility.
- `extension/ui/popup.*` + `popup-view-model.js`
  - Card-based compact popup and strict control-state rendering.
- `extension/ui/debug.*`
  - Shared log browsing/export UX.
- `extension/core/json-schema-validator.js`
  - Strict schema validation path.

## Prior Failure Causes And Countermeasures
1. Monolithic runtime scripts created hidden coupling.
- Countermeasure: split into `sw`, `offscreen`, `content`, `popup`, `debug`, `shared` modules.

2. UI and orchestration logic were mixed.
- Countermeasure: popup only sends intents; SW is the single orchestration authority.

3. SW unload could orphan running sessions.
- Countermeasure: persistent `TabStateStore` + resume scanner + orphan recovery/restart.

4. Inflight requests were not durably tracked.
- Countermeasure: `InflightRequestStore` with in-memory map + persistent metadata flush.

5. Cancellation was soft/incomplete.
- Countermeasure: hard-cancel aborts queue, session signal, offscreen request IDs, and session-level offscreen ops.

6. Retry/backoff logic existed in multiple places.
- Countermeasure: one `BudgetThroughputController.retryWithBackoff` path for all LLM calls.

7. TPM/RPM behavior was not observable enough.
- Countermeasure: detailed `openai.rate_limit` events for wait, hit, retry, and concurrency adaptation.

8. Queue concurrency stayed static under 429 pressure.
- Countermeasure: sync queue concurrency from controller dynamic limits.

9. Structured output parsing accepted weak/ambiguous payloads.
- Countermeasure: strict JSON schema + required fields + hard validation.

10. Content script readiness raced with pipeline start.
- Countermeasure: `ui.ping` preflight and scripted reinjection fallback.

11. Unsupported tabs failed with vague errors.
- Countermeasure: explicit start validation (tab id + http/https URL + readable lastError in UI).

12. Credentials misconfiguration started doomed requests.
- Countermeasure: pre-start gate for BYOK/PROXY credentials when mock mode is off.

13. Event logs could grow unbounded.
- Countermeasure: GC by age + record count + byte budget (`maxBytes`).

14. Secret leakage risk in logs.
- Countermeasure: centralized redaction before persistence/export.

15. Popup and debug could diverge on data source.
- Countermeasure: both read/export from one `EventLogStore` implementation.

16. Anchor resolution broke after DOM shifts.
- Countermeasure: anchor path + parent anchor id + text hash fallback resolution.

17. Batch/job identity drift across stages.
- Countermeasure: deterministic `blockId` and `batchId` generation from stable inputs.

18. Profile editing UX caused state drift.
- Countermeasure: single source `profileDraft` + explicit `*` dirty mode + one combobox input editor.

19. Model selection lacked stable sorting by cost.
- Countermeasure: sort by total input+output price, show input/output/cached prices.

20. Context generation could undershoot target detail.
- Countermeasure: enforce minimum 15000 target tokens for global context requests.

21. Orchestrator state could be inconsistent after clear/reset.
- Countermeasure: clear session state, inflight metadata, and transient UI errors together.

22. Event taxonomy was incomplete for forensic debugging.
- Countermeasure: explicit categories for `dom.scan`, `dom.classify`, `dom.apply`, stage transitions, rate-limit, cancellation, GC.

## Reuse Decisions
- Reused patterns: modular stores, queue/cancel primitives, offscreen executor boundary, popup compact card style, telemetry discipline.
- Explicitly avoided: copying whole legacy modules and carrying old coupling/legacy-only commands.
