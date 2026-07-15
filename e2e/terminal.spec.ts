import { expect, test, type Page } from '@playwright/test';

import { openAuthenticatedWorkspace, workspacePath } from './fixtures/auth.js';

const marker = `phase2-${Date.now()}`;

function activePanel(page: Page) {
  return page.locator('.terminal-panel:not([hidden])');
}

async function terminalText(page: Page): Promise<string> {
  return activePanel(page).locator('.xterm-rows').innerText();
}

async function waitConnected(page: Page): Promise<void> {
  await expect(page.locator('.terminal-tab.is-active .tab-status')).toHaveClass(
    /status-connected/,
  );
  await expect(activePanel(page).locator('.xterm-screen')).not.toBeEmpty();
}

async function sendCommand(page: Page, command: string): Promise<void> {
  await activePanel(page).getByRole('region', { name: 'Terminal' }).focus();
  await page.keyboard.type(command);
  await page.keyboard.press('Enter');
}

async function expectTerminal(page: Page, text: string): Promise<void> {
  await expect.poll(() => terminalText(page)).toContain(text);
}

async function wheelUntilVisible(
  page: Page,
  text: string,
  deltaY: number,
): Promise<void> {
  const screen = activePanel(page).locator('.xterm-screen');
  const viewport = activePanel(page).locator('.xterm-viewport');
  await expect(viewport).toBeVisible();
  await screen.hover();
  await expect
    .poll(
      async () => {
        await page.mouse.wheel(0, deltaY);
        return terminalText(page);
      },
      { intervals: [50, 100, 200], timeout: 10_000 },
    )
    .toContain(text);
}

async function sessionAction(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'Session actions' }).click();
  await page.getByRole('menuitem', { name }).click();
}

test('native xterm scrolling exposes managed-session history', async ({
  page,
}) => {
  await openAuthenticatedWorkspace(page);
  await waitConnected(page);

  const earlyMarker = `SCROLLBACK_EARLY_${marker}`;
  const finalMarker = `SCROLLBACK_FINAL_${marker}`;
  await sendCommand(
    page,
    `printf '${earlyMarker}\\n'; i=1; while [ $i -le 200 ]; do printf 'SCROLLBACK_LINE_%03d\\n' "$i"; i=$((i + 1)); done; printf '${finalMarker}\\n'`,
  );
  await expectTerminal(page, finalMarker);

  await wheelUntilVisible(page, earlyMarker, -120);
  await wheelUntilVisible(page, finalMarker, 120);

  const afterMarker = `SCROLLBACK_AFTER_${marker}`;
  await sendCommand(page, `printf '${afterMarker}\\n'`);
  await wheelUntilVisible(page, afterMarker, 120);
});

test('multiple terminal tabs preserve independent shells and lifecycle state', async ({
  page,
}, testInfo) => {
  const fontResponses: string[] = [];
  const externalRequests: string[] = [];
  const reorderResponses: number[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin !== new URL(testInfo.project.use.baseURL as string).origin) {
      externalRequests.push(request.url());
    }
  });
  page.on('response', (response) => {
    if (response.url().endsWith('/api/tabs/order')) {
      reorderResponses.push(response.status());
    }
    if (response.ok() && /\.(?:ttf|woff2?)(?:\?|$)/.test(response.url())) {
      fontResponses.push(response.url());
    }
  });

  await openAuthenticatedWorkspace(page);
  await expect(page).toHaveURL(
    new RegExp(`${workspacePath.replace('/', '\\/')}$`),
  );
  await waitConnected(page);
  await expect
    .poll(() =>
      page.evaluate(
        async () =>
          (await document.fonts.load('14px "JetBrainsMono Nerd Font"')).length,
      ),
    )
    .toBeGreaterThan(0);
  expect(
    await page.evaluate(() =>
      document.fonts.check('14px "JetBrainsMono Nerd Font"'),
    ),
  ).toBe(true);
  expect(fontResponses).toHaveLength(1);
  expect(new URL(fontResponses[0]!).origin).toBe(new URL(page.url()).origin);

  const firstOutput = `FIRST_${marker}`;
  await sendCommand(
    page,
    `export FIRST_MARKER=${marker}; printf '${firstOutput}\\n'`,
  );
  await expectTerminal(page, firstOutput);

  await page.getByRole('button', { name: 'New terminal tab' }).click();
  await expect(page.getByRole('tab')).toHaveCount(2);
  await waitConnected(page);
  const secondOutput = `SECOND_${marker}`;
  await sendCommand(
    page,
    `export SECOND_MARKER=${marker}; printf '${secondOutput}\\n'`,
  );
  await expectTerminal(page, secondOutput);

  await page.getByRole('tab', { name: 'Terminal 1' }).click();
  await expectTerminal(page, firstOutput);
  await sendCommand(page, `printf 'FIRST_RESTORED_%s\\n' "$FIRST_MARKER"`);
  await expectTerminal(page, `FIRST_RESTORED_${marker}`);

  await page.getByRole('tab', { name: 'Terminal 2' }).dblclick();
  const rename = page.getByRole('textbox', { name: 'Rename Terminal 2' });
  await rename.fill('Operations');
  await rename.press('Enter');
  await expect(page.getByRole('tab', { name: 'Operations' })).toBeVisible();
  await page
    .locator('.terminal-tab')
    .nth(1)
    .dragTo(page.locator('.terminal-tab').nth(0));
  await expect.poll(() => reorderResponses).toEqual([200]);
  await expect(page.getByRole('tab').first()).toHaveText('Operations');

  await page.reload();
  await expect(page.getByRole('tab').first()).toHaveText('Operations');
  await waitConnected(page);
  const replacementSocket = page.waitForEvent('websocket', (socket) =>
    socket.url().includes('/ws/sessions/'),
  );
  await sessionAction(page, 'Restart bridge');
  await replacementSocket;
  await waitConnected(page);
  await sendCommand(page, `printf 'SECOND_RESTORED_%s\\n' "$SECOND_MARKER"`);
  await expectTerminal(page, `SECOND_RESTORED_${marker}`);

  await sessionAction(page, 'Terminate session');
  await page.getByRole('button', { name: 'Terminate session' }).click();
  await expect(page.getByText('Session stopped')).toBeVisible();
  await page.getByRole('tab', { name: 'Terminal 1' }).click();
  await waitConnected(page);
  await sendCommand(page, `printf 'FIRST_ALIVE_%s\\n' "$FIRST_MARKER"`);
  await expectTerminal(page, `FIRST_ALIVE_${marker}`);

  await page.getByRole('tab', { name: 'Operations' }).click();
  await page.getByRole('button', { name: 'Recreate session' }).click();
  await waitConnected(page);
  await page.getByRole('button', { name: 'Close Operations' }).click();
  await page.getByRole('button', { name: 'Close tab' }).click();
  await expect(page.getByRole('tab')).toHaveCount(1);

  await page.keyboard.press('Control+Shift+T');
  await expect(page.getByRole('tab')).toHaveCount(2);
  await page.keyboard.press('Control+Shift+W');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await page
    .getByRole('button', { name: /Close Terminal/ })
    .last()
    .click();
  await page.getByRole('button', { name: 'Close tab' }).click();
  await expect(page.getByRole('tab')).toHaveCount(1);

  expect(externalRequests).toEqual([]);
});

for (const viewport of [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'phone', width: 320, height: 640 },
]) {
  test(`${viewport.name} terminal layout has no toolbar overlap`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    await openAuthenticatedWorkspace(page);
    await waitConnected(page);
    const header = await page.locator('.top-bar').boundingBox();
    const terminal = await activePanel(page).boundingBox();
    const plus = await page
      .getByRole('button', { name: 'New terminal tab' })
      .boundingBox();
    const menu = await page
      .getByRole('button', { name: 'Session actions' })
      .boundingBox();
    expect(header).not.toBeNull();
    expect(terminal).not.toBeNull();
    expect(plus).not.toBeNull();
    expect(menu).not.toBeNull();
    expect((header?.y ?? 0) + (header?.height ?? 0)).toBeLessThanOrEqual(
      terminal?.y ?? 0,
    );
    expect((plus?.x ?? 0) + (plus?.width ?? 0)).toBeLessThanOrEqual(
      menu?.x ?? viewport.width,
    );
    await expect(activePanel(page).locator('.xterm-rows')).not.toBeEmpty();
    await page.screenshot({
      path: testInfo.outputPath(`${viewport.name}.png`),
    });
  });
}
