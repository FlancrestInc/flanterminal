import { expect, type Page } from '@playwright/test';

export const workspacePath = process.env.E2E_BASE_PATH ?? '/';
export const authMode = process.env.E2E_MODE ?? 'local';
export const localUsername = process.env.E2E_LOCAL_USERNAME ?? 'webterm';

export function localPassword(): string {
  const password = process.env.E2E_LOCAL_PASSWORD;
  if (password === undefined || password.length < 12) {
    throw new Error(
      'E2E_LOCAL_PASSWORD must contain an untracked test password',
    );
  }
  return password;
}

export async function signInLocal(
  page: Page,
  password = localPassword(),
): Promise<void> {
  await page.getByLabel('Username').fill(localUsername);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('button', { name: 'Settings' })).toBeVisible();
}

export async function openAuthenticatedWorkspace(page: Page): Promise<void> {
  if (authMode === 'cloudflare') {
    const { installCloudflareAssertion } = await import('./cloudflare.js');
    await installCloudflareAssertion(page);
  }
  await page.goto(workspacePath);
  if (authMode === 'local') await signInLocal(page);
}
