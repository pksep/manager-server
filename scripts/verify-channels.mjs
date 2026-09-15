import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';

const fixtures = JSON.parse(
  readFileSync('.local/channels-browser-fixtures.json', 'utf8'),
);
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  timeout: 30000,
});
try {
  for (const { platform, width, routeId, name, text } of fixtures) {
    const context = await browser.newContext({
      viewport: { width, height: 950 },
      ...(width < 500 ? { isMobile: true, hasTouch: true } : {}),
    });
    const page = await context.newPage();
    const errors = [];
    const requests = [];
    page.on('response', (response) => {
      const url = new URL(response.url());
      if (
        url.pathname.includes('/manager/') &&
        (response.status() >= 400 || url.pathname.endsWith('/messages'))
      )
        requests.push({ path: url.pathname, status: response.status() });
    });
    page.on('pageerror', (error) => errors.push(error.message));
    try {
      await page.goto('http://127.0.0.2:4312/?manager=2', {
        waitUntil: 'domcontentloaded',
      });
      await page
        .locator('[data-testid$="MenuBottomNav-Clients"]')
        .click({ timeout: 60000 });
      await page.getByText(name, { exact: true }).filter({ visible: true }).first().click({ timeout: 45000 });
      const choice = page.getByTestId(`ClientReplyRoute-Filter-${routeId}`);
      await choice.waitFor({ timeout: 30000 });
      assert.equal(await choice.getAttribute('aria-pressed'), 'true');
      const editor = page.locator('.chat__input [contenteditable=true]').first();
      await editor.fill(text);
      await page
        .locator('.chat__input button.toolbar-button.right:visible')
        .last()
        .click();
      await page
        .getByTestId('ClientMessageDelivery')
        .filter({ hasText: 'Отправлено' })
        .last()
        .waitFor({ timeout: 45000 });
      assert.ok(!(await editor.innerText()).includes(text));
      assert.deepEqual(errors, []);
      await page.screenshot({
        path: `.local/channels-${platform}-${width}.png`,
        fullPage: true,
      });
      console.info(`PASS: ответ ${platform} из стандартного редактора, экран ${width}`);
    } catch (error) {
      const connected = await page
        .evaluate(async () =>
          (await import('/src/services/useChat.ts')).getHasWebsocketConnection(),
        )
        .catch(() => 'unknown');
      writeFileSync(
        `.local/channels-${platform}-browser-debug.json`,
        JSON.stringify({ requests, errors, connected }),
      );
      await page
        .screenshot({ path: `.local/channels-${platform}-failure.png`, fullPage: true })
        .catch(() => {});
      throw error;
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
}
