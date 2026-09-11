import 'reflect-metadata';
import { chromium } from 'playwright';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createApplication } from '../dist/app.js';
import { readConfig } from '../dist/config.js';

const config = readConfig();
const databaseUrl = new URL(config.DATABASE_URL);
if (
  databaseUrl.hostname !== '127.0.0.1' ||
  databaseUrl.port !== '56441' ||
  databaseUrl.pathname !== '/manager_local' ||
  config.CHAT_SERVICE_URL !== 'http://127.0.0.1:4501/api'
)
  throw new Error('Проверка разрешена только на локальном стенде manager');
const runtime = await createApplication(config);
await runtime.app.listen(4314, '127.0.0.1');
const browser = await chromium.launch({
  channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome',
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
console.log('Chrome запущен для проверки виджета.');
const errors: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));
let closed = false;
async function chat(
  path: string,
  body: unknown,
  headers: Record<string, string>,
  method = 'POST',
) {
  const response = await fetch(config.CHAT_SERVICE_URL + path, {
    method,
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  assert.ok(response.ok, `Не выполнен ${path}: ${response.status}`);
  return response.json() as Promise<any>;
}
try {
  const operator = await chat(
    '/auth/login',
    { nickname: 'manager-browser-' + randomUUID(), initials: 'Тестовый оператор' },
    { 'x-service-key': config.MANAGER_INTERNAL_KEY },
  );
  await chat(
    '/internal/manager-access/snapshot',
    {
      revision: Date.now(),
      expiresAt: new Date(Date.now() + 14 * 60 * 1000).toISOString(),
      userIds: [operator.user.id],
    },
    { 'x-manager-access-key': process.env.CHAT_MANAGER_ACCESS_KEY! },
    'PUT',
  );
  const auth = { Authorization: `Bearer ${operator.accessToken || operator.token}` };
  await page.goto('http://127.0.0.1:4310/?service=manager');
  const frame = page.frameLocator('iframe[data-sep-manager]');
  await frame.getByRole('button', { name: 'Открыть чат' }).click({ timeout: 20000 });
  await frame.locator('.composer .tiptap').fill('Сквозная проверка реального сервиса');
  await frame.locator('.composer .tiptap').press('Enter');
  await frame
    .getByRole('textbox', { name: 'Имя', exact: true })
    .fill('Посетитель проверки');
  await frame
    .getByRole('textbox', { name: 'Телефон', exact: true })
    .fill('+7 999 333-44-55');
  await frame
    .getByRole('textbox', { name: 'E-mail', exact: true })
    .fill('browser@example.test');
  const sentResponse = page.waitForResponse(
    (response) =>
      response.url() === 'http://127.0.0.1:4314/v1/widget/inquiries' &&
      response.request().method() === 'POST',
  );
  await frame.getByRole('button', { name: 'Отправить сообщение', exact: true }).click();
  const sent = await (await sentResponse).json();
  assert.ok(sent.inquiryId);
  console.log('Обращение принято из браузера.');
  let inquiry: any;
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await fetch(
      `${config.CHAT_SERVICE_URL}/manager/inquiries/${sent.inquiryId}`,
      { headers: auth },
    );
    if (response.ok) {
      const detail = (await response.json()) as any;
      if (detail.inquiry.topic_id) {
        inquiry = detail.inquiry;
        break;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(inquiry?.topic_id, 'Обращение должно появиться в настоящем чате');
  await chat(
    `/manager/inquiries/${sent.inquiryId}/messages`,
    {
      operationId: randomUUID(),
      html: '<p>Ответ из настоящего СЭП Чата</p>',
      attachmentIds: [],
    },
    auth,
  );
  await frame
    .getByText('Ответ из настоящего СЭП Чата', { exact: true })
    .waitFor({ timeout: 15000 });
  const sentFile = page.waitForResponse(
    (response) =>
      response.url() ===
        `http://127.0.0.1:4314/v1/widget/inquiries/${sent.inquiryId}/messages` &&
      response.request().method() === 'POST',
  );
  await frame
    .locator('.composer input[type="file"]')
    .first()
    .setInputFiles({
      name: 'browser-check.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('Проверка файла из браузера'),
    });
  const fileMessage = await (await sentFile).json();
  assert.equal(fileMessage.message.attachments.length, 1);
  assert.equal(await frame.locator('.attach-modal-container').count(), 0);
  mkdirSync('.local', { recursive: true });
  await page.screenshot({ path: '.local/widget-real-chat.png' });
  await runtime.close();
  closed = true;
  await page
    .locator('iframe[data-sep-manager]')
    .waitFor({ state: 'hidden', timeout: 20000 });
  assert.deepEqual(errors, []);
  console.log(
    'Chrome: контакты → сообщение в чате → ответ в виджете; файл без модального окна; скрытие при остановке сервиса — успешно.',
  );
} finally {
  await browser.close();
  if (!closed) await runtime.close();
}
