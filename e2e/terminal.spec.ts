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
  expect(new URL(fontResponses[0]).origin).toBe(new URL(page.url()).origin);

  const output = `OUTPUT_${marker}`;
  await sendCommand(
    page,
    `export PHASE1_MARKER=${marker}; printf '${output}\\n'`,
  );
  await expect.poll(() => terminalText(page)).toContain(output);

  await page.setViewportSize({ width: 768, height: 640 });
  const sizeSentinel = `SIZE_${marker}`;
  await sendCommand(
    page,
    `printf '${sizeSentinel} '; stty size; printf '${sizeSentinel}_END\\n'`,
  );
  await expect.poll(() => terminalText(page)).toContain(`${sizeSentinel}_END`);
  const sizeText = await terminalText(page);
  const match = sizeText.match(new RegExp(`${sizeSentinel} (\\d+) (\\d+)`));
  expect(match).not.toBeNull();
  const rows = Number(match?.[1]);
  const cols = Number(match?.[2]);
  expect(rows).toBeGreaterThanOrEqual(2);
  expect(rows).toBeLessThanOrEqual(200);
  expect(cols).toBeGreaterThanOrEqual(2);
  expect(cols).toBeLessThanOrEqual(500);

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
