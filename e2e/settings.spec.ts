import { expect, test, type Page } from '@playwright/test';

import {
  authMode,
  openAuthenticatedWorkspace,
  signInLocal,
  workspacePath,
} from './fixtures/auth.js';

test.skip(authMode !== 'local', 'local authentication deployment only');

test('persists terminal preferences across browser contexts', async ({
  browser,
  page,
}) => {
  await openAuthenticatedWorkspace(page);
  await openSettings(page);
  await page.getByLabel('Light').check();
  await page.getByLabel('Font size').fill('17');
  await page.getByLabel('Reconnect').selectOption('manual');
  await page.getByLabel('Workspace shortcuts').selectOption('disabled');
  await page.getByLabel('Stale cleanup hours').fill('1');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

  const secondContext = await browser.newContext({
    baseURL: process.env.E2E_BASE_URL ?? 'http://app:3000/',
  });
  try {
    const secondPage = await secondContext.newPage();
    await secondPage.goto(workspacePath);
    await signInLocal(secondPage);
    await openSettings(secondPage);
    await expect(secondPage.getByLabel('Light')).toBeChecked();
    await expect(secondPage.getByLabel('Font size')).toHaveValue('17');
    await expect(secondPage.getByLabel('Reconnect')).toHaveValue('manual');
    await expect(secondPage.getByLabel('Workspace shortcuts')).toHaveValue(
      'disabled',
    );

    await secondPage.getByRole('button', { name: 'Back to terminal' }).click();
    const tabCount = await secondPage.getByRole('tab').count();
    await secondPage.keyboard.press('Control+Shift+T');
    await expect(secondPage.getByRole('tab')).toHaveCount(tabCount);

    await openSettings(secondPage);
    await secondPage.getByLabel('Dark').check();
    await secondPage.getByLabel('Font size').fill('14');
    await secondPage.getByLabel('Reconnect').selectOption('automatic');
    await secondPage.getByLabel('Workspace shortcuts').selectOption('default');
    await secondPage.getByLabel('Stale cleanup hours').fill('0');
    await secondPage.getByRole('button', { name: 'Save settings' }).click();
    await expect(secondPage.locator('html')).toHaveAttribute(
      'data-theme',
      'dark',
    );
  } finally {
    await secondContext.close();
  }
});

async function openSettings(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
}
