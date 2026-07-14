import { expect, test } from '@playwright/test';

import {
  authMode,
  localPassword,
  localUsername,
  signInLocal,
  workspacePath,
} from './fixtures/auth.js';

test.skip(authMode !== 'local', 'local authentication deployment only');
test.describe.configure({ mode: 'serial' });

test('rejects invalid credentials and creates a strict scoped session cookie', async ({
  context,
  page,
}) => {
  await page.goto(workspacePath);
  await page.getByLabel('Username').fill(localUsername);
  await page.getByLabel('Password').fill('definitely-not-the-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toHaveText('Sign-in failed.');

  await signInLocal(page);
  const cookie = (await context.cookies()).find(
    ({ name }) => name === 'flanterminal_session',
  );
  expect(cookie).toMatchObject({
    httpOnly: true,
    sameSite: 'Strict',
    secure: false,
    path: workspacePath === '/' ? '/' : workspacePath.replace(/\/$/u, ''),
  });
});

test('signs out without terminating the container-local tmux session', async ({
  page,
}) => {
  const marker = `LOGOUT_${Date.now()}`;
  await page.goto(workspacePath);
  await signInLocal(page);
  await sendTerminalCommand(page, `export LOGOUT_MARKER=${marker}`);
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await signInLocal(page);
  await sendTerminalCommand(page, `printf 'RESTORED_%s\\n' "$LOGOUT_MARKER"`);
  await expect
    .poll(() =>
      page.locator('.terminal-panel:not([hidden]) .xterm-rows').innerText(),
    )
    .toContain(`RESTORED_${marker}`);
});

test('changes and restores the enrolled administrator password', async ({
  page,
}) => {
  const original = localPassword();
  const replacement = `${original}-replacement`;
  await page.goto(workspacePath);
  await signInLocal(page);

  await changePassword(page, original, replacement);
  await signInLocal(page, replacement);
  await changePassword(page, replacement, original);
  await signInLocal(page, original);
});

async function changePassword(
  page: import('@playwright/test').Page,
  current: string,
  replacement: string,
): Promise<void> {
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByLabel('Current password').fill(current);
  await page.getByLabel('New password').fill(replacement);
  await page.getByRole('button', { name: 'Change password' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
}

async function sendTerminalCommand(
  page: import('@playwright/test').Page,
  command: string,
): Promise<void> {
  await expect(page.locator('.terminal-tab.is-active .tab-status')).toHaveClass(
    /status-connected/,
  );
  await page
    .locator('.terminal-panel:not([hidden])')
    .getByRole('region', { name: 'Terminal' })
    .focus();
  await page.keyboard.type(command);
  await page.keyboard.press('Enter');
}
