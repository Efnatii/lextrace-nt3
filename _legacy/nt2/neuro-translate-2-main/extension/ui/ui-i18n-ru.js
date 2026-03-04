(function initUiI18nRu(global) {
  const NT = global.NT || (global.NT = {});

  const dict = {
    common: {
      appName: 'Нейро Переводчик',
      noData: 'Нет данных',
      loading: 'Загрузка...',
      connected: 'Связь с фоном есть',
      reconnecting: 'Нет связи, переподключаюсь...',
      disconnected: 'Нет связи',
      copyDone: 'Скопировано в буфер',
      errorUnknown: 'Неизвестная ошибка',
      yes: 'Да',
      no: 'Нет'
    },
    stage: {
      idle: 'Ожидание',
      preparing: 'Сканирование',
      planning: 'Анализ агентом',
      analysis_in_progress: 'Анализ агентом',
      planning_in_progress: 'Анализ агентом',
      awaiting_categories: 'Выбор категорий',
      running: 'Перевод',
      execution_in_progress: 'Перевод',
      execution: 'Перевод',
      completing: 'Вычитка',
      proofreading: 'Вычитка',
      proofreading_in_progress: 'Вычитка',
      done: 'Готово',
      failed: 'Ошибка',
      cancelled: 'Отменено',
      unknown: 'Неизвестный этап'
    },
    status: {
      queued: 'В очереди',
      idle: 'Ожидание',
      running: 'Выполняется',
      done: 'Готово',
      failed: 'Ошибка',
      cancelled: 'Отменено'
    },
    popup: {
      subtitle: 'Управление переводом страницы',
      tabStatus: 'Статус',
      tabSettings: 'Настройки',
      tabHistory: 'История',
      tabErrors: 'Ошибки',
      sectionProfile: 'Профиль',
      sectionModels: 'Модели (разрешенный список)',
      sectionAccess: 'Доступ и ключи',
      byok: 'BYOK ключ',
      proxy: 'Прокси',
      btnTranslate: 'Перевести',
      btnCancel: 'Отменить',
      btnErase: 'Стереть задачу и данные',
      btnDebug: 'Отладка',
      btnStartSelected: 'Начать перевод выбранного',
      btnReclassify: 'Пересканировать',
      btnAddLater: 'Добавить позже',
      btnOpenDebugError: 'Открыть отладку',
      btnPickOnPage: 'Выбрать на странице',
      btnSave: 'Сохранить',
      btnClear: 'Очистить',
      btnSaveProfilePreset: 'Сохранить профиль',
      btnApplyProfilePreset: 'Применить профиль',
      btnDeleteProfilePreset: 'Удалить профиль',
      btnTestConnection: 'Проверить соединение',
      btnCopySettingsJson: 'Копировать JSON настроек',
      btnCopyHistoryJson: 'Копировать JSON истории',
      btnCopyHistoryRow: 'Копировать запись',
      modeOriginal: 'Оригинал',
      modeTranslated: 'Перевод',
      modeCompare: 'Сравнение',
      presetCheap: 'Дёшево',
      presetBalanced: 'Баланс',
      presetQuality: 'Качество',
      savedProfilesPlaceholder: 'Сохраненные профили',
      categoriesHint: 'Категории появятся после этапа планирования.',
      leaseWarning: 'Аренда задачи истекла. Откройте отладку и проверьте планировщик.',
      showSecret: 'Показать',
      hideSecret: 'Скрыть',
      viewModeLocked: 'Режим доступен после старта перевода или когда есть готовые переведенные блоки.',
      errorUnscriptableTab: 'Эту вкладку нельзя переводить (служебная страница браузера или магазина расширений).',
      profilePresetNameRequired: 'Введите имя профиля для сохранения.',
      profilePresetSaved: 'Профиль сохранен.',
      profilePresetApplied: 'Профиль применен.',
      profilePresetDeleted: 'Профиль удален.',
      profilePresetSelectFirst: 'Сначала выберите сохраненный профиль.',
      profilePresetMissing: 'Профиль не найден.',
      profileEditorSelectPlaceholder: 'Выберите значение',
      profileEditorCustomOption: 'Свое значение',
      profileEditorClosed: 'Редактирование параметра отменено.',
      profileParamUpdated: 'Параметр профиля обновлен.',
      profileParamInvalid: 'Недопустимое значение параметра.',
      profileParamAllowed: 'Допустимые',
      profileParamBoolHint: 'Для этого параметра используйте true/false.',
      profileParamNumberHint: 'Для этого параметра требуется число.',
      profileParamJsonHint: 'Для этого параметра требуется валидный JSON.',
      profileParamReadonly: 'Это вычисляемое поле: изменяйте соответствующий userSettings параметр.',
      modelUnavailableHint: 'Этот model spec сейчас вне translationModelList. При выборе будет автоматически добавлен в runtime список.',
      profilePipelineInput: 'Ввод',
      profilePipelinePolicy: 'Политика',
      profilePipelineRuntime: 'Рантайм',
      profilePipelineService: 'Сервис',
      copySettingsDone: 'JSON настроек скопирован.',
      copyHistoryDone: 'JSON истории скопирован.'
    },
    debug: {
      title: 'Панель оператора',
      subtitle: 'Текущая вкладка и состояние задачи',
      navOverview: 'Обзор',
      navPlan: 'План',
      navTools: 'Инструменты',
      navDiffPatches: 'Патчи',
      navCategories: 'Категории',
      navMemory: 'Память',
      navRateLimits: 'Лимиты',
      navPerf: 'Производительность',
      navSecurity: 'Безопасность',
      navExport: 'Экспорт',
      btnExportJson: 'Экспорт отчета JSON',
      btnExportHtml: 'Экспорт HTML',
      btnCopyDiagnostics: 'Копировать диагностику',
      btnKickScheduler: 'Пнуть планировщик',
      btnCancel: 'Отменить',
      btnErase: 'Стереть',
      btnReclassify: 'Переклассифицировать',
      btnRepair: 'Исправить/сжать',
      planNotReady: 'План еще не построен для текущей задачи.',
      categoriesHidden: 'Категории доступны только на этапе выбора категорий.',
      includeTextMode: 'Режим текста в экспорте',
      includeNone: 'без текста',
      includeSnippets: 'фрагменты',
      includeFull: 'полный'
    },
    tooltips: {
      popupTranslate: 'Запускает перевод для текущей вкладки.',
      popupCancel: 'Останавливает текущую задачу.',
      popupErase: 'Удаляет задачу и данные перевода для вкладки.',
      popupDebug: 'Открывает расширенную страницу отладки.',
      popupStartSelected: 'Запустить перевод по выбранным категориям.',
      popupReclassify: 'Пересканировать категории принудительно.',
      popupAddLater: 'Отложить выбор категорий на потом.',
      popupPickOnPage: 'Открыть диалог выбора категорий прямо на переводимой странице.',
      modeOriginal: 'Показывать оригинальный текст страницы.',
      modeTranslated: 'Показывать переведенный текст.',
      modeCompare: 'Показывать отличия оригинала и перевода.',
      profile: 'Профиль влияет на баланс скорости и качества.',
      models: 'Список моделей, разрешенных для агента.',
      byokSave: 'Сохранить BYOK ключ.',
      byokClear: 'Удалить BYOK ключ.',
      proxySave: 'Сохранить прокси-конфиг.',
      proxyClear: 'Очистить прокси-конфиг.',
      testConnection: 'Проверить подключение к backend.',
      presetCheap: 'Выбрать самые дешевые модели.',
      presetBalanced: 'Выбрать сбалансированный набор моделей.',
      presetQuality: 'Выбрать приоритет качества.',
      profileSavePreset: 'Сохранить текущие userSettings как профиль.',
      profileApplyPreset: 'Применить выбранный сохраненный профиль.',
      profileDeletePreset: 'Удалить выбранный сохраненный профиль.',
      settingsJsonCopy: 'Копирует форматированный JSON текущих настроек из snapshot.',
      profilePipelineInput: 'Шаг 1. Исходные значения, которые пользователь или UI отправляет в настройки.',
      profilePipelinePolicy: 'Шаг 2. Применение политик и вычисление effectiveSettings.',
      profilePipelineRuntime: 'Шаг 3. Итоговые runtime-поля, которые реально использует пайплайн.',
      profilePipelineService: 'Служебные поля версии, времени и debug-флагов.',
      historyCopy: 'Копирует текущую отфильтрованную историю JSON обмена.',
      historyCopyRow: 'Копирует JSON этой записи в буфер.',
      debugKick: 'Запускает scheduler tick принудительно.',
      diagnostics: 'Создает и копирует очищенную диагностику.',
      exportJson: 'Скачать очищенный JSON-отчет.',
      exportHtml: 'Скачать HTML-отчет для передачи коллегам.'
    }
  };

  function getByPath(path, fallback = '') {
    const safePath = typeof path === 'string' ? path.trim() : '';
    if (!safePath) {
      return fallback;
    }
    const keys = safePath.split('.');
    let cursor = dict;
    for (let i = 0; i < keys.length; i += 1) {
      const key = keys[i];
      if (!cursor || typeof cursor !== 'object' || !Object.prototype.hasOwnProperty.call(cursor, key)) {
        return fallback;
      }
      cursor = cursor[key];
    }
    return typeof cursor === 'string' ? cursor : fallback;
  }

  function stageLabel(value) {
    const key = String(value || '').trim().toLowerCase();
    return getByPath(`stage.${key}`, getByPath('stage.unknown', key || getByPath('common.noData', 'Нет данных')));
  }

  function statusLabel(value) {
    const key = String(value || '').trim().toLowerCase();
    return getByPath(`status.${key}`, stageLabel(key));
  }

  NT.UiI18nRu = {
    locale: 'ru',
    dict,
    t: getByPath,
    stageLabel,
    statusLabel
  };
})(globalThis);
