import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const staffContext = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
});
const visitorContext = await browser.newContext();
const chat = await staffContext.newPage();
const errors = [];
const failures = [];
staffContext.on('page', (page) => {
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', (response) => {
    if (response.status() >= 400)
      failures.push({ url: response.url(), status: response.status() });
  });
});
chat.on('pageerror', (error) => errors.push(error.message));

/** Читает состояние через обычный авторизованный API менеджера. */
async function manager(path) {
  return chat.evaluate(async (path) => {
    const { token } = JSON.parse(sessionStorage.getItem('chat_auth_session'));
    const response = await fetch('/api/manager/' + path, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error('Manager HTTP ' + response.status);
    return response.json();
  }, path);
}

/** Открывает ЕРП настоящим кликом по карточке чата. */
async function openErp() {
  const popupPromise = staffContext.waitForEvent('page');
  await chat.locator('[data-testid="Client-ErpButton"]').click();
  const popup = await popupPromise;
  await popup.waitForURL(
    (url) =>
      url.origin === 'http://127.0.0.3:4315' && url.searchParams.has('managerContact'),
    { timeout: 30000 },
  );
  await popup.locator('.main-layout #nav').waitFor({ timeout: 60000 });
  await popup
    .locator('[data-testid="ManagerContact-Input-Initial"] input')
    .waitFor({ timeout: 60000 });
  assert.equal(await popup.locator('.header').count(), 1);
  assert.ok(await popup.getByText('База продукции', { exact: true }).count());
  return popup;
}

/** Получает итоговое значение связи с учётом фоновой очереди синхронизации. */
async function waitLinked(inquiryId) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const detail = await manager('inquiries/' + inquiryId);
    if (detail.inquiry.erp_contact_id) return detail.inquiry;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('Contact was not linked');
}

try {
  await chat.goto('http://127.0.0.2:4312/');
  await chat.locator('[data-testid$="MenuBottomNav-Clients"]').click({ timeout: 60000 });
  const existing = (await manager('inquiries?page=1')).find(
    (item) => item.erp_contact_id,
  );
  assert.ok(existing);
  await chat.getByText(existing.name, { exact: false }).first().click();
  await chat
    .locator('[data-testid="Client-Header-Profile-UserProfile-Container"]')
    .click();
  const edit = await openErp();
  await edit.getByText('Редактирование контакта', { exact: true }).waitFor();
  assert.equal(
    await edit.getByPlaceholder('Введите ФИО', { exact: true }).inputValue(),
    existing.name,
  );
  assert.ok(!edit.url().includes(existing.contacts.email));
  await edit.screenshot({ path: '.local/erp-full-edit.png', animations: 'disabled' });
  await edit.reload();
  await edit
    .getByText('Редактирование контакта', { exact: true })
    .waitFor({ timeout: 60000 });
  assert.equal(
    await edit.getByPlaceholder('Введите ФИО', { exact: true }).inputValue(),
    existing.name,
  );
  await edit.close();
  await chat.bringToFront();
  console.log(
    'PASS: существующий контакт открывается на редактирование внутри основной ЕРП; перезагрузка сохраняет режим.',
  );

  // Новый посетитель и уникальные контакты не затрагивают чужие тестовые карточки.
  await chat.locator('.user-info-panel__close').click();
  const visitor = await visitorContext.newPage();
  await visitor.goto('http://127.0.0.1:4310/?service=manager');
  const widget = visitor.frameLocator('iframe[data-sep-manager]');
  const marker = Date.now();
  const name = 'Форма ЕРП ' + marker;
  const phone = '+7999' + String(marker).slice(-7);
  const email = `erp-form-${marker}@example.test`;
  await widget.getByRole('button', { name: 'Открыть чат' }).click();
  await widget.locator('.composer .tiptap').fill('Проверка штатной формы ЕРП');
  await widget.locator('.composer .tiptap').press('Enter');
  await widget.getByRole('textbox', { name: 'Имя', exact: true }).fill(name);
  await widget.getByRole('textbox', { name: 'Телефон', exact: true }).fill(phone);
  await widget.getByRole('textbox', { name: 'E-mail', exact: true }).fill(email);
  const accepted = visitor.waitForResponse(
    (response) =>
      response.url() === 'http://127.0.0.1:4314/v1/widget/inquiries' &&
      response.request().method() === 'POST',
  );
  await widget.getByRole('button', { name: 'Отправить сообщение', exact: true }).click();
  const { inquiryId } = await (await accepted).json();
  await chat.getByText(name, { exact: false }).first().click({ timeout: 30000 });
  await chat
    .locator('[data-testid="Client-Header-Profile-UserProfile-Container"]')
    .click();
  let create = await openErp();
  await create.getByText('Создание нового контакта', { exact: true }).waitFor();
  assert.equal(
    await create.getByPlaceholder('Введите ФИО', { exact: true }).inputValue(),
    name,
  );
  const values = await create
    .locator('[data-testid^="ManagerContact-RequisiteTable"] input')
    .evaluateAll((inputs) => inputs.map((input) => input.value));
  assert.ok(values.includes(phone));
  assert.ok(values.includes(email));
  assert.equal((await manager('inquiries/' + inquiryId)).inquiry.erp_contact_id, null);
  assert.deepEqual(await manager(`inquiries/${inquiryId}/erp/candidates`), []);
  await create.screenshot({ path: '.local/erp-full-create.png', animations: 'disabled' });
  await create.locator('[data-testid="ManagerContact-Button-Cancel"]').click();
  assert.deepEqual(await manager(`inquiries/${inquiryId}/erp/candidates`), []);
  await create.close();
  console.log(
    'PASS: форма создания предзаполнена; открытие и отмена не создают контакт.',
  );

  create = await openErp();
  await create.getByPlaceholder('Введите ФИО', { exact: true }).fill('');
  await create.locator('[data-testid="ManagerContact-Button-Save"]').click();
  await create.getByText('ФИО не может быть пустым', { exact: true }).waitFor();
  assert.deepEqual(await manager(`inquiries/${inquiryId}/erp/candidates`), []);
  await create.getByPlaceholder('Введите ФИО', { exact: true }).fill(name);
  const savedResponse = create.waitForResponse(
    (response) =>
      response.url().endsWith('/api/contacts') && response.request().method() === 'POST',
  );
  await create.locator('[data-testid="ManagerContact-Button-Save"]').click();
  const response = await savedResponse;
  assert.equal(response.status(), 201);
  const contact = await response.json();
  const linked = await waitLinked(inquiryId);
  assert.equal(Number(linked.erp_contact_id), contact.id);
  await chat.getByText('Открыть в СЭП', { exact: true }).waitFor();
  assert.equal((await manager(`inquiries/${inquiryId}/erp/candidates`)).length, 1);
  await create.close();
  const reopened = await openErp();
  await reopened.getByText('Редактирование контакта', { exact: true }).waitFor();
  const updateResponse = reopened.waitForResponse(
    (response) =>
      response.url().endsWith('/api/contacts') && response.request().method() === 'PUT',
  );
  await reopened.locator('[data-testid="ManagerContact-Button-Save"]').click();
  assert.equal((await updateResponse).status(), 200);
  assert.equal((await manager(`inquiries/${inquiryId}/erp/candidates`)).length, 1);
  console.log(
    'PASS: штатная валидация сохранена; создание и последующее редактирование связаны с одним контактом.',
  );

  // Обычная ссылка базы сохраняет прежний режим просмотра, без принудительного редактирования.
  await reopened.goto(`http://127.0.0.3:4315/contactbase?contactId=${contact.id}`);
  await reopened
    .getByText('Информация о контакте', { exact: true })
    .waitFor({ timeout: 60000 });
  assert.equal(await reopened.locator('[data-testid$="Button-Edit"]').isVisible(), true);
  assert.deepEqual(errors, []);
  assert.deepEqual(failures, []);
  console.log(
    'PASS: обычная карточка базы контактов сохранена; ошибок JavaScript и HTTP нет.',
  );
} finally {
  await browser.close();
}
