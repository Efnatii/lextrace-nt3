const { test, expect } = require('../fixtures/extension-fixture');

function pickCategories(state, maxCount = 6) {
  const job = state && state.job && typeof state.job === 'object' ? state.job : {};
  const fromQuestion = job.categoryQuestion && Array.isArray(job.categoryQuestion.options)
    ? job.categoryQuestion.options.map((row) => String(row && row.id ? row.id : '').trim().toLowerCase()).filter(Boolean)
    : [];
  const fromAvailable = Array.isArray(job.availableCategories)
    ? job.availableCategories.map((row) => String(row || '').trim().toLowerCase()).filter(Boolean)
    : [];
  const merged = Array.from(new Set(fromQuestion.concat(fromAvailable)));
  return merged.slice(0, Math.max(1, Number(maxCount) || 1));
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

test.describe('Complex synthetic page pipeline', () => {
  test('runs full translation cycle on complex fixture', async ({ app }) => {
    test.setTimeout(app.isRealMode ? 420000 : 220000);
    await app.configureTestBackend();

    const site = await app.openSite('/complex-pipeline.html');
    const tabId = await app.resolveTabIdByUrl(site.url());
    const popup = await app.openPopupPage(tabId);
    const originalIntro = ((await site.textContent('#cp-intro')) || '').trim();

    await popup.locator('[data-action="start-translation"]').click();

    let state = await app.waitForState(
      tabId,
      (current) => current && (
        current.jobStatus === 'awaiting_categories'
        || current.jobStatus === 'running'
        || current.jobStatus === 'done'
        || current.jobStatus === 'failed'
      ),
      { timeoutMs: app.isRealMode ? 240000 : 120000, label: 'awaiting_categories|running|done|failed' }
    );

    if (state && state.jobStatus === 'awaiting_categories') {
      const categories = pickCategories(state, 8);
      expect(categories.length).toBeGreaterThan(0);
      const selectRes = await app.sendCommand('SET_TRANSLATION_CATEGORIES', {
        tabId,
        jobId: state.jobId || null,
        categories,
        mode: 'replace'
      }, tabId);
      expect(selectRes && selectRes.ok).toBeTruthy();

      await app.sendCommand('KICK_SCHEDULER', { tabId }, tabId).catch(() => null);
      state = await app.waitForState(
        tabId,
        (current) => current && (
          current.jobStatus === 'running'
          || current.jobStatus === 'done'
          || current.jobStatus === 'failed'
          || current.jobStatus === 'cancelled'
        ),
        { timeoutMs: app.isRealMode ? 240000 : 120000, label: 'running|done|failed|cancelled' }
      );
    }

    const runningOrDone = state && (state.jobStatus === 'running' || state.jobStatus === 'done')
      ? state
      : await app.waitForState(
        tabId,
        (current) => current && (current.jobStatus === 'running' || current.jobStatus === 'done'),
        { timeoutMs: app.isRealMode ? 240000 : 120000, label: 'running|done' }
      );

    await expect.poll(async () => ((await site.textContent('#cp-intro')) || '').trim(), { timeout: 70000 }).not.toBe(originalIntro);
    await app.waitForState(
      tabId,
      (current) => current && (countTranslatedBlocks(current) > 0 || current.jobStatus === 'done'),
      { timeoutMs: app.isRealMode ? 180000 : 90000, label: 'translated blocks > 0' }
    );

    let terminal = runningOrDone;
    if (runningOrDone && runningOrDone.jobStatus === 'running') {
      await app.sendCommand('CANCEL_TRANSLATION', { tabId }, tabId).catch(() => null);
      terminal = await app.waitForState(
        tabId,
        (current) => current && (
          current.jobStatus === 'done'
          || current.jobStatus === 'cancelled'
          || current.jobStatus === 'failed'
        ),
        { timeoutMs: app.isRealMode ? 180000 : 90000, label: 'terminal after cancel' }
      );
    }
    expect(terminal && ['done', 'cancelled'].includes(terminal.jobStatus)).toBeTruthy();

    await popup.close();
    await site.close();
  });
});
