(function initPopup(global) {
  const NT = global.NT || {};
  const Ui = NT.Ui;
  const UiProtocol = NT.UiProtocol || {};
  const I18n = NT.UiI18nRu || null;
  const PopupVm = NT.PopupViewModel || null;
  const POPUP_TABS = ['status', 'settings', 'history', 'errors'];
  const PROFILE_IDS = ['minimal', 'medium', 'optimized', 'maximum', 'custom'];
  const PROFILE_PRESET_IDS = ['minimal', 'medium', 'optimized', 'maximum'];
  const PROFILE_ALIAS_MAP = Object.freeze({
    auto: 'medium',
    fast: 'minimal',
    balanced: 'medium',
    bulk: 'minimal',
    accurate: 'maximum',
    research: 'maximum',
    literal: 'maximum',
    readable: 'minimal',
    technical: 'maximum',
    minimal: 'minimal',
    medium: 'medium',
    optimized: 'optimized',
    optimal: 'optimized',
    efficient: 'optimized',
    maximum: 'maximum',
    custom: 'custom'
  });
  const DEFAULT_IGNORED_QUERY_PARAMS = ['utm_*', 'fbclid', 'gclid'];
  const SCRIPTING_BLOCKED_PHRASE = 'extensions gallery cannot be scripted';
  const MODEL_PRIORITY_PRESET_IDS = ['cheap', 'optimal', 'expensive', 'smart_cheap', 'smart_fast', 'cheap_fast', 'custom'];
  const MODEL_PRIORITY_ROLE_IDS = ['agent', 'translation', 'context', 'compaction', 'proofreading'];
  const PROFILE_PIPELINE_TABS = ['input', 'policy', 'runtime', 'service'];
  const PROFILE_JSON_MIN_HEIGHT = 180;
  const PROFILE_JSON_MAX_HEIGHT = 720;
  const PROFILE_JSON_DEFAULT_HEIGHT = 280;
  const PROFILE_PIPELINE_TAB_ROOTS = Object.freeze({
    input: [
      'translationAgentProfileRequested',
      'translationAgentProfile',
      'userSettings',
      'modelPriorityRoles',
      'translationModelList',
      'requestedAgentAllowedModels',
      'translationAgentAllowedModels'
    ],
    policy: [
      'translationAgentProfileApplied',
      'effectiveSettings',
      'overrides',
      'appliedAgentAllowedModels',
      'rejectedAgentAllowedModels'
    ],
    runtime: [
      'modelSelection',
      'translationAgentModelPolicy',
      'translationAgentTuning',
      'runtimeApplied',
      'translationAgentExecutionMode',
      'translationPipelineEnabled',
      'translationCategoryMode',
      'translationCategoryList',
      'translationMemoryEnabled',
      'translationMemoryMaxPages',
      'translationMemoryMaxBlocks',
      'translationMemoryMaxAgeDays',
      'translationMemoryGcOnStartup',
      'translationMemoryIgnoredQueryParams',
      'translationPageCacheEnabled',
      'translationApiCacheEnabled',
      'translationClassifierObserveDomChanges',
      'translationPerfMaxTextNodesPerScan',
      'translationPerfYieldEveryNNodes',
      'translationPerfAbortScanIfOverMs',
      'translationPerfDegradedScanOnHeavy',
      'translationCompareDiffThreshold',
      'translationCompareRendering'
    ],
    service: [
      'schemaVersion',
      'updatedAt',
      'debugAllowTestCommands'
    ]
  });
  const PROFILE_PIPELINE_KNOWN_ROOTS = Object.freeze((() => {
    const out = new Set();
    PROFILE_PIPELINE_TABS.forEach((tabId) => {
      const rows = PROFILE_PIPELINE_TAB_ROOTS[tabId] || [];
      rows.forEach((entry) => out.add(entry));
    });
    return out;
  })());
  const MODEL_PRIORITY_PRESET_LABELS = Object.freeze({
    cheap: 'дёшево',
    optimal: 'оптимально',
    expensive: 'дорого',
    smart_cheap: 'умные, но дешёвые',
    smart_fast: 'умные, но быстрые',
    cheap_fast: 'дешёвые и быстрые',
    custom: 'кастом'
  });
  const PROFILE_ROLE_PRESETS = Object.freeze({
    minimal: Object.freeze({
      agent: 'smart_fast',
      context: 'smart_fast',
      translation: 'cheap_fast',
      compaction: 'cheap_fast',
      proofreading: 'smart_fast'
    }),
    medium: Object.freeze({
      agent: 'smart_fast',
      context: 'optimal',
      translation: 'optimal',
      compaction: 'optimal',
      proofreading: 'smart_fast'
    }),
    optimized: Object.freeze({
      agent: 'smart_fast',
      context: 'smart_fast',
      translation: 'optimal',
      compaction: 'optimal',
      proofreading: 'smart_fast'
    }),
    maximum: Object.freeze({
      agent: 'expensive',
      context: 'expensive',
      translation: 'smart_cheap',
      compaction: 'expensive',
      proofreading: 'expensive'
    })
  });
  const PROFILE_INFLUENCE_PREFIXES = Object.freeze([
    'userSettings.profile',
    'userSettings.reasoning',
    'userSettings.caching',
    'userSettings.memory',
    'userSettings.models.modelRoutingMode',
    'userSettings.models.modelUserPriority',
    'translationAgentProfileRequested',
    'translationAgentProfileApplied',
    'translationAgentProfile',
    'modelPriorityRoles',
    'modelSelection',
    'translationAgentModelPolicy',
    'translationAgentTuning',
    'translationAgentExecutionMode',
    'translationPipelineEnabled',
    'translationCategoryMode',
    'translationMemoryEnabled',
    'translationMemoryMaxPages',
    'translationMemoryMaxBlocks',
    'translationMemoryMaxAgeDays',
    'translationMemoryGcOnStartup',
    'translationMemoryIgnoredQueryParams',
    'translationPageCacheEnabled',
    'translationApiCacheEnabled',
    'translationCompareRendering',
    'effectiveSettings.profile',
    'effectiveSettings.effectiveProfile',
    'effectiveSettings.reasoning',
    'effectiveSettings.caching',
    'effectiveSettings.memory',
    'effectiveSettings.ui',
    'effectiveSettings.models.modelProfilePriority',
    'effectiveSettings.agent.toolConfigDefault',
    'overrides'
  ]);
  const LEGACY_TOOL_KEYS = Object.freeze([
    'pageAnalyzer',
    'categorySelector',
    'glossaryBuilder',
    'batchPlanner',
    'modelRouter',
    'progressAuditor',
    'antiRepeatGuard',
    'contextCompressor',
    'reportWriter',
    'pageRuntime',
    'cacheManager',
    'workflowController'
  ]);
  const TOP_LEVEL_PATCH_KEYS = new Set([
    'apiKey',
    'translationModelList',
    'modelSelection',
    'modelSelectionPolicy',
    'translationAgentModelPolicy',
    'translationAgentProfile',
    'translationAgentTools',
    'translationAgentTuning',
    'translationAgentExecutionMode',
    'translationAgentAllowedModels',
    'translationPipelineEnabled',
    'translationCategoryMode',
    'translationCategoryList',
    'translationMemoryEnabled',
    'translationMemoryMaxPages',
    'translationMemoryMaxBlocks',
    'translationMemoryMaxAgeDays',
    'translationMemoryGcOnStartup',
    'translationMemoryIgnoredQueryParams',
    'translationPageCacheEnabled',
    'translationApiCacheEnabled',
    'translationClassifierObserveDomChanges',
    'translationPerfMaxTextNodesPerScan',
    'translationPerfYieldEveryNNodes',
    'translationPerfAbortScanIfOverMs',
    'translationPerfDegradedScanOnHeavy',
    'translationPopupActiveTab',
    'translationVisibilityByTab',
    'translationDisplayModeByTab',
    'translationCompareDiffThreshold',
    'translationCompareRendering',
    'debugAllowTestCommands'
  ]);
  const PROFILE_PARAM_META = Object.freeze({
    'userSettings.profile': {
      label: 'Профиль',
      description: 'Базовый пресет настроек агента и перевода.',
      values: PROFILE_PRESET_IDS.slice(),
      allowCustom: false,
      type: 'string'
    },
    'userSettings.agent.agentMode': {
      label: 'Режим агента',
      description: 'Режим выполнения пайплайна переводчика.',
      values: ['agent', 'legacy'],
      allowCustom: false,
      type: 'string'
    },
    'userSettings.reasoning.reasoningMode': {
      label: 'Режим reasoning',
      description: 'Определяет, берет ли параметры reasoning из профиля или из ручных значений.',
      values: ['auto', 'custom'],
      allowCustom: false,
      type: 'string'
    },
    'userSettings.reasoning.reasoningEffort': {
      label: 'Глубина рассуждения',
      description: 'Насколько глубоко модель анализирует входной контекст.',
      values: ['minimal', 'low', 'medium', 'high', 'max'],
      allowCustom: false,
      type: 'string',
      forceCustom: true,
      forceReasoningCustom: true
    },
    'userSettings.reasoning.reasoningSummary': {
      label: 'Формат reasoning summary',
      description: 'Объем пояснений reasoning в ответе модели.',
      values: ['auto', 'none', 'short', 'detailed'],
      allowCustom: false,
      type: 'string',
      forceCustom: true,
      forceReasoningCustom: true
    },
    'userSettings.caching.promptCacheRetention': {
      label: 'Политика prompt-кеша',
      description: 'Время жизни и режим хранения prompt cache.',
      values: ['auto', 'in_memory', 'extended', 'disabled'],
      allowCustom: false,
      type: 'string',
      forceCustom: true
    },
    'userSettings.caching.promptCacheKey': {
      label: 'Ключ prompt-кеша',
      description: 'Пользовательский ключ сегментации кеша; можно задать вручную.',
      values: [],
      allowCustom: true,
      type: 'string',
      forceCustom: true
    },
    'userSettings.caching.compatCache': {
      label: 'Compat cache',
      description: 'Включает совместимый legacy-кеш API.',
      values: ['true', 'false'],
      allowCustom: false,
      type: 'boolean',
      forceCustom: true
    },
    'userSettings.models.modelRoutingMode': {
      label: 'Роутинг моделей',
      description: 'Правило выбора модели в рантайме.',
      values: ['auto', 'user_priority', 'profile_priority'],
      allowCustom: false,
      type: 'string',
      forceCustom: true
    },
    'userSettings.ui.uiLanguage': {
      label: 'Язык интерфейса',
      description: 'Язык popup/debug интерфейса.',
      values: ['ru'],
      allowCustom: false,
      type: 'string',
      forceCustom: true
    },
    'userSettings.ui.showAdvanced': {
      label: 'Показывать расширенное',
      description: 'Включает расширенные UI элементы.',
      values: ['true', 'false'],
      allowCustom: false,
      type: 'boolean',
      forceCustom: true
    },
    'userSettings.ui.compareRendering': {
      label: 'Рендер compare',
      description: 'Визуальный способ показа diff на странице.',
      values: ['auto', 'highlights', 'wrappers'],
      allowCustom: false,
      type: 'string',
      forceCustom: true
    },
    'userSettings.memory.enabled': {
      label: 'Память перевода',
      description: 'Включает сохранение памяти перевода между задачами.',
      values: ['true', 'false'],
      allowCustom: false,
      type: 'boolean',
      forceCustom: true
    },
    'userSettings.memory.maxPages': {
      label: 'Лимит страниц памяти',
      description: 'Максимальное число страниц, хранимых в памяти перевода.',
      values: [],
      allowCustom: true,
      type: 'number',
      forceCustom: true
    },
    'userSettings.memory.maxBlocks': {
      label: 'Лимит блоков памяти',
      description: 'Максимальное число блоков в памяти перевода.',
      values: [],
      allowCustom: true,
      type: 'number',
      forceCustom: true
    },
    'userSettings.memory.maxAgeDays': {
      label: 'TTL памяти (дни)',
      description: 'Максимальный возраст записей памяти в днях.',
      values: [],
      allowCustom: true,
      type: 'number',
      forceCustom: true
    },
    'userSettings.memory.gcOnStartup': {
      label: 'GC при старте',
      description: 'Удалять устаревшие записи памяти при старте.',
      values: ['true', 'false'],
      allowCustom: false,
      type: 'boolean',
      forceCustom: true
    },
    'userSettings.memory.ignoredQueryParams': {
      label: 'Игнорируемые query-параметры',
      description: 'Список query-параметров, которые не участвуют в ключах памяти.',
      values: [],
      allowCustom: true,
      editable: true,
      type: 'json'
    },
    'userSettings.models.agentAllowedModels': {
      label: 'Разрешенные модели',
      description: 'Список model spec, разрешенных для агента. Кликните по параметру, чтобы открыть всплывающий выбор.',
      values: [],
      allowCustom: false,
      editable: true,
      type: 'model_list',
      editor: 'model-picker'
    },
    'userSettings.models.modelUserPriority': {
      label: 'Пользовательский приоритет моделей',
      description: 'Явный приоритет моделей при routingMode=user_priority.',
      values: [],
      allowCustom: false,
      editable: true,
      type: 'model_list',
      editor: 'model-picker'
    },
    'translationAgentAllowedModels': {
      label: 'Legacy allowlist моделей',
      description: 'Legacy-список разрешенных моделей. Можно редактировать тем же всплывающим picker.',
      values: [],
      allowCustom: false,
      editable: true,
      type: 'model_list',
      editor: 'model-picker',
      patchPath: 'translationAgentAllowedModels'
    },
    'translationModelList': {
      label: 'Runtime список моделей',
      description: 'Список моделей, доступных для маршрутизации и UI. Редактируемый model-picker.',
      values: [],
      allowCustom: false,
      editable: true,
      type: 'model_list',
      editor: 'model-picker',
      patchPath: 'translationModelList'
    },
    'modelSelection.speed': {
      label: 'Скоростной выбор модели (глобально)',
      description: 'Влияет на выбор модели для LLM-запросов переводчика в фоне.',
      values: ['true', 'false'],
      allowCustom: false,
      type: 'boolean',
      patchPath: 'modelSelection.speed'
    },
    'modelSelection.preference': {
      label: 'Предпочтение модели (глобально)',
      description: 'Приоритет выбора: cheapest|smartest|none для глобальных LLM-запросов.',
      values: ['none', 'smartest', 'cheapest'],
      allowCustom: false,
      nullToken: 'none',
      type: 'string',
      patchPath: 'modelSelection.preference'
    },
    'translationAgentModelPolicy.mode': {
      label: 'Политика маршрутизации агента: режим',
      description: 'auto = учитывать route/profile, fixed = фиксированная политика.',
      values: ['auto', 'fixed'],
      allowCustom: false,
      type: 'string',
      patchPath: 'translationAgentModelPolicy.mode'
    },
    'translationAgentModelPolicy.speed': {
      label: 'Политика маршрутизации агента: speed',
      description: 'При true приоритет в сторону скорости ответа.',
      values: ['true', 'false'],
      allowCustom: false,
      type: 'boolean',
      patchPath: 'translationAgentModelPolicy.speed'
    },
    'translationAgentModelPolicy.preference': {
      label: 'Политика маршрутизации агента: preference',
      description: 'Приоритет cheapest|smartest|none для агентных задач.',
      values: ['none', 'smartest', 'cheapest'],
      allowCustom: false,
      nullToken: 'none',
      type: 'string',
      patchPath: 'translationAgentModelPolicy.preference'
    },
    'translationAgentModelPolicy.allowRouteOverride': {
      label: 'Политика маршрутизации агента: route override',
      description: 'Разрешать агенту менять fast/strong route по ситуации.',
      values: ['true', 'false'],
      allowCustom: false,
      type: 'boolean',
      patchPath: 'translationAgentModelPolicy.allowRouteOverride'
    },
    'translationAgentTuning.styleOverride': {
      label: 'Тюнинг агента: стиль',
      description: 'Переопределение стиля перевода на уровне агента.',
      values: ['auto', 'balanced', 'literal', 'readable', 'technical'],
      allowCustom: false,
      type: 'string',
      patchPath: 'translationAgentTuning.styleOverride'
    },
    'translationAgentTuning.maxBatchSizeOverride': {
      label: 'Тюнинг агента: максимум блоков в батче',
      description: 'Ограничивает размер батча перевода; пусто/auto сбрасывает override.',
      values: ['auto'],
      allowCustom: true,
      nullable: true,
      nullToken: 'auto',
      type: 'number',
      patchPath: 'translationAgentTuning.maxBatchSizeOverride'
    },
    'translationAgentTuning.proofreadingPassesOverride': {
      label: 'Тюнинг агента: проходы вычитки',
      description: 'Количество проходов вычитки; пусто/auto сбрасывает override.',
      values: ['auto'],
      allowCustom: true,
      nullable: true,
      nullToken: 'auto',
      type: 'number',
      patchPath: 'translationAgentTuning.proofreadingPassesOverride'
    },
    'translationAgentTuning.parallelismOverride': {
      label: 'Тюнинг агента: параллелизм',
      description: 'Предпочтительный уровень параллельной обработки.',
      values: ['auto', 'low', 'mixed', 'high'],
      allowCustom: false,
      type: 'string',
      patchPath: 'translationAgentTuning.parallelismOverride'
    },
    'translationAgentTuning.plannerTemperature': {
      label: 'Тюнинг агента: temperature планировщика',
      description: 'Температура генерации плана (planner).',
      values: [],
      allowCustom: true,
      type: 'number',
      patchPath: 'translationAgentTuning.plannerTemperature'
    },
    'translationAgentTuning.plannerMaxOutputTokens': {
      label: 'Тюнинг агента: лимит токенов планировщика',
      description: 'Максимум output токенов для planner-запроса.',
      values: [],
      allowCustom: true,
      type: 'number',
      patchPath: 'translationAgentTuning.plannerMaxOutputTokens'
    },
    'translationAgentTuning.auditIntervalMs': {
      label: 'Тюнинг агента: интервал аудита (мс)',
      description: 'Частота регулярного аудита прогресса.',
      values: [],
      allowCustom: true,
      type: 'number',
      patchPath: 'translationAgentTuning.auditIntervalMs'
    },
    'translationAgentTuning.mandatoryAuditIntervalMs': {
      label: 'Тюнинг агента: обязательный аудит (мс)',
      description: 'Жесткий максимум паузы между audit-проверками.',
      values: [],
      allowCustom: true,
      type: 'number',
      patchPath: 'translationAgentTuning.mandatoryAuditIntervalMs'
    },
    'translationAgentTuning.compressionThreshold': {
      label: 'Тюнинг агента: порог сжатия контекста',
      description: 'Когда запускать compaction по размеру/нагрузке контекста.',
      values: [],
      allowCustom: true,
      type: 'number',
      patchPath: 'translationAgentTuning.compressionThreshold'
    },
    'translationAgentTuning.contextFootprintLimit': {
      label: 'Тюнинг агента: лимит footprint контекста',
      description: 'Порог размера контекста перед сжатием.',
      values: [],
      allowCustom: true,
      type: 'number',
      patchPath: 'translationAgentTuning.contextFootprintLimit'
    },
    'translationAgentTuning.compressionCooldownMs': {
      label: 'Тюнинг агента: cooldown compaction (мс)',
      description: 'Минимальная пауза между повторными compaction.',
      values: [],
      allowCustom: true,
      type: 'number',
      patchPath: 'translationAgentTuning.compressionCooldownMs'
    },
    'translationPipelineEnabled': {
      label: 'Пайплайн перевода включён',
      description: 'Глобальный флаг запуска пайплайна переводчика.',
      values: ['true', 'false'],
      allowCustom: false,
      type: 'boolean',
      patchPath: 'translationPipelineEnabled'
    },
    'translationAgentExecutionMode': {
      label: 'Режим выполнения агента',
      description: 'agent или legacy режим исполнения.',
      values: ['agent', 'legacy'],
      allowCustom: false,
      type: 'string',
      patchPath: 'translationAgentExecutionMode'
    },
    'translationCategoryMode': {
      label: 'Режим категорий',
      description: 'Политика выбора категорий для перевода.',
      values: ['auto', 'all', 'content', 'interface', 'meta', 'custom'],
      allowCustom: false,
      type: 'string',
      patchPath: 'translationCategoryMode'
    },
    'translationPageCacheEnabled': {
      label: 'Кэш страницы',
      description: 'Сохранять/восстанавливать готовый перевод страницы целиком.',
      values: ['true', 'false'],
      allowCustom: false,
      type: 'boolean',
      patchPath: 'translationPageCacheEnabled'
    },
    'translationApiCacheEnabled': {
      label: 'API кэш',
      description: 'Использовать совместимый API cache между повторными запросами.',
      values: ['true', 'false'],
      allowCustom: false,
      type: 'boolean',
      patchPath: 'translationApiCacheEnabled'
    },
    'translationClassifierObserveDomChanges': {
      label: 'DOM watchdog классификатора',
      description: 'Отслеживать изменения DOM и повторять классификацию при дрейфе.',
      values: ['true', 'false'],
      allowCustom: false,
      type: 'boolean',
      patchPath: 'translationClassifierObserveDomChanges'
    },
    'translationPerfMaxTextNodesPerScan': {
      label: 'Perf: максимум text nodes за скан',
      description: 'Лимит объема DOM-сканирования за проход.',
      values: [],
      allowCustom: true,
      type: 'number',
      patchPath: 'translationPerfMaxTextNodesPerScan'
    },
    'translationPerfYieldEveryNNodes': {
      label: 'Perf: yield каждые N узлов',
      description: 'Частота освобождения event-loop при сканировании DOM.',
      values: [],
      allowCustom: true,
      type: 'number',
      patchPath: 'translationPerfYieldEveryNNodes'
    },
    'translationPerfAbortScanIfOverMs': {
      label: 'Perf: abort scan если дольше (мс)',
      description: 'Жесткий лимит времени сканирования страницы.',
      values: [],
      allowCustom: true,
      type: 'number',
      patchPath: 'translationPerfAbortScanIfOverMs'
    },
    'translationPerfDegradedScanOnHeavy': {
      label: 'Perf: degrade scan на тяжелых страницах',
      description: 'Включать деградированный скан на тяжелых DOM.',
      values: ['true', 'false'],
      allowCustom: false,
      type: 'boolean',
      patchPath: 'translationPerfDegradedScanOnHeavy'
    },
    'translationCompareRendering': {
      label: 'Режим compare-рендера',
      description: 'Способ визуализации diff в режиме сравнения.',
      values: ['auto', 'highlights', 'wrappers'],
      allowCustom: false,
      type: 'string',
      patchPath: 'translationCompareRendering'
    },
    'debugAllowTestCommands': {
      label: 'Разрешить тестовые debug-команды',
      description: 'Открывает диагностические команды в debug UI.',
      values: ['true', 'false'],
      allowCustom: false,
      type: 'boolean',
      patchPath: 'debugAllowTestCommands'
    },
    'modelPriorityRoles.agent': {
      label: 'Приоритет моделей: агент',
      description: 'Пресет политики выбора моделей для агентных LLM запросов.',
      values: MODEL_PRIORITY_PRESET_IDS.slice(),
      valueLabels: { ...MODEL_PRIORITY_PRESET_LABELS },
      allowCustom: false,
      type: 'string',
      patchPath: '__rolePreset__.agent'
    },
    'modelPriorityRoles.translation': {
      label: 'Приоритет моделей: перевод',
      description: 'Пресет приоритета моделей для основного перевода.',
      values: MODEL_PRIORITY_PRESET_IDS.slice(),
      valueLabels: { ...MODEL_PRIORITY_PRESET_LABELS },
      allowCustom: false,
      type: 'string',
      patchPath: '__rolePreset__.translation'
    },
    'modelPriorityRoles.context': {
      label: 'Приоритет моделей: генерация контекста',
      description: 'Пресет для параметров planner/context и вспомогательного контекста.',
      values: MODEL_PRIORITY_PRESET_IDS.slice(),
      valueLabels: { ...MODEL_PRIORITY_PRESET_LABELS },
      allowCustom: false,
      type: 'string',
      patchPath: '__rolePreset__.context'
    },
    'modelPriorityRoles.compaction': {
      label: 'Приоритет моделей: компакция',
      description: 'Пресет параметров сжатия контекста и compaction.',
      values: MODEL_PRIORITY_PRESET_IDS.slice(),
      valueLabels: { ...MODEL_PRIORITY_PRESET_LABELS },
      allowCustom: false,
      type: 'string',
      patchPath: '__rolePreset__.compaction'
    },
    'modelPriorityRoles.proofreading': {
      label: 'Приоритет моделей: вычитка',
      description: 'Пресет параметров proofread-проходов и политики модели.',
      values: MODEL_PRIORITY_PRESET_IDS.slice(),
      valueLabels: { ...MODEL_PRIORITY_PRESET_LABELS },
      allowCustom: false,
      type: 'string',
      patchPath: '__rolePreset__.proofreading'
    }
  });
  if (!Ui || !I18n || !PopupVm || !NT.UiProtocolClient) {
    return;
  }

  function safeString(value, fallback = '') {
    if (value === null || value === undefined) {
      return fallback;
    }
    return String(value);
  }

  function shortText(value, limit = 160) {
    const text = safeString(value, '').replace(/\s+/g, ' ').trim();
    if (!text) {
      return '';
    }
    return text.length <= limit ? text : `${text.slice(0, Math.max(1, limit - 1))}...`;
  }

  function normalizeModelSort(value) {
    const key = safeString(value, 'name').trim().toLowerCase();
    if (key === 'input' || key === 'output' || key === 'total') {
      return key;
    }
    return 'name';
  }

  function normalizeProfileJsonHeight(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) {
      return PROFILE_JSON_DEFAULT_HEIGHT;
    }
    return Math.max(PROFILE_JSON_MIN_HEIGHT, Math.min(PROFILE_JSON_MAX_HEIGHT, Math.round(num)));
  }

  function normalizeProfilePipelineTab(value) {
    const key = safeString(value, 'input').trim().toLowerCase();
    return PROFILE_PIPELINE_TABS.includes(key) ? key : 'input';
  }

  function normalizeProfileMarkerVisibility(value) {
    const src = value && typeof value === 'object' ? value : {};
    return {
      user: src.user !== false,
      agent: src.agent !== false,
      profile: src.profile !== false
    };
  }

  function normalizeProfileId(value, fallback = 'minimal') {
    const raw = safeString(value, '').trim().toLowerCase();
    if (!raw) {
      return fallback;
    }
    if (PROFILE_IDS.includes(raw)) {
      return raw;
    }
    if (Object.prototype.hasOwnProperty.call(PROFILE_ALIAS_MAP, raw)) {
      return PROFILE_ALIAS_MAP[raw];
    }
    return fallback;
  }

  function normalizeHistorySource(value) {
    const key = safeString(value, 'all').trim().toLowerCase();
    if (key === 'agent' || key === 'translation' || key === 'ai' || key === 'event') {
      return key;
    }
    return 'all';
  }

  function normalizeHistoryType(value) {
    const key = safeString(value, 'all').trim().toLowerCase();
    if (key === 'request' || key === 'response' || key === 'tool' || key === 'event') {
      return key;
    }
    return 'all';
  }

  function modelSpec(row) {
    if (!row || !row.id) {
      return '';
    }
    return `${String(row.id)}:${String(row.tier || 'standard').toLowerCase()}`;
  }

  function normalizeModelSpec(spec) {
    return safeString(spec, '').trim();
  }

  function normalizeModelSpecList(list) {
    const src = Array.isArray(list) ? list : [];
    const out = [];
    src.forEach((item) => {
      const spec = normalizeModelSpec(item);
      if (!spec || out.includes(spec)) {
        return;
      }
      out.push(spec);
    });
    return out;
  }

  function parseModelSpec(spec) {
    const normalized = normalizeModelSpec(spec);
    if (!normalized) {
      return { id: '', tier: 'standard', spec: '' };
    }
    const separator = normalized.lastIndexOf(':');
    if (separator <= 0) {
      return { id: normalized, tier: 'standard', spec: `${normalized}:standard` };
    }
    const id = normalized.slice(0, separator).trim();
    const tier = normalized.slice(separator + 1).trim().toLowerCase() || 'standard';
    return {
      id,
      tier,
      spec: id ? `${id}:${tier}` : ''
    };
  }

  function normalizeModelPriorityPreset(value) {
    const key = safeString(value, 'optimal').trim().toLowerCase();
    if (MODEL_PRIORITY_PRESET_IDS.includes(key)) {
      return key;
    }
    return 'optimal';
  }

  function modelPriorityPresetLabel(value) {
    const key = normalizeModelPriorityPreset(value);
    return MODEL_PRIORITY_PRESET_LABELS[key] || key;
  }

  function modelTierSpeedRank(spec) {
    const normalized = normalizeModelSpec(spec);
    const tier = normalized.split(':')[1] ? normalized.split(':')[1].trim().toLowerCase() : 'standard';
    if (tier === 'priority') {
      return 0;
    }
    if (tier === 'flex') {
      return 1;
    }
    return 2;
  }

  function firstKey(path) {
    return safeString(path, '').trim().split('.')[0] || '';
  }

  function isTopLevelSettingsPath(path) {
    const root = firstKey(path);
    return TOP_LEVEL_PATCH_KEYS.has(root);
  }

  function formatMoney(value) {
    if (!Number.isFinite(Number(value))) {
      return '—';
    }
    const num = Number(value);
    if (Math.abs(num) >= 100) {
      return num.toFixed(0);
    }
    if (Math.abs(num) >= 10) {
      return num.toFixed(2);
    }
    if (Math.abs(num) >= 1) {
      return num.toFixed(3);
    }
    return num.toFixed(4);
  }

  function cloneJson(value, fallback = null) {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (_) {
      return fallback;
    }
  }

  function redactSensitive(value, depth = 0, keyPath = '') {
    if (depth > 12) {
      return '[TRUNCATED]';
    }
    if (value === null || value === undefined) {
      return value;
    }
    if (typeof value === 'string') {
      return value.length > 5000
        ? `${value.slice(0, 4997)}...`
        : value;
    }
    if (typeof value !== 'object') {
      return value;
    }
    if (Array.isArray(value)) {
      return value.slice(0, 200).map((item, index) => redactSensitive(item, depth + 1, `${keyPath}[${index}]`));
    }
    const out = {};
    Object.keys(value).slice(0, 200).forEach((key) => {
      const nextPath = keyPath ? `${keyPath}.${key}` : key;
      if (/(api[-_]?key|token|secret|password|authorization|cookie|session|auth)/i.test(nextPath)) {
        out[key] = '[REDACTED]';
        return;
      }
      out[key] = redactSensitive(value[key], depth + 1, nextPath);
    });
    return out;
  }

  function readByPath(root, path, fallback = null) {
    const src = root && typeof root === 'object' ? root : {};
    const key = safeString(path, '').trim();
    if (!key) {
      return fallback;
    }
    const parts = key.split('.');
    let cursor = src;
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      if (!cursor || typeof cursor !== 'object' || !Object.prototype.hasOwnProperty.call(cursor, part)) {
        return fallback;
      }
      cursor = cursor[part];
    }
    return cursor;
  }

  function hasPath(root, path) {
    const src = root && typeof root === 'object' ? root : {};
    const key = safeString(path, '').trim();
    if (!key) {
      return false;
    }
    const parts = key.split('.');
    let cursor = src;
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      if (!cursor || typeof cursor !== 'object' || !Object.prototype.hasOwnProperty.call(cursor, part)) {
        return false;
      }
      cursor = cursor[part];
    }
    return true;
  }

  function writeByPath(root, path, value) {
    const dst = root && typeof root === 'object' ? root : {};
    const key = safeString(path, '').trim();
    if (!key) {
      return dst;
    }
    const parts = key.split('.');
    let cursor = dst;
    for (let i = 0; i < (parts.length - 1); i += 1) {
      const part = parts[i];
      if (!cursor[part] || typeof cursor[part] !== 'object' || Array.isArray(cursor[part])) {
        cursor[part] = {};
      }
      cursor = cursor[part];
    }
    cursor[parts[parts.length - 1]] = value;
    return dst;
  }

  function cssEscape(value) {
    const text = safeString(value, '');
    if (!text) {
      return '';
    }
    if (global.CSS && typeof global.CSS.escape === 'function') {
      return global.CSS.escape(text);
    }
    return text.replace(/([!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, '\\$1');
  }

  function formatTs(ts) {
    const value = Number(ts);
    if (!Number.isFinite(value) || value <= 0) {
      return '—';
    }
    try {
      return new Date(value).toLocaleString('ru-RU', {
        hour12: false
      });
    } catch (_) {
      return new Date(value).toISOString();
    }
  }

  class PopupApp {
    constructor(doc) {
      this.doc = doc;
      this.root = this.doc.getElementById('popupRoot');
      this.fields = {};

      this.client = null;
      this.uiModule = NT.UiModule
        ? new NT.UiModule({ chromeApi: global.chrome || null, portName: 'popup' })
        : null;
      this.uiStateStore = NT.UiStateStore
        ? new NT.UiStateStore({ chromeApi: global.chrome || null })
        : null;

      this.scheduler = new Ui.RenderScheduler();
      this.toasts = null;
      this.tabs = null;

      this.snapshot = {};
      this.vm = PopupVm.computeViewModel({}, {});
      this.uiStatus = {
        state: 'connecting',
        message: I18n.t('common.loading', 'Загрузка...')
      };

      this.uiState = {
        activeTab: 'status',
        modelSort: 'name',
        profilePipelineTab: 'input',
        profileJsonHeight: PROFILE_JSON_DEFAULT_HEIGHT,
        profileMarkerVisibility: normalizeProfileMarkerVisibility(null),
        byokVisible: false,
        proxyVisible: false,
        historySourceFilter: 'all',
        historyTypeFilter: 'all',
        savedProfiles: {},
        selectedSavedProfile: ''
      };

      this.categoryDraft = new Set();
      this.categoryDraftJobId = null;
      this.categoryDraftTouched = false;
      this.pendingSettingsPatch = {};
      this.flushSettingsDebounced = Ui.debounce(() => {
        this._flushSettingsPatch().catch((error) => this._showErrorToast(error));
      }, 260);

      this.credentialsDraft = {
        byokKey: '',
        proxyBaseUrl: '',
        proxyHeaderName: 'X-NT-Token',
        proxyToken: '',
        proxyProjectId: ''
      };
      this.formTouched = {
        proxyBaseUrl: false,
        proxyHeaderName: false,
        proxyProjectId: false
      };

      this._allowlistRenderKey = '';
      this._categoriesRenderKey = '';
      this._profileJsonRenderKey = '';
      this._savedProfilesRenderKey = '';
      this._historyRenderKey = '';
      this._historyEntries = [];
      this._profileJsonResizeObserver = null;
      this._profileJsonSizeSyncing = false;
      this._presetButtons = [];
      this._presetActive = '';
      this.initialTabId = null;
      this.profileEditorState = {
        path: '',
        meta: null,
        anchorPath: '',
        anchorToken: null,
        mode: 'simple'
      };
      this.tabMetaCache = {
        tabId: null,
        url: '',
        scriptable: null,
        ts: 0
      };
    }

    async init(initialTabId) {
      this.initialTabId = this._normalizeTabId(initialTabId);
      this._cacheElements();
      this._buildIconButtons();
      this._bind();

      this.toasts = new Ui.Toasts(this.fields.toastHost);
      await this._loadUiState();
      this._initProfileJsonViewerResize();
      this._initTabs();

      this.client = new NT.UiProtocolClient({ channelName: 'popup' });
      this.client
        .onStatus((status) => {
          this.uiStatus = status || this.uiStatus;
          this._scheduleRender();
        })
        .onSnapshot((payload) => {
          this.snapshot = PopupVm.cloneJson(payload, {}) || {};
          this._scheduleRender();
        })
        .onPatch((patch) => {
          this.snapshot = PopupVm.applyPatch(this.snapshot, patch);
          this._scheduleRender();
        });

      this.client.setHelloContext({
        ...(this.initialTabId ? { tabId: this.initialTabId } : {})
      });
      this.client.connect();
      this._scheduleRender();
    }

    _cacheElements() {
      this.fields.connectionBadge = this.doc.querySelector('[data-field="connection-badge"]');
      this.fields.connectionText = this.doc.querySelector('[data-field="connection-text"]');

      this.fields.stage = this.doc.querySelector('[data-field="stage"]');
      this.fields.progress = this.doc.querySelector('[data-field="progress"]');
      this.fields.progressDone = this.doc.querySelector('[data-field="progress-done"]');
      this.fields.progressPending = this.doc.querySelector('[data-field="progress-pending"]');
      this.fields.progressFailed = this.doc.querySelector('[data-field="progress-failed"]');
      this.fields.agentStatusLog = this.doc.querySelector('[data-field="agent-status-log"]');
      this.fields.agentDigest = this.doc.querySelector('[data-field="agent-digest"]');
      this.fields.agentLine1 = this.doc.querySelector('[data-field="agent-line-1"]');
      this.fields.agentLine2 = this.doc.querySelector('[data-field="agent-line-2"]');
      this.fields.leaseWarning = this.doc.querySelector('[data-field="lease-warning"]');

      this.fields.statusActions = this.doc.querySelector('[data-field="status-actions"]');
      this.fields.modeGroup = this.doc.querySelector('[data-field="mode-group"]');

      this.fields.categoryChooser = this.doc.querySelector('[data-section="category-chooser"]');
      this.fields.categoryChooserList = this.doc.querySelector('[data-section="category-chooser-list"]');
      this.fields.categoryQuestion = this.doc.querySelector('[data-field="category-question"]');
      this.fields.categoryActions = this.doc.querySelector('[data-field="category-actions"]');

      this.fields.profileSelect = this.doc.querySelector('[data-field="profile-select"]');
      this.fields.profileSaveName = this.doc.querySelector('[data-field="profile-save-name"]');
      this.fields.profileActions = this.doc.querySelector('[data-field="profile-actions"]');
      this.fields.profileSavedSelect = this.doc.querySelector('[data-field="profile-saved-select"]');
      this.fields.profileJsonViewer = this.doc.querySelector('[data-field="profile-json-viewer"]');
      this.fields.profileJsonActions = this.doc.querySelector('[data-field="profile-json-actions"]');
      this.fields.profilePipelineTabs = Array.from(this.doc.querySelectorAll('[data-profile-pipeline-tab]'));
      this.fields.profileLegendToggles = Array.from(this.doc.querySelectorAll('[data-action="toggle-profile-marker"]'));
      this.fields.profileJsonEditor = this.doc.querySelector('[data-field="profile-json-editor"]');
      this.fields.profileJsonEditorTitle = this.doc.querySelector('[data-field="profile-json-editor-title"]');
      this.fields.profileJsonSimpleEditor = this.doc.querySelector('[data-field="profile-json-simple-editor"]');
      this.fields.profileJsonModelsEditor = this.doc.querySelector('[data-field="profile-json-models-editor"]');
      this.fields.profileJsonEditorSelect = this.doc.querySelector('[data-field="profile-json-editor-select"]');
      this.fields.profileJsonEditorInput = this.doc.querySelector('[data-field="profile-json-editor-input"]');

      this.fields.modelSortSelect = this.doc.querySelector('[data-field="model-sort-select"]');
      this.fields.modelTableWrap = this.doc.querySelector('[data-field="model-table-wrap"]');
      this.fields.modelRows = this.doc.querySelector('[data-field="model-rows"]');
      this.fields.modelEmpty = this.doc.querySelector('[data-field="model-empty"]');
      this.fields.modelPresets = this.doc.querySelector('[data-field="model-presets"]');

      this.fields.modeByok = this.doc.querySelector('[data-field="connection-mode-byok"]');
      this.fields.modeProxy = this.doc.querySelector('[data-field="connection-mode-proxy"]');

      this.fields.byokInput = this.doc.querySelector('[data-field="byok-input"]');
      this.fields.byokStatus = this.doc.querySelector('[data-field="byok-status"]');
      this.fields.byokActions = this.doc.querySelector('[data-field="byok-actions"]');
      this.fields.byokBlock = this.doc.querySelector('[data-field="byok-block"]');

      this.fields.proxyBaseUrl = this.doc.querySelector('[data-field="proxy-base-url"]');
      this.fields.proxyHeaderName = this.doc.querySelector('[data-field="proxy-header-name"]');
      this.fields.proxyToken = this.doc.querySelector('[data-field="proxy-token"]');
      this.fields.proxyProjectId = this.doc.querySelector('[data-field="proxy-project-id"]');
      this.fields.proxyStatus = this.doc.querySelector('[data-field="proxy-status"]');
      this.fields.proxyActions = this.doc.querySelector('[data-field="proxy-actions"]');
      this.fields.proxyBlock = this.doc.querySelector('[data-field="proxy-block"]');

      this.fields.connectionActions = this.doc.querySelector('[data-field="connection-actions"]');

      this.fields.historySourceFilter = this.doc.querySelector('[data-field="history-source-filter"]');
      this.fields.historyTypeFilter = this.doc.querySelector('[data-field="history-type-filter"]');
      this.fields.historyCount = this.doc.querySelector('[data-field="history-count"]');
      this.fields.historyActions = this.doc.querySelector('[data-field="history-actions"]');
      this.fields.historyList = this.doc.querySelector('[data-field="history-list"]');
      this.fields.historyEmpty = this.doc.querySelector('[data-field="history-empty"]');

      this.fields.errorBox = this.doc.querySelector('[data-field="error-box"]');
      this.fields.errorCode = this.doc.querySelector('[data-field="error-code"]');
      this.fields.errorMessage = this.doc.querySelector('[data-field="error-message"]');
      this.fields.errorEmpty = this.doc.querySelector('[data-field="error-empty"]');
      this.fields.errorActions = this.doc.querySelector('[data-field="error-actions"]');

      this.fields.toastHost = this.doc.querySelector('[data-field="toast-host"]');
    }

    _buildIconButtons() {
      const make = (opts) => Ui.createIconButton(opts);

      const openDebugSlot = this.doc.querySelector('[data-field="open-debug-slot"]');
      if (openDebugSlot) {
        const button = make({
          icon: 'bug',
          label: I18n.t('popup.btnDebug', 'Отладка'),
          tooltip: I18n.t('tooltips.popupDebug', 'Открывает расширенную страницу отладки.'),
          attrs: {
            'data-action': 'open-debug'
          }
        });
        openDebugSlot.replaceWith(button);
      }

      Ui.clearNode(this.fields.statusActions);
      this.fields.statusActions.appendChild(make({
        icon: 'play',
        label: I18n.t('popup.btnTranslate', 'Перевести'),
        tooltip: I18n.t('tooltips.popupTranslate', 'Запускает перевод для текущей вкладки.'),
        attrs: { 'data-action': 'start-translation' }
      }));
      this.fields.statusActions.appendChild(make({
        icon: 'stop',
        label: I18n.t('popup.btnCancel', 'Отменить'),
        tooltip: I18n.t('tooltips.popupCancel', 'Останавливает текущую задачу.'),
        attrs: { 'data-action': 'cancel-translation' }
      }));
      this.fields.statusActions.appendChild(make({
        icon: 'trash',
        label: I18n.t('popup.btnErase', 'Стереть задачу и данные'),
        tooltip: I18n.t('tooltips.popupErase', 'Удаляет задачу и данные перевода для вкладки.'),
        tone: 'danger',
        attrs: { 'data-action': 'clear-translation-data' }
      }));

      Ui.clearNode(this.fields.modeGroup);
      this.fields.modeGroup.appendChild(make({
        icon: 'eyeOff',
        label: I18n.t('popup.modeOriginal', 'Оригинал'),
        tooltip: I18n.t('tooltips.modeOriginal', 'Показывать оригинальный текст страницы.'),
        attrs: { 'data-action': 'set-view-mode', 'data-mode': 'original' }
      }));
      this.fields.modeGroup.appendChild(make({
        icon: 'eye',
        label: I18n.t('popup.modeTranslated', 'Перевод'),
        tooltip: I18n.t('tooltips.modeTranslated', 'Показывать переведенный текст.'),
        attrs: { 'data-action': 'set-view-mode', 'data-mode': 'translated' }
      }));
      this.fields.modeGroup.appendChild(make({
        icon: 'copy',
        label: I18n.t('popup.modeCompare', 'Сравнение'),
        tooltip: I18n.t('tooltips.modeCompare', 'Показывать отличия оригинала и перевода.'),
        attrs: { 'data-action': 'set-view-mode', 'data-mode': 'compare' }
      }));

      Ui.clearNode(this.fields.categoryActions);
      this.fields.categoryActions.appendChild(make({
        icon: 'play',
        label: I18n.t('popup.btnStartSelected', 'Начать перевод выбранного'),
        tooltip: I18n.t('tooltips.popupStartSelected', 'Запустить перевод по выбранным категориям.'),
        attrs: { 'data-action': 'start-selected-categories' }
      }));
      this.fields.categoryActions.appendChild(make({
        icon: 'refresh',
        label: I18n.t('popup.btnReclassify', 'Пересканировать'),
        tooltip: I18n.t('tooltips.popupReclassify', 'Повторно определить категории.'),
        attrs: { 'data-action': 'reclassify-force' }
      }));
      this.fields.categoryActions.appendChild(make({
        icon: 'wand',
        label: I18n.t('popup.btnAddLater', 'Добавить позже'),
        tooltip: I18n.t('tooltips.popupAddLater', 'Отложить выбор категорий.'),
        attrs: { 'data-action': 'add-categories-later' }
      }));
      this.fields.categoryActions.appendChild(make({
        icon: 'key',
        label: I18n.t('popup.btnPickOnPage', 'Выбрать на странице'),
        tooltip: I18n.t('tooltips.popupPickOnPage', 'Открыть диалог выбора категорий прямо на переводимой странице.'),
        attrs: { 'data-action': 'choose-categories-on-page' }
      }));

      this._presetButtons = [];
      if (this.fields.modelPresets) {
        Ui.clearNode(this.fields.modelPresets);
        this._presetButtons = ['cheap', 'balanced', 'quality'].map((preset) => {
          const map = {
            cheap: I18n.t('popup.presetCheap', 'Дёшево'),
            balanced: I18n.t('popup.presetBalanced', 'Баланс'),
            quality: I18n.t('popup.presetQuality', 'Качество')
          };
          const button = make({
            icon: preset === 'quality' ? 'wand' : (preset === 'balanced' ? 'gear' : 'play'),
            label: map[preset],
            tooltip: I18n.t(`tooltips.preset${preset.charAt(0).toUpperCase()}${preset.slice(1)}`, map[preset]),
            attrs: {
              'data-action': 'apply-model-preset',
              'data-preset': preset
            },
            showLabel: true
          });
          this.fields.modelPresets.appendChild(button);
          return button;
        });
      }

      if (this.fields.profileActions) {
        Ui.clearNode(this.fields.profileActions);
        this.fields.profileActions.appendChild(make({
          icon: 'save',
          label: I18n.t('popup.btnSaveProfilePreset', 'Сохранить профиль'),
          tooltip: I18n.t('tooltips.profileSavePreset', 'Сохранить текущие userSettings как профиль.'),
          attrs: { 'data-action': 'save-profile-preset' }
        }));
        this.fields.profileActions.appendChild(make({
          icon: 'play',
          label: I18n.t('popup.btnApplyProfilePreset', 'Применить профиль'),
          tooltip: I18n.t('tooltips.profileApplyPreset', 'Применить выбранный сохраненный профиль.'),
          attrs: { 'data-action': 'apply-profile-preset' }
        }));
        this.fields.profileActions.appendChild(make({
          icon: 'trash',
          label: I18n.t('popup.btnDeleteProfilePreset', 'Удалить профиль'),
          tooltip: I18n.t('tooltips.profileDeletePreset', 'Удалить выбранный сохраненный профиль.'),
          tone: 'danger',
          attrs: { 'data-action': 'delete-profile-preset' }
        }));
      }

      Ui.clearNode(this.fields.byokActions);
      this.fields.byokActions.appendChild(make({
        icon: 'save',
        label: I18n.t('popup.btnSave', 'Сохранить'),
        tooltip: I18n.t('tooltips.byokSave', 'Сохранить BYOK ключ.'),
        attrs: { 'data-action': 'save-byok' }
      }));
      this.fields.byokActions.appendChild(make({
        icon: 'trash',
        label: I18n.t('popup.btnClear', 'Очистить'),
        tooltip: I18n.t('tooltips.byokClear', 'Удалить BYOK ключ.'),
        tone: 'danger',
        attrs: { 'data-action': 'clear-byok' }
      }));

      Ui.clearNode(this.fields.proxyActions);
      this.fields.proxyActions.appendChild(make({
        icon: 'save',
        label: I18n.t('popup.btnSave', 'Сохранить'),
        tooltip: I18n.t('tooltips.proxySave', 'Сохранить proxy-конфиг.'),
        attrs: { 'data-action': 'save-proxy' }
      }));
      this.fields.proxyActions.appendChild(make({
        icon: 'trash',
        label: I18n.t('popup.btnClear', 'Очистить'),
        tooltip: I18n.t('tooltips.proxyClear', 'Очистить proxy-конфиг.'),
        tone: 'danger',
        attrs: { 'data-action': 'clear-proxy' }
      }));

      Ui.clearNode(this.fields.connectionActions);
      this.fields.connectionActions.appendChild(make({
        icon: 'refresh',
        label: I18n.t('popup.btnTestConnection', 'Проверить соединение'),
        tooltip: I18n.t('tooltips.testConnection', 'Проверить подключение к backend.'),
        attrs: { 'data-action': 'test-connection' },
        showLabel: true
      }));

      Ui.clearNode(this.fields.profileJsonActions);
      if (this.fields.profileJsonActions) {
        this.fields.profileJsonActions.appendChild(make({
          icon: 'copy',
          label: I18n.t('popup.btnCopySettingsJson', 'Копировать JSON настроек'),
          tooltip: I18n.t('tooltips.settingsJsonCopy', 'Копирует форматированный JSON текущих настроек из snapshot.'),
          attrs: { 'data-action': 'copy-settings-json' }
        }));
      }

      Ui.clearNode(this.fields.historyActions);
      if (this.fields.historyActions) {
        this.fields.historyActions.appendChild(make({
          icon: 'copy',
          label: I18n.t('popup.btnCopyHistoryJson', 'Копировать JSON истории'),
          tooltip: I18n.t('tooltips.historyCopy', 'Копирует текущую отфильтрованную историю JSON обмена.'),
          attrs: { 'data-action': 'copy-history-json' }
        }));
      }

      Ui.clearNode(this.fields.errorActions);
      this.fields.errorActions.appendChild(make({
        icon: 'bug',
        label: I18n.t('popup.btnOpenDebugError', 'Открыть отладку'),
        tooltip: I18n.t('tooltips.popupDebug', 'Открыть расширенную страницу отладки.'),
        attrs: { 'data-action': 'open-debug-from-error' },
        showLabel: true
      }));
    }

    _bind() {
      this.root.addEventListener('click', (event) => {
        const profileEditorOpen = Boolean(this.fields.profileJsonEditor && this.fields.profileJsonEditor.hidden === false);
        if (profileEditorOpen) {
          const clickedEditorTrigger = event && event.target && typeof event.target.closest === 'function'
            ? event.target.closest('[data-action="open-profile-param-editor"]')
            : null;
          const clickedInsideEditor = Boolean(this.fields.profileJsonEditor && this.fields.profileJsonEditor.contains(event.target));
          if (!clickedEditorTrigger && !clickedInsideEditor) {
            this._closeProfileParamEditor({ silent: true });
          }
        }

        const profilePipelineTrigger = event && event.target && typeof event.target.closest === 'function'
          ? event.target.closest('[data-profile-pipeline-tab]')
          : null;
        if (profilePipelineTrigger) {
          const profileTabId = safeString(profilePipelineTrigger.getAttribute('data-profile-pipeline-tab'), '').trim();
          if (profileTabId) {
            this._activateProfilePipelineTab(profileTabId, { persist: true, rerender: true });
            return;
          }
        }

        const tabTrigger = event && event.target && typeof event.target.closest === 'function'
          ? event.target.closest('[data-tab]')
          : null;
        if (tabTrigger) {
          const tabId = safeString(tabTrigger.getAttribute('data-tab'), '').trim();
          if (tabId) {
            this._activateTab(tabId, { persist: true });
            return;
          }
        }

        const trigger = event && event.target && typeof event.target.closest === 'function'
          ? event.target.closest('[data-action]')
          : null;
        if (!trigger) {
          return;
        }
        const action = trigger.getAttribute('data-action');
        if (!action) {
          return;
        }
        this._handleAction(action, trigger).catch((error) => this._showErrorToast(error));
      });

      this.doc.addEventListener('keydown', (event) => {
        if (event && safeString(event.key, '') === 'Escape' && this.fields.profileJsonEditor && this.fields.profileJsonEditor.hidden === false) {
          event.preventDefault();
          this._closeProfileParamEditor({ silent: true });
          return;
        }

        if (event && event.target === this.fields.profileJsonEditorInput) {
          const key = safeString(event.key, '');
          if (key === 'Enter') {
            event.preventDefault();
            this._applyProfileParamEditor({
              rawValue: safeString(this.fields.profileJsonEditorInput && this.fields.profileJsonEditorInput.value, '').trim(),
              fromPreset: false,
              close: true
            });
            return;
          }
        }

        const trigger = event && event.target && typeof event.target.closest === 'function'
          ? event.target.closest('[data-action="open-profile-param-editor"]')
          : null;
        if (!trigger) {
          return;
        }
        const key = safeString(event.key, '');
        if (key !== 'Enter' && key !== ' ') {
          return;
        }
        event.preventDefault();
        this._handleAction('open-profile-param-editor', trigger).catch((error) => this._showErrorToast(error));
      });

      this.root.addEventListener('mouseover', (event) => {
        const token = event && event.target && typeof event.target.closest === 'function'
          ? event.target.closest('[data-profile-path]')
          : null;
        if (!token || !this.fields.profileJsonViewer || !this.fields.profileJsonViewer.contains(token)) {
          return;
        }
        const path = safeString(token.getAttribute('data-profile-path'), '').trim();
        if (!path) {
          return;
        }
        this._setProfilePathHover(path, true);
      });

      this.root.addEventListener('mouseout', (event) => {
        const token = event && event.target && typeof event.target.closest === 'function'
          ? event.target.closest('[data-profile-path]')
          : null;
        if (!token || !this.fields.profileJsonViewer || !this.fields.profileJsonViewer.contains(token)) {
          return;
        }
        const path = safeString(token.getAttribute('data-profile-path'), '').trim();
        if (!path) {
          return;
        }
        const next = event && event.relatedTarget && typeof event.relatedTarget.closest === 'function'
          ? event.relatedTarget.closest('[data-profile-path]')
          : null;
        if (next && this.fields.profileJsonViewer.contains(next)) {
          const nextPath = safeString(next.getAttribute('data-profile-path'), '').trim();
          if (nextPath === path) {
            return;
          }
        }
        this._setProfilePathHover(path, false);
      });

      this.root.addEventListener('input', (event) => {
        const target = event && event.target ? event.target : null;
        if (!target || !target.getAttribute) {
          return;
        }

        if (target === this.fields.byokInput) {
          this.credentialsDraft.byokKey = safeString(target.value, '');
          return;
        }
        if (target === this.fields.proxyBaseUrl) {
          this.credentialsDraft.proxyBaseUrl = safeString(target.value, '');
          this.formTouched.proxyBaseUrl = true;
          return;
        }
        if (target === this.fields.proxyHeaderName) {
          this.credentialsDraft.proxyHeaderName = safeString(target.value, '');
          this.formTouched.proxyHeaderName = true;
          return;
        }
        if (target === this.fields.proxyToken) {
          this.credentialsDraft.proxyToken = safeString(target.value, '');
          return;
        }
        if (target === this.fields.proxyProjectId) {
          this.credentialsDraft.proxyProjectId = safeString(target.value, '');
          this.formTouched.proxyProjectId = true;
          return;
        }
        if (target === this.fields.profileJsonEditorInput) {
          this._syncProfileEditorControls();
        }
      });

      this.root.addEventListener('change', (event) => {
        const target = event && event.target ? event.target : null;
        if (!target || !target.getAttribute) {
          return;
        }

        if (target === this.fields.profileSelect) {
          this._applyProfileSelection(safeString(target.value, 'minimal'));
          return;
        }
        if (target === this.fields.profileSavedSelect) {
          const selectedSavedProfile = safeString(target.value, '').trim();
          this._saveUiState({ selectedSavedProfile });
          return;
        }
        if (target === this.fields.modelSortSelect) {
          const modelSort = normalizeModelSort(target.value);
          this.uiState.modelSort = modelSort;
          this._saveUiState({ modelSort });
          this._renderAllowlist();
          return;
        }
        if (target === this.fields.historySourceFilter) {
          const historySourceFilter = normalizeHistorySource(target.value);
          this.uiState.historySourceFilter = historySourceFilter;
          this._saveUiState({ historySourceFilter });
          this._renderHistory();
          return;
        }
        if (target === this.fields.historyTypeFilter) {
          const historyTypeFilter = normalizeHistoryType(target.value);
          this.uiState.historyTypeFilter = historyTypeFilter;
          this._saveUiState({ historyTypeFilter });
          this._renderHistory();
          return;
        }
        if (target === this.fields.modeByok && target.checked) {
          this._setConnectionMode('BYOK');
          return;
        }
        if (target === this.fields.modeProxy && target.checked) {
          this._setConnectionMode('PROXY');
          return;
        }
        if (target === this.fields.profileJsonEditorSelect) {
          this._handleProfileEditorSelectChange();
          return;
        }
        if (target === this.fields.profileJsonEditorInput) {
          this._applyProfileParamEditor({
            rawValue: safeString(target.value, '').trim(),
            fromPreset: false,
            close: true
          });
          return;
        }

        const categoryToggle = target.getAttribute('data-category-toggle');
        if (categoryToggle) {
          const categoryId = safeString(categoryToggle, '').trim().toLowerCase();
          if (!categoryId) {
            return;
          }
          if (target.checked) {
            this.categoryDraft.add(categoryId);
          } else {
            this.categoryDraft.delete(categoryId);
          }
          this.categoryDraftTouched = true;
          this._renderButtonsState();
          return;
        }

        const modelToggle = target.getAttribute('data-model-spec');
        if (modelToggle) {
          this._applyAllowlistFromUi();
        }
      });
    }

    async _loadUiState() {
      if (!this.uiStateStore || typeof this.uiStateStore.getPopupState !== 'function') {
        return;
      }
      try {
        const state = await this.uiStateStore.getPopupState();
        const next = state && typeof state === 'object' ? state : {};
        const activeTab = safeString(next.activeTab || '', '').trim().toLowerCase();
        const savedProfiles = this._sanitizeSavedProfiles(next.savedProfiles);
        const selectedSavedProfile = safeString(next.selectedSavedProfile, '').trim();
        this.uiState = {
          ...this.uiState,
          ...next,
          activeTab: POPUP_TABS.includes(activeTab) ? activeTab : this.uiState.activeTab,
          modelSort: normalizeModelSort(next.modelSort || this.uiState.modelSort),
          profilePipelineTab: normalizeProfilePipelineTab(next.profilePipelineTab || this.uiState.profilePipelineTab),
          profileJsonHeight: normalizeProfileJsonHeight(next.profileJsonHeight || this.uiState.profileJsonHeight),
          profileMarkerVisibility: normalizeProfileMarkerVisibility(next.profileMarkerVisibility || this.uiState.profileMarkerVisibility),
          historySourceFilter: normalizeHistorySource(next.historySourceFilter || this.uiState.historySourceFilter),
          historyTypeFilter: normalizeHistoryType(next.historyTypeFilter || this.uiState.historyTypeFilter),
          savedProfiles,
          selectedSavedProfile: Object.prototype.hasOwnProperty.call(savedProfiles, selectedSavedProfile)
            ? selectedSavedProfile
            : ''
        };
      } catch (_) {
        // keep defaults
      }
    }

    _saveUiState(patch) {
      const source = patch && typeof patch === 'object' ? patch : {};
      const nextProfileMarkerVisibility = Object.prototype.hasOwnProperty.call(source, 'profileMarkerVisibility')
        ? normalizeProfileMarkerVisibility({
          ...(this.uiState.profileMarkerVisibility || {}),
          ...(source.profileMarkerVisibility && typeof source.profileMarkerVisibility === 'object'
            ? source.profileMarkerVisibility
            : {})
        })
        : normalizeProfileMarkerVisibility(this.uiState.profileMarkerVisibility);
      this.uiState = {
        ...this.uiState,
        ...source,
        modelSort: normalizeModelSort((source.modelSort || this.uiState.modelSort)),
        profilePipelineTab: normalizeProfilePipelineTab(source.profilePipelineTab || this.uiState.profilePipelineTab),
        profileJsonHeight: normalizeProfileJsonHeight(source.profileJsonHeight || this.uiState.profileJsonHeight),
        profileMarkerVisibility: nextProfileMarkerVisibility,
        historySourceFilter: normalizeHistorySource(source.historySourceFilter || this.uiState.historySourceFilter),
        historyTypeFilter: normalizeHistoryType(source.historyTypeFilter || this.uiState.historyTypeFilter)
      };
      if (!this.uiStateStore || typeof this.uiStateStore.setPopupState !== 'function') {
        return;
      }
      const storePatch = { ...source };
      if (Object.prototype.hasOwnProperty.call(source, 'activeTab')) {
        storePatch.activeTab = this.uiState.activeTab;
      }
      if (Object.prototype.hasOwnProperty.call(source, 'modelSort')) {
        storePatch.modelSort = this.uiState.modelSort;
      }
      if (Object.prototype.hasOwnProperty.call(source, 'profilePipelineTab')) {
        storePatch.profilePipelineTab = this.uiState.profilePipelineTab;
      }
      if (Object.prototype.hasOwnProperty.call(source, 'profileJsonHeight')) {
        storePatch.profileJsonHeight = this.uiState.profileJsonHeight;
      }
      if (Object.prototype.hasOwnProperty.call(source, 'profileMarkerVisibility')) {
        storePatch.profileMarkerVisibility = normalizeProfileMarkerVisibility(this.uiState.profileMarkerVisibility);
      }
      if (Object.prototype.hasOwnProperty.call(source, 'historySourceFilter')) {
        storePatch.historySourceFilter = this.uiState.historySourceFilter;
      }
      if (Object.prototype.hasOwnProperty.call(source, 'historyTypeFilter')) {
        storePatch.historyTypeFilter = this.uiState.historyTypeFilter;
      }
      if (Object.prototype.hasOwnProperty.call(source, 'savedProfiles')) {
        storePatch.savedProfiles = this._sanitizeSavedProfiles(this.uiState.savedProfiles);
      }
      if (Object.prototype.hasOwnProperty.call(source, 'selectedSavedProfile')) {
        storePatch.selectedSavedProfile = safeString(this.uiState.selectedSavedProfile, '').trim();
      }
      if (Object.prototype.hasOwnProperty.call(source, 'profileJsonHeight')) {
        this._applyProfileJsonViewerHeight();
      }
      this.uiStateStore.setPopupState(storePatch).catch(() => {});
    }

    _sanitizeSavedProfiles(input) {
      const src = input && typeof input === 'object' ? input : {};
      const out = {};
      Object.keys(src).slice(0, 40).forEach((rawName) => {
        const name = safeString(rawName, '').trim().slice(0, 64);
        if (!name) {
          return;
        }
        const userSettings = src[rawName];
        if (!userSettings || typeof userSettings !== 'object') {
          return;
        }
        out[name] = cloneJson(userSettings, {});
      });
      return out;
    }

    _applyProfileJsonViewerHeight() {
      if (!this.fields.profileJsonViewer) {
        return;
      }
      const height = normalizeProfileJsonHeight(this.uiState.profileJsonHeight);
      this.uiState.profileJsonHeight = height;
      this._profileJsonSizeSyncing = true;
      this.fields.profileJsonViewer.style.height = `${height}px`;
      this._profileJsonSizeSyncing = false;
    }

    _initProfileJsonViewerResize() {
      if (!this.fields.profileJsonViewer) {
        return;
      }
      this._applyProfileJsonViewerHeight();
      if (this._profileJsonResizeObserver && typeof this._profileJsonResizeObserver.disconnect === 'function') {
        this._profileJsonResizeObserver.disconnect();
      }
      if (typeof global.ResizeObserver !== 'function') {
        return;
      }
      this._profileJsonResizeObserver = new global.ResizeObserver((entries) => {
        if (!Array.isArray(entries) || !entries.length || this._profileJsonSizeSyncing) {
          return;
        }
        const first = entries[0];
        const contentRect = first && first.contentRect ? first.contentRect : null;
        if (!contentRect) {
          return;
        }
        const next = normalizeProfileJsonHeight(contentRect.height);
        if (Math.abs(next - this.uiState.profileJsonHeight) < 2) {
          return;
        }
        this._saveUiState({ profileJsonHeight: next });
      });
      this._profileJsonResizeObserver.observe(this.fields.profileJsonViewer);
    }

    _initTabs() {
      this.tabs = new Ui.TabsController(this.root, {
        defaultTab: this.uiState.activeTab || 'status',
        onChange: (tabId) => {
          this._activateTab(tabId, { persist: true, syncController: false });
        }
      });
      this._activateTab(this.uiState.activeTab || 'status', { persist: false, syncController: true });
    }

    _normalizeTabId(value) {
      const num = Number(value);
      if (!Number.isFinite(num)) {
        return null;
      }
      const rounded = Math.floor(num);
      return rounded > 0 ? rounded : null;
    }

    _getTargetTabId() {
      const initial = this._normalizeTabId(this.initialTabId);
      if (initial) {
        return initial;
      }
      const vmTabId = this._normalizeTabId(this.vm && this.vm.tabId);
      if (vmTabId) {
        return vmTabId;
      }
      const snapshotTabId = this._normalizeTabId(this.snapshot && this.snapshot.tabId);
      if (snapshotTabId) {
        return snapshotTabId;
      }
      return null;
    }

    _setActionTabContext(tabId) {
      const normalized = this._normalizeTabId(tabId);
      if (!normalized) {
        return null;
      }
      this.initialTabId = normalized;
      if (this.client && typeof this.client.setHelloContext === 'function') {
        this.client.setHelloContext({ tabId: normalized });
      }
      if (this.uiModule && typeof this.uiModule.setHelloContext === 'function') {
        this.uiModule.setHelloContext({ tabId: normalized });
      }
      return normalized;
    }

    async _queryActiveTabId() {
      if (!global.chrome || !global.chrome.tabs || typeof global.chrome.tabs.query !== 'function') {
        return null;
      }
      return new Promise((resolve) => {
        try {
          global.chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            const first = Array.isArray(tabs) && tabs.length ? tabs[0] : null;
            resolve(this._normalizeTabId(first && first.id));
          });
        } catch (_) {
          resolve(null);
        }
      });
    }

    async _resolveActionTabId() {
      const known = this._getTargetTabId();
      if (known) {
        return this._setActionTabContext(known);
      }
      const active = await this._queryActiveTabId();
      if (active) {
        return this._setActionTabContext(active);
      }
      return null;
    }

    async _requireActionTabId() {
      const tabId = await this._resolveActionTabId();
      if (tabId) {
        return tabId;
      }
      this.toasts.show('Не удалось определить активную вкладку.', { tone: 'warn' });
      return null;
    }

    _isScriptableTabUrl(url) {
      const value = safeString(url, '').trim().toLowerCase();
      if (!value) {
        return true;
      }
      const blockedPrefixes = [
        'chrome://',
        'edge://',
        'about:',
        'chrome-extension://',
        'edge-extension://',
        'moz-extension://',
        'devtools://',
        'view-source:'
      ];
      return !blockedPrefixes.some((prefix) => value.startsWith(prefix));
    }

    async _ensureTabScriptable(tabId) {
      const normalized = this._normalizeTabId(tabId);
      if (!normalized) {
        return false;
      }
      if (
        this.tabMetaCache.tabId === normalized
        && this.tabMetaCache.scriptable !== null
        && (Date.now() - Number(this.tabMetaCache.ts || 0)) < 2500
      ) {
        return this.tabMetaCache.scriptable === true;
      }
      if (!global.chrome || !global.chrome.tabs || typeof global.chrome.tabs.get !== 'function') {
        return true;
      }
      return new Promise((resolve) => {
        try {
          global.chrome.tabs.get(normalized, (tab) => {
            const url = safeString(tab && tab.url, '');
            const scriptable = this._isScriptableTabUrl(url);
            this.tabMetaCache = {
              tabId: normalized,
              url,
              scriptable,
              ts: Date.now()
            };
            resolve(scriptable);
          });
        } catch (_) {
          resolve(true);
        }
      });
    }

    _activateTab(tabId, { persist = true, syncController = true } = {}) {
      const key = safeString(tabId, '').trim();
      if (!POPUP_TABS.includes(key)) {
        return;
      }
      this.uiState.activeTab = key;
      if (syncController && this.tabs && typeof this.tabs.setActive === 'function') {
        this.tabs.setActive(key, { emit: false, fromHash: false });
      }
      this._ensureTabVisibility();
      if (persist) {
        this._saveUiState({ activeTab: key });
      }
    }

    _ensureTabVisibility() {
      const active = safeString(this.uiState.activeTab, 'status');
      const panels = this.root.querySelectorAll('[data-tab-panel]');
      panels.forEach((panel) => {
        const panelId = safeString(panel.getAttribute('data-tab-panel'), '');
        panel.hidden = panelId !== active;
      });
      const tabs = this.root.querySelectorAll('[data-tab]');
      tabs.forEach((tab) => {
        const tabId = safeString(tab.getAttribute('data-tab'), '');
        const isActive = tabId === active;
        tab.classList.toggle('is-active', isActive);
        tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
      });
    }

    _activateProfilePipelineTab(tabId, { persist = true, rerender = false } = {}) {
      const key = normalizeProfilePipelineTab(tabId);
      const changed = this.uiState.profilePipelineTab !== key;
      this.uiState.profilePipelineTab = key;
      this._renderProfilePipelineTabs();
      if (persist) {
        this._saveUiState({ profilePipelineTab: key });
      }
      if (rerender || changed) {
        const fullSnapshot = this._buildProfileSettingsSnapshot();
        const filtered = this._buildProfileSnapshotForPipelineTab(fullSnapshot);
        this._renderProfileJsonViewer(filtered);
      }
    }

    _renderProfilePipelineTabs() {
      const tabs = Array.isArray(this.fields.profilePipelineTabs) ? this.fields.profilePipelineTabs : [];
      if (!tabs.length) {
        return;
      }
      const active = normalizeProfilePipelineTab(this.uiState.profilePipelineTab);
      tabs.forEach((tab) => {
        const tabId = normalizeProfilePipelineTab(tab.getAttribute('data-profile-pipeline-tab'));
        const meta = this._profilePipelineTabMeta(tabId);
        const isActive = tabId === active;
        tab.classList.toggle('is-active', isActive);
        tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
        tab.textContent = meta.label;
        tab.setAttribute('title', meta.tooltip);
        tab.setAttribute('data-tooltip', meta.tooltip);
        tab.setAttribute('aria-label', `${meta.label}. ${meta.tooltip}`);
      });
    }

    async _handleAction(action, trigger) {
      if (action === 'open-debug' || action === 'open-debug-from-error') {
        this._openDebugPage('overview');
        return;
      }

      if (action === 'start-translation') {
        const tabId = await this._requireActionTabId();
        if (!tabId) {
          return;
        }
        const scriptable = await this._ensureTabScriptable(tabId);
        if (!scriptable) {
          this.toasts.show(
            I18n.t('popup.errorUnscriptableTab', 'Эту вкладку нельзя переводить (служебная страница браузера или магазина расширений).'),
            { tone: 'warn' }
          );
          return;
        }
        if (this.vm.awaitingCategories) {
          await this._applyCategorySelection(tabId);
          return;
        }
        await this._sendCommand(UiProtocol.Commands ? UiProtocol.Commands.START_TRANSLATION : 'START_TRANSLATION', {
          tabId,
          targetLang: 'ru'
        });
        return;
      }

      if (action === 'cancel-translation') {
        const tabId = await this._requireActionTabId();
        if (!tabId) {
          return;
        }
        await this._sendCommand(UiProtocol.Commands ? UiProtocol.Commands.CANCEL_TRANSLATION : 'CANCEL_TRANSLATION', {
          tabId
        });
        await this._sendCommand(UiProtocol.Commands ? UiProtocol.Commands.KICK_SCHEDULER : 'KICK_SCHEDULER', {
          tabId
        }, { timeoutMs: 2200, retries: 0 }).catch(() => null);
        this.toasts.show('Запрос на отмену отправлен.', { tone: 'info' });
        return;
      }

      if (action === 'clear-translation-data') {
        const tabId = await this._requireActionTabId();
        if (!tabId) {
          return;
        }
        await this._sendCommand(UiProtocol.Commands ? UiProtocol.Commands.CLEAR_TRANSLATION_DATA : 'CLEAR_TRANSLATION_DATA', {
          tabId,
          includeCache: true
        });
        await this._sendCommand(UiProtocol.Commands ? UiProtocol.Commands.KICK_SCHEDULER : 'KICK_SCHEDULER', {
          tabId
        }, { timeoutMs: 2200, retries: 0 }).catch(() => null);
        this.toasts.show('Запрошена очистка задачи и данных.', { tone: 'info' });
        return;
      }

      if (action === 'set-view-mode') {
        const tabId = await this._requireActionTabId();
        if (!tabId) {
          return;
        }
        const mode = trigger && trigger.getAttribute
          ? safeString(trigger.getAttribute('data-mode'), 'translated')
          : 'translated';
        if ((mode === 'translated' || mode === 'compare') && !this._canUseTranslatedModes()) {
          this.toasts.show(
            I18n.t(
              'popup.viewModeLocked',
              'Режим доступен после старта перевода или когда есть готовые переведенные блоки.'
            ),
            { tone: 'warn' }
          );
          return;
        }
        await this._sendCommand(UiProtocol.Commands ? UiProtocol.Commands.SET_TRANSLATION_VISIBILITY : 'SET_TRANSLATION_VISIBILITY', {
          tabId,
          mode,
          visible: mode !== 'original'
        });
        return;
      }

      if (action === 'start-selected-categories') {
        await this._applyCategorySelection();
        return;
      }

      if (action === 'reclassify-force') {
        const tabId = await this._requireActionTabId();
        if (!tabId) {
          return;
        }
        await this._sendCommand(UiProtocol.Commands ? UiProtocol.Commands.RECLASSIFY_BLOCKS : 'RECLASSIFY_BLOCKS', {
          tabId,
          jobId: this.vm.job && this.vm.job.id ? this.vm.job.id : null,
          force: true
        });
        this.toasts.show('Классификация обновлена.', { tone: 'ok' });
        return;
      }

      if (action === 'add-categories-later') {
        this.toasts.show('Категории можно выбрать позже.', { tone: 'info' });
        return;
      }

      if (action === 'choose-categories-on-page') {
        await this._chooseCategoriesOnPage();
        return;
      }

      if (action === 'apply-model-preset') {
        const preset = trigger && trigger.getAttribute ? trigger.getAttribute('data-preset') : '';
        this._applyModelPreset(preset);
        return;
      }

      if (action === 'save-profile-preset') {
        this._saveCurrentProfilePreset();
        return;
      }

      if (action === 'apply-profile-preset') {
        this._applySelectedProfilePreset();
        return;
      }

      if (action === 'delete-profile-preset') {
        this._deleteSelectedProfilePreset();
        return;
      }

      if (action === 'open-profile-param-editor') {
        const key = trigger && trigger.getAttribute
          ? safeString(trigger.getAttribute('data-param-key'), '').trim()
          : '';
        if (key) {
          this._openProfileParamEditor(key, trigger || null);
        }
        return;
      }

      if (action === 'toggle-profile-marker') {
        const marker = trigger && trigger.getAttribute
          ? safeString(trigger.getAttribute('data-marker'), '').trim().toLowerCase()
          : '';
        if (marker === 'user' || marker === 'agent' || marker === 'profile') {
          this._toggleProfileMarker(marker);
        }
        return;
      }

      if (action === 'apply-profile-param-edit') {
        this._applyProfileParamEditor();
        return;
      }

      if (action === 'cancel-profile-param-edit') {
        this._closeProfileParamEditor();
        return;
      }

      if (action === 'copy-settings-json') {
        this._copySettingsJsonToClipboard();
        return;
      }

      if (action === 'copy-history-json') {
        this._copyHistoryJsonToClipboard();
        return;
      }

      if (action === 'copy-history-row') {
        this._copyHistoryRowToClipboard(trigger);
        return;
      }

      if (action === 'toggle-byok-visibility') {
        this.uiState.byokVisible = !this.uiState.byokVisible;
        this._saveUiState({ byokVisible: this.uiState.byokVisible });
        this._renderPasswordToggles();
        return;
      }

      if (action === 'toggle-proxy-visibility') {
        this.uiState.proxyVisible = !this.uiState.proxyVisible;
        this._saveUiState({ proxyVisible: this.uiState.proxyVisible });
        this._renderPasswordToggles();
        return;
      }

      if (action === 'save-byok') {
        await this._saveByok();
        return;
      }

      if (action === 'clear-byok') {
        await this._clearByok();
        return;
      }

      if (action === 'save-proxy') {
        await this._saveProxy();
        return;
      }

      if (action === 'clear-proxy') {
        await this._clearProxy();
        return;
      }

      if (action === 'test-connection') {
        await this._testConnection();
      }
    }

    async _saveByok() {
      const key = safeString(this.credentialsDraft.byokKey, '').trim();
      if (!key) {
        this.toasts.show('Введите BYOK ключ.', { tone: 'warn' });
        return;
      }
      if (this.uiModule && typeof this.uiModule.saveByokKey === 'function') {
        this.uiModule.saveByokKey({ key, persist: true });
      } else {
        await this._sendCommand(UiProtocol.Commands ? UiProtocol.Commands.SAVE_BYOK_KEY : 'SAVE_BYOK_KEY', {
          key,
          persist: true
        });
      }
      this.credentialsDraft.byokKey = '';
      if (this.fields.byokInput) {
        this.fields.byokInput.value = '';
      }
      this.toasts.show('BYOK ключ сохранен.', { tone: 'ok' });
    }

    async _clearByok() {
      if (this.uiModule && typeof this.uiModule.clearByokKey === 'function') {
        this.uiModule.clearByokKey();
      } else {
        await this._sendCommand(UiProtocol.Commands ? UiProtocol.Commands.CLEAR_BYOK_KEY : 'CLEAR_BYOK_KEY', {});
      }
      this.credentialsDraft.byokKey = '';
      if (this.fields.byokInput) {
        this.fields.byokInput.value = '';
      }
      this.toasts.show('BYOK ключ очищен.', { tone: 'info' });
    }

    async _saveProxy() {
      const payload = {
        baseUrl: safeString(this.credentialsDraft.proxyBaseUrl, '').trim(),
        authHeaderName: safeString(this.credentialsDraft.proxyHeaderName, '').trim() || 'X-NT-Token',
        authToken: safeString(this.credentialsDraft.proxyToken, ''),
        projectId: safeString(this.credentialsDraft.proxyProjectId, '').trim(),
        persistToken: true
      };
      if (!payload.baseUrl) {
        this.toasts.show('Укажите proxy base URL.', { tone: 'warn' });
        return;
      }
      if (this.uiModule && typeof this.uiModule.saveProxyConfig === 'function') {
        this.uiModule.saveProxyConfig(payload);
      } else {
        await this._sendCommand(UiProtocol.Commands ? UiProtocol.Commands.SAVE_PROXY_CONFIG : 'SAVE_PROXY_CONFIG', payload);
      }
      this.credentialsDraft.proxyToken = '';
      if (this.fields.proxyToken) {
        this.fields.proxyToken.value = '';
      }
      this.formTouched.proxyBaseUrl = false;
      this.formTouched.proxyHeaderName = false;
      this.formTouched.proxyProjectId = false;
      this.toasts.show('Прокси-конфиг сохранен.', { tone: 'ok' });
    }

    async _clearProxy() {
      if (this.uiModule && typeof this.uiModule.clearProxyConfig === 'function') {
        this.uiModule.clearProxyConfig();
      } else {
        await this._sendCommand(UiProtocol.Commands ? UiProtocol.Commands.CLEAR_PROXY_CONFIG : 'CLEAR_PROXY_CONFIG', {});
      }
      this.credentialsDraft.proxyToken = '';
      if (this.fields.proxyToken) {
        this.fields.proxyToken.value = '';
      }
      this.toasts.show('Прокси-конфиг очищен.', { tone: 'info' });
    }

    async _testConnection() {
      if (this.uiModule && typeof this.uiModule.testConnection === 'function') {
        this.uiModule.testConnection({ timeoutMs: 12000 });
      } else {
        await this._sendCommand(UiProtocol.Commands ? UiProtocol.Commands.BG_TEST_CONNECTION : 'BG_TEST_CONNECTION', { timeoutMs: 12000 });
      }
      this.toasts.show('Проверка соединения запущена.', { tone: 'info' });
    }

    async _setConnectionMode(mode) {
      const normalized = String(mode || '').toUpperCase() === 'BYOK' ? 'BYOK' : 'PROXY';
      if (this.uiModule && typeof this.uiModule.setConnectionMode === 'function') {
        this.uiModule.setConnectionMode(normalized);
      } else {
        await this._sendCommand(UiProtocol.Commands ? UiProtocol.Commands.SET_CONNECTION_MODE : 'SET_CONNECTION_MODE', {
          mode: normalized
        });
      }
      this.toasts.show(`Режим соединения: ${normalized}.`, { tone: 'info' });
    }

    _applyModelPreset(preset) {
      if (!this.fields.modelRows) {
        return;
      }
      const models = this._modelRows().filter((row) => row.available);
      if (!models.length) {
        return;
      }
      const nextSet = new Set();
      const priced = models
        .filter((row) => Number.isFinite(Number(row.inputPrice)) && Number.isFinite(Number(row.outputPrice)))
        .slice();

      if (preset === 'cheap') {
        priced.sort((a, b) => Number(a.sum_1M || Infinity) - Number(b.sum_1M || Infinity));
        priced.slice(0, 8).forEach((row) => nextSet.add(row.spec || modelSpec(row)));
      } else if (preset === 'quality') {
        models
          .slice()
          .sort((a, b) => {
            const rankA = Number.isFinite(Number(a.capabilityRank)) ? Number(a.capabilityRank) : 0;
            const rankB = Number.isFinite(Number(b.capabilityRank)) ? Number(b.capabilityRank) : 0;
            if (rankA !== rankB) {
              return rankB - rankA;
            }
            return Number(b.outputPrice || 0) - Number(a.outputPrice || 0);
          })
          .slice(0, 8)
          .forEach((row) => nextSet.add(row.spec || modelSpec(row)));
      } else {
        models
          .slice()
          .sort((a, b) => {
            const rankA = Number.isFinite(Number(a.capabilityRank)) ? Number(a.capabilityRank) : 0;
            const rankB = Number.isFinite(Number(b.capabilityRank)) ? Number(b.capabilityRank) : 0;
            if (rankA !== rankB) {
              return rankB - rankA;
            }
            const priceA = Number.isFinite(Number(a.sum_1M)) ? Number(a.sum_1M) : 9999;
            const priceB = Number.isFinite(Number(b.sum_1M)) ? Number(b.sum_1M) : 9999;
            return priceA - priceB;
          })
          .filter((row) => Number(row.outputPrice || 0) <= 40)
          .slice(0, 8)
          .forEach((row) => nextSet.add(row.spec || modelSpec(row)));
      }

      if (!nextSet.size) {
        models.slice(0, 5).forEach((row) => nextSet.add(row.spec || modelSpec(row)));
      }

      const checkboxes = this.fields.modelRows
        ? Array.from(this.fields.modelRows.querySelectorAll('input[data-model-spec]'))
        : [];
      checkboxes.forEach((input) => {
        const spec = safeString(input.getAttribute('data-model-spec'), '');
        input.checked = nextSet.has(spec);
      });

      this._presetActive = preset;
      this._renderPresetState();
      this._applyAllowlistFromUi();
    }

    _renderPresetState() {
      this._presetButtons.forEach((button) => {
        const preset = safeString(button.getAttribute('data-preset'), '');
        if (preset === this._presetActive) {
          button.classList.add('is-active');
        } else {
          button.classList.remove('is-active');
        }
      });
    }

    _policyShapeFromPreset(preset) {
      const key = normalizeModelPriorityPreset(preset);
      if (key === 'cheap') {
        return { speed: false, preference: 'cheapest' };
      }
      if (key === 'expensive') {
        return { speed: false, preference: 'smartest' };
      }
      if (key === 'smart_cheap') {
        return { speed: false, preference: 'smartest' };
      }
      if (key === 'smart_fast') {
        return { speed: true, preference: 'smartest' };
      }
      if (key === 'cheap_fast') {
        return { speed: true, preference: 'cheapest' };
      }
      return { speed: true, preference: null };
    }

    _presetFromPolicy(policy) {
      const src = policy && typeof policy === 'object' ? policy : {};
      const speed = src.speed !== false;
      const preference = src.preference === 'smartest' || src.preference === 'cheapest'
        ? src.preference
        : null;
      if (preference === 'cheapest' && speed) {
        return 'cheap_fast';
      }
      if (preference === 'cheapest' && !speed) {
        return 'cheap';
      }
      if (preference === 'smartest' && speed) {
        return 'smart_fast';
      }
      if (preference === 'smartest' && !speed) {
        return 'expensive';
      }
      if (!preference && speed) {
        return 'optimal';
      }
      if (!preference && !speed) {
        return 'smart_cheap';
      }
      return 'custom';
    }

    _orderedAllowlistByPreset(preset) {
      const key = normalizeModelPriorityPreset(preset);
      const rows = this._modelRows().filter((row) => row && row.available === true);
      const rowBySpec = new Map(rows.map((row) => [safeString(row.spec, ''), row]));
      const selectedAllowlist = this._selectedAllowlist();
      const base = selectedAllowlist.length
        ? selectedAllowlist.filter((spec) => rowBySpec.has(spec))
        : rows.map((row) => safeString(row.spec, '')).filter(Boolean);
      if (!base.length) {
        return [];
      }
      const withScore = base.map((spec) => {
        const row = rowBySpec.get(spec) || {};
        return {
          spec,
          cap: Number.isFinite(Number(row.capabilityRank)) ? Number(row.capabilityRank) : 0,
          inPrice: Number.isFinite(Number(row.inputPrice)) ? Number(row.inputPrice) : Infinity,
          outPrice: Number.isFinite(Number(row.outputPrice)) ? Number(row.outputPrice) : Infinity,
          sumPrice: Number.isFinite(Number(row.sum_1M))
            ? Number(row.sum_1M)
            : (
              (Number.isFinite(Number(row.inputPrice)) ? Number(row.inputPrice) : Infinity)
              + (Number.isFinite(Number(row.outputPrice)) ? Number(row.outputPrice) : Infinity)
            ),
          speedRank: modelTierSpeedRank(spec)
        };
      });
      const sorted = withScore.slice();
      if (key === 'cheap') {
        sorted.sort((a, b) => (a.sumPrice - b.sumPrice) || a.spec.localeCompare(b.spec));
      } else if (key === 'expensive') {
        sorted.sort((a, b) => (b.cap - a.cap) || (b.sumPrice - a.sumPrice) || a.spec.localeCompare(b.spec));
      } else if (key === 'smart_cheap') {
        sorted.sort((a, b) => (b.cap - a.cap) || (a.sumPrice - b.sumPrice) || a.spec.localeCompare(b.spec));
      } else if (key === 'smart_fast') {
        sorted.sort((a, b) => (b.cap - a.cap) || (a.speedRank - b.speedRank) || (a.sumPrice - b.sumPrice) || a.spec.localeCompare(b.spec));
      } else if (key === 'cheap_fast') {
        sorted.sort((a, b) => (a.speedRank - b.speedRank) || (a.sumPrice - b.sumPrice) || a.spec.localeCompare(b.spec));
      } else if (key === 'optimal') {
        sorted.sort((a, b) => (b.cap - a.cap) || (a.sumPrice - b.sumPrice) || (a.speedRank - b.speedRank) || a.spec.localeCompare(b.spec));
      } else {
        return base.slice();
      }
      return sorted.map((row) => row.spec);
    }

    _deriveRolePresetSummary() {
      const settings = this.vm.settings && typeof this.vm.settings === 'object' ? this.vm.settings : {};
      const modelSelection = settings.modelSelection && typeof settings.modelSelection === 'object'
        ? settings.modelSelection
        : {};
      const modelPolicy = settings.translationAgentModelPolicy && typeof settings.translationAgentModelPolicy === 'object'
        ? settings.translationAgentModelPolicy
        : {};
      const tuning = settings.translationAgentTuning && typeof settings.translationAgentTuning === 'object'
        ? settings.translationAgentTuning
        : {};
      const contextTokens = Number.isFinite(Number(tuning.plannerMaxOutputTokens))
        ? Number(tuning.plannerMaxOutputTokens)
        : 2200;
      const contextParallel = safeString(tuning.parallelismOverride, 'auto').trim().toLowerCase();
      const compressionThreshold = Number.isFinite(Number(tuning.compressionThreshold))
        ? Number(tuning.compressionThreshold)
        : 80;
      const contextLimit = Number.isFinite(Number(tuning.contextFootprintLimit))
        ? Number(tuning.contextFootprintLimit)
        : 9000;
      const proofPasses = Number.isFinite(Number(tuning.proofreadingPassesOverride))
        ? Number(tuning.proofreadingPassesOverride)
        : null;

      let contextPreset = 'optimal';
      if (contextParallel === 'low' || contextTokens <= 1600) {
        contextPreset = 'cheap_fast';
      } else if (contextParallel === 'high' || contextTokens >= 3200) {
        contextPreset = 'expensive';
      }

      let compactionPreset = 'optimal';
      if (compressionThreshold <= 60 || contextLimit <= 6500) {
        compactionPreset = 'cheap_fast';
      } else if (compressionThreshold >= 140 || contextLimit >= 14000) {
        compactionPreset = 'expensive';
      }

      let proofreadingPreset = this._presetFromPolicy(modelPolicy);
      if (proofPasses === 0) {
        proofreadingPreset = 'cheap';
      } else if (proofPasses >= 2) {
        proofreadingPreset = 'expensive';
      } else if (proofPasses === 1) {
        proofreadingPreset = 'optimal';
      }

      return {
        agent: this._presetFromPolicy(modelSelection),
        translation: this._presetFromPolicy(modelPolicy),
        context: contextPreset,
        compaction: compactionPreset,
        proofreading: proofreadingPreset
      };
    }

    _buildRolePresetPatch(role, preset) {
      const normalizedRole = MODEL_PRIORITY_ROLE_IDS.includes(role) ? role : '';
      const normalizedPreset = normalizeModelPriorityPreset(preset);
      if (!normalizedRole || !MODEL_PRIORITY_PRESET_IDS.includes(normalizedPreset) || normalizedPreset === 'custom') {
        return null;
      }
      const policy = this._policyShapeFromPreset(normalizedPreset);
      const orderedAllowlist = this._orderedAllowlistByPreset(normalizedPreset);
      if (normalizedRole === 'agent') {
        return {
          modelSelection: {
            speed: policy.speed,
            preference: policy.preference
          },
          translationAgentModelPolicy: {
            mode: 'fixed',
            speed: policy.speed,
            preference: policy.preference,
            allowRouteOverride: true
          }
        };
      }
      if (normalizedRole === 'translation') {
        return {
          userSettings: {
            models: {
              modelRoutingMode: orderedAllowlist.length ? 'user_priority' : 'auto',
              modelUserPriority: orderedAllowlist
            }
          },
          translationAgentModelPolicy: {
            mode: 'fixed',
            speed: policy.speed,
            preference: policy.preference,
            allowRouteOverride: true
          }
        };
      }
      if (normalizedRole === 'context') {
        const contextByPreset = {
          cheap: { parallelism: 'mixed', tokens: 1800, temperature: 0, auditMs: 2200 },
          optimal: { parallelism: 'mixed', tokens: 2400, temperature: 0, auditMs: 1800 },
          expensive: { parallelism: 'high', tokens: 3600, temperature: 0.15, auditMs: 1200 },
          smart_cheap: { parallelism: 'mixed', tokens: 2600, temperature: 0.05, auditMs: 1700 },
          smart_fast: { parallelism: 'high', tokens: 2400, temperature: 0, auditMs: 1400 },
          cheap_fast: { parallelism: 'low', tokens: 1200, temperature: 0, auditMs: 2600 }
        };
        const contextPatch = contextByPreset[normalizedPreset] || contextByPreset.optimal;
        return {
          translationAgentTuning: {
            parallelismOverride: contextPatch.parallelism,
            plannerMaxOutputTokens: contextPatch.tokens,
            plannerTemperature: contextPatch.temperature,
            auditIntervalMs: contextPatch.auditMs
          }
        };
      }
      if (normalizedRole === 'compaction') {
        const map = {
          cheap: { threshold: 55, limit: 5600, cooldown: 650 },
          optimal: { threshold: 80, limit: 9000, cooldown: 1200 },
          expensive: { threshold: 150, limit: 15000, cooldown: 2600 },
          smart_cheap: { threshold: 95, limit: 10000, cooldown: 1300 },
          smart_fast: { threshold: 70, limit: 8500, cooldown: 750 },
          cheap_fast: { threshold: 42, limit: 4800, cooldown: 420 }
        };
        const row = map[normalizedPreset] || map.optimal;
        return {
          translationAgentTuning: {
            compressionThreshold: row.threshold,
            contextFootprintLimit: row.limit,
            compressionCooldownMs: row.cooldown
          }
        };
      }
      if (normalizedRole === 'proofreading') {
        const passesByPreset = {
          cheap: 0,
          optimal: 1,
          expensive: 2,
          smart_cheap: 1,
          smart_fast: 1,
          cheap_fast: 0
        };
        return {
          translationAgentTuning: {
            proofreadingPassesOverride: Object.prototype.hasOwnProperty.call(passesByPreset, normalizedPreset)
              ? passesByPreset[normalizedPreset]
              : 1
          },
          translationAgentModelPolicy: {
            mode: 'fixed',
            speed: policy.speed,
            preference: policy.preference,
            allowRouteOverride: true
          }
        };
      }
      return null;
    }

    _applyRolePresetFromEditor(role, preset) {
      const patch = this._buildRolePresetPatch(role, preset);
      if (!patch) {
        this.toasts.show(I18n.t('popup.profileParamInvalid', 'Недопустимое значение параметра.'), { tone: 'warn' });
        return;
      }
      this._queueSettingsPatch(patch);
      this.toasts.show(`Пресет для роли "${role}" применен: ${modelPriorityPresetLabel(preset)}.`, { tone: 'ok' });
    }

    _applyAllowlistFromUi() {
      if (!this.fields.modelRows) {
        return;
      }
      const selectedRaw = this.fields.modelRows
        ? Array.from(this.fields.modelRows.querySelectorAll('input[data-model-spec]:checked'))
          .map((node) => safeString(node.getAttribute('data-model-spec'), '').trim())
          .filter(Boolean)
        : [];
      const selected = normalizeModelSpecList(selectedRaw);
      const targetPath = this._resolveActiveModelListPatchPath();

      if (targetPath === 'userSettings.models.agentAllowedModels' || targetPath === 'translationAgentAllowedModels') {
        const expandedModelList = this._mergeTranslationModelListWith(selected);
        this._queueSettingsPatch({
          userSettings: { models: { agentAllowedModels: selected } },
          translationAgentAllowedModels: selected,
          translationModelList: expandedModelList
        });
        return;
      }

      if (targetPath === 'translationModelList') {
        this._queueSettingsPatch({ translationModelList: selected });
        return;
      }

      if (targetPath === 'userSettings.models.modelUserPriority') {
        const expandedModelList = this._mergeTranslationModelListWith(selected);
        this._queueSettingsPatch({
          translationModelList: expandedModelList,
          userSettings: {
            profile: 'custom',
            models: {
              modelRoutingMode: 'user_priority',
              modelUserPriority: selected
            }
          }
        });
        return;
      }

      if (targetPath.startsWith('userSettings.')) {
        const relative = targetPath.slice('userSettings.'.length);
        const userPatch = { profile: 'custom' };
        writeByPath(userPatch, relative, selected);
        const topPatch = { userSettings: userPatch };
        if (targetPath.includes('.agentAllowedModels') || targetPath.includes('.modelUserPriority')) {
          topPatch.translationModelList = this._mergeTranslationModelListWith(selected);
        }
        this._queueSettingsPatch(topPatch);
        return;
      }

      if (isTopLevelSettingsPath(targetPath)) {
        const topPatch = {};
        writeByPath(topPatch, targetPath, selected);
        this._queueSettingsPatch(topPatch);
      }
    }

    _profilePresetConfig(profileValue) {
      const profile = normalizeProfileId(profileValue, 'minimal');
      if (profile === 'maximum') {
        return {
          profile,
          reasoningEffort: 'max',
          reasoningSummary: 'detailed',
          memory: { maxPages: 160, maxBlocks: 70000, maxAgeDays: 90 },
          tuning: {
            maxBatchSizeOverride: 30,
            proofreadingPassesOverride: 2,
            parallelismOverride: 'high',
            plannerTemperature: 0.15,
            plannerMaxOutputTokens: 3600,
            auditIntervalMs: 1200,
            mandatoryAuditIntervalMs: 600,
            compressionThreshold: 130,
            contextFootprintLimit: 16000,
            compressionCooldownMs: 2200
          },
          rolePresets: PROFILE_ROLE_PRESETS.maximum
        };
      }
      if (profile === 'optimized') {
        return {
          profile,
          reasoningEffort: 'high',
          reasoningSummary: 'short',
          memory: { maxPages: 80, maxBlocks: 30000, maxAgeDays: 45 },
          tuning: {
            maxBatchSizeOverride: 16,
            proofreadingPassesOverride: 1,
            parallelismOverride: 'high',
            plannerTemperature: 0,
            plannerMaxOutputTokens: 2200,
            auditIntervalMs: 2400,
            mandatoryAuditIntervalMs: 1100,
            compressionThreshold: 95,
            contextFootprintLimit: 10500,
            compressionCooldownMs: 1500
          },
          rolePresets: PROFILE_ROLE_PRESETS.optimized
        };
      }
      if (profile === 'medium') {
        return {
          profile,
          reasoningEffort: 'high',
          reasoningSummary: 'short',
          memory: { maxPages: 80, maxBlocks: 30000, maxAgeDays: 45 },
          tuning: {
            maxBatchSizeOverride: 20,
            proofreadingPassesOverride: 1,
            parallelismOverride: 'mixed',
            plannerTemperature: 0.1,
            plannerMaxOutputTokens: 2600,
            auditIntervalMs: 1800,
            mandatoryAuditIntervalMs: 900,
            compressionThreshold: 85,
            contextFootprintLimit: 9000,
            compressionCooldownMs: 1200
          },
          rolePresets: PROFILE_ROLE_PRESETS.medium
        };
      }
      return {
        profile: 'minimal',
        reasoningEffort: 'max',
        reasoningSummary: 'detailed',
        memory: { maxPages: 40, maxBlocks: 15000, maxAgeDays: 30 },
        tuning: {
          maxBatchSizeOverride: 12,
          proofreadingPassesOverride: 0,
          parallelismOverride: 'low',
          plannerTemperature: 0,
          plannerMaxOutputTokens: 1800,
          auditIntervalMs: 2600,
          mandatoryAuditIntervalMs: 1200,
          compressionThreshold: 55,
          contextFootprintLimit: 6000,
          compressionCooldownMs: 700
        },
        rolePresets: PROFILE_ROLE_PRESETS.minimal
      };
    }

    _buildProfileSelectionPatch(profileValue) {
      const profile = normalizeProfileId(profileValue, 'minimal');
      if (profile === 'custom') {
        return { userSettings: { profile: 'custom' } };
      }

      const preset = this._profilePresetConfig(profile);
      const rolePresets = preset.rolePresets && typeof preset.rolePresets === 'object'
        ? preset.rolePresets
        : (PROFILE_ROLE_PRESETS[preset.profile] || PROFILE_ROLE_PRESETS.minimal);
      const translationPreset = normalizeModelPriorityPreset(rolePresets.translation || 'optimal');
      const selectedAllowlist = this._selectedAllowlist();
      const baseAllowlist = selectedAllowlist.length
        ? selectedAllowlist
        : this._orderedAllowlistByPreset(translationPreset);
      const allowlist = normalizeModelSpecList(baseAllowlist.length ? baseAllowlist : this._allKnownModelSpecs());
      const translationPolicy = this._policyShapeFromPreset(rolePresets.translation || 'optimal');

      const patch = {
        userSettings: {
          profile: preset.profile,
          agent: {
            agentMode: 'agent',
            toolConfigUser: {}
          },
          reasoning: {
            reasoningMode: 'auto',
            reasoningEffort: preset.reasoningEffort,
            reasoningSummary: preset.reasoningSummary
          },
          caching: {
            promptCacheRetention: 'extended',
            promptCacheKey: null,
            compatCache: true
          },
          models: {
            agentAllowedModels: allowlist,
            modelRoutingMode: 'user_priority',
            modelUserPriority: allowlist.slice()
          },
          memory: {
            enabled: true,
            maxPages: preset.memory.maxPages,
            maxBlocks: preset.memory.maxBlocks,
            maxAgeDays: preset.memory.maxAgeDays,
            gcOnStartup: true,
            ignoredQueryParams: DEFAULT_IGNORED_QUERY_PARAMS.slice()
          },
          ui: {
            uiLanguage: 'ru',
            showAdvanced: false,
            collapseState: {},
            compareRendering: 'auto'
          }
        },
        modelSelection: this._policyShapeFromPreset(rolePresets.agent || 'optimal'),
        translationAgentModelPolicy: {
          mode: 'fixed',
          speed: translationPolicy.speed,
          preference: translationPolicy.preference,
          allowRouteOverride: true
        },
        translationAgentTuning: { ...preset.tuning },
        translationAgentExecutionMode: 'agent',
        translationPipelineEnabled: true,
        translationCategoryMode: 'auto',
        translationPageCacheEnabled: true,
        translationApiCacheEnabled: true,
        translationMemoryEnabled: true,
        translationMemoryMaxPages: preset.memory.maxPages,
        translationMemoryMaxBlocks: preset.memory.maxBlocks,
        translationMemoryMaxAgeDays: preset.memory.maxAgeDays,
        translationMemoryGcOnStartup: true,
        translationMemoryIgnoredQueryParams: DEFAULT_IGNORED_QUERY_PARAMS.slice(),
        translationCompareRendering: 'auto',
        translationAgentAllowedModels: allowlist
      };

      Object.keys(rolePresets).forEach((role) => {
        const rolePatch = this._buildRolePresetPatch(role, rolePresets[role]);
        if (!rolePatch) {
          return;
        }
        PopupVm.mergeDeep(patch, rolePatch);
      });

      const finalAllowlist = normalizeModelSpecList(
        readByPath(patch, 'userSettings.models.agentAllowedModels', allowlist)
      );
      const finalUserPriority = normalizeModelSpecList(
        readByPath(patch, 'userSettings.models.modelUserPriority', [])
      );
      const mergedModelList = this._mergeTranslationModelListWith(finalAllowlist.concat(finalUserPriority));
      patch.userSettings.models.agentAllowedModels = finalAllowlist;
      patch.userSettings.models.modelUserPriority = finalUserPriority.length
        ? finalUserPriority
        : finalAllowlist.slice();
      patch.translationAgentAllowedModels = finalAllowlist;
      patch.translationModelList = mergedModelList;
      return patch;
    }

    _applyProfileSelection(profileValue, { showToast = true } = {}) {
      const profile = normalizeProfileId(profileValue, 'minimal');
      const patch = this._buildProfileSelectionPatch(profile);
      this._queueSettingsPatch(patch);
      if (showToast) {
        this.toasts.show(`Профиль применен: ${profile}.`, { tone: 'ok' });
      }
    }

    async _applyCategorySelection(tabIdOverride = null) {
      const tabId = this._normalizeTabId(tabIdOverride) || await this._requireActionTabId();
      if (!tabId) {
        return;
      }
      const categories = Array.from(this.categoryDraft.values()).filter(Boolean);
      if (!categories.length) {
        this.toasts.show('Выберите минимум одну категорию.', { tone: 'warn' });
        return;
      }
      await this._sendCommand(UiProtocol.Commands ? UiProtocol.Commands.SET_TRANSLATION_CATEGORIES : 'SET_TRANSLATION_CATEGORIES', {
        tabId,
        jobId: this.vm.job && this.vm.job.id ? this.vm.job.id : null,
        categories,
        mode: 'replace'
      });
      await this._sendCommand(UiProtocol.Commands ? UiProtocol.Commands.KICK_SCHEDULER : 'KICK_SCHEDULER', {
        tabId
      }, { timeoutMs: 2500, retries: 0 }).catch(() => null);
      this.categoryDraftTouched = false;
      this.toasts.show('Выбор категорий применен.', { tone: 'ok' });
      this._activateTab('status', { persist: true });
    }

    async _chooseCategoriesOnPage() {
      const tabId = await this._requireActionTabId();
      if (!tabId) {
        return;
      }
      const scriptable = await this._ensureTabScriptable(tabId);
      if (!scriptable) {
        this.toasts.show(
          I18n.t('popup.errorUnscriptableTab', 'Эту вкладку нельзя переводить (служебная страница браузера или магазина расширений).'),
          { tone: 'warn' }
        );
        return;
      }
      const options = this.vm.categories && Array.isArray(this.vm.categories.items)
        ? this.vm.categories.items
          .filter((item) => item && item.disabled !== true)
          .map((item) => ({
            id: safeString(item.id, '').trim().toLowerCase(),
            title: safeString(item.titleRu, '').trim()
          }))
          .filter((item) => item.id)
          .slice(0, 60)
        : [];
      if (!options.length) {
        this.toasts.show('Нет категорий для выбора на странице.', { tone: 'warn' });
        return;
      }
      const defaults = Array.from(this.categoryDraft.values()).filter(Boolean);
      const question = this.vm.categories && this.vm.categories.userQuestion
        ? this.vm.categories.userQuestion
        : 'Выберите категории для перевода';

      const pick = await this._runPageCategoryPrompt(tabId, { question, options, defaults });
      if (!pick || pick.cancelled === true) {
        this.toasts.show('Выбор категорий отменен на странице.', { tone: 'info' });
        return;
      }
      const selected = Array.from(new Set((Array.isArray(pick.selected) ? pick.selected : [])
        .map((item) => safeString(item, '').trim().toLowerCase())
        .filter(Boolean)));
      if (!selected.length) {
        this.toasts.show('На странице не выбрано ни одной категории.', { tone: 'warn' });
        return;
      }
      this.categoryDraft = new Set(selected);
      this._categoriesRenderKey = '';
      this._renderCategories();
      this._renderButtonsState();
      await this._applyCategorySelection(tabId);
    }

    async _runPageCategoryPrompt(tabId, payload) {
      if (!global.chrome || !global.chrome.scripting || typeof global.chrome.scripting.executeScript !== 'function') {
        throw new Error('Scripting API недоступен. Невозможно открыть диалог на странице.');
      }
      return new Promise((resolve, reject) => {
        try {
          global.chrome.scripting.executeScript({
            target: { tabId },
            args: [payload],
            func: (source) => {
              const data = source && typeof source === 'object' ? source : {};
              const question = typeof data.question === 'string' && data.question.trim()
                ? data.question.trim()
                : 'Выберите категории для перевода';
              const options = Array.isArray(data.options) ? data.options : [];
              const defaults = Array.isArray(data.defaults) ? data.defaults : [];
              const valid = new Set(
                options
                  .map((row) => String(row && row.id ? row.id : '').trim().toLowerCase())
                  .filter(Boolean)
              );
              const lines = options.map((row, index) => {
                const id = String(row && row.id ? row.id : '').trim().toLowerCase();
                const title = String(row && row.title ? row.title : id).trim();
                return `${index + 1}. ${id} — ${title}`;
              });
              const message = [
                question,
                '',
                lines.join('\n'),
                '',
                'Введите id категорий через запятую:'
              ].join('\n');
              const raw = globalThis.prompt(message, defaults.join(', '));
              if (raw === null) {
                return { cancelled: true, selected: [] };
              }
              const selected = String(raw)
                .split(/[,;\n]+/)
                .map((item) => item.trim().toLowerCase())
                .filter(Boolean)
                .filter((item) => valid.has(item));
              return {
                cancelled: false,
                selected: Array.from(new Set(selected))
              };
            }
          }, (results) => {
            const runtimeError = global.chrome && global.chrome.runtime && global.chrome.runtime.lastError
              ? global.chrome.runtime.lastError
              : null;
            if (runtimeError) {
              reject(new Error(runtimeError.message || 'Не удалось открыть диалог выбора категорий'));
              return;
            }
            const first = Array.isArray(results) && results.length ? results[0] : null;
            resolve(first && first.result && typeof first.result === 'object' ? first.result : null);
          });
        } catch (error) {
          reject(error);
        }
      });
    }

    _queueSettingsPatch(patch) {
      const linkedPatch = this._applyLinkedSettingsPatch(patch);
      this.pendingSettingsPatch = PopupVm.mergeDeep(this.pendingSettingsPatch || {}, linkedPatch || {});
      this.flushSettingsDebounced();
    }

    _applyLinkedSettingsPatch(patch) {
      const source = patch && typeof patch === 'object' ? patch : {};
      let out = cloneJson(source, {}) || {};

      const requestedProfile = normalizeProfileId(readByPath(out, 'userSettings.profile', ''), '');
      if (requestedProfile && requestedProfile !== 'custom') {
        const baseProfilePatch = this._buildProfileSelectionPatch(requestedProfile);
        const merged = cloneJson(baseProfilePatch, {}) || {};
        PopupVm.mergeDeep(merged, out);
        out = merged;
      }

      const settings = this.vm.settings && typeof this.vm.settings === 'object' ? this.vm.settings : {};
      const currentUser = settings.userSettings && typeof settings.userSettings === 'object'
        ? settings.userSettings
        : {};
      const pendingUser = this.pendingSettingsPatch
        && typeof this.pendingSettingsPatch === 'object'
        && this.pendingSettingsPatch.userSettings
        && typeof this.pendingSettingsPatch.userSettings === 'object'
        ? this.pendingSettingsPatch.userSettings
        : {};
      const outUserPatch = out.userSettings && typeof out.userSettings === 'object'
        ? out.userSettings
        : {};
      const nextUser = PopupVm.mergeDeep(
        PopupVm.mergeDeep(cloneJson(currentUser, {}) || {}, cloneJson(pendingUser, {}) || {}),
        cloneJson(outUserPatch, {}) || {}
      );
      const ensureNumber = (value, fallback) => {
        const num = Number(value);
        return Number.isFinite(num) ? num : fallback;
      };

      const modelTouched = hasPath(out, 'userSettings.models')
        || hasPath(out, 'translationAgentAllowedModels')
        || hasPath(out, 'translationModelList');
      if (modelTouched) {
        const explicitAllowlist = hasPath(out, 'translationAgentAllowedModels')
          ? normalizeModelSpecList(readByPath(out, 'translationAgentAllowedModels', []))
          : [];
        const nextAllowlist = normalizeModelSpecList(
          explicitAllowlist.length
            ? explicitAllowlist
            : readByPath(nextUser, 'models.agentAllowedModels', [])
        );
        const nextRoutingMode = safeString(readByPath(nextUser, 'models.modelRoutingMode', 'auto'), 'auto').trim().toLowerCase();
        let nextUserPriority = normalizeModelSpecList(readByPath(nextUser, 'models.modelUserPriority', []));

        if (!nextUserPriority.length && nextRoutingMode === 'user_priority' && nextAllowlist.length) {
          nextUserPriority = nextAllowlist.slice();
          writeByPath(out, 'userSettings.models.modelUserPriority', nextUserPriority);
        }

        writeByPath(out, 'userSettings.models.agentAllowedModels', nextAllowlist);
        out.translationAgentAllowedModels = nextAllowlist;
        out.translationModelList = this._mergeTranslationModelListWith(nextAllowlist.concat(nextUserPriority));
      }

      const memoryTouched = hasPath(out, 'userSettings.memory')
        || hasPath(out, 'translationMemoryEnabled')
        || hasPath(out, 'translationMemoryMaxPages')
        || hasPath(out, 'translationMemoryMaxBlocks')
        || hasPath(out, 'translationMemoryMaxAgeDays')
        || hasPath(out, 'translationMemoryGcOnStartup')
        || hasPath(out, 'translationMemoryIgnoredQueryParams');
      if (memoryTouched) {
        const nextMemory = readByPath(nextUser, 'memory', {}) || {};
        out.translationMemoryEnabled = nextMemory.enabled !== false;
        out.translationMemoryMaxPages = Math.max(1, Math.round(ensureNumber(nextMemory.maxPages, 200)));
        out.translationMemoryMaxBlocks = Math.max(1, Math.round(ensureNumber(nextMemory.maxBlocks, 5000)));
        out.translationMemoryMaxAgeDays = Math.max(1, Math.round(ensureNumber(nextMemory.maxAgeDays, 30)));
        out.translationMemoryGcOnStartup = nextMemory.gcOnStartup !== false;
        out.translationMemoryIgnoredQueryParams = Array.isArray(nextMemory.ignoredQueryParams)
          ? nextMemory.ignoredQueryParams.slice()
          : DEFAULT_IGNORED_QUERY_PARAMS.slice();
      }

      if (hasPath(out, 'userSettings.caching.compatCache')) {
        out.translationApiCacheEnabled = readByPath(nextUser, 'caching.compatCache', true) !== false;
      }

      if (hasPath(out, 'userSettings.ui.compareRendering')) {
        out.translationCompareRendering = safeString(readByPath(nextUser, 'ui.compareRendering', 'auto'), 'auto').trim().toLowerCase() || 'auto';
      }

      if (hasPath(out, 'userSettings.agent.agentMode')) {
        out.translationAgentExecutionMode = safeString(readByPath(nextUser, 'agent.agentMode', 'agent'), 'agent');
      }

      if (hasPath(out, 'userSettings.profile') && readByPath(out, 'userSettings.profile', 'custom') === 'custom') {
        if (!hasPath(out, 'translationAgentProfile')) {
          out.translationAgentProfile = 'balanced';
        }
      }

      return out;
    }

    async _flushSettingsPatch() {
      const patch = this.pendingSettingsPatch && typeof this.pendingSettingsPatch === 'object'
        ? this.pendingSettingsPatch
        : null;
      this.pendingSettingsPatch = {};
      if (!patch || !Object.keys(patch).length) {
        return;
      }
      await this._sendCommand(UiProtocol.Commands ? UiProtocol.Commands.SET_SETTINGS : 'SET_SETTINGS', {
        patch,
        expectedSchemaVersion: this.vm.settings && Number.isFinite(Number(this.vm.settings.schemaVersion))
          ? Number(this.vm.settings.schemaVersion)
          : null
      }, { timeoutMs: 5000, retries: 1 });
    }

    async _sendCommand(type, payload, options = {}) {
      if (!this.client) {
        throw new Error('UI client not initialized');
      }
      const commandType = safeString(type, '').trim();
      if (!commandType) {
        throw new Error('Команда не указана');
      }
      const result = await this.client.sendCommand(commandType, payload && typeof payload === 'object' ? payload : {}, options);
      if (!result || result.ok !== false) {
        return result;
      }
      throw new Error(result.error && result.error.message
        ? result.error.message
        : I18n.t('common.errorUnknown', 'Неизвестная ошибка'));
    }

    _openDebugPage(section) {
      const runtime = global.chrome && global.chrome.runtime ? global.chrome.runtime : null;
      const tabs = global.chrome && global.chrome.tabs ? global.chrome.tabs : null;
      if (!runtime || !tabs || typeof runtime.getURL !== 'function' || typeof tabs.create !== 'function') {
        return;
      }
      const url = new URL(runtime.getURL('extension/ui/debug.html'));
      const tabId = this._getTargetTabId();
      if (tabId) {
        url.searchParams.set('tabId', String(tabId));
      }
      if (section) {
        url.hash = String(section).startsWith('#') ? String(section) : `#${section}`;
      }
      tabs.create({ url: url.toString() });
    }

    _scheduleRender() {
      this.scheduler.queueRender(() => {
        this.vm = PopupVm.computeViewModel(this.snapshot, this.uiStatus);
        this._syncCategoryDraft();
        this._render();
      });
    }

    _syncCategoryDraft() {
      if (!this.vm.awaitingCategories) {
        this.categoryDraft.clear();
        this.categoryDraftJobId = null;
        this.categoryDraftTouched = false;
        return;
      }
      const jobId = this.vm.job && this.vm.job.id ? this.vm.job.id : '__no_job__';
      if (this.categoryDraftJobId !== jobId) {
        this.categoryDraftTouched = false;
      }
      if (this.categoryDraftJobId === jobId && this.categoryDraftTouched) {
        return;
      }
      this.categoryDraft.clear();
      const items = this.vm.categories && Array.isArray(this.vm.categories.items) ? this.vm.categories.items : [];
      items.forEach((item) => {
        if (!item || item.disabled) {
          return;
        }
        if (item.selected === true) {
          this.categoryDraft.add(item.id);
        }
      });
      this.categoryDraftJobId = jobId;
    }

    _render() {
      this._renderPasswordToggles();
      this._renderConnection();
      this._renderStatus();
      this._renderCategories();
      this._renderProfile();
      this._renderAllowlist();
      this._renderCredentials();
      this._renderHistory();
      this._renderErrors();
      this._renderViewModeButtons();
      this._renderButtonsState();
    }

    _renderPasswordToggles() {
      const buttons = this.root.querySelectorAll('[data-action="toggle-byok-visibility"], [data-action="toggle-proxy-visibility"]');
      buttons.forEach((button) => {
        const action = button.getAttribute('data-action');
        const visible = action === 'toggle-byok-visibility' ? this.uiState.byokVisible : this.uiState.proxyVisible;
        const iconName = visible ? 'eyeOff' : 'eye';
        const label = visible ? I18n.t('popup.hideSecret', 'Скрыть') : I18n.t('popup.showSecret', 'Показать');
        const iconMarkup = NT.UiIcons && typeof NT.UiIcons.get === 'function'
          ? NT.UiIcons.get(iconName)
          : (NT.UiIcons && NT.UiIcons[iconName] ? NT.UiIcons[iconName] : '');
        button.innerHTML = `<span class="nt-icon" aria-hidden="true">${iconMarkup}</span><span class="nt-sr-only">${label}</span>`;
      });

      if (this.fields.byokInput) {
        this.fields.byokInput.type = this.uiState.byokVisible ? 'text' : 'password';
      }
      if (this.fields.proxyToken) {
        this.fields.proxyToken.type = this.uiState.proxyVisible ? 'text' : 'password';
      }
    }

    _renderConnection() {
      const state = safeString(this.vm.connectionState, 'connecting');
      let tone = 'neutral';
      let label = I18n.t('common.loading', 'Загрузка...');
      let badgeText = '...';
      if (state === 'connected') {
        tone = 'ok';
        label = I18n.t('common.connected', 'Связь с фоном есть');
        badgeText = 'OK';
      } else if (state === 'reconnecting') {
        tone = 'warn';
        label = I18n.t('common.reconnecting', 'Нет связи, переподключаюсь...');
        badgeText = 'RETRY';
      } else if (state === 'disconnected') {
        tone = 'danger';
        label = I18n.t('common.disconnected', 'Нет связи');
        badgeText = 'OFF';
      } else if (state === 'connecting') {
        badgeText = '...';
      }
      if (this.fields.connectionBadge) {
        this.fields.connectionBadge.className = `nt-badge nt-badge--${tone}`;
        Ui.setText(this.fields.connectionBadge, badgeText, '...');
      }
      Ui.setText(this.fields.connectionText, shortText(this.vm.connectionMessage || label, 140), label);
    }

    _renderStatus() {
      Ui.setText(this.fields.stage, I18n.stageLabel(this.vm.stage), I18n.t('common.noData', 'Нет данных'));
      if (this.fields.progress) {
        this.fields.progress.value = Math.max(0, Math.min(100, Number(this.vm.progress.percent || 0)));
      }
      Ui.setText(this.fields.progressDone, `Готово: ${Number(this.vm.progress.done || 0)}`);
      Ui.setText(this.fields.progressPending, `Ожидает: ${Number(this.vm.progress.pending || 0)}`);
      Ui.setText(this.fields.progressFailed, `С ошибкой: ${Number(this.vm.progress.failed || 0)}`);
      Ui.setText(this.fields.agentDigest, shortText(this.vm.agentStatus.digest, 180) || I18n.t('common.noData', 'Нет данных'));
      Ui.setText(this.fields.agentLine1, shortText(this.vm.agentStatus.line1, 180));
      Ui.setText(this.fields.agentLine2, shortText(this.vm.agentStatus.line2, 180));
      this._renderAgentStatusLog();

      const leaseExpired = this.vm.status === 'running'
        && Number.isFinite(Number(this.vm.leaseUntilTs))
        && Number(this.vm.leaseUntilTs) < Date.now();
      Ui.setHidden(this.fields.leaseWarning, !leaseExpired);
      if (leaseExpired) {
        Ui.setText(this.fields.leaseWarning, I18n.t('popup.leaseWarning', 'Аренда задачи истекла. Откройте отладку и проверьте планировщик.'));
      }
    }

    _isLikelyJsonString(text) {
      const src = safeString(text, '').trim();
      if (!src) {
        return false;
      }
      return (src.startsWith('{') && src.endsWith('}')) || (src.startsWith('[') && src.endsWith(']'));
    }

    _isLikelyMojibake(text) {
      const src = safeString(text, '');
      if (!src) {
        return false;
      }
      const pairs = (src.match(/[РС][\s\u00A0][^\s]/g) || []).length;
      return pairs >= 3;
    }

    _cleanStatusText(text, maxLen = 220) {
      const src = safeString(text, '').replace(/\s+/g, ' ').trim();
      if (!src) {
        return '';
      }
      if (this._isLikelyMojibake(src)) {
        return '';
      }
      if (this._isLikelyJsonString(src)) {
        try {
          const parsed = JSON.parse(src);
          if (parsed && typeof parsed === 'object') {
            if (typeof parsed.message === 'string' && parsed.message.trim()) {
              return shortText(parsed.message.trim(), maxLen);
            }
            if (Array.isArray(parsed.results)) {
              const okCount = parsed.results.length;
              const errCount = Array.isArray(parsed.errors) ? parsed.errors.length : 0;
              return `Результат батча: ${okCount} блок(ов), ошибок: ${errCount}.`;
            }
          }
        } catch (_) {
          return '';
        }
        return '';
      }
      return shortText(src, maxLen);
    }

    _toRuToolStatus(status) {
      const key = safeString(status, '').trim().toLowerCase();
      if (key === 'ok' || key === 'done') {
        return 'успех';
      }
      if (key === 'failed') {
        return 'ошибка';
      }
      if (key === 'coalesced') {
        return 'склеено';
      }
      if (key === 'skipped') {
        return 'пропущено';
      }
      return key || 'неизвестно';
    }

    _summarizeToolMessage(lastTool) {
      const raw = safeString(lastTool && lastTool.message, '').trim();
      if (!raw) {
        return '';
      }
      const cleaned = this._cleanStatusText(raw, 240);
      if (cleaned) {
        return cleaned;
      }
      if (!this._isLikelyJsonString(raw)) {
        return '';
      }
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          if (Array.isArray(parsed.results)) {
            const okCount = parsed.results.length;
            const errCount = Array.isArray(parsed.errors) ? parsed.errors.length : 0;
            return `Результат батча: ${okCount} блок(ов), ошибок: ${errCount}.`;
          }
          if (Number.isFinite(Number(parsed.pendingCount))) {
            const pending = Number(parsed.pendingCount);
            const completed = Number.isFinite(Number(parsed.completedCount)) ? Number(parsed.completedCount) : 0;
            return `Прогресс: завершено ${completed}, осталось ${pending}.`;
          }
        }
      } catch (_) {
        return '';
      }
      return '';
    }

    _renderAgentStatusLog() {
      if (!this.fields.agentStatusLog) {
        return;
      }
      const rows = [];
      const push = (tag, text, tone = 'info') => {
        const safeText = safeString(text, '').trim();
        if (!safeText) {
          return;
        }
        rows.push({
          tag: safeString(tag, 'Статус'),
          text: safeText,
          tone
        });
      };

      push('Этап', `${I18n.stageLabel(this.vm.stage)} | ${Number(this.vm.progress.percent || 0)}%`);
      push('Сводка', this._cleanStatusText(this.vm.agentStatus && this.vm.agentStatus.digest ? this.vm.agentStatus.digest : ''), 'ok');
      push('Деталь', this._cleanStatusText(this.vm.agentStatus && this.vm.agentStatus.line1 ? this.vm.agentStatus.line1 : ''));
      push('Деталь', this._cleanStatusText(this.vm.agentStatus && this.vm.agentStatus.line2 ? this.vm.agentStatus.line2 : ''));

      const agentState = this.snapshot && this.snapshot.agentState && typeof this.snapshot.agentState === 'object'
        ? this.snapshot.agentState
        : {};
      const reports = Array.isArray(agentState.reports) ? agentState.reports : [];
      const lastReport = reports.length ? reports[reports.length - 1] : null;
      if (lastReport && typeof lastReport === 'object') {
        const reportTitle = this._cleanStatusText(safeString(lastReport.title, ''), 120);
        const reportBody = this._cleanStatusText(safeString(lastReport.body, ''), 240);
        push('Отчёт', reportTitle, 'ok');
        push('Отчёт', reportBody);
      }
      const toolTrace = Array.isArray(agentState.toolExecutionTrace) ? agentState.toolExecutionTrace : [];
      const lastTool = toolTrace.length ? toolTrace[toolTrace.length - 1] : null;
      if (lastTool && typeof lastTool === 'object') {
        const toolName = safeString(lastTool.toolName || lastTool.tool, '');
        const toolStatus = safeString(lastTool.status, '').toLowerCase();
        let tone = 'info';
        if (toolStatus === 'failed') {
          tone = 'danger';
        } else if (toolStatus === 'ok' || toolStatus === 'done') {
          tone = 'ok';
        } else if (toolStatus === 'coalesced' || toolStatus === 'skipped') {
          tone = 'warn';
        }
        push('Инстр.', `${toolName || '—'} | ${this._toRuToolStatus(toolStatus)}`, tone);
        push('Инстр.', this._summarizeToolMessage(lastTool), tone);
      }
      if (this.vm.lastError && typeof this.vm.lastError === 'object') {
        push('Ошибка', `${safeString(this.vm.lastError.code, 'UNKNOWN')}: ${safeString(this.vm.lastError.message, '')}`, 'danger');
      }
      if (!rows.length) {
        push('Статус', I18n.t('common.noData', 'Нет данных'), 'info');
      }

      Ui.clearNode(this.fields.agentStatusLog);
      rows.slice(-14).forEach((row) => {
        const line = this.doc.createElement('div');
        line.className = 'popup__status-row';
        const badge = this.doc.createElement('span');
        badge.className = `popup__status-tag popup__status-tag--${row.tone}`;
        badge.textContent = row.tag;
        const text = this.doc.createElement('span');
        text.className = 'popup__status-text';
        text.textContent = row.text;
        line.appendChild(badge);
        line.appendChild(text);
        this.fields.agentStatusLog.appendChild(line);
      });
    }

    _categorySelectionModeLabel(mode) {
      const key = safeString(mode, '').trim().toLowerCase();
      if (key === 'recommended') {
        return 'реком.';
      }
      if (key === 'excluded') {
        return 'искл.';
      }
      return 'опц.';
    }

    _categoryFlowCompactLabel(flow) {
      const key = safeString(flow, '').trim().toLowerCase();
      if (key === 'sequential') {
        return 'послед.';
      }
      if (key === 'parallel') {
        return 'паралл.';
      }
      return 'авто';
    }

    _categoryFlowTooltip(flow) {
      const key = safeString(flow, '').trim().toLowerCase();
      if (key === 'sequential') {
        return 'Перевод этой категории: последовательный.';
      }
      if (key === 'parallel') {
        return 'Перевод этой категории: параллельный.';
      }
      return 'Режим перевода категории определяется автоматически.';
    }

    _renderCategories() {
      const awaiting = this.vm.awaitingCategories === true;
      const staleSelection = (
        this.vm.job
        && this.vm.job.classificationStale === true
      ) || (
        this.vm.lastError
        && this.vm.lastError.code === 'CLASSIFICATION_STALE'
      );
      Ui.setHidden(this.fields.categoryChooser, !awaiting);

      const reclassifyBtn = this.root.querySelector('[data-action="reclassify-force"]');
      if (reclassifyBtn) {
        reclassifyBtn.hidden = !(awaiting && staleSelection);
      }

      if (!awaiting) {
        return;
      }

      Ui.setText(
        this.fields.categoryQuestion,
        this.vm.categories.userQuestion || I18n.t('popup.categoriesHint', 'Категории появятся после этапа планирования.')
      );
      const items = this.vm.categories && Array.isArray(this.vm.categories.items) ? this.vm.categories.items : [];
      const renderKey = JSON.stringify({
        question: safeString(this.vm.categories && this.vm.categories.userQuestion, ''),
        ids: items.map((row) => [row.id, row.mode, row.translationFlow, row.disabled, row.countUnits]),
        draft: Array.from(this.categoryDraft.values()).sort()
      });
      if (this._categoriesRenderKey === renderKey) {
        return;
      }
      this._categoriesRenderKey = renderKey;

      Ui.clearNode(this.fields.categoryChooserList);
      if (!items.length) {
        this.fields.categoryChooserList.appendChild(Ui.createElement('div', {
          className: 'popup__hint',
          text: I18n.t('common.noData', 'Нет данных')
        }));
        return;
      }

      items.forEach((item) => {
        const row = Ui.createElement('label', {
          className: `popup__category-row${item.disabled ? ' is-excluded' : ''}`
        });
        const checkbox = Ui.createElement('input', {
          attrs: {
            type: 'checkbox',
            'data-category-toggle': item.id,
            title: item.titleRu || item.id
          }
        });
        checkbox.checked = this.categoryDraft.has(item.id);
        checkbox.disabled = item.disabled === true;

        const content = Ui.createElement('div');
        content.appendChild(Ui.createElement('div', { className: 'popup__category-title', text: item.titleRu || item.id }));
        content.appendChild(Ui.createElement('div', { className: 'popup__category-desc', text: shortText(item.descriptionRu || '', 110) }));

        const tag = Ui.createElement('span', {
          className: 'popup__tag',
          text: `${this._categorySelectionModeLabel(item.mode)} • ${Number(item.countUnits || 0)} • ${this._categoryFlowCompactLabel(item.translationFlow)}`,
          attrs: {
            title: this._categoryFlowTooltip(item.translationFlow)
          }
        });

        row.appendChild(checkbox);
        row.appendChild(content);
        row.appendChild(tag);
        this.fields.categoryChooserList.appendChild(row);
      });
    }

    _renderProfile() {
      const settings = this.vm.settings && typeof this.vm.settings === 'object' ? this.vm.settings : {};
      const user = settings.userSettings && typeof settings.userSettings === 'object' ? settings.userSettings : {};
      const profile = normalizeProfileId(user.profile || settings.translationAgentProfile, 'minimal');
      if (this.fields.profileSelect && this.fields.profileSelect.value !== profile) {
        this.fields.profileSelect.value = profile;
      }
      if (this.fields.modelSortSelect && this.fields.modelSortSelect.value !== this.uiState.modelSort) {
        this.fields.modelSortSelect.value = this.uiState.modelSort;
      }

      this._renderSavedProfiles();
      this._renderProfilePipelineTabs();
      this._renderProfileLegend();
      const fullSnapshot = this._buildProfileSettingsSnapshot();
      const filteredSnapshot = this._buildProfileSnapshotForPipelineTab(fullSnapshot);
      this._renderProfileJsonViewer(filteredSnapshot);
    }

    _toggleProfileMarker(marker) {
      const visibility = normalizeProfileMarkerVisibility(this.uiState.profileMarkerVisibility);
      visibility[marker] = visibility[marker] === false;
      this._saveUiState({ profileMarkerVisibility: visibility });
      this._renderProfileLegend();
    }

    _renderProfileLegend() {
      const visibility = normalizeProfileMarkerVisibility(this.uiState.profileMarkerVisibility);
      if (Array.isArray(this.fields.profileLegendToggles)) {
        this.fields.profileLegendToggles.forEach((button) => {
          if (!button || !button.getAttribute) {
            return;
          }
          const marker = safeString(button.getAttribute('data-marker'), '').trim().toLowerCase();
          if (marker !== 'user' && marker !== 'agent' && marker !== 'profile') {
            return;
          }
          const enabled = visibility[marker] !== false;
          button.classList.toggle('is-off', !enabled);
          button.setAttribute('aria-pressed', enabled ? 'true' : 'false');
        });
      }
      if (this.root && this.root.classList) {
        this.root.classList.toggle('popup--hide-marker-user', visibility.user === false);
        this.root.classList.toggle('popup--hide-marker-agent', visibility.agent === false);
        this.root.classList.toggle('popup--hide-marker-profile', visibility.profile === false);
      }
    }

    _profilePipelineTabMeta(tabId) {
      const key = normalizeProfilePipelineTab(tabId);
      const map = {
        input: {
          label: I18n.t('popup.profilePipelineInput', 'Ввод'),
          tooltip: I18n.t('tooltips.profilePipelineInput', 'Шаг 1: исходные userSettings и запрошенные значения.')
        },
        policy: {
          label: I18n.t('popup.profilePipelinePolicy', 'Политика'),
          tooltip: I18n.t('tooltips.profilePipelinePolicy', 'Шаг 2: effectiveSettings после нормализации.')
        },
        runtime: {
          label: I18n.t('popup.profilePipelineRuntime', 'Рантайм'),
          tooltip: I18n.t('tooltips.profilePipelineRuntime', 'Шаг 3: параметры, которые реально читает runtime.')
        },
        service: {
          label: I18n.t('popup.profilePipelineService', 'Сервис'),
          tooltip: I18n.t('tooltips.profilePipelineService', 'Служебные поля версии и debug-гейтов.')
        }
      };
      return map[key] || map.input;
    }

    _buildProfileSnapshotForPipelineTab(snapshot) {
      const source = snapshot && typeof snapshot === 'object' ? snapshot : {};
      const tabId = normalizeProfilePipelineTab(this.uiState.profilePipelineTab);
      const out = {};
      Object.keys(source).forEach((rootKey) => {
        if (this._isProfileRootInPipelineTab(rootKey, tabId)) {
          out[rootKey] = source[rootKey];
        }
      });
      if (!Object.keys(out).length) {
        return source;
      }
      return out;
    }

    _isProfileRootInPipelineTab(rootKey, tabId) {
      const key = safeString(rootKey, '').trim();
      if (!key) {
        return false;
      }
      const normalizedTab = normalizeProfilePipelineTab(tabId);
      const explicitRoots = PROFILE_PIPELINE_TAB_ROOTS[normalizedTab] || [];
      if (explicitRoots.includes(key)) {
        return true;
      }
      if (!PROFILE_PIPELINE_KNOWN_ROOTS.has(key)) {
        return normalizedTab === 'service';
      }
      return false;
    }

    _renderSavedProfiles() {
      if (!this.fields.profileSavedSelect) {
        return;
      }
      const savedProfiles = this._sanitizeSavedProfiles(this.uiState.savedProfiles);
      this.uiState.savedProfiles = savedProfiles;

      const names = Object.keys(savedProfiles).sort((a, b) => a.localeCompare(b, 'ru'));
      let selected = safeString(this.uiState.selectedSavedProfile, '').trim();
      if (selected && !Object.prototype.hasOwnProperty.call(savedProfiles, selected)) {
        selected = '';
      }
      this.uiState.selectedSavedProfile = selected;
      const renderKey = JSON.stringify({ names, selected });
      if (this._savedProfilesRenderKey === renderKey) {
        return;
      }
      this._savedProfilesRenderKey = renderKey;

      Ui.clearNode(this.fields.profileSavedSelect);
      const placeholder = this.doc.createElement('option');
      placeholder.value = '';
      placeholder.textContent = I18n.t('popup.savedProfilesPlaceholder', 'Сохраненные профили');
      this.fields.profileSavedSelect.appendChild(placeholder);

      names.forEach((name) => {
        const option = this.doc.createElement('option');
        option.value = name;
        option.textContent = name;
        this.fields.profileSavedSelect.appendChild(option);
      });
      this.fields.profileSavedSelect.value = selected;
    }

    _renderProfileJsonViewer(effectiveSettings) {
      if (!this.fields.profileJsonViewer) {
        return;
      }
      const safeEffective = effectiveSettings && typeof effectiveSettings === 'object' ? effectiveSettings : {};
      const renderKey = JSON.stringify(safeEffective || {});
      if (this._profileJsonRenderKey === renderKey) {
        this._syncProfileEditorControls({ syncInput: false });
        return;
      }
      this._profileJsonRenderKey = renderKey;

      Ui.clearNode(this.fields.profileJsonViewer);
      const keys = Object.keys(safeEffective);
      if (!keys.length) {
        this.fields.profileJsonViewer.textContent = I18n.t('common.noData', 'Нет данных');
        this._closeProfileParamEditor({ silent: true });
        return;
      }

      this._appendProfileJsonNode(this.fields.profileJsonViewer, safeEffective, '', 0);
      if (this.profileEditorState.path && !this._resolveProfileAnchorToken(this.profileEditorState.path)) {
        this._closeProfileParamEditor({ silent: true });
      }
      this._syncProfileEditorControls({ syncInput: false });
    }

    _appendProfileJsonNode(container, value, path, depth) {
      const indent = '  '.repeat(Math.max(0, depth));
      const nextIndent = '  '.repeat(Math.max(0, depth + 1));
      const isObject = value && typeof value === 'object' && !Array.isArray(value);
      const isArray = Array.isArray(value);

      if (isObject) {
        const keys = this._orderedProfileJsonKeys(path, Object.keys(value));
        this._appendProfileJsonText(container, '{');
        if (keys.length) {
          this._appendProfileJsonText(container, '\n');
        }
        keys.forEach((key, index) => {
          const childPath = path ? `${path}.${key}` : key;
          const childValue = value[key];
          const meta = this._resolveProfileMeta(childPath, childValue);
          const keyEditable = this._isProfileMetaInteractive(meta);
          const keyHasChoices = Boolean(meta && Array.isArray(meta.values) && meta.values.length);
          const ownershipClass = this._profileOwnershipTokenClass(childPath, meta);
          this._appendProfileJsonText(container, nextIndent);
          const keyClass = `popup__json-token popup__json-key${ownershipClass}${keyEditable ? ' popup__json-key--editable' : ''}${keyHasChoices ? ' popup__json-token--selectable' : ''}`;
          this._appendProfileJsonToken(container, `"${key}"`, keyClass, keyEditable ? {
            type: 'button',
            tabindex: '0',
            'data-action': 'open-profile-param-editor',
            'data-param-key': childPath,
            'data-profile-path': childPath,
            'data-profile-role': 'key',
            title: this._buildProfileParamTooltip(childPath, meta, { value: childValue, role: 'key', editable: keyEditable })
          } : {
            'data-profile-path': childPath,
            'data-profile-role': 'key',
            title: this._buildProfileParamTooltip(childPath, meta, { value: childValue, role: 'key' })
          });
          this._appendProfileJsonText(container, ': ');
          this._appendProfileJsonNode(container, childValue, childPath, depth + 1);
          if (index < keys.length - 1) {
            this._appendProfileJsonText(container, ',');
          }
          this._appendProfileJsonText(container, '\n');
        });
        if (keys.length) {
          this._appendProfileJsonText(container, indent);
        }
        this._appendProfileJsonText(container, '}');
        return;
      }

      if (isArray) {
        this._appendProfileJsonText(container, '[');
        if (value.length) {
          this._appendProfileJsonText(container, '\n');
        }
        value.forEach((item, index) => {
          const childPath = `${path}[${index}]`;
          this._appendProfileJsonText(container, nextIndent);
          this._appendProfileJsonNode(container, item, childPath, depth + 1);
          if (index < value.length - 1) {
            this._appendProfileJsonText(container, ',');
          }
          this._appendProfileJsonText(container, '\n');
        });
        if (value.length) {
          this._appendProfileJsonText(container, indent);
        }
        this._appendProfileJsonText(container, ']');
        return;
      }

      const literal = this._formatProfileJsonLiteral(value);
      const meta = this._resolveProfileMeta(path, value);
      const ownershipClass = this._profileOwnershipTokenClass(path, meta);
      const editable = this._isProfileMetaInteractive(meta);
      const hasChoices = Boolean(meta && Array.isArray(meta.values) && meta.values.length);
      if (!editable) {
        this._appendProfileJsonToken(container, literal, `popup__json-token popup__json-value${ownershipClass}`, {
          'data-profile-path': path || '',
          'data-profile-role': 'value',
          title: this._buildProfileParamTooltip(path, meta, { value, role: 'value' })
        });
        return;
      }
      this._appendProfileJsonToken(container, literal, `popup__json-token popup__json-value${ownershipClass} popup__json-value--editable${hasChoices ? ' popup__json-token--selectable' : ''}`, {
        type: 'button',
        tabindex: '0',
        'data-action': 'open-profile-param-editor',
        'data-param-key': path,
        'data-profile-path': path,
        'data-profile-role': 'value',
        title: this._buildProfileParamTooltip(path, meta, { value, role: 'value', editable: true })
      });
    }

    _isProfileMetaInteractive(meta) {
      if (!meta || meta.editable === false) {
        return false;
      }
      if (safeString(meta.editor, '').trim() === 'model-picker') {
        return true;
      }
      return ['string', 'number', 'boolean', 'json'].includes(meta.type || 'string');
    }

    _orderedProfileJsonKeys(path, keys) {
      const list = Array.isArray(keys) ? keys.slice() : [];
      const normalizedPath = safeString(path, '').trim();
      const priorityMap = {
        '': [
          'schemaVersion',
          'updatedAt',
          'translationAgentProfileRequested',
          'translationAgentProfileApplied',
          'userSettings',
          'modelPriorityRoles',
          'modelSelection',
          'translationAgentModelPolicy',
          'translationAgentTuning',
          'runtimeApplied',
          'translationAgentExecutionMode',
          'translationPipelineEnabled',
          'translationCategoryMode',
          'translationCategoryList',
          'translationMemoryEnabled',
          'translationMemoryMaxPages',
          'translationMemoryMaxBlocks',
          'translationMemoryMaxAgeDays',
          'translationMemoryGcOnStartup',
          'translationMemoryIgnoredQueryParams',
          'translationPageCacheEnabled',
          'translationApiCacheEnabled',
          'translationClassifierObserveDomChanges',
          'translationPerfMaxTextNodesPerScan',
          'translationPerfYieldEveryNNodes',
          'translationPerfAbortScanIfOverMs',
          'translationPerfDegradedScanOnHeavy',
          'translationCompareDiffThreshold',
          'translationCompareRendering',
          'translationModelList',
          'requestedAgentAllowedModels',
          'appliedAgentAllowedModels',
          'rejectedAgentAllowedModels',
          'translationAgentAllowedModels',
          'debugAllowTestCommands',
          'effectiveSettings',
          'overrides'
        ],
        userSettings: [
          'profile',
          'agent',
          'reasoning',
          'models',
          'caching',
          'memory',
          'ui',
          '_meta'
        ],
        'userSettings.models': [
          'agentAllowedModels',
          'modelRoutingMode',
          'modelUserPriority'
        ],
        effectiveSettings: [
          'profile',
          'effectiveProfile',
          'agent',
          'reasoning',
          'models',
          'caching',
          'memory',
          'ui',
          'legacyProjection'
        ],
        modelPriorityRoles: MODEL_PRIORITY_ROLE_IDS.slice()
      };

      const order = Object.prototype.hasOwnProperty.call(priorityMap, normalizedPath)
        ? priorityMap[normalizedPath]
        : null;
      if (!order || !order.length) {
        return list.sort((a, b) => safeString(a, '').localeCompare(safeString(b, ''), 'ru'));
      }
      const rank = new Map(order.map((key, index) => [String(key), index]));
      return list.sort((a, b) => {
        const ra = rank.has(a) ? rank.get(a) : Number.MAX_SAFE_INTEGER;
        const rb = rank.has(b) ? rank.get(b) : Number.MAX_SAFE_INTEGER;
        if (ra !== rb) {
          return ra - rb;
        }
        return safeString(a, '').localeCompare(safeString(b, ''), 'ru');
      });
    }

    _appendProfileJsonText(container, text) {
      if (!container) {
        return;
      }
      container.appendChild(this.doc.createTextNode(safeString(text, '')));
    }

    _appendProfileJsonToken(container, text, className, attrs = {}) {
      if (!container) {
        return;
      }
      const isActionButton = safeString(attrs['data-action'], '').trim() === 'open-profile-param-editor';
      const el = this.doc.createElement(isActionButton ? 'button' : 'span');
      el.className = className;
      if (isActionButton) {
        el.setAttribute('type', 'button');
      }
      Object.keys(attrs).forEach((key) => {
        const value = attrs[key];
        if (value === null || value === undefined || value === '') {
          return;
        }
        el.setAttribute(key, String(value));
      });
      const tooltip = safeString(attrs.title, '');
      if (tooltip) {
        el.setAttribute('data-tooltip', tooltip);
      }
      el.textContent = safeString(text, '');
      container.appendChild(el);
    }

    _formatProfileJsonLiteral(value) {
      if (value === null || value === undefined) {
        return 'null';
      }
      if (typeof value === 'boolean') {
        return value ? 'true' : 'false';
      }
      if (typeof value === 'number') {
        return Number.isFinite(value) ? String(value) : 'null';
      }
      if (typeof value === 'string') {
        return JSON.stringify(value);
      }
      const asJson = JSON.stringify(value);
      return asJson === undefined ? 'null' : asJson;
    }

    _setProfilePathHover(path, hovered) {
      if (!this.fields.profileJsonViewer) {
        return;
      }
      const key = safeString(path, '').trim();
      if (!key) {
        return;
      }
      const selector = `[data-profile-path="${cssEscape(key)}"]`;
      const tokens = this.fields.profileJsonViewer.querySelectorAll(selector);
      tokens.forEach((token) => {
        token.classList.toggle('is-hover', hovered === true);
      });
    }

    _profileAreaDescription(path) {
      const key = safeString(path, '').trim();
      if (key.startsWith('requestedAgentAllowedModels')) {
        return 'Запрошенный пользователем allowlist моделей до фильтрации политикой.';
      }
      if (key.startsWith('appliedAgentAllowedModels')) {
        return 'Итоговый allowlist моделей после фильтрации по доступному translationModelList.';
      }
      if (key === 'translationAgentAllowedModels' || key.startsWith('translationAgentAllowedModels[')) {
        return 'Legacy allowlist моделей. Можно редактировать вручную; применяется как часть model policy.';
      }
      if (key.startsWith('rejectedAgentAllowedModels')) {
        return 'Model spec, которые были отклонены политикой (например, отсутствуют в translationModelList).';
      }
      if (key.startsWith('translationAgentProfileRequested')) {
        return 'Профиль, который выбрал пользователь.';
      }
      if (key.startsWith('translationAgentProfileApplied')) {
        return 'Итоговый профиль после применения overrides (часто custom при ручных изменениях).';
      }
      if (key.startsWith('modelPriorityRoles')) {
        return 'Ролевые пресеты приоритета: маппятся на реальные поля modelSelection/translationAgentModelPolicy/translationAgentTuning.';
      }
      if (key.startsWith('modelSelection')) {
        return 'Глобальная политика выбора модели для фоновых LLM-запросов.';
      }
      if (key.startsWith('translationAgentModelPolicy')) {
        return 'Политика выбора модели и route для задач агента перевода.';
      }
      if (key.startsWith('translationAgentTuning')) {
        return 'Тонкая настройка planner/audit/compaction/proofreading.';
      }
      if (key === 'runtimeApplied' || key.startsWith('runtimeApplied.')) {
        return 'Реальные runtime-настройки активного job (effective run settings и примененные агентом параметры).';
      }
      if (key.startsWith('translationPerf')) {
        return 'Ограничения производительности сканирования и выполнения.';
      }
      if (key.startsWith('userSettings.agent')) {
        return 'Параметры режима работы агента и его инструментов.';
      }
      if (key.startsWith('userSettings.reasoning')) {
        return 'Параметры глубины рассуждения модели и формата reasoning-summary.';
      }
      if (key.startsWith('userSettings.caching')) {
        return 'Параметры кеширования запросов и совместимого cache-режима.';
      }
      if (key.startsWith('userSettings.models')) {
        return 'Параметры выбора и маршрутизации моделей.';
      }
      if (key.startsWith('userSettings.memory')) {
        return 'Параметры памяти перевода и ограничения хранения.';
      }
      if (key.startsWith('userSettings.ui')) {
        return 'Параметры интерфейса popup/debug.';
      }
      if (key.startsWith('effectiveSettings')) {
        return 'Вычисленное итоговое значение после применения профиля и пользовательских overrides.';
      }
      if (key.startsWith('legacyProjection')) {
        return 'Проекция в legacy-ключи для обратной совместимости.';
      }
      if (key.startsWith('translationModelList')) {
        return 'Список model spec, доступных в текущей конфигурации запуска.';
      }
      return 'Параметр конфигурации переводчика.';
    }

    _allowedValuesText(meta, value) {
      if (meta && safeString(meta.editor, '').trim() === 'model-picker') {
        return 'выбор из всплывающего списка моделей (checkbox)';
      }
      if (meta && Array.isArray(meta.values) && meta.values.length) {
        const labels = meta.valueLabels && typeof meta.valueLabels === 'object'
          ? meta.valueLabels
          : null;
        if (labels) {
          return meta.values.map((entry) => {
            const key = safeString(entry, '');
            const label = Object.prototype.hasOwnProperty.call(labels, key)
              ? safeString(labels[key], key)
              : key;
            return key === label ? key : `${key} (${label})`;
          }).join(', ');
        }
        return meta.values.join(', ');
      }
      if (meta && meta.type === 'number') {
        return 'число в допустимом диапазоне политики настроек';
      }
      if (meta && meta.type === 'boolean') {
        return 'true, false';
      }
      if (meta && meta.type === 'json') {
        return 'валидный JSON (объект/массив/число/строка/boolean/null)';
      }
      if (Array.isArray(value)) {
        return 'массив значений';
      }
      if (value && typeof value === 'object') {
        return 'объект ключ-значение';
      }
      if (typeof value === 'number') {
        return 'число';
      }
      if (typeof value === 'boolean') {
        return 'true, false';
      }
      return 'строка';
    }

    _resolveProfileMeta(path, value = null) {
      const key = safeString(path, '').trim();
      if (!key) {
        return null;
      }
      const direct = PROFILE_PARAM_META[key];
      if (direct) {
        return { ...direct };
      }
      if (key.startsWith('userSettings.agent.toolConfigUser.')) {
        return {
          label: 'Ручной режим инструмента',
          description: 'Ручное переопределение режима конкретного инструмента агента.',
          values: ['auto', 'on', 'off'],
          allowCustom: false,
          type: 'string',
          forceCustom: true,
          patchPath: key
        };
      }
      if (key.startsWith('effectiveSettings.')) {
        const mapped = `userSettings.${key.slice('effectiveSettings.'.length)}`;
        const base = PROFILE_PARAM_META[mapped];
        if (base) {
          return {
            ...base,
            label: `${base.label} (эффективное)`,
            description: `${base.description} Это поле read-only.`,
            editable: false
          };
        }
        return {
          label: 'Эффективное значение',
          description: 'Вычислено автоматически из профиля и пользовательских параметров. Поле read-only.',
          values: [],
          allowCustom: false,
          editable: false,
          type: typeof value === 'number'
            ? 'number'
            : (typeof value === 'boolean' ? 'boolean' : (Array.isArray(value) ? 'array' : 'string'))
        };
      }
      if (key.startsWith('legacyProjection.')) {
        return {
          label: 'Legacy-проекция',
          description: 'Служебное вычисленное значение для обратной совместимости. Поле read-only.',
          values: [],
          allowCustom: false,
          editable: false,
          type: typeof value === 'number'
            ? 'number'
            : (typeof value === 'boolean' ? 'boolean' : (Array.isArray(value) ? 'array' : 'string'))
        };
      }
      if (key === 'runtimeApplied' || key.startsWith('runtimeApplied.')) {
        return {
          label: 'Реально применено в runtime',
          description: 'Снимок настроек активного процесса перевода: effective run settings и параметры, выставленные агентом. Поле read-only.',
          values: [],
          allowCustom: false,
          editable: false,
          type: typeof value === 'number'
            ? 'number'
            : (typeof value === 'boolean' ? 'boolean' : (Array.isArray(value) ? 'array' : 'string'))
        };
      }
      if (key === 'translationAgentProfileRequested') {
        return {
          label: 'Запрошенный профиль',
          description: 'Профиль, выбранный пользователем до вычисления effectiveSettings. Поле read-only.',
          values: PROFILE_IDS.slice(),
          allowCustom: false,
          editable: false,
          type: 'string'
        };
      }
      if (key === 'translationAgentProfileApplied') {
        return {
          label: 'Примененный профиль',
          description: 'Итоговый профиль после применения policy и overrides. Поле read-only.',
          values: PROFILE_IDS.slice(),
          allowCustom: false,
          editable: false,
          type: 'string'
        };
      }
      if (key === 'requestedAgentAllowedModels' || key.startsWith('requestedAgentAllowedModels[')) {
        return {
          label: 'Запрошенный allowlist',
          description: 'Список моделей, который запрошен пользователем. Поле read-only.',
          values: [],
          allowCustom: false,
          editable: false,
          type: Array.isArray(value) ? 'array' : 'string'
        };
      }
      if (key === 'appliedAgentAllowedModels' || key.startsWith('appliedAgentAllowedModels[') || key.startsWith('translationAgentAllowedModels[')) {
        return {
          label: 'Примененный allowlist',
          description: 'Список моделей, реально примененный после фильтрации policy. Поле read-only.',
          values: [],
          allowCustom: false,
          editable: false,
          type: Array.isArray(value) ? 'array' : 'string'
        };
      }
      if (key === 'translationAgentAllowedModels') {
        return {
          label: 'Legacy allowlist (примененный)',
          description: 'Legacy-поле, синхронизированное с appliedAgentAllowedModels. Поле read-only.',
          values: [],
          allowCustom: false,
          editable: false,
          type: 'array'
        };
      }
      if (key === 'rejectedAgentAllowedModels' || key.startsWith('rejectedAgentAllowedModels[')) {
        return {
          label: 'Отклоненные модели',
          description: 'Model spec, отклоненные policy (не входят в translationModelList). Поле read-only.',
          values: [],
          allowCustom: false,
          editable: false,
          type: Array.isArray(value) ? 'array' : 'string'
        };
      }
      if (key === 'translationModelList' || key.startsWith('translationModelList[')) {
        return {
          label: 'Доступные модели',
          description: 'Model spec, доступные в текущем runtime. Поле read-only.',
          values: [],
          allowCustom: false,
          editable: false,
          type: Array.isArray(value) ? 'array' : 'string'
        };
      }
      if (key === 'schemaVersion' || key === 'updatedAt' || key === 'translationAgentProfile') {
        return {
          label: 'Служебное поле snapshot',
          description: 'Текущее служебное значение из snapshot. Поле read-only.',
          values: [],
          allowCustom: false,
          editable: false,
          type: typeof value === 'number' ? 'number' : 'string'
        };
      }

      const isArrayItemPath = key.includes('[');
      const topLevelEditable = isTopLevelSettingsPath(key);
      const userSettingsEditable = key.startsWith('userSettings.');
      if (!isArrayItemPath && (topLevelEditable || userSettingsEditable)) {
        const valueType = Array.isArray(value) || (value && typeof value === 'object')
          ? 'json'
          : (typeof value === 'number'
            ? 'number'
            : (typeof value === 'boolean' ? 'boolean' : 'string'));
        return {
          label: 'Параметр настройки',
          description: 'Прямое редактирование параметра. Значение отправляется в SET_SETTINGS patch.',
          values: [],
          allowCustom: true,
          editable: true,
          type: valueType,
          patchPath: key,
          forceCustom: userSettingsEditable && key !== 'userSettings.profile'
        };
      }
      return null;
    }

    _normalizeProfileOwnershipPath(path) {
      return safeString(path, '').replace(/\[\d+\]/g, '').trim();
    }

    _resolveProfileOwnership(path, meta = null) {
      const key = this._normalizeProfileOwnershipPath(path);
      if (!key) {
        return 'neutral';
      }
      const resolvedMeta = meta || this._resolveProfileMeta(key, null);
      if (PROFILE_INFLUENCE_PREFIXES.some((prefix) => key === prefix || key.startsWith(`${prefix}.`))) {
        return 'profile';
      }
      const userPrefixes = [
        'userSettings',
        'translationModelList',
        'translationAgentAllowedModels',
        'requestedAgentAllowedModels',
        'translationAgentProfileRequested',
        'modelPriorityRoles',
        'overrides.values',
        'overrides.changed'
      ];
      if (userPrefixes.some((prefix) => key === prefix || key.startsWith(`${prefix}.`))) {
        return 'user';
      }
      const agentPrefixes = [
        'effectiveSettings',
        'appliedAgentAllowedModels',
        'rejectedAgentAllowedModels',
        'translationAgentProfileApplied',
        'legacyProjection',
        'runtimeApplied'
      ];
      if (agentPrefixes.some((prefix) => key === prefix || key.startsWith(`${prefix}.`))) {
        return 'agent';
      }
      if (resolvedMeta && resolvedMeta.editable === true) {
        return 'user';
      }
      return 'neutral';
    }

    _profileOwnershipTokenClass(path, meta = null) {
      const ownership = this._resolveProfileOwnership(path, meta);
      if (ownership === 'user') {
        return ' popup__json-token--user';
      }
      if (ownership === 'agent') {
        return ' popup__json-token--agent';
      }
      if (ownership === 'profile') {
        return ' popup__json-token--profile';
      }
      return '';
    }

    _buildProfileParamTooltip(path, meta, { value = null, role = 'key', editable = false } = {}) {
      const normalizedPath = safeString(path, '').trim();
      if (!normalizedPath) {
        return '';
      }
      const resolvedMeta = meta || this._resolveProfileMeta(normalizedPath, value);
      const ownership = this._resolveProfileOwnership(normalizedPath, resolvedMeta);
      const ownershipLabel = ownership === 'user'
        ? 'Источник: задает пользователь'
        : (ownership === 'agent'
          ? 'Источник: вычисляет агент/политика'
          : (ownership === 'profile'
            ? 'Источник: влияние выбранного профиля'
            : 'Источник: служебное/runtime'));
      const schema = this._allowedValuesText(resolvedMeta, value);
      const kind = role === 'key' ? 'Параметр' : 'Значение';
      const parts = [
        `${kind}: ${resolvedMeta && resolvedMeta.label ? resolvedMeta.label : normalizedPath}`,
        resolvedMeta && resolvedMeta.description
          ? resolvedMeta.description
          : this._profileAreaDescription(normalizedPath),
        ownershipLabel,
        `Путь: ${normalizedPath}`,
        `Допустимые значения: ${schema}`
      ];
      if (role === 'value') {
        parts.push(`Текущее: ${this._formatProfileParamValue(value)}`);
        if (editable) {
          parts.push('Кликните, чтобы изменить значение.');
        }
      }
      return parts.join('\n');
    }

    _formatProfileParamValue(value) {
      if (value === null || value === undefined) {
        return 'null';
      }
      if (typeof value === 'boolean') {
        return value ? 'true' : 'false';
      }
      if (typeof value === 'number') {
        return Number.isFinite(value) ? String(value) : 'null';
      }
      if (typeof value === 'string') {
        return value;
      }
      const asJson = JSON.stringify(value);
      return asJson === undefined ? 'null' : asJson;
    }

    _openProfileParamEditor(path, anchorToken = null) {
      const key = safeString(path, '').trim();
      const snapshotView = this._buildProfileSettingsSnapshot();
      const currentValue = readByPath(snapshotView, key, null);
      const meta = this._resolveProfileMeta(key, currentValue);
      if (!meta || meta.editable === false || !this.fields.profileJsonEditor) {
        return;
      }

      this.profileEditorState = {
        path: key,
        meta,
        anchorPath: key,
        anchorToken: anchorToken || null,
        mode: safeString(meta.editor, '').trim() === 'model-picker' ? 'models' : 'simple'
      };
      this.fields.profileJsonEditor.hidden = false;
      if (this.fields.profileJsonEditorTitle) {
        this.fields.profileJsonEditorTitle.textContent = `${meta.label} (${key})`;
      }
      this._setProfileEditorMode(this.profileEditorState.mode);

      if (this.profileEditorState.mode === 'models') {
        this._renderAllowlist();
        this._positionProfileEditor(anchorToken || this._resolveProfileAnchorToken(key));
        if (this.fields.modelSortSelect && typeof this.fields.modelSortSelect.focus === 'function') {
          this.fields.modelSortSelect.focus();
        }
        return;
      }

      const values = Array.isArray(meta.values) ? meta.values.map((entry) => String(entry)) : [];
      if (this.fields.profileJsonEditorSelect) {
        Ui.clearNode(this.fields.profileJsonEditorSelect);
        const valueLabels = meta && meta.valueLabels && typeof meta.valueLabels === 'object'
          ? meta.valueLabels
          : {};
        values.forEach((entry) => {
          const valueKey = String(entry);
          const option = this.doc.createElement('option');
          option.value = valueKey;
          option.textContent = Object.prototype.hasOwnProperty.call(valueLabels, valueKey)
            ? String(valueLabels[valueKey])
            : valueKey;
          this.fields.profileJsonEditorSelect.appendChild(option);
        });
        if (meta.allowCustom) {
          const customOption = this.doc.createElement('option');
          customOption.value = '__custom__';
          customOption.textContent = I18n.t('popup.profileEditorCustomOption', 'Свое значение');
          this.fields.profileJsonEditorSelect.appendChild(customOption);
        }
      }
      if (this.fields.profileJsonEditorInput) {
        this.fields.profileJsonEditorInput.value = this._formatProfileParamValue(currentValue);
      }

      const currentText = (currentValue === null && safeString(meta.nullToken, '').trim())
        ? safeString(meta.nullToken, '').trim().toLowerCase()
        : this._formatProfileParamValue(currentValue).toLowerCase();
      const matched = values.find((entry) => entry.toLowerCase() === currentText) || '';
      if (this.fields.profileJsonEditorSelect) {
        if (matched) {
          this.fields.profileJsonEditorSelect.value = matched;
        } else if (meta.allowCustom) {
          this.fields.profileJsonEditorSelect.value = '__custom__';
        } else if (values.length) {
          this.fields.profileJsonEditorSelect.value = values[0];
        }
      }

      this._syncProfileEditorControls({ syncInput: true });
      this._positionProfileEditor(anchorToken || this._resolveProfileAnchorToken(key));
      const shouldFocusInput = !values.length || (meta.allowCustom && this.fields.profileJsonEditorSelect && this.fields.profileJsonEditorSelect.value === '__custom__');
      if (shouldFocusInput && this.fields.profileJsonEditorInput && typeof this.fields.profileJsonEditorInput.focus === 'function') {
        this.fields.profileJsonEditorInput.focus();
        this.fields.profileJsonEditorInput.select();
      } else if (this.fields.profileJsonEditorSelect && typeof this.fields.profileJsonEditorSelect.focus === 'function') {
        this.fields.profileJsonEditorSelect.focus();
      }
    }

    _setProfileEditorMode(mode) {
      const editor = this.fields.profileJsonEditor;
      if (!editor) {
        return;
      }
      const normalized = mode === 'models' ? 'models' : 'simple';
      this.profileEditorState.mode = normalized;
      editor.classList.toggle('is-model-picker', normalized === 'models');
      editor.classList.toggle('is-simple-editor', normalized === 'simple');
      if (this.fields.profileJsonSimpleEditor) {
        this.fields.profileJsonSimpleEditor.hidden = normalized !== 'simple';
      }
      if (this.fields.profileJsonModelsEditor) {
        this.fields.profileJsonModelsEditor.hidden = normalized !== 'models';
      }
      if (normalized !== 'simple') {
        if (this.fields.profileJsonEditorSelect) {
          this.fields.profileJsonEditorSelect.hidden = true;
        }
        if (this.fields.profileJsonEditorInput) {
          this.fields.profileJsonEditorInput.hidden = true;
        }
      }
    }

    _syncProfileEditorControls({ syncInput = false } = {}) {
      const editor = this.fields.profileJsonEditor;
      if (!editor) {
        return;
      }
      const path = this.profileEditorState && this.profileEditorState.path
        ? safeString(this.profileEditorState.path, '').trim()
        : '';
      const meta = this.profileEditorState && this.profileEditorState.meta ? this.profileEditorState.meta : null;
      if (!path || !meta) {
        editor.hidden = true;
        return;
      }
      editor.hidden = false;
      const mode = this.profileEditorState && this.profileEditorState.mode === 'models' ? 'models' : 'simple';
      this._setProfileEditorMode(mode);
      if (mode === 'models') {
        this._positionProfileEditor(this._resolveProfileAnchorToken(path));
        return;
      }

      const select = this.fields.profileJsonEditorSelect;
      const input = this.fields.profileJsonEditorInput;
      const values = Array.isArray(meta.values) ? meta.values : [];
      const hasValues = values.length > 0;
      if (select) {
        select.hidden = !hasValues;
      }

      const selected = hasValues && select ? safeString(select.value, '').trim() : '';
      const isCustom = hasValues && meta.allowCustom && selected === '__custom__';
      if (input) {
        const showInput = !hasValues || isCustom;
        input.hidden = !showInput;
        input.disabled = !showInput;
        if (syncInput && hasValues && selected && selected !== '__custom__') {
          input.value = selected;
        }
      }
      this._positionProfileEditor(this._resolveProfileAnchorToken(path));
    }

    _handleProfileEditorSelectChange() {
      const meta = this.profileEditorState && this.profileEditorState.meta ? this.profileEditorState.meta : null;
      if (!meta || !this.fields.profileJsonEditorSelect) {
        return;
      }
      const selected = safeString(this.fields.profileJsonEditorSelect.value, '').trim();
      if (!selected) {
        return;
      }
      if (selected === '__custom__') {
        this._syncProfileEditorControls({ syncInput: true });
        if (this.fields.profileJsonEditorInput && typeof this.fields.profileJsonEditorInput.focus === 'function') {
          this.fields.profileJsonEditorInput.focus();
          this.fields.profileJsonEditorInput.select();
        }
        return;
      }
      this._applyProfileParamEditor({
        rawValue: selected,
        fromPreset: true,
        close: true
      });
    }

    _applyProfileParamEditor(options = {}) {
      const path = this.profileEditorState && this.profileEditorState.path
        ? safeString(this.profileEditorState.path, '').trim()
        : '';
      const meta = this.profileEditorState && this.profileEditorState.meta ? this.profileEditorState.meta : null;
      if (!path || !meta) {
        return;
      }

      const opts = options && typeof options === 'object' ? options : {};
      const hasRawValue = Object.prototype.hasOwnProperty.call(opts, 'rawValue');
      const selected = this.fields.profileJsonEditorSelect
        ? safeString(this.fields.profileJsonEditorSelect.value, '').trim()
        : '';
      const useSelected = hasRawValue
        ? opts.fromPreset === true
        : Boolean(selected && selected !== '__custom__');
      const rawValue = hasRawValue
        ? safeString(opts.rawValue, '').trim()
        : (useSelected
          ? selected
          : safeString(this.fields.profileJsonEditorInput && this.fields.profileJsonEditorInput.value, '').trim());
      const parsed = this._parseProfileParamInput(rawValue, meta, { fromPreset: useSelected });
      if (!parsed.ok) {
        this.toasts.show(parsed.error || I18n.t('common.errorUnknown', 'Неизвестная ошибка'), { tone: 'warn' });
        return;
      }

      const rawPatchPath = safeString(meta.patchPath || path, '').trim();
      if (!rawPatchPath || rawPatchPath.startsWith('effectiveSettings.') || rawPatchPath.startsWith('legacyProjection.')) {
        this.toasts.show(I18n.t('popup.profileParamReadonly', 'Это вычисляемое поле: изменяйте соответствующий userSettings параметр.'), { tone: 'warn' });
        return;
      }

      if (rawPatchPath.startsWith('__rolePreset__.')) {
        const role = safeString(rawPatchPath.slice('__rolePreset__.'.length), '').trim().toLowerCase();
        this._applyRolePresetFromEditor(role, safeString(parsed.value, 'optimal'));
        if (opts.close !== false) {
          this._closeProfileParamEditor({ silent: true });
        }
        return;
      }

      if (rawPatchPath === 'userSettings.profile' || rawPatchPath === 'profile') {
        this._applyProfileSelection(parsed.value, { showToast: true });
        if (opts.close !== false) {
          this._closeProfileParamEditor({ silent: true });
        }
        return;
      }

      if (isTopLevelSettingsPath(rawPatchPath)) {
        const topLevelPatch = {};
        writeByPath(topLevelPatch, rawPatchPath, parsed.value);
        this._queueSettingsPatch(topLevelPatch);
        this.toasts.show(I18n.t('popup.profileParamUpdated', 'Параметр профиля обновлен.'), { tone: 'ok' });
        if (opts.close !== false) {
          this._closeProfileParamEditor({ silent: true });
        }
        return;
      }

      let patchPath = rawPatchPath;
      if (patchPath.startsWith('userSettings.')) {
        patchPath = patchPath.slice('userSettings.'.length);
      }
      const userPatch = {};
      writeByPath(userPatch, patchPath, parsed.value);
      if (meta.forceReasoningCustom) {
        writeByPath(userPatch, 'reasoning.reasoningMode', 'custom');
      }
      if (patchPath !== 'profile') {
        userPatch.profile = 'custom';
      }
      this._queueSettingsPatch({ userSettings: userPatch });
      this.toasts.show(I18n.t('popup.profileParamUpdated', 'Параметр профиля обновлен.'), { tone: 'ok' });
      if (opts.close !== false) {
        this._closeProfileParamEditor({ silent: true });
      }
    }

    _closeProfileParamEditor({ silent = false } = {}) {
      if (!silent) {
        this.toasts.show(I18n.t('popup.profileEditorClosed', 'Редактирование параметра отменено.'), { tone: 'info' });
      }
      this.profileEditorState = { path: '', meta: null, anchorPath: '', anchorToken: null, mode: 'simple' };
      if (this.fields.profileJsonEditor) {
        this.fields.profileJsonEditor.hidden = true;
        this.fields.profileJsonEditor.classList.remove('is-model-picker');
        this.fields.profileJsonEditor.classList.remove('is-simple-editor');
        this.fields.profileJsonEditor.style.top = '0px';
        this.fields.profileJsonEditor.style.left = '0px';
      }
      if (this.fields.profileJsonSimpleEditor) {
        this.fields.profileJsonSimpleEditor.hidden = false;
      }
      if (this.fields.profileJsonModelsEditor) {
        this.fields.profileJsonModelsEditor.hidden = true;
      }
      if (this.fields.profileJsonEditorSelect) {
        this.fields.profileJsonEditorSelect.hidden = true;
      }
      if (this.fields.profileJsonEditorInput) {
        this.fields.profileJsonEditorInput.hidden = true;
        this.fields.profileJsonEditorInput.disabled = false;
      }
    }

    _resolveProfileAnchorToken(path) {
      const key = safeString(path, '').trim();
      if (!key || !this.fields.profileJsonViewer) {
        return null;
      }
      const selector = `[data-action="open-profile-param-editor"][data-param-key="${cssEscape(key)}"]`;
      const tokens = this.fields.profileJsonViewer.querySelectorAll(selector);
      if (!tokens || !tokens.length) {
        return null;
      }
      const valueToken = Array.from(tokens).find((token) => token.getAttribute('data-profile-role') === 'value');
      return valueToken || tokens[0] || null;
    }

    _positionProfileEditor(anchorToken) {
      const editor = this.fields.profileJsonEditor;
      if (!editor || editor.hidden) {
        return;
      }
      const wrap = editor.closest('.popup__json-wrap');
      if (!wrap) {
        return;
      }
      const anchor = anchorToken && wrap.contains(anchorToken)
        ? anchorToken
        : this._resolveProfileAnchorToken(this.profileEditorState.anchorPath || this.profileEditorState.path);
      if (!anchor) {
        editor.style.top = '8px';
        editor.style.left = '8px';
        return;
      }

      const wrapRect = wrap.getBoundingClientRect();
      const anchorRect = anchor.getBoundingClientRect();
      const isModelPicker = editor.classList.contains('is-model-picker');
      const minWidth = isModelPicker ? 340 : 220;
      const defaultWidth = isModelPicker ? 390 : 260;
      const maxWidth = Math.max(minWidth, Math.floor(wrapRect.width - 16));
      editor.style.maxWidth = `${maxWidth}px`;
      const editorWidth = Math.min(maxWidth, Math.max(minWidth, editor.offsetWidth || defaultWidth));
      let left = Math.round(anchorRect.left - wrapRect.left);
      if (left + editorWidth > (wrapRect.width - 8)) {
        left = Math.max(8, Math.round(wrapRect.width - editorWidth - 8));
      }
      left = Math.max(8, left);

      let top = Math.round(anchorRect.bottom - wrapRect.top + 6);
      const maxTop = Math.max(8, Math.round(wrapRect.height - editor.offsetHeight - 8));
      if (top > maxTop) {
        top = Math.max(8, Math.round(anchorRect.top - wrapRect.top - editor.offsetHeight - 6));
      }
      editor.style.left = `${left}px`;
      editor.style.top = `${Math.max(8, top)}px`;
    }

    _parseProfileParamInput(raw, meta, { fromPreset = false } = {}) {
      const text = safeString(raw, '').trim();
      const nullToken = safeString(meta && meta.nullToken, '').trim().toLowerCase();
      const isNullLike = meta && meta.nullable === true
        ? (!text || (nullToken && text.toLowerCase() === nullToken))
        : false;
      if (!text && !meta.allowCustom && !fromPreset && !isNullLike) {
        return {
          ok: false,
          error: I18n.t('popup.profileParamInvalid', 'Недопустимое значение параметра.')
        };
      }

      let value = isNullLike ? null : text;
      if (!isNullLike && meta.type === 'boolean') {
        const lowered = text.toLowerCase();
        if (['true', '1', 'yes', 'да'].includes(lowered)) {
          value = true;
        } else if (['false', '0', 'no', 'нет'].includes(lowered)) {
          value = false;
        } else {
          return {
            ok: false,
            error: I18n.t('popup.profileParamBoolHint', 'Для этого параметра используйте true/false.')
          };
        }
      } else if (!isNullLike && meta.type === 'number') {
        const num = Number(text.replace(',', '.'));
        if (!Number.isFinite(num)) {
          return {
            ok: false,
            error: I18n.t('popup.profileParamNumberHint', 'Для этого параметра требуется число.')
          };
        }
        value = num;
      } else if (!isNullLike && meta.type === 'json') {
        try {
          value = JSON.parse(text);
        } catch (_) {
          return {
            ok: false,
            error: I18n.t('popup.profileParamJsonHint', 'Для этого параметра требуется валидный JSON.')
          };
        }
      }

      const values = Array.isArray(meta.values) ? meta.values : [];
      if (values.length && !meta.allowCustom) {
        const normalized = value === null
          ? (nullToken || 'none')
          : safeString(value, '').trim().toLowerCase();
        const allowed = values.map((entry) => safeString(entry, '').toLowerCase());
        if (!allowed.includes(normalized)) {
          return {
            ok: false,
            error: `${I18n.t('popup.profileParamInvalid', 'Недопустимое значение параметра.')}\n${I18n.t('popup.profileParamAllowed', 'Допустимые')}: ${values.join(', ')}`
          };
        }
        if (meta.type !== 'boolean' && value !== null) {
          value = values.find((entry) => safeString(entry, '').toLowerCase() === normalized) || value;
        }
      }

      if (meta.type === 'string' && nullToken && text.toLowerCase() === nullToken) {
        value = null;
      }
      if (meta.type === 'string' && safeString(meta.label, '').includes('Ключ prompt-кеша') && value === '') {
        value = null;
      }
      return { ok: true, value };
    }

    _saveCurrentProfilePreset() {
      const name = safeString(this.fields.profileSaveName && this.fields.profileSaveName.value, '').trim().slice(0, 64);
      if (!name) {
        this.toasts.show(I18n.t('popup.profilePresetNameRequired', 'Введите имя профиля для сохранения.'), { tone: 'warn' });
        return;
      }
      const settings = this.vm.settings && typeof this.vm.settings === 'object' ? this.vm.settings : {};
      const userSettings = settings.userSettings && typeof settings.userSettings === 'object' ? settings.userSettings : null;
      if (!userSettings) {
        this.toasts.show(I18n.t('common.noData', 'Нет данных'), { tone: 'warn' });
        return;
      }
      const savedProfiles = this._sanitizeSavedProfiles(this.uiState.savedProfiles);
      savedProfiles[name] = cloneJson(userSettings, {});
      this._saveUiState({
        savedProfiles,
        selectedSavedProfile: name
      });
      if (this.fields.profileSaveName) {
        this.fields.profileSaveName.value = name;
      }
      this.toasts.show(I18n.t('popup.profilePresetSaved', 'Профиль сохранен.'), { tone: 'ok' });
      this._renderSavedProfiles();
    }

    _applySelectedProfilePreset() {
      const selected = safeString(
        this.fields.profileSavedSelect && this.fields.profileSavedSelect.value
          ? this.fields.profileSavedSelect.value
          : this.uiState.selectedSavedProfile,
        ''
      ).trim();
      if (!selected) {
        this.toasts.show(I18n.t('popup.profilePresetSelectFirst', 'Сначала выберите сохраненный профиль.'), { tone: 'warn' });
        return;
      }
      const savedProfiles = this._sanitizeSavedProfiles(this.uiState.savedProfiles);
      const patch = savedProfiles[selected];
      if (!patch || typeof patch !== 'object') {
        this.toasts.show(I18n.t('popup.profilePresetMissing', 'Профиль не найден.'), { tone: 'warn' });
        return;
      }
      this._queueSettingsPatch({ userSettings: cloneJson(patch, {}) });
      this._saveUiState({ selectedSavedProfile: selected });
      this.toasts.show(I18n.t('popup.profilePresetApplied', 'Профиль применен.'), { tone: 'ok' });
    }

    _deleteSelectedProfilePreset() {
      const selected = safeString(
        this.fields.profileSavedSelect && this.fields.profileSavedSelect.value
          ? this.fields.profileSavedSelect.value
          : this.uiState.selectedSavedProfile,
        ''
      ).trim();
      if (!selected) {
        this.toasts.show(I18n.t('popup.profilePresetSelectFirst', 'Сначала выберите сохраненный профиль.'), { tone: 'warn' });
        return;
      }
      const savedProfiles = this._sanitizeSavedProfiles(this.uiState.savedProfiles);
      if (!Object.prototype.hasOwnProperty.call(savedProfiles, selected)) {
        return;
      }
      delete savedProfiles[selected];
      this._saveUiState({
        savedProfiles,
        selectedSavedProfile: ''
      });
      if (this.fields.profileSavedSelect) {
        this.fields.profileSavedSelect.value = '';
      }
      this.toasts.show(I18n.t('popup.profilePresetDeleted', 'Профиль удален.'), { tone: 'info' });
      this._renderSavedProfiles();
    }

    _selectedAllowlist() {
      const settings = this.vm.settings && typeof this.vm.settings === 'object' ? this.vm.settings : {};
      const user = settings.userSettings && typeof settings.userSettings === 'object' ? settings.userSettings : {};
      const fromUser = user.models && Array.isArray(user.models.agentAllowedModels)
        ? user.models.agentAllowedModels
        : [];
      const fallback = Array.isArray(settings.translationAgentAllowedModels)
        ? settings.translationAgentAllowedModels
        : [];
      return normalizeModelSpecList(fromUser.length ? fromUser : fallback);
    }

    _availableModelSpecSet() {
      const settings = this.vm.settings && typeof this.vm.settings === 'object' ? this.vm.settings : {};
      const list = normalizeModelSpecList(settings.translationModelList);
      return new Set(list);
    }

    _resolveActiveModelListPatchPath() {
      const state = this.profileEditorState && typeof this.profileEditorState === 'object' ? this.profileEditorState : {};
      const meta = state.meta && typeof state.meta === 'object' ? state.meta : null;
      const mode = safeString(state.mode, '').trim();
      if (mode !== 'models' || !meta) {
        return 'userSettings.models.agentAllowedModels';
      }
      const patchPath = safeString(meta.patchPath || state.path, '').trim();
      if (!patchPath) {
        return 'userSettings.models.agentAllowedModels';
      }
      return patchPath;
    }

    _modelListByPatchPath(patchPath) {
      const settings = this.vm.settings && typeof this.vm.settings === 'object' ? this.vm.settings : {};
      const key = safeString(patchPath, '').trim();
      if (!key) {
        return [];
      }
      if (key.startsWith('userSettings.')) {
        const userSettings = settings.userSettings && typeof settings.userSettings === 'object'
          ? settings.userSettings
          : {};
        const relative = key.slice('userSettings.'.length);
        return normalizeModelSpecList(readByPath(userSettings, relative, []));
      }
      return normalizeModelSpecList(readByPath(settings, key, []));
    }

    _allKnownModelSpecs() {
      const settings = this.vm.settings && typeof this.vm.settings === 'object'
        ? this.vm.settings
        : {};
      const userSettings = settings.userSettings && typeof settings.userSettings === 'object'
        ? settings.userSettings
        : {};
      const effectiveSettings = settings.effectiveSettings && typeof settings.effectiveSettings === 'object'
        ? settings.effectiveSettings
        : {};
      const sets = [
        settings.translationModelList,
        settings.translationAgentAllowedModels,
        userSettings && userSettings.models ? userSettings.models.agentAllowedModels : [],
        userSettings && userSettings.models ? userSettings.models.modelUserPriority : [],
        effectiveSettings && effectiveSettings.models ? effectiveSettings.models.agentAllowedModels : []
      ];
      const out = new Set();
      sets.forEach((list) => {
        normalizeModelSpecList(list).forEach((spec) => out.add(spec));
      });
      const registry = this.snapshot && this.snapshot.modelRegistry && Array.isArray(this.snapshot.modelRegistry.entries)
        ? this.snapshot.modelRegistry.entries
        : [];
      registry.forEach((entry) => {
        const row = entry && typeof entry === 'object' ? entry : {};
        const spec = modelSpec({
          id: safeString(row.id, ''),
          tier: safeString(row.tier, 'standard').toLowerCase()
        });
        if (spec) {
          out.add(spec);
        }
      });
      return Array.from(out.values());
    }

    _mergeTranslationModelListWith(specs) {
      const currentList = normalizeModelSpecList(
        this.vm && this.vm.settings && Array.isArray(this.vm.settings.translationModelList)
          ? this.vm.settings.translationModelList
          : []
      );
      const incomingList = normalizeModelSpecList(specs);
      const union = new Set(currentList);
      incomingList.forEach((spec) => union.add(spec));
      if (!union.size) {
        this._allKnownModelSpecs().forEach((spec) => union.add(spec));
      }
      return Array.from(union.values());
    }

    _modelRows() {
      const runtimeSpecs = this._availableModelSpecSet();
      const registry = this.snapshot && this.snapshot.modelRegistry && Array.isArray(this.snapshot.modelRegistry.entries)
        ? this.snapshot.modelRegistry.entries
        : [];
      const bySpec = new Map();
      registry.forEach((entry) => {
        const row = entry && typeof entry === 'object' ? entry : {};
        const normalized = {
          id: safeString(row.id, ''),
          tier: safeString(row.tier, 'standard').toLowerCase()
        };
        const spec = modelSpec(normalized);
        if (!normalized.id || !spec) {
          return;
        }
        bySpec.set(spec, {
          ...normalized,
          spec,
          available: true,
          runtimeAvailable: runtimeSpecs.size ? runtimeSpecs.has(spec) : true,
          fromRegistry: true,
          inputPrice: Number.isFinite(Number(row.inputPrice)) ? Number(row.inputPrice) : null,
          cachedInputPrice: Number.isFinite(Number(row.cachedInputPrice)) ? Number(row.cachedInputPrice) : null,
          outputPrice: Number.isFinite(Number(row.outputPrice)) ? Number(row.outputPrice) : null,
          sum_1M: Number.isFinite(Number(row.sum_1M)) ? Number(row.sum_1M) : null,
          capabilityRank: Number.isFinite(Number(row.capabilityRank)) ? Number(row.capabilityRank) : 0,
          notes: safeString(row.notes, '')
        });
      });

      this._allKnownModelSpecs().forEach((spec) => {
        const normalized = parseModelSpec(spec);
        if (!normalized.spec || !normalized.id) {
          return;
        }
        if (bySpec.has(normalized.spec)) {
          const row = bySpec.get(normalized.spec);
          row.runtimeAvailable = runtimeSpecs.size ? runtimeSpecs.has(normalized.spec) : true;
          return;
        }
        bySpec.set(normalized.spec, {
          ...normalized,
          available: true,
          runtimeAvailable: runtimeSpecs.size ? runtimeSpecs.has(normalized.spec) : true,
          fromRegistry: false,
          inputPrice: null,
          cachedInputPrice: null,
          outputPrice: null,
          sum_1M: null,
          capabilityRank: 0,
          notes: runtimeSpecs.size && !runtimeSpecs.has(normalized.spec)
            ? I18n.t('popup.modelUnavailableHint', 'Этот model spec сейчас вне translationModelList. При выборе будет автоматически добавлен в runtime список.')
            : ''
        });
      });

      return Array.from(bySpec.values()).filter((row) => Boolean(row && row.id));
    }

    _sortModelRows(rows) {
      const list = rows.slice();
      const sortMode = normalizeModelSort(this.uiState.modelSort);
      if (sortMode === 'input') {
        list.sort((a, b) => {
          const aPrice = Number.isFinite(Number(a.inputPrice)) ? Number(a.inputPrice) : Infinity;
          const bPrice = Number.isFinite(Number(b.inputPrice)) ? Number(b.inputPrice) : Infinity;
          if (aPrice !== bPrice) {
            return aPrice - bPrice;
          }
          return modelSpec(a).localeCompare(modelSpec(b));
        });
        return list;
      }
      if (sortMode === 'output') {
        list.sort((a, b) => {
          const aPrice = Number.isFinite(Number(a.outputPrice)) ? Number(a.outputPrice) : Infinity;
          const bPrice = Number.isFinite(Number(b.outputPrice)) ? Number(b.outputPrice) : Infinity;
          if (aPrice !== bPrice) {
            return aPrice - bPrice;
          }
          return modelSpec(a).localeCompare(modelSpec(b));
        });
        return list;
      }
      if (sortMode === 'total') {
        list.sort((a, b) => {
          const aInput = Number.isFinite(Number(a.inputPrice)) ? Number(a.inputPrice) : Infinity;
          const bInput = Number.isFinite(Number(b.inputPrice)) ? Number(b.inputPrice) : Infinity;
          const aOutput = Number.isFinite(Number(a.outputPrice)) ? Number(a.outputPrice) : Infinity;
          const bOutput = Number.isFinite(Number(b.outputPrice)) ? Number(b.outputPrice) : Infinity;
          const aPrice = aInput + aOutput;
          const bPrice = bInput + bOutput;
          if (aPrice !== bPrice) {
            return aPrice - bPrice;
          }
          return modelSpec(a).localeCompare(modelSpec(b));
        });
        return list;
      }
      list.sort((a, b) => modelSpec(a).localeCompare(modelSpec(b)));
      return list;
    }

    _renderAllowlist() {
      if (!this.fields.modelRows) {
        return;
      }
      const rows = this._sortModelRows(this._modelRows());
      const targetPath = this._resolveActiveModelListPatchPath();
      const selectedSet = new Set(this._modelListByPatchPath(targetPath));
      const tableWrap = this.fields.modelTableWrap
        || (this.fields.modelRows && typeof this.fields.modelRows.closest === 'function'
          ? this.fields.modelRows.closest('.popup__table-wrap')
          : null);
      const prevScrollTop = tableWrap ? tableWrap.scrollTop : 0;
      const prevScrollLeft = tableWrap ? tableWrap.scrollLeft : 0;
      const renderKey = JSON.stringify({
        targetPath,
        sort: this.uiState.modelSort,
        rows: rows.map((row) => [row.id, row.tier, row.runtimeAvailable, row.inputPrice, row.cachedInputPrice, row.outputPrice]),
        selected: Array.from(selectedSet).sort()
      });

      if (this._allowlistRenderKey === renderKey) {
        return;
      }
      this._allowlistRenderKey = renderKey;

      Ui.clearNode(this.fields.modelRows);
      Ui.setHidden(this.fields.modelEmpty, rows.length > 0);
      if (!rows.length) {
        return;
      }

      rows.forEach((row) => {
        const spec = row.spec || modelSpec(row);
        const tr = this.doc.createElement('tr');

        const tdCheck = this.doc.createElement('td');
        const checkbox = this.doc.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.setAttribute('data-model-spec', spec);
        if (!row.runtimeAvailable) {
          checkbox.setAttribute(
            'title',
            I18n.t('popup.modelUnavailableHint', 'Этот model spec сейчас вне translationModelList. При выборе будет автоматически добавлен в runtime список.')
          );
        } else {
          checkbox.setAttribute('title', I18n.t('tooltips.models', 'Список моделей, разрешенных для агента.'));
        }
        checkbox.checked = selectedSet.has(spec);
        tdCheck.appendChild(checkbox);
        tr.appendChild(tdCheck);

        [
          row.id,
          row.tier,
          formatMoney(row.inputPrice),
          formatMoney(row.cachedInputPrice),
          formatMoney(row.outputPrice)
        ].forEach((value, index) => {
          const td = this.doc.createElement('td');
          td.textContent = String(value);
          if (index === 0 && row.notes) {
            td.title = row.notes;
          }
          tr.appendChild(td);
        });

        this.fields.modelRows.appendChild(tr);
      });

      if (tableWrap) {
        const maxTop = Math.max(0, tableWrap.scrollHeight - tableWrap.clientHeight);
        const maxLeft = Math.max(0, tableWrap.scrollWidth - tableWrap.clientWidth);
        tableWrap.scrollTop = Math.min(prevScrollTop, maxTop);
        tableWrap.scrollLeft = Math.min(prevScrollLeft, maxLeft);
      }
    }

    _renderCredentials() {
      const security = this.snapshot && this.snapshot.security && typeof this.snapshot.security === 'object'
        ? this.snapshot.security
        : {};
      const credentials = security.credentials && typeof security.credentials === 'object'
        ? security.credentials
        : {};
      const proxy = credentials.proxy && typeof credentials.proxy === 'object'
        ? credentials.proxy
        : {};

      const mode = safeString(credentials.mode, 'PROXY').toUpperCase() === 'BYOK' ? 'BYOK' : 'PROXY';
      if (this.fields.modeByok) {
        this.fields.modeByok.checked = mode === 'BYOK';
      }
      if (this.fields.modeProxy) {
        this.fields.modeProxy.checked = mode === 'PROXY';
      }
      Ui.setHidden(this.fields.byokBlock, mode !== 'BYOK');
      Ui.setHidden(this.fields.proxyBlock, mode !== 'PROXY');

      if (!this.formTouched.proxyBaseUrl) {
        this.credentialsDraft.proxyBaseUrl = safeString(proxy.baseUrl, this.credentialsDraft.proxyBaseUrl);
      }
      if (!this.formTouched.proxyHeaderName) {
        this.credentialsDraft.proxyHeaderName = safeString(proxy.authHeaderName, this.credentialsDraft.proxyHeaderName || 'X-NT-Token');
      }
      if (!this.formTouched.proxyProjectId) {
        this.credentialsDraft.proxyProjectId = safeString(proxy.projectId, this.credentialsDraft.proxyProjectId);
      }

      if (this.fields.proxyBaseUrl && this.fields.proxyBaseUrl.value !== this.credentialsDraft.proxyBaseUrl) {
        this.fields.proxyBaseUrl.value = this.credentialsDraft.proxyBaseUrl;
      }
      if (this.fields.proxyHeaderName && this.fields.proxyHeaderName.value !== this.credentialsDraft.proxyHeaderName) {
        this.fields.proxyHeaderName.value = this.credentialsDraft.proxyHeaderName;
      }
      if (this.fields.proxyProjectId && this.fields.proxyProjectId.value !== this.credentialsDraft.proxyProjectId) {
        this.fields.proxyProjectId.value = this.credentialsDraft.proxyProjectId;
      }

      const byokStatus = credentials.hasByokKey
        ? (credentials.byokPersisted ? 'Ключ установлен (локально)' : 'Ключ установлен (текущая сессия)')
        : 'Ключ не установлен';
      Ui.setText(this.fields.byokStatus, byokStatus);

      const proxyStatusCore = proxy.hasAuthToken
        ? (proxy.authTokenPersisted ? 'Токен установлен (локально)' : 'Токен установлен (текущая сессия)')
        : 'Токен не установлен';
      const connectionTest = security.lastConnectionTest && typeof security.lastConnectionTest === 'object'
        ? security.lastConnectionTest
        : null;
      const connectionLine = connectionTest
        ? (connectionTest.ok
          ? ` | проверка: ok${connectionTest.endpointHost ? ` (${connectionTest.endpointHost})` : ''}`
          : ` | проверка: ${safeString(connectionTest.error && connectionTest.error.code, 'ошибка')}`)
        : '';
      Ui.setText(this.fields.proxyStatus, `${proxyStatusCore}${connectionLine}`);

      this._renderPasswordToggles();
    }

    _buildProfileSettingsSnapshot() {
      const settings = this.vm.settings && typeof this.vm.settings === 'object' ? this.vm.settings : {};
      const userSettings = settings.userSettings && typeof settings.userSettings === 'object'
        ? settings.userSettings
        : {};
      const effectiveSettings = settings.effectiveSettings && typeof settings.effectiveSettings === 'object'
        ? settings.effectiveSettings
        : {};
      const translationModelList = normalizeModelSpecList(settings.translationModelList);
      const legacyAllowlist = normalizeModelSpecList(settings.translationAgentAllowedModels);
      const requestedAllowlist = normalizeModelSpecList(
        userSettings
        && userSettings.models
        && Array.isArray(userSettings.models.agentAllowedModels)
          ? userSettings.models.agentAllowedModels
          : settings.translationAgentAllowedModels
      );
      const appliedAllowlist = normalizeModelSpecList(
        effectiveSettings
        && effectiveSettings.models
        && Array.isArray(effectiveSettings.models.agentAllowedModels)
          ? effectiveSettings.models.agentAllowedModels
          : settings.translationAgentAllowedModels
      );
      const availableSpecSet = new Set(translationModelList);
      const rejectedAllowlist = requestedAllowlist.filter((spec) => availableSpecSet.size > 0 && !availableSpecSet.has(spec));

      const snapshot = cloneJson(settings, {}) || {};
      snapshot.schemaVersion = Number.isFinite(Number(settings.schemaVersion)) ? Number(settings.schemaVersion) : null;
      snapshot.updatedAt = Number.isFinite(Number(settings.updatedAt)) ? Number(settings.updatedAt) : null;
      snapshot.translationModelList = translationModelList;
      snapshot.translationAgentAllowedModels = legacyAllowlist;
      snapshot.requestedAgentAllowedModels = requestedAllowlist;
      snapshot.appliedAgentAllowedModels = appliedAllowlist;
      snapshot.rejectedAgentAllowedModels = rejectedAllowlist;
      snapshot.translationAgentProfileRequested = normalizeProfileId(
        userSettings.profile || settings.translationAgentProfile,
        'minimal'
      );
      snapshot.translationAgentProfileApplied = normalizeProfileId(
        effectiveSettings.effectiveProfile || effectiveSettings.profile,
        snapshot.translationAgentProfileRequested
      );
      snapshot.modelPriorityRoles = this._deriveRolePresetSummary();
      snapshot.translationAgentProfile = snapshot.translationAgentProfileApplied
        || snapshot.translationAgentProfileRequested
        || normalizeProfileId(snapshot.translationAgentProfile, 'minimal');
      if (effectiveSettings.agent && typeof effectiveSettings.agent === 'object') {
        snapshot.translationAgentExecutionMode = safeString(effectiveSettings.agent.agentMode, snapshot.translationAgentExecutionMode || 'agent');
      }
      if (effectiveSettings.caching && typeof effectiveSettings.caching === 'object') {
        snapshot.translationApiCacheEnabled = effectiveSettings.caching.compatCache !== false;
      }
      if (effectiveSettings.ui && typeof effectiveSettings.ui === 'object') {
        snapshot.translationCompareRendering = safeString(
          effectiveSettings.ui.compareRendering,
          safeString(snapshot.translationCompareRendering, 'auto')
        );
      }
      if (effectiveSettings.memory && typeof effectiveSettings.memory === 'object') {
        snapshot.translationMemoryEnabled = effectiveSettings.memory.enabled !== false;
        snapshot.translationMemoryMaxPages = Number.isFinite(Number(effectiveSettings.memory.maxPages))
          ? Number(effectiveSettings.memory.maxPages)
          : snapshot.translationMemoryMaxPages;
        snapshot.translationMemoryMaxBlocks = Number.isFinite(Number(effectiveSettings.memory.maxBlocks))
          ? Number(effectiveSettings.memory.maxBlocks)
          : snapshot.translationMemoryMaxBlocks;
        snapshot.translationMemoryMaxAgeDays = Number.isFinite(Number(effectiveSettings.memory.maxAgeDays))
          ? Number(effectiveSettings.memory.maxAgeDays)
          : snapshot.translationMemoryMaxAgeDays;
        snapshot.translationMemoryGcOnStartup = effectiveSettings.memory.gcOnStartup !== false;
        snapshot.translationMemoryIgnoredQueryParams = Array.isArray(effectiveSettings.memory.ignoredQueryParams)
          ? effectiveSettings.memory.ignoredQueryParams.slice()
          : snapshot.translationMemoryIgnoredQueryParams;
      }
      const liveJob = this.snapshot && this.snapshot.translationJob && typeof this.snapshot.translationJob === 'object'
        ? this.snapshot.translationJob
        : null;
      const liveAgentState = this.snapshot && this.snapshot.agentState && typeof this.snapshot.agentState === 'object'
        ? this.snapshot.agentState
        : null;
      const liveStatus = safeString(liveJob && liveJob.status, '').trim().toLowerCase();
      const runtimeStage = safeString(liveJob && liveJob.runtime && liveJob.runtime.stage, '').trim().toLowerCase();
      const runtimeActive = Boolean(
        liveJob
        && liveStatus
        && liveStatus !== 'idle'
        && liveStatus !== 'done'
        && liveStatus !== 'failed'
        && liveStatus !== 'cancelled'
      );
      if (runtimeActive) {
        const runSettings = liveJob.runSettings && typeof liveJob.runSettings === 'object'
          ? liveJob.runSettings
          : {};
        const runSettingsEffective = runSettings.effective && typeof runSettings.effective === 'object'
          ? runSettings.effective
          : (runSettings.effectiveSummary && typeof runSettings.effectiveSummary === 'object'
            ? runSettings.effectiveSummary
            : {});
        snapshot.runtimeApplied = {
          jobId: safeString(liveJob.id, ''),
          status: liveStatus,
          stage: runtimeStage || null,
          updatedAt: Number.isFinite(Number(liveJob.updatedAt)) ? Number(liveJob.updatedAt) : null,
          selectedCategories: Array.isArray(liveJob.selectedCategories) ? liveJob.selectedCategories.slice(0, 60) : [],
          runSettingsEffective,
          runSettingsAgentOverrides: runSettings.agentOverrides && typeof runSettings.agentOverrides === 'object'
            ? runSettings.agentOverrides
            : {},
          runSettingsUserOverrides: runSettings.userOverrides && typeof runSettings.userOverrides === 'object'
            ? runSettings.userOverrides
            : {},
          agentRuntimeTuning: liveAgentState && liveAgentState.runtimeTuning && typeof liveAgentState.runtimeTuning === 'object'
            ? liveAgentState.runtimeTuning
            : {},
          agentModelPolicy: liveAgentState && liveAgentState.modelPolicy && typeof liveAgentState.modelPolicy === 'object'
            ? liveAgentState.modelPolicy
            : {},
          agentToolConfigEffective: liveAgentState && liveAgentState.toolConfigEffective && typeof liveAgentState.toolConfigEffective === 'object'
            ? liveAgentState.toolConfigEffective
            : {},
          agentProfile: normalizeProfileId(liveAgentState && liveAgentState.profile ? liveAgentState.profile : '', ''),
          agentResolvedProfile: liveAgentState && liveAgentState.resolvedProfile && typeof liveAgentState.resolvedProfile === 'object'
            ? liveAgentState.resolvedProfile
            : {}
        };
      } else if (Object.prototype.hasOwnProperty.call(snapshot, 'runtimeApplied')) {
        delete snapshot.runtimeApplied;
      }
      snapshot.userSettings = userSettings;
      snapshot.effectiveSettings = effectiveSettings;
      snapshot.overrides = settings.overrides && typeof settings.overrides === 'object'
        ? settings.overrides
        : {};

      if (Object.prototype.hasOwnProperty.call(snapshot, 'legacyProjection')) {
        delete snapshot.legacyProjection;
      }
      return redactSensitive(snapshot);
    }

    _collectHistoryEntries() {
      const out = [];
      const agentState = this.snapshot && this.snapshot.agentState && typeof this.snapshot.agentState === 'object'
        ? this.snapshot.agentState
        : {};
      const toolTrace = Array.isArray(agentState.toolExecutionTrace) ? agentState.toolExecutionTrace : [];
      toolTrace.forEach((entry, idx) => {
        const row = entry && typeof entry === 'object' ? entry : {};
        const toolName = safeString(row.toolName || row.tool, 'unknown');
        const status = safeString(row.status, 'ok').toLowerCase();
        const requestPayload = redactSensitive({
          tool: toolName,
          callId: row.meta && row.meta.callId ? row.meta.callId : null,
          requestId: row.meta && row.meta.requestId ? row.meta.requestId : null,
          args: row.meta && row.meta.args && typeof row.meta.args === 'object'
            ? row.meta.args
            : (row.args && typeof row.args === 'object' ? row.args : {})
        });
        const responsePayload = redactSensitive({
          tool: toolName,
          callId: row.meta && row.meta.callId ? row.meta.callId : null,
          requestId: row.meta && row.meta.requestId ? row.meta.requestId : null,
          status,
          message: safeString(row.message, ''),
          output: row.meta && Object.prototype.hasOwnProperty.call(row.meta, 'output')
            ? row.meta.output
            : (Object.prototype.hasOwnProperty.call(row, 'output') ? row.output : null)
        });

        out.push({
          id: `agent-req-${idx}-${Number(row.ts || 0)}`,
          ts: Number.isFinite(Number(row.ts)) ? Number(row.ts) : Date.now(),
          source: 'agent',
          type: 'request',
          status: 'ok',
          title: `Инструмент ${toolName} • запрос`,
          message: safeString(row.message, ''),
          payload: requestPayload
        });
        out.push({
          id: `agent-res-${idx}-${Number(row.ts || 0)}`,
          ts: Number.isFinite(Number(row.ts)) ? Number(row.ts) : Date.now(),
          source: 'agent',
          type: 'response',
          status,
          title: `Инструмент ${toolName} • ответ`,
          message: safeString(row.message, ''),
          payload: responsePayload
        });
      });

      const eventLog = this.snapshot && this.snapshot.eventLog && typeof this.snapshot.eventLog === 'object'
        ? this.snapshot.eventLog
        : {};
      const items = Array.isArray(eventLog.items) ? eventLog.items : [];
      items.forEach((entry) => {
        const row = entry && typeof entry === 'object' ? entry : {};
        const tag = safeString(row.tag, '').toLowerCase();
        let source = 'event';
        if (tag.startsWith('ai.')) {
          source = 'ai';
        } else if (tag.startsWith('translation.')) {
          source = 'translation';
        }
        let type = 'event';
        if (tag.includes('request') || tag.endsWith('.sent')) {
          type = 'request';
        } else if (tag.includes('response') || tag.endsWith('.applied')) {
          type = 'response';
        }
        out.push({
          id: `event-${Number(row.seq || 0)}-${Number(row.ts || 0)}-${tag}`,
          ts: Number.isFinite(Number(row.ts)) ? Number(row.ts) : Date.now(),
          source,
          type,
          status: safeString(row.level, 'info').toLowerCase(),
          title: tag || 'event',
          message: safeString(row.message, ''),
          payload: redactSensitive({
            seq: Number.isFinite(Number(row.seq)) ? Number(row.seq) : null,
            ts: Number.isFinite(Number(row.ts)) ? Number(row.ts) : null,
            level: safeString(row.level, ''),
            tag,
            message: safeString(row.message, ''),
            meta: row.meta && typeof row.meta === 'object' ? row.meta : {}
          })
        });
      });

      return out
        .sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0))
        .slice(0, 180);
    }

    _historyBadgeTone(status) {
      const key = safeString(status, '').trim().toLowerCase();
      if (key === 'ok' || key === 'done' || key === 'info') {
        return 'ok';
      }
      if (key === 'warn' || key === 'warning' || key === 'coalesced' || key === 'skipped') {
        return 'warn';
      }
      if (key === 'error' || key === 'failed' || key === 'danger') {
        return 'danger';
      }
      return '';
    }

    _filteredHistoryEntries() {
      const sourceFilter = normalizeHistorySource(this.uiState.historySourceFilter);
      const typeFilter = normalizeHistoryType(this.uiState.historyTypeFilter);
      const all = this._collectHistoryEntries();
      return all.filter((entry) => {
        if (sourceFilter !== 'all' && entry.source !== sourceFilter) {
          return false;
        }
        if (typeFilter !== 'all' && entry.type !== typeFilter) {
          return false;
        }
        return true;
      });
    }

    _renderHistory() {
      if (!this.fields.historyList) {
        return;
      }
      if (this.fields.historySourceFilter && this.fields.historySourceFilter.value !== this.uiState.historySourceFilter) {
        this.fields.historySourceFilter.value = this.uiState.historySourceFilter;
      }
      if (this.fields.historyTypeFilter && this.fields.historyTypeFilter.value !== this.uiState.historyTypeFilter) {
        this.fields.historyTypeFilter.value = this.uiState.historyTypeFilter;
      }

      const entries = this._filteredHistoryEntries();
      this._historyEntries = entries.slice();
      Ui.setText(this.fields.historyCount, `Записей: ${entries.length}`);
      Ui.setHidden(this.fields.historyEmpty, entries.length > 0);

      const renderKey = JSON.stringify({
        sourceFilter: this.uiState.historySourceFilter,
        typeFilter: this.uiState.historyTypeFilter,
        ids: entries.map((entry) => entry.id)
      });
      if (this._historyRenderKey === renderKey) {
        return;
      }
      this._historyRenderKey = renderKey;

      Ui.clearNode(this.fields.historyList);
      if (!entries.length) {
        return;
      }

      entries.forEach((entry, index) => {
        const details = this.doc.createElement('details');
        details.className = 'popup__history-item';

        const summary = this.doc.createElement('summary');
        summary.className = 'popup__history-summary';

        const meta = this.doc.createElement('span');
        meta.className = 'popup__history-meta';
        const sourceBadge = this.doc.createElement('span');
        sourceBadge.className = 'popup__history-badge';
        sourceBadge.textContent = entry.source;
        const typeBadge = this.doc.createElement('span');
        typeBadge.className = 'popup__history-badge';
        typeBadge.textContent = entry.type;
        const statusBadge = this.doc.createElement('span');
        const tone = this._historyBadgeTone(entry.status);
        statusBadge.className = `popup__history-badge${tone ? ` popup__history-badge--${tone}` : ''}`;
        statusBadge.textContent = safeString(entry.status, 'info') || 'info';
        meta.appendChild(sourceBadge);
        meta.appendChild(typeBadge);
        meta.appendChild(statusBadge);

        const title = this.doc.createElement('span');
        title.className = 'popup__history-title';
        title.textContent = safeString(entry.title, 'event');

        const time = this.doc.createElement('span');
        time.className = 'popup__history-time';
        time.textContent = formatTs(entry.ts);

        summary.appendChild(meta);
        summary.appendChild(title);
        summary.appendChild(time);
        details.appendChild(summary);

        const body = this.doc.createElement('div');
        body.className = 'popup__history-body';
        if (entry.message) {
          body.appendChild(Ui.createElement('div', {
            className: 'popup__hint',
            text: shortText(entry.message, 260)
          }));
        }
        const pre = this.doc.createElement('pre');
        pre.className = 'popup__history-json';
        pre.textContent = JSON.stringify(entry.payload, null, 2);
        body.appendChild(pre);
        const copyButton = Ui.createIconButton({
          icon: 'copy',
          label: I18n.t('popup.btnCopyHistoryRow', 'Копировать запись'),
          tooltip: I18n.t('tooltips.historyCopyRow', 'Копирует JSON этой записи в буфер.'),
          attrs: {
            'data-action': 'copy-history-row',
            'data-history-index': String(index)
          }
        });
        body.appendChild(copyButton);
        details.appendChild(body);
        this.fields.historyList.appendChild(details);
      });
    }

    _copyTextToClipboard(text, okMessage) {
      const value = safeString(text, '');
      if (!value) {
        this.toasts.show(I18n.t('common.noData', 'Нет данных'), { tone: 'warn' });
        return;
      }
      const clipboard = global.navigator && global.navigator.clipboard && typeof global.navigator.clipboard.writeText === 'function'
        ? global.navigator.clipboard
        : null;
      if (!clipboard) {
        this.toasts.show('Clipboard API недоступен.', { tone: 'warn' });
        return;
      }
      clipboard.writeText(value)
        .then(() => {
          this.toasts.show(okMessage || I18n.t('common.copyDone', 'Скопировано в буфер'), { tone: 'ok' });
        })
        .catch(() => {
          this.toasts.show(I18n.t('common.errorUnknown', 'Неизвестная ошибка'), { tone: 'danger' });
        });
    }

    _copySettingsJsonToClipboard() {
      const payload = this._buildProfileSettingsSnapshot();
      this._copyTextToClipboard(
        JSON.stringify(payload, null, 2),
        I18n.t('popup.copySettingsDone', 'JSON настроек скопирован.')
      );
    }

    _copyHistoryJsonToClipboard() {
      const entries = this._filteredHistoryEntries();
      this._copyTextToClipboard(
        JSON.stringify(entries, null, 2),
        I18n.t('popup.copyHistoryDone', 'JSON истории скопирован.')
      );
    }

    _copyHistoryRowToClipboard(trigger) {
      const index = Number(trigger && trigger.getAttribute ? trigger.getAttribute('data-history-index') : NaN);
      if (!Number.isFinite(index) || index < 0 || index >= this._historyEntries.length) {
        this.toasts.show(I18n.t('common.noData', 'Нет данных'), { tone: 'warn' });
        return;
      }
      const entry = this._historyEntries[index];
      this._copyTextToClipboard(
        JSON.stringify(entry && entry.payload ? entry.payload : {}, null, 2),
        I18n.t('popup.copyHistoryDone', 'JSON истории скопирован.')
      );
    }

    _renderErrors() {
      const lastError = this.vm.lastError && typeof this.vm.lastError === 'object' ? this.vm.lastError : null;
      const hasError = Boolean(lastError);
      Ui.setHidden(this.fields.errorBox, !hasError);
      Ui.setHidden(this.fields.errorEmpty, hasError);
      if (!hasError) {
        return;
      }
      Ui.setText(this.fields.errorCode, safeString(lastError.code, 'UNKNOWN'));
      Ui.setText(this.fields.errorMessage, shortText(lastError.message, 220) || I18n.t('common.errorUnknown', 'Неизвестная ошибка'));
    }

    _canUseTranslatedModes() {
      const status = safeString(this.vm.status, '').toLowerCase();
      const activeStatuses = ['running', 'completing', 'proofreading', 'done'];
      if (activeStatuses.includes(status)) {
        return true;
      }
      const stage = safeString(this.vm.stage, '').toLowerCase();
      if (activeStatuses.includes(stage)) {
        return true;
      }
      const done = Number(this.vm && this.vm.progress ? this.vm.progress.done : 0);
      return Number.isFinite(done) && done > 0;
    }

    _renderViewModeButtons() {
      const tabId = this._getTargetTabId();
      const mode = this.snapshot && this.snapshot.translationDisplayModeByTab && tabId
        ? safeString(this.snapshot.translationDisplayModeByTab[tabId], 'translated')
        : 'translated';
      const normalized = ['original', 'translated', 'compare'].includes(mode) ? mode : 'translated';
      const canUseTranslatedModes = this._canUseTranslatedModes();
      const activeMode = canUseTranslatedModes ? normalized : 'original';
      const buttons = this.root.querySelectorAll('[data-action="set-view-mode"]');
      buttons.forEach((button) => {
        const value = button.getAttribute('data-mode');
        const defaultTitle = value === 'original'
          ? I18n.t('tooltips.modeOriginal', 'Показывать оригинальный текст страницы.')
          : (value === 'translated'
            ? I18n.t('tooltips.modeTranslated', 'Показывать переведенный текст.')
            : I18n.t('tooltips.modeCompare', 'Показывать отличия оригинала и перевода.'));
        const requiresTranslation = value === 'translated' || value === 'compare';
        const disabled = requiresTranslation && !canUseTranslatedModes;
        button.disabled = disabled;
        button.title = defaultTitle;
        if (disabled) {
          button.title = I18n.t(
            'popup.viewModeLocked',
            'Режим доступен после старта перевода или когда есть готовые переведенные блоки.'
          );
        }
        if (value === activeMode) {
          button.classList.add('is-active');
        } else {
          button.classList.remove('is-active');
        }
      });
    }

    _renderButtonsState() {
      const status = safeString(this.vm.status, '').toLowerCase();
      const stage = safeString(this.vm.stage, '').toLowerCase();
      const busy = ['preparing', 'planning', 'running', 'completing', 'proofreading'].includes(status)
        || ['preparing', 'planning', 'running', 'completing', 'proofreading'].includes(stage);
      const targetTabId = this._getTargetTabId();
      const hasTab = Boolean(targetTabId);
      const unscriptableCached = Boolean(
        hasTab
        && this.tabMetaCache
        && this.tabMetaCache.tabId === targetTabId
        && this.tabMetaCache.scriptable === false
      );

      const start = this.root.querySelector('[data-action="start-translation"]');
      const cancel = this.root.querySelector('[data-action="cancel-translation"]');
      const erase = this.root.querySelector('[data-action="clear-translation-data"]');
      const startSelected = this.root.querySelector('[data-action="start-selected-categories"]');
      const reclassifyForce = this.root.querySelector('[data-action="reclassify-force"]');
      const saveByok = this.root.querySelector('[data-action="save-byok"]');
      const saveProxy = this.root.querySelector('[data-action="save-proxy"]');

      if (start) {
        start.disabled = !hasTab || busy || unscriptableCached;
        start.title = I18n.t('tooltips.popupTranslate', 'Запускает перевод для текущей вкладки.');
        if (unscriptableCached) {
          start.title = I18n.t(
            'popup.errorUnscriptableTab',
            'Эту вкладку нельзя переводить (служебная страница браузера или магазина расширений).'
          );
        }
      }
      if (cancel) {
        const cancellable = ['preparing', 'planning', 'awaiting_categories', 'running', 'completing', 'proofreading'];
        cancel.disabled = !hasTab || !(cancellable.includes(status) || cancellable.includes(stage));
      }
      if (erase) {
        erase.disabled = !hasTab;
      }
      if (startSelected) {
        startSelected.disabled = !hasTab || !this.vm.awaitingCategories || this.categoryDraft.size === 0;
      }
      if (reclassifyForce) {
        reclassifyForce.disabled = !hasTab || !this.vm.awaitingCategories;
      }
      if (saveByok) {
        saveByok.disabled = safeString(this.credentialsDraft.byokKey, '').trim().length === 0;
      }
      if (saveProxy) {
        saveProxy.disabled = safeString(this.credentialsDraft.proxyBaseUrl, '').trim().length === 0;
      }
    }

    _showErrorToast(error) {
      let message = error && error.message ? error.message : I18n.t('common.errorUnknown', 'Неизвестная ошибка');
      const normalized = safeString(message, '').toLowerCase();
      if (normalized.includes(SCRIPTING_BLOCKED_PHRASE)) {
        message = I18n.t(
          'popup.errorUnscriptableTab',
          'Эту вкладку нельзя переводить (служебная страница браузера или магазина расширений).'
        );
      }
      this.toasts.show(shortText(message, 180), { tone: 'danger' });
    }
  }

  function resolveInitialTabId() {
    const normalizeTabId = (value) => {
      const num = Number(value);
      if (!Number.isFinite(num)) {
        return null;
      }
      const rounded = Math.floor(num);
      return rounded > 0 ? rounded : null;
    };

    try {
      const params = new URLSearchParams(global.location.search || '');
      const value = normalizeTabId(params.get('tabId'));
      if (value) {
        return Promise.resolve(value);
      }
    } catch (_) {
      // fallback
    }
    if (!global.chrome || !global.chrome.tabs || typeof global.chrome.tabs.query !== 'function') {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      try {
        global.chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          const first = Array.isArray(tabs) && tabs.length ? tabs[0] : null;
          resolve(normalizeTabId(first && first.id));
        });
      } catch (_) {
        resolve(null);
      }
    });
  }

  (async () => {
    const tabId = await resolveInitialTabId();
    const app = new PopupApp(global.document);
    await app.init(tabId);
  })();
})(globalThis);
