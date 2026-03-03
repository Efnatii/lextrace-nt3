const { test, expect } = require('./fixtures/extension-fixture');

test.describe('Popup UI tabs and credentials', () => {
  test('popup tabs persist and core controls work', async ({ app }) => {
    test.setTimeout(180000);
    await app.configureTestBackend({ mode: 'mock' });

    const site = await app.openSite('/simple.html');
    const tabId = await app.resolveTabIdByUrl(site.url());

    const popup = await app.openPopupPage(tabId);

    await popup.locator('[data-tab="settings"]').click();
    await expect(popup.locator('[data-tab-panel="settings"]')).toBeVisible();
    await expect.poll(
      async () => (await popup.locator('[data-field="profile-json-viewer"]').textContent()) || '',
      { timeout: 15000 }
    ).toContain('"userSettings"');
    const snapshotAudit = await popup.evaluate(() => {
      const raw = String(document.querySelector('[data-field="profile-json-viewer"]')?.textContent || '{}');
      const parsed = JSON.parse(raw);
      return {
        hasLegacyProjectionTopLevel: Object.prototype.hasOwnProperty.call(parsed, 'legacyProjection'),
        hasRequested: Array.isArray(parsed.requestedAgentAllowedModels),
        hasLegacyAllowlist: Array.isArray(parsed.translationAgentAllowedModels)
      };
    });
    expect(snapshotAudit.hasLegacyProjectionTopLevel).toBeFalsy();
    expect(snapshotAudit.hasRequested).toBeTruthy();
    expect(snapshotAudit.hasLegacyAllowlist).toBeTruthy();
    await popup.locator('[data-profile-pipeline-tab="policy"]').click();
    await expect.poll(
      async () => {
        const raw = String(await popup.locator('[data-field="profile-json-viewer"]').textContent() || '{}');
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed.appliedAgentAllowedModels);
      },
      { timeout: 15000 }
    ).toBeTruthy();
    await popup.locator('[data-profile-pipeline-tab="input"]').click();
    await expect(popup.locator('[data-action="copy-settings-json"]')).toBeVisible();
    await popup.locator('[data-field="profile-json-viewer"] [data-action="open-profile-param-editor"][data-param-key="userSettings.profile"][data-profile-role="value"]').click();
    await popup.locator('[data-field="profile-json-editor-select"]').selectOption('minimal');
    await expect.poll(
      async () => (await popup.locator('[data-field="profile-json-viewer"]').textContent()) || '',
      { timeout: 15000 }
    ).toContain('"profile": "minimal"');
    await popup.locator('[data-field="profile-json-viewer"] [data-action="open-profile-param-editor"][data-param-key="userSettings.profile"][data-profile-role="value"]').click();
    await popup.locator('[data-field="profile-json-editor-select"]').selectOption('optimized');
    await expect.poll(
      async () => (await popup.locator('[data-field="profile-json-viewer"]').textContent()) || '',
      { timeout: 15000 }
    ).toContain('"profile": "optimized"');
    await popup.locator('[data-profile-pipeline-tab="runtime"]').click();
    await expect.poll(
      async () => (await popup.locator('[data-field="profile-json-viewer"]').textContent()) || '',
      { timeout: 15000 }
    ).toContain('"maxBatchSizeOverride": 16');
    await expect.poll(
      async () => (await popup.locator('[data-field="profile-json-viewer"]').textContent()) || '',
      { timeout: 15000 }
    ).toContain('"parallelismOverride": "high"');
    await popup.locator('[data-profile-pipeline-tab="input"]').click();
    await expect.poll(
      async () => popup.locator('[data-field="profile-json-viewer"] [data-action="open-profile-param-editor"]').count(),
      { timeout: 15000 }
    ).toBeGreaterThan(0);
    const firstEditableParam = popup.locator('[data-field="profile-json-viewer"] [data-action="open-profile-param-editor"]').first();
    await expect(firstEditableParam).toHaveAttribute('title', /.+/);
    await firstEditableParam.click();
    await expect(popup.locator('[data-field="profile-json-editor"]')).toBeVisible();
    await expect(popup.locator('[data-field="profile-json-editor-title"]')).toContainText(/\S+/);
    const editorSelect = popup.locator('[data-field="profile-json-editor-select"]');
    await expect(editorSelect).toBeVisible();
    const optionCount = await editorSelect.locator('option').count();
    if (optionCount > 1) {
      const value = await editorSelect.locator('option').nth(1).getAttribute('value');
      if (value) {
        await editorSelect.selectOption(value);
      }
      await expect(popup.locator('[data-field="profile-json-editor"]')).toBeHidden();
    } else {
      await popup.keyboard.press('Escape');
    }
    await popup.locator('[data-field="profile-json-viewer"] [data-action="open-profile-param-editor"][data-param-key="modelPriorityRoles.agent"][data-profile-role="value"]').click();
    await popup.locator('[data-field="profile-json-editor-select"]').selectOption('cheap_fast');
    await expect.poll(
      async () => (await popup.locator('[data-field="profile-json-viewer"]').textContent()) || '',
      { timeout: 15000 }
    ).toMatch(/"profile": "(minimal|medium|optimized|maximum|custom)"/);
    await popup.locator('[data-profile-pipeline-tab="runtime"]').click();
    await expect.poll(
      async () => (await popup.locator('[data-field="profile-json-viewer"]').textContent()) || '',
      { timeout: 15000 }
    ).toContain('"modelSelection"');
    await popup.locator('[data-profile-pipeline-tab="input"]').click();

    await popup.locator('[data-tab="history"]').click();
    await expect(popup.locator('[data-tab-panel="history"]')).toBeVisible();
    await expect.poll(
      async () => (await popup.locator('[data-field="history-count"]').textContent()) || '',
      { timeout: 15000 }
    ).toMatch(/Записей:\s*\d+/);
    await expect(popup.locator('[data-action="copy-history-json"]')).toBeVisible();
    await popup.locator('[data-tab="settings"]').click();
    const profileLegendToggle = popup.locator('[data-action="toggle-profile-marker"][data-marker="profile"]');
    await expect(profileLegendToggle).toBeVisible();
    await profileLegendToggle.click();
    await expect(profileLegendToggle).toHaveAttribute('aria-pressed', 'false');
    await expect(popup.locator('#popupRoot')).toHaveClass(/popup--hide-marker-profile/);
    await popup.waitForTimeout(420);

    await popup.close();
    const popup2 = await app.openPopupPage(tabId);
    await expect(popup2.locator('[data-tab-panel="settings"]')).toBeVisible();
    await expect(popup2.locator('[data-action="toggle-profile-marker"][data-marker="profile"]')).toHaveAttribute('aria-pressed', 'false');
    await expect(popup2.locator('#popupRoot')).toHaveClass(/popup--hide-marker-profile/);

    const byokInput = popup2.locator('[data-field="byok-input"]');
    let byokVisible = await byokInput.isVisible();
    if (!byokVisible) {
      await popup2.locator('[data-field="connection-mode-byok"]').click({ force: true });
      await popup2.waitForTimeout(400);
      byokVisible = await byokInput.isVisible();
    }
    if (byokVisible) {
      await expect(byokInput).toHaveAttribute('type', 'password');
      await popup2.locator('[data-action="toggle-byok-visibility"]').click();
      await expect(byokInput).toHaveAttribute('type', 'text');
      await popup2.locator('[data-action="toggle-byok-visibility"]').click();
      await expect(byokInput).toHaveAttribute('type', 'password');
    } else {
      const proxyToken = popup2.locator('[data-field="proxy-token"]');
      await expect(proxyToken).toBeVisible();
      await expect(proxyToken).toHaveAttribute('type', 'password');
      await popup2.locator('[data-action="toggle-proxy-visibility"]').click();
      await expect(proxyToken).toHaveAttribute('type', 'text');
      await popup2.locator('[data-action="toggle-proxy-visibility"]').click();
      await expect(proxyToken).toHaveAttribute('type', 'password');
    }

    await popup2.locator('[data-field="profile-json-viewer"] [data-action="open-profile-param-editor"][data-param-key="userSettings.models.agentAllowedModels"][data-profile-role="key"]').click();
    await expect(popup2.locator('[data-field="profile-json-models-editor"]')).toBeVisible();
    await expect.poll(async () => popup2.locator('[data-field="model-rows"] tr').count(), { timeout: 15000 }).toBeGreaterThan(0);
    const hasPrice = await popup2.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('[data-field="model-rows"] tr'));
      return rows.some((row) => {
        const cells = Array.from(row.querySelectorAll('td'));
        return cells.slice(3, 6).some((cell) => /\d/.test(String(cell.textContent || '')));
      });
    });
    expect(hasPrice).toBeTruthy();

    const scrollProbe = await popup2.evaluate(() => {
      const wrap = document.querySelector('[data-field="model-table-wrap"]');
      if (!wrap || wrap.scrollHeight <= (wrap.clientHeight + 4)) {
        return { skipped: true, before: 0 };
      }
      wrap.scrollTop = Math.max(0, wrap.scrollHeight - wrap.clientHeight - 12);
      return { skipped: false, before: wrap.scrollTop };
    });
    if (!scrollProbe.skipped) {
      const lastModelCheckbox = popup2.locator('[data-field="model-rows"] input[data-model-spec]').last();
      await lastModelCheckbox.scrollIntoViewIfNeeded();
      await lastModelCheckbox.click();
      const afterScroll = await popup2.evaluate(() => {
        const wrap = document.querySelector('[data-field="model-table-wrap"]');
        return wrap ? wrap.scrollTop : 0;
      });
      expect(afterScroll).toBeGreaterThan(8);
    }
    await popup2.keyboard.press('Escape');
    await expect(popup2.locator('[data-field="profile-json-models-editor"]')).toBeHidden();

    await popup2.locator('[data-field="profile-json-viewer"] [data-action="open-profile-param-editor"][data-param-key="userSettings.models.modelUserPriority"][data-profile-role="key"]').click();
    await expect(popup2.locator('[data-field="profile-json-models-editor"]')).toBeVisible();
    await popup2.keyboard.press('Escape');
    await popup2.locator('[data-field="profile-json-viewer"] [data-action="open-profile-param-editor"][data-param-key="translationAgentAllowedModels"][data-profile-role="key"]').click();
    await expect(popup2.locator('[data-field="profile-json-models-editor"]')).toBeVisible();
    await popup2.keyboard.press('Escape');
    await popup2.locator('[data-field="profile-json-viewer"] [data-action="open-profile-param-editor"][data-param-key="translationModelList"][data-profile-role="key"]').click();
    await expect(popup2.locator('[data-field="profile-json-models-editor"]')).toBeVisible();
    await popup2.keyboard.press('Escape');

    await popup2.locator('[data-tab="status"]').click();
    const pageErrors = [];
    popup2.on('pageerror', (error) => pageErrors.push(String(error && error.message ? error.message : error)));
    await expect(popup2.locator('[data-action="set-view-mode"][data-mode="translated"]')).toBeDisabled();
    await expect(popup2.locator('[data-action="set-view-mode"][data-mode="compare"]')).toBeDisabled();

    await popup2.locator('[data-action="start-translation"]').click();
    await app.waitForState(
      tabId,
      (state) => state && state.jobStatus && state.jobStatus !== 'idle',
      { timeoutMs: 90000, label: 'job started from popup' }
    );
    await expect.poll(
      async () => {
        const state = await app.readTabState(tabId);
        const lang = state && state.job && typeof state.job.targetLang === 'string'
          ? state.job.targetLang
        : '';
        return String(lang || '').trim().toLowerCase();
      },
      { timeout: 15000 }
    ).toBe('ru');
    const afterStart = await app.readTabState(tabId);
    const statusAfterStart = String(afterStart && afterStart.jobStatus ? afterStart.jobStatus : '').toLowerCase();
    if (statusAfterStart === 'awaiting_categories') {
      await popup2.locator('[data-action="start-translation"]').click();
      await expect(popup2.locator('[data-action="set-view-mode"][data-mode="translated"]')).toBeDisabled();
      await expect(popup2.locator('[data-action="set-view-mode"][data-mode="compare"]')).toBeDisabled();
    } else if (['running', 'completing', 'proofreading', 'done'].includes(statusAfterStart)) {
      await expect.poll(
        async () => popup2.locator('[data-action="set-view-mode"][data-mode="translated"]').isDisabled(),
        { timeout: 15000 }
      ).toBeFalsy();
      await expect.poll(
        async () => popup2.locator('[data-action="set-view-mode"][data-mode="compare"]').isDisabled(),
        { timeout: 15000 }
      ).toBeFalsy();
    } else {
      await expect(popup2.locator('[data-action="set-view-mode"][data-mode="translated"]')).toBeDisabled();
      await expect(popup2.locator('[data-action="set-view-mode"][data-mode="compare"]')).toBeDisabled();
    }

    await popup2.locator('[data-action="cancel-translation"]').click().catch(() => null);
    await popup2.locator('[data-action="clear-translation-data"]').click().catch(() => null);
    expect(pageErrors).toEqual([]);

    await popup2.close();
    await site.close();
  });
});
