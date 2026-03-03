const { test, expect } = require('../fixtures/extension-fixture');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRuntimeStage(state) {
  const runtime = state && state.job && state.job.runtime && typeof state.job.runtime === 'object'
    ? state.job.runtime
    : {};
  return String(runtime.stage || '').toLowerCase();
}

function hasExecutionStarted(state) {
  if (!state || typeof state !== 'object') {
    return false;
  }
  if (state.jobStatus === 'done') {
    return true;
  }
  const stage = getRuntimeStage(state);
  if (stage === 'execution' || stage === 'proofreading' || stage === 'completing') {
    return true;
  }
  const completed = Number.isFinite(Number(state.job && state.job.completedBlocks))
    ? Number(state.job.completedBlocks)
    : 0;
  return completed > 0;
}

function pickCategoriesFromState(state, { categoryLimit = 6 } = {}) {
  const job = state && state.job && typeof state.job === 'object' ? state.job : {};
  const available = Array.isArray(job.availableCategories) ? job.availableCategories : [];
  const recommendations = job.categoryRecommendations && typeof job.categoryRecommendations === 'object'
    ? job.categoryRecommendations
    : (job.agentState && job.agentState.categoryRecommendations && typeof job.agentState.categoryRecommendations === 'object'
      ? job.agentState.categoryRecommendations
      : null);
  const recommended = recommendations && Array.isArray(recommendations.recommended)
    ? recommendations.recommended
    : (Array.isArray(job.selectedCategories) ? job.selectedCategories : []);
  const merged = recommended.concat(available.filter((category) => !recommended.includes(category)));
  return (merged.length ? merged : available).slice(0, Math.max(1, Number(categoryLimit) || 1));
}

async function selectCategoriesAndContinue(app, tabId, state, { categoryLimit = 6 } = {}) {
  const categories = pickCategoriesFromState(state, { categoryLimit });
  expect(categories.length).toBeGreaterThan(0);
  const selectRes = await app.sendCommand('SET_TRANSLATION_CATEGORIES', {
    tabId,
    jobId: state && state.jobId ? state.jobId : null,
    categories,
    mode: 'replace'
  }, tabId);
  if (selectRes && selectRes.ok === true) {
    return true;
  }
  const fallback = await app.readTabState(tabId).catch(() => null);
  return hasExecutionStarted(fallback);
}

async function beginTranslationFlow(app, tabId, { attempts = 2, categoryLimit = 6 } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const startRes = await app.sendCommand('START_TRANSLATION', { tabId }, tabId);
    if (!startRes || startRes.ok !== true) {
      lastError = new Error(`START_TRANSLATION failed: ${JSON.stringify(startRes || null)}`);
      if (attempt >= attempts) {
        throw lastError;
      }
      await sleep(400 * attempt);
      continue;
    }
    try {
      const state = await app.waitForState(
        tabId,
        (row) => row && (
          row.jobStatus === 'awaiting_categories'
          || hasExecutionStarted(row)
          || row.jobStatus === 'done'
        ),
        { timeoutMs: 120000, label: 'awaiting_categories|running|done' }
      );
      if (state && hasExecutionStarted(state)) {
        return;
      }
      const accepted = await selectCategoriesAndContinue(app, tabId, state, { categoryLimit });
      expect(accepted).toBeTruthy();
      return;
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) {
        throw error;
      }
      await app.sendCommand('CANCEL_TRANSLATION', { tabId }, tabId).catch(() => null);
      await sleep(500 * attempt);
    }
  }
  throw lastError || new Error('beginTranslationFlow failed');
}

test.describe('Frames/Shadow/Highlights e2e', () => {
  test('G1: scan/apply covers iframe srcdoc and same-origin iframe', async ({ app }) => {
    test.setTimeout(app.isRealMode ? 420000 : 180000);
    await app.configureTestBackend();
    const site = await app.openSite('/iframe.html');
    const tabId = await app.resolveTabIdByUrl(site.url());

    const srcdocOriginal = ((await site.frameLocator('#frame-srcdoc').locator('#srcdoc-text').textContent()) || '').trim();
    const childOriginal = ((await site.frameLocator('#frame-same-origin').locator('#frame-child-text').textContent()) || '').trim();
    expect(srcdocOriginal.length).toBeGreaterThan(0);
    expect(childOriginal.length).toBeGreaterThan(0);

    await beginTranslationFlow(app, tabId, { categoryLimit: 20 });
    await app.waitForState(tabId, (state) => state && state.jobStatus === 'done', {
      timeoutMs: app.isRealMode ? 300000 : 130000,
      label: 'done'
    });

    await expect.poll(
      async () => (((await site.frameLocator('#frame-srcdoc').locator('#srcdoc-text').textContent()) || '').trim()),
      { timeout: app.isRealMode ? 90000 : 40000 }
    ).not.toBe(srcdocOriginal);
    await expect.poll(
      async () => (((await site.frameLocator('#frame-same-origin').locator('#frame-child-text').textContent()) || '').trim()),
      { timeout: app.isRealMode ? 90000 : 40000 }
    ).not.toBe(childOriginal);

    await site.close();
  });

  test('G2: scan detects open shadow text and apply writes into shadow root', async ({ app }) => {
    test.setTimeout(app.isRealMode ? 420000 : 180000);
    await app.configureTestBackend();
    const site = await app.openSite('/shadow.html');
    const tabId = await app.resolveTabIdByUrl(site.url());

    const originalShadow = await site.evaluate(() => {
      const host = document.getElementById('shadow-host');
      if (!host || !host.shadowRoot) {
        return '';
      }
      const node = host.shadowRoot.getElementById('shadow-text');
      return node ? String(node.textContent || '') : '';
    });
    expect(originalShadow.length).toBeGreaterThan(0);
    await expect.poll(async () => {
      return site.evaluate(() => {
        const host = document.getElementById('shadow-host');
        if (!host || !host.shadowRoot) {
          return '';
        }
        const node = host.shadowRoot.getElementById('shadow-text');
        return node ? String(node.textContent || '') : '';
      });
    }, { timeout: 10000 }).toContain('inside open shadow root');

    const startRes = await app.sendCommand('START_TRANSLATION', { tabId }, tabId);
    expect(startRes && startRes.ok).toBeTruthy();
    const stage = await app.waitForState(
      tabId,
      (state) => state && (
        state.jobStatus === 'awaiting_categories'
        || hasExecutionStarted(state)
        || state.jobStatus === 'done'
      ),
      { timeoutMs: 120000, label: 'awaiting_categories|running|done' }
    );
    const blocks = stage && stage.job && stage.job.blocksById && typeof stage.job.blocksById === 'object'
      ? Object.values(stage.job.blocksById)
      : [];
    const hasShadowText = blocks.some((row) => row && typeof row.originalText === 'string' && row.originalText.includes('inside open shadow root'));
    expect(hasShadowText).toBeTruthy();

    if (stage && stage.jobStatus === 'awaiting_categories') {
      const accepted = await selectCategoriesAndContinue(app, tabId, stage, { categoryLimit: Math.max(1, blocks.length || 1) });
      expect(accepted).toBeTruthy();
    }

    await app.waitForState(tabId, (state) => state && state.jobStatus === 'done', {
      timeoutMs: app.isRealMode ? 300000 : 130000,
      label: 'done'
    });

    const translatedShadow = await site.evaluate(() => {
      const host = document.getElementById('shadow-host');
      if (!host || !host.shadowRoot) {
        return '';
      }
      const node = host.shadowRoot.getElementById('shadow-text');
      return node ? String(node.textContent || '') : '';
    });
    expect(translatedShadow).not.toBe(originalShadow);

    await site.close();
  });

  test('G3: compare mode uses CSS highlights without mark wrappers', async ({ app }) => {
    test.setTimeout(app.isRealMode ? 420000 : 180000);
    await app.configureTestBackend();
    const site = await app.openSite('/simple.html');
    const tabId = await app.resolveTabIdByUrl(site.url());

    await beginTranslationFlow(app, tabId, { categoryLimit: 5 });
    await app.waitForState(tabId, (state) => state && state.jobStatus === 'done', {
      timeoutMs: app.isRealMode ? 300000 : 130000,
      label: 'done'
    });

    await app.sendCommand('SET_TRANSLATION_VISIBILITY', { tabId, mode: 'compare', visible: true }, tabId);
    const supportsHighlights = await site.evaluate(() => Boolean(globalThis.CSS && CSS.highlights && typeof globalThis.Highlight === 'function'));
    expect(supportsHighlights).toBeTruthy();

    await expect.poll(async () => await site.locator('mark.nt-diff-ins').count(), { timeout: 20000 }).toBe(0);
    await expect.poll(async () => {
      return site.evaluate(() => {
        if (!globalThis.CSS || !CSS.highlights) {
          return 0;
        }
        const highlight = CSS.highlights.get('nt-diff');
        if (!highlight) {
          return 0;
        }
        let count = 0;
        if (typeof highlight.forEach === 'function') {
          highlight.forEach(() => { count += 1; });
          return count;
        }
        if (typeof highlight[Symbol.iterator] === 'function') {
          for (const _item of highlight) {
            count += 1;
          }
          return count;
        }
        if (Number.isFinite(Number(highlight.size))) {
          return Number(highlight.size);
        }
        return count;
      });
    }, { timeout: 20000 }).toBeGreaterThan(0);

    await site.close();
  });
});
