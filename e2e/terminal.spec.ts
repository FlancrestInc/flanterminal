import { expect, test, type Page } from '@playwright/test';

const workspacePath = process.env.E2E_BASE_PATH ?? '/';
const marker = `phase1-${Date.now()}`;

async function terminalText(page: Page): Promise<string> {
  return page.locator('.xterm-rows').innerText();
}

async function sendCommand(page: Page, command: string): Promise<void> {
  await page.getByRole('region', { name: 'Terminal' }).focus();
  await page.keyboard.type(command);
  await page.keyboard.press('Enter');
}

async function readTerminalSize(
  page: Page,
  phase: 'BEFORE' | 'AFTER',
): Promise<{ rows: number; cols: number }> {
  const sentinel = `${phase}_SIZE_${marker}`;
  const end = `${sentinel}_END`;
  await sendCommand(
    page,
    `printf '${sentinel} '; stty size; printf '${end}\\n'`,
  );
  await expect.poll(() => terminalText(page)).toContain(end);
  const matches = [
    ...(await terminalText(page)).matchAll(
      new RegExp(`${sentinel}\\s+(\\d+)\\s+(\\d+)\\s+${end}`, 'g'),
    ),
  ];
  const match = matches.at(-1);
  expect(match, `${phase} terminal size output`).toBeDefined();
  return { rows: Number(match?.[1]), cols: Number(match?.[2]) };
}

test('production workspace keeps its terminal session across resize and reconnect', async ({
  page,
}, testInfo) => {
  const fontResponses: string[] = [];
  const externalRequests: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin !== new URL(testInfo.project.use.baseURL as string).origin) {
      externalRequests.push(request.url());
    }
  });
  page.on('response', (response) => {
    if (response.ok() && /\.(?:ttf|woff2?)(?:\?|$)/.test(response.url())) {
      fontResponses.push(response.url());
    }
  });

  await page.goto(workspacePath);
  await expect(page).toHaveURL(
    new RegExp(`${workspacePath.replace('/', '\\/')}$`),
  );
  await expect(page.getByRole('status', { name: 'Connected' })).toBeVisible();
  await expect(page.locator('.xterm-screen')).not.toBeEmpty();

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
  expect(
    await page
      .locator('.xterm')
      .evaluate((element) => getComputedStyle(element).fontFamily),
  ).toMatch(/^['"]?JetBrainsMono Nerd Font/);
  expect(fontResponses).toHaveLength(1);
  const fontUrl = new URL(fontResponses[0]);
  expect(fontUrl.origin).toBe(new URL(page.url()).origin);
  expect(fontUrl.pathname.startsWith(workspacePath)).toBe(true);

  const output = `OUTPUT_${marker}`;
  await sendCommand(
    page,
    `export PHASE1_MARKER=${marker}; printf '${output}\\n'`,
  );
  await expect.poll(() => terminalText(page)).toContain(output);

  const before = await readTerminalSize(page, 'BEFORE');
  await page.setViewportSize({ width: 768, height: 640 });
  const after = await readTerminalSize(page, 'AFTER');
  expect(after.rows !== before.rows || after.cols !== before.cols).toBe(true);
  expect(after.rows).toBeGreaterThanOrEqual(2);
  expect(after.rows).toBeLessThanOrEqual(200);
  expect(after.cols).toBeGreaterThanOrEqual(2);
  expect(after.cols).toBeLessThanOrEqual(500);

  await page.getByRole('button', { name: 'Reconnect terminal' }).click();
  await expect(page.getByRole('status', { name: 'Connected' })).toBeVisible();
  await sendCommand(page, `printf 'RESTORED_%s\\n' "$PHASE1_MARKER"`);
  await expect.poll(() => terminalText(page)).toContain(`RESTORED_${marker}`);

  expect(externalRequests).toEqual([]);
});

for (const viewport of [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'phone', width: 320, height: 640 },
]) {
  test(`${viewport.name} terminal layout is usable`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.goto(workspacePath);
    await expect(page.getByRole('status', { name: 'Connected' })).toBeVisible();
    const header = await page.locator('.top-bar').boundingBox();
    const terminal = await page.locator('.terminal-panel').boundingBox();
    const button = await page
      .getByRole('button', { name: 'Reconnect terminal' })
      .boundingBox();
    expect(header).not.toBeNull();
    expect(terminal).not.toBeNull();
    expect(button).not.toBeNull();
    expect((header?.y ?? 0) + (header?.height ?? 0)).toBeLessThanOrEqual(
      terminal?.y ?? 0,
    );
    expect(button?.width).toBeGreaterThanOrEqual(
      viewport.width <= 768 ? 44 : 30,
    );
    expect(button?.height).toBeGreaterThanOrEqual(
      viewport.width <= 768 ? 44 : 30,
    );
    await expect(page.locator('.xterm-rows')).not.toBeEmpty();
    await page.screenshot({
      path: testInfo.outputPath(`${viewport.name}.png`),
    });
  });
}
