const { test, expect } = require('../fixtures/extension-fixture');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function countTranslatedBlocks(state) {
  const blocks = state && state.job && state.job.blocksById && typeof state.job.blocksById === 'object'
    ? Object.values(state.job.blocksById)
    : [];
  return blocks.reduce((sum, row) => {
    if (row && typeof row.translatedText === 'string' && row.translatedText.trim()) {
      return sum + 1;
    }
    return sum;
  }, 0);
}

function getAgentCategoryOptions(job) {
  const safeJob = job && typeof job === 'object' ? job : {};
  const fromJob = safeJob.categoryQuestion && typeof safeJob.categoryQuestion === 'object'
    ? safeJob.categoryQuestion
    : null;
  if (fromJob && Array.isArray(fromJob.options)) {
    return fromJob.options;
  }
  const agent = safeJob.agentState && typeof safeJob.agentState === 'object'
    ? safeJob.agentState
    : {};
  const fromAgent = agent.userQuestion && typeof agent.userQuestion === 'object'
    ? agent.userQuestion
    : null;
  return fromAgent && Array.isArray(fromAgent.options) ? fromAgent.options : [];
}

function getRecommendedCategories(job) {
  const safeJob = job && typeof job === 'object' ? job : {};
  const rec = safeJob.categoryRecommendations && typeof safeJob.categoryRecommendations === 'object'
    ? safeJob.categoryRecommendations
    : (safeJob.agentState && safeJob.agentState.categoryRecommendations && typeof safeJob.agentState.categoryRecommendations === 'object'
      ? safeJob.agentState.categoryRecommendations
      : null);
  if (!rec || !Array.isArray(rec.recommended)) {
    return [];
  }
  return rec.recommended
    .map((item) => String(item || '').trim().toLowerCase())
    .filter(Boolean);
}

function pickCategoriesFromState(state, { maxCategories = 6 } = {}) {
  const job = state && state.job && typeof state.job === 'object' ? state.job : {};
  const options = getAgentCategoryOptions(job);
  const available = Array.isArray(job.availableCategories) ? job.availableCategories : [];
  const all = [];
  options.forEach((row) => {
    const id = String(row && row.id ? row.id : '').trim().toLowerCase();
    if (id && !all.includes(id)) {
      all.push(id);
    }
  });
  available.forEach((idRaw) => {
    const id = String(idRaw || '').trim().toLowerCase();
    if (id && !all.includes(id)) {
      all.push(id);
    }
  });
  const recommended = getRecommendedCategories(job).filter((id) => all.includes(id));
  const merged = recommended.concat(all.filter((id) => !recommended.includes(id)));
  return (merged.length ? merged : all).slice(0, Math.max(1, Number(maxCategories) || 1));
}

async function selectCategoriesAndRun(app, tabId, awaitingState, { mode = 'replace', maxCategories = 6 } = {}) {
  let sourceState = awaitingState;
  let categories = pickCategoriesFromState(sourceState, { maxCategories });
  expect(categories.length).toBeGreaterThan(0);

  const sendSelection = async (state) => app.sendCommand('SET_TRANSLATION_CATEGORIES', {
    tabId,
    jobId: state && state.jobId ? state.jobId : null,
    categories,
    mode
  }, tabId, { timeoutMs: 120000 });

  let selectRes = await sendSelection(sourceState);
  if (selectRes && selectRes.ok === true) {
    await app.sendCommand('KICK_SCHEDULER', { tabId }, tabId);
    return categories;
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const fallback = await app.readTabState(tabId).catch(() => null);
    const status = fallback && typeof fallback.jobStatus === 'string' ? fallback.jobStatus : '';
    if (status === 'running' || status === 'done') {
      return categories;
    }
    if (status !== 'awaiting_categories') {
      sourceState = await app.waitForState(
        tabId,
        (state) => state && (
          state.jobStatus === 'awaiting_categories'
          || state.jobStatus === 'running'
          || state.jobStatus === 'done'
        ),
        { timeoutMs: 90000, label: 'awaiting_categories before selection retry' }
      );
      if (sourceState.jobStatus === 'running' || sourceState.jobStatus === 'done') {
        return categories;
      }
    } else {
      sourceState = fallback;
    }
    categories = pickCategoriesFromState(sourceState, { maxCategories });
    expect(categories.length).toBeGreaterThan(0);
    selectRes = await sendSelection(sourceState);
    if (selectRes && selectRes.ok === true) {
      await app.sendCommand('KICK_SCHEDULER', { tabId }, tabId);
      return categories;
    }
  }
  if (!(selectRes && selectRes.ok)) {
    throw new Error(`SET_TRANSLATION_CATEGORIES failed: ${JSON.stringify(selectRes || null)}`);
  }
  return categories;
}

test.describe('Mega chaos pipeline', () => {
  test('full pipeline on 2000+ blocks fixture (headed)', async ({ app }, testInfo) => {
    test.skip(testInfo.project.name !== 'ext-headed', 'Этот сценарий запускается только в headed режиме для визуального прогона.');
    test.setTimeout(720000);

    await app.configureTestBackend({ mode: 'mock' });

    const site = await app.openSite('/mega-chaos.html');
    await site.waitForSelector('#mega-ready[data-ready="1"]', { timeout: 30000 });

    const blocksDeclared = await site.locator('#mega-counter').textContent();
    const declaredCount = Number(String(blocksDeclared || '0').trim()) || 0;
    expect(declaredCount).toBeGreaterThanOrEqual(2000);

    const textNodeCount = await site.evaluate(() => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const value = String(node && node.nodeValue ? node.nodeValue : '').replace(/\s+/g, ' ').trim();
          if (!value) {
            return NodeFilter.FILTER_REJECT;
          }
          const parent = node.parentElement;
          if (!parent) {
            return NodeFilter.FILTER_REJECT;
          }
          const tag = String(parent.tagName || '').toLowerCase();
          if (tag === 'script' || tag === 'style' || tag === 'noscript') {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        }
      });
      let count = 0;
      while (walker.nextNode()) {
        count += 1;
      }
      return count;
    });
    expect(textNodeCount).toBeGreaterThanOrEqual(2000);

    const tabId = await app.resolveTabIdByUrl(site.url());
    const popup = await app.openPopupPage(tabId);

    const originalIntro = ((await site.textContent('#mega-intro')) || '').trim();
    await popup.locator('[data-action="start-translation"]').click();

    let state = await app.waitForState(
      tabId,
      (current) => current && (
        current.jobStatus === 'awaiting_categories'
        || current.jobStatus === 'running'
        || current.jobStatus === 'done'
        || current.jobStatus === 'failed'
      ),
      { timeoutMs: 420000, label: 'awaiting_categories|running|done|failed' }
    );

    if (state.jobStatus === 'awaiting_categories') {
      await popup.locator('[data-tab="status"]').click();
      const chooser = popup.locator('[data-section="category-chooser"]');
      const chooserVisible = await chooser.isVisible().catch(() => false);
      if (chooserVisible) {
        const toggles = popup.locator('[data-section="category-chooser-list"] input[type="checkbox"]:not([disabled])');
        await expect.poll(async () => toggles.count(), { timeout: 30000 }).toBeGreaterThanOrEqual(3);
        const count = await toggles.count();
        for (let i = 0; i < count; i += 1) {
          const cb = toggles.nth(i);
          if (!(await cb.isChecked())) {
            await cb.check();
          }
        }
        await popup.locator('[data-action="start-selected-categories"]').click();
      } else {
        await selectCategoriesAndRun(app, tabId, state, { mode: 'replace', maxCategories: 12 });
      }
      state = await app.waitForState(
        tabId,
        (current) => current && (
          current.jobStatus === 'running'
          || current.jobStatus === 'done'
          || current.jobStatus === 'failed'
        ),
        { timeoutMs: 180000, label: 'running|done|failed after categories' }
      );
    }

    if (state.jobStatus === 'failed') {
      const runtime = await app.readTabState(tabId);
      const exported = await app.exportReportJson(tabId, { logsLimit: 400, toolTraceLimit: 120, patchLimit: 120 });
      const exportedJob = exported && exported.ok && exported.report && exported.report.job
        ? exported.report.job
        : null;
      const statusText = runtime
        && runtime.statusEntry
        && typeof runtime.statusEntry.statusText === 'string'
        ? runtime.statusEntry.statusText
        : null;
      const runtimeMessage = runtime && runtime.job && typeof runtime.job.message === 'string'
        ? runtime.job.message
        : null;
      const runtimeError = runtime && runtime.job && runtime.job.error ? runtime.job.error : null;
      const runtimeAgentState = runtime && runtime.job && runtime.job.agentState && typeof runtime.job.agentState === 'object'
        ? runtime.job.agentState
        : null;
      const runtimeMarkers = runtimeAgentState && runtimeAgentState.planningMarkers
        ? runtimeAgentState.planningMarkers
        : null;
      const runtimeTaxonomyCount = runtimeAgentState
        && runtimeAgentState.taxonomy
        && Array.isArray(runtimeAgentState.taxonomy.categories)
        ? runtimeAgentState.taxonomy.categories.length
        : 0;
      const runtimeBlockMapCount = runtimeAgentState
        && runtimeAgentState.taxonomy
        && runtimeAgentState.taxonomy.blockToCategory
        && typeof runtimeAgentState.taxonomy.blockToCategory === 'object'
        ? Object.keys(runtimeAgentState.taxonomy.blockToCategory).length
        : 0;
      const runtimePipelineCount = runtimeAgentState
        && runtimeAgentState.pipeline
        && runtimeAgentState.pipeline.modelRouting
        && typeof runtimeAgentState.pipeline.modelRouting === 'object'
        ? Object.keys(runtimeAgentState.pipeline.modelRouting).length
        : 0;
      const runtimeReportsTail = runtimeAgentState && Array.isArray(runtimeAgentState.reports)
        ? runtimeAgentState.reports.slice(-3)
        : [];
      const exportedMessage = exportedJob && typeof exportedJob.message === 'string' ? exportedJob.message : null;
      const exportedError = exportedJob && exportedJob.error ? exportedJob.error : null;
      throw new Error(
        `Перевод завершился failed после выбора категорий. statusText=${statusText || 'n/a'};`
        + ` runtimeMessage=${runtimeMessage || 'n/a'}; runtimeError=${JSON.stringify(runtimeError || null)};`
        + ` exportedMessage=${exportedMessage || 'n/a'}; exportedError=${JSON.stringify(exportedError || null)};`
        + ` markers=${JSON.stringify(runtimeMarkers || null)}; taxonomyCount=${runtimeTaxonomyCount};`
        + ` blockMapCount=${runtimeBlockMapCount}; pipelineCount=${runtimePipelineCount};`
        + ` reportsTail=${JSON.stringify(runtimeReportsTail)}`
      );
    }
    expect(['running', 'done']).toContain(state.jobStatus);

    let translatedState = null;
    try {
      translatedState = await app.waitForState(
        tabId,
        (current) => current && (countTranslatedBlocks(current) >= 1 || current.jobStatus === 'done'),
        { timeoutMs: 240000, label: 'translated blocks >= 1' }
      );
    } catch (_) {
      translatedState = await app.readTabState(tabId).catch(() => null);
    }

    const translatedReady = Boolean(translatedState && countTranslatedBlocks(translatedState) >= 1);
    if (translatedReady) {
      await expect.poll(async () => ((await site.textContent('#mega-intro')) || '').trim(), { timeout: 120000 }).not.toBe(originalIntro);

      await expect.poll(
        async () => popup.locator('[data-action="set-view-mode"][data-mode="translated"]').isDisabled(),
        { timeout: 30000 }
      ).toBeFalsy();
      await expect.poll(
        async () => popup.locator('[data-action="set-view-mode"][data-mode="compare"]').isDisabled(),
        { timeout: 30000 }
      ).toBeFalsy();

      await popup.locator('[data-action="set-view-mode"][data-mode="translated"]').click();
      await sleep(300);
      await popup.locator('[data-action="set-view-mode"][data-mode="compare"]').click();
      await sleep(300);
      await popup.locator('[data-action="set-view-mode"][data-mode="original"]').click();
    }

    const debug = await app.openDebugPage(tabId, 'overview');
    await expect(debug.locator('.debug__tabs')).toBeVisible({ timeout: 15000 });
    await debug.locator('.debug__tabs [data-tab="diff"]').first().click();
    await expect.poll(async () => debug.url().includes('#diff'), { timeout: 15000 }).toBeTruthy();
    await debug.locator('.debug__tabs [data-tab="tools"]').first().click();
    await expect.poll(async () => debug.url().includes('#tools'), { timeout: 15000 }).toBeTruthy();

    await popup.screenshot({ path: testInfo.outputPath('mega-popup-running.png') });
    await debug.screenshot({ path: testInfo.outputPath('mega-debug-running.png') });
    await site.screenshot({ path: testInfo.outputPath('mega-site-running.png'), fullPage: true });

    if (state.jobStatus !== 'done') {
      await popup.locator('[data-action="cancel-translation"]').click();
      state = await app.waitForState(
        tabId,
        (current) => current && (
          current.jobStatus === 'cancelled'
          || current.jobStatus === 'done'
          || current.jobStatus === 'failed'
        ),
        { timeoutMs: 180000, label: 'cancelled|done|failed' }
      );
      expect(['cancelled', 'done', 'failed']).toContain(state.jobStatus);
    }

    await popup.locator('[data-action="clear-translation-data"]').click();
    await app.waitForState(
      tabId,
      (current) => current && current.jobStatus !== 'running',
      { timeoutMs: 90000, label: 'not running after clear' }
    );

    await debug.close();
    await popup.close();
    await site.close();
  });
});
