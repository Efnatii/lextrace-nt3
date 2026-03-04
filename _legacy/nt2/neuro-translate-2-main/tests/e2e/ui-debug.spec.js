const { test, expect } = require('./fixtures/extension-fixture');

test.describe('Debug UI tabs and hash routing', () => {
  test('debug tabs replace sidebar and persist active tab', async ({ app }) => {
    test.setTimeout(120000);
    await app.configureTestBackend({ mode: 'mock' });

    const site = await app.openSite('/simple.html');
    const tabId = await app.resolveTabIdByUrl(site.url());

    const debug = await app.openDebugPage(tabId);
    await expect(debug.locator('aside.debug__nav')).toHaveCount(0);

    await debug.locator('[data-tab="tools"]').click();
    await expect(debug.locator('[data-tab-panel="tools"]')).toBeVisible();
    await expect.poll(async () => new URL(debug.url()).hash).toBe('#tools');

    await debug.close();
    const debug2 = await app.openDebugPage(tabId);
    await expect(debug2.locator('[data-tab-panel="tools"]')).toBeVisible();

    await debug2.evaluate(() => {
      globalThis.location.hash = '#ratelimits';
    });
    await expect(debug2.locator('[data-tab-panel="ratelimits"]')).toBeVisible();

    await debug2.close();
    await site.close();
  });
});
