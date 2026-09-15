import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const contexts = await Promise.all(
  [1, 2, 3].map(() => browser.newContext({ viewport: { width: 1440, height: 1000 } })),
);
const [staff1, staff2, visitor] = await Promise.all(
  contexts.map((context) => context.newPage()),
);
const errors = [];
for (const page of [staff1, staff2, visitor]) {
  page.setDefaultTimeout(20000);
  page.setDefaultNavigationTimeout(30000);
  page.on('pageerror', (e) => errors.push(e.message));
}
const customer = 'Тест виджета ' + Date.now().toString().slice(-6);
try {
  // На полном стенде ЕРП используется штатная авторизация. Оба менеджера
  // имеют одинаковое право «Чат → Клиенты»; отсутствие доступа проверяют API-тесты.
  if (process.env.MANAGER_ERP_LOGIN_FILE) {
    const login = JSON.parse(readFileSync(process.env.MANAGER_ERP_LOGIN_FILE, 'utf8'));
    for (const context of contexts.slice(0, 2)) {
      const erp = await context.newPage();
      await erp.goto('http://127.0.0.3:4315/');
      await erp
        .getByPlaceholder('Введите табельный номер', { exact: true })
        .fill(login.tabel, { timeout: 60000 });
      await erp.getByPlaceholder('Введите табельный номер', { exact: true }).press('Tab');
      await erp.locator('input[type="password"]').fill(login.password);
      await erp.getByTestId('LoginForm-Login-Button').click();
      await erp.locator('.main-layout #nav').waitFor({ timeout: 60000 });
      await erp.close();
    }
  }
  await staff1.goto('http://127.0.0.2:4312/', { waitUntil: 'domcontentloaded' });
  console.log('Открыт первый менеджер.');
  await staff1.locator('.chat').first().waitFor({ timeout: 60000 });
  // Сравниваем оформление с каноническими фильтрами обычного чата.
  const filterStyle = async (locator) =>
    locator.evaluate((element) => {
      const styles = getComputedStyle(element);
      return Object.fromEntries(
        [
          'min-height',
          'padding',
          'border-radius',
          'border-color',
          'background-color',
          'color',
          'font-size',
          'gap',
        ].map((property) => [property, styles.getPropertyValue(property)]),
      );
    });
  const standardActive = staff1.locator('[data-testid$="ChatsToolbar-Filter-all"]');
  await standardActive.waitFor();
  const activeStyle = await filterStyle(standardActive);
  const inactiveStyle = await filterStyle(
    staff1.locator('[data-testid$="ChatsToolbar-Filter-chats"]'),
  );
  const clientsIcon = staff1.locator('[data-testid$="MenuBottomNav-Clients"] svg');
  await clientsIcon.waitFor({ timeout: 30000 });
  assert.equal(await clientsIcon.locator('path').count(), 1);
  assert.ok(
    (await clientsIcon.locator('path').getAttribute('d')).startsWith('M19.9168 3.285'),
  );
  await staff1
    .locator('[data-testid$="MenuBottomNav-Clients"]')
    .click({ timeout: 30000 });
  console.log('Открыт раздел клиентов.');
  assert.deepEqual(
    await filterStyle(staff1.locator('[data-testid="Clients-Filter-all"]')),
    activeStyle,
  );
  assert.deepEqual(
    await filterStyle(staff1.locator('[data-testid="Clients-Filter-new"]')),
    inactiveStyle,
  );
  assert.deepEqual(
    await filterStyle(staff1.locator('[data-testid="Clients-Platforms-Filter-Сайт"]')),
    inactiveStyle,
  );
  await staff1.locator('[data-testid="Clients-Platforms-Filter-Сайт"]').click();
  await staff1.locator('[data-testid="Clients-Platforms-Filter-Сайт"]').click();
  assert.equal(
    await staff1
      .locator('[data-testid="Clients-Platforms-Filter-Сайт"]')
      .getAttribute('aria-pressed'),
    'false',
  );
  await staff1.screenshot({ path: '.local/clients-filters.png' });
  console.log(
    'PASS: фильтры совпадают с ChatsToolbar, используется предоставленная Headset.',
  );
  await visitor.goto('http://127.0.0.1:4310/?service=manager', {
    waitUntil: 'domcontentloaded',
  });
  const widget = visitor.frameLocator('iframe[data-sep-manager]');
  await widget.getByRole('button', { name: 'Открыть чат' }).click({ timeout: 30000 });
  await widget
    .locator('.composer .tiptap')
    .fill('Проверяем переписку из двух окон браузера');
  await widget.locator('.composer .tiptap').press('Enter');
  await widget.getByRole('textbox', { name: 'Имя', exact: true }).fill(customer);
  await widget
    .getByRole('textbox', { name: 'Телефон', exact: true })
    .fill('+7999' + String(Date.now()).slice(-7));
  await widget
    .getByRole('textbox', { name: 'E-mail', exact: true })
    .fill('manual-' + Date.now() + '@example.test');
  const accepted = visitor.waitForResponse(
    (r) =>
      r.url() === 'http://127.0.0.1:4314/v1/widget/inquiries' &&
      r.request().method() === 'POST',
  );
  await widget.getByRole('button', { name: 'Отправить сообщение', exact: true }).click();
  const sent = await (await accepted).json();
  assert.ok(sent.inquiryId);
  console.log('Виджет создал обращение:', customer);
  await staff1.getByText(customer, { exact: false }).first().click({ timeout: 30000 });
  await staff1
    .locator('.chat__input [contenteditable=true]')
    .fill('Ответ первого менеджера из интерфейса чата');
  await staff1.locator('.chat__input [contenteditable=true]').press('Enter');
  await widget
    .getByText('Ответ первого менеджера из интерфейса чата', { exact: true })
    .waitFor({ timeout: 30000 });
  console.log('Ответ из интерфейса первого менеджера получен виджетом.');
  const getInquiry = (page) =>
    page.evaluate(async (id) => {
      const session = JSON.parse(sessionStorage.getItem('chat_auth_session'));
      const response = await fetch('/api/manager/inquiries/' + id, {
        headers: { Authorization: 'Bearer ' + session.token },
      });
      if (!response.ok) throw new Error('Inquiry HTTP ' + response.status);
      return response.json();
    }, sent.inquiryId);
  const before = await getInquiry(staff1);
  await staff2.goto('http://127.0.0.2:4312/?manager=2');
  await staff2.locator('.chat').first().waitFor({ timeout: 60000 });
  await staff2
    .locator('[data-testid$="MenuBottomNav-Clients"]')
    .click({ timeout: 30000 });
  await staff2.getByText(customer, { exact: false }).first().click({ timeout: 30000 });
  await staff2
    .locator('.chat__input [contenteditable=true]')
    .fill('Второй менеджер тоже может ответить');
  await staff2.locator('.chat__input [contenteditable=true]').press('Enter');
  await widget
    .getByText('Второй менеджер тоже может ответить', { exact: true })
    .waitFor({ timeout: 30000 });
  const after = await getInquiry(staff2);
  assert.ok(before.inquiry.assignee_id);
  assert.equal(after.inquiry.assignee_id, before.inquiry.assignee_id);
  console.log('Второй менеджер ответил; первый ответственный сохранился.');
  await widget
    .locator('.composer input[type=file]')
    .first()
    .setInputFiles({
      name: 'проверка-стенда.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('Файл из виджета для локального менеджера'),
    });
  await staff1
    .getByText('проверка-стенда.txt', { exact: false })
    .first()
    .waitFor({ timeout: 30000 });
  assert.equal(await widget.locator('.attach-modal-container').count(), 0);
  console.log('Файл из виджета появился в интерфейсе чата без предпросмотра в виджете.');
  await staff1.locator('[data-testid="Client-Header-Call"]').waitFor();
  assert.equal(
    await staff1.locator('[data-testid="Client-Header-Call"]').isDisabled(),
    true,
  );
  await staff1
    .locator('[data-testid="Client-Header-Profile-UserProfile-Container"]')
    .click();
  await staff1.locator('[data-testid="ClientDetails"]').waitFor();
  await staff1.locator('[data-testid="Client-Managers-Current"]').click();
  console.log(
    'MANAGERS',
    await staff1.locator('[data-testid="Client-Managers-AvatarOptions"]').innerText(),
  );
  await staff1
    .locator('[data-testid="Client-Managers-AvatarOptions"] button')
    .filter({ hasText: 'Менеджер 2' })
    .click();
  await staff1.locator('.user-info-panel__name').click();
  await staff1
    .locator('[data-testid="Client-Note-Textarea"]')
    .fill('Примечание менеджера для проверки');
  const saveNote = staff1.waitForResponse(
    (r) =>
      r.url().endsWith('/metadata') &&
      r.request().method() === 'POST' &&
      r.status() === 201,
  );
  await staff1.locator('[data-testid="Client-Note-Textarea"]').press('Tab');
  await saveNote;
  assert.equal(await staff1.locator('.client-details__status').count(), 0);
  const savedCard = await getInquiry(staff1);
  assert.equal(savedCard.inquiry.manager_ids.length, 2);
  assert.equal(savedCard.inquiry.note, 'Примечание менеджера для проверки');
  await staff1.screenshot({ path: '.local/clients-card.png' });
  console.log('PASS: стандартная карточка, два менеджера, примечание, disabled-звонок.');
  await staff2
    .locator('[data-testid="Client-Header-Profile-UserProfile-Container"]')
    .click();
  await staff2.locator('[data-testid="Client-Note-Textarea"]').waitFor();
  await staff1
    .locator('[data-testid="Client-Note-Textarea"]')
    .fill('Черновик первого менеджера');
  await staff2
    .locator('[data-testid="Client-Note-Textarea"]')
    .fill('Правка второго менеджера');
  const saveSecondNote = staff2.waitForResponse(
    (r) =>
      r.url().endsWith('/metadata') &&
      r.request().method() === 'POST' &&
      r.status() === 201,
  );
  await staff2.locator('[data-testid="Client-Note-Textarea"]').press('Tab');
  await saveSecondNote;
  await staff1.locator('[data-testid="Client-Note-Textarea"]').press('Tab');
  await staff1.getByText('Карточку изменил другой менеджер.', { exact: false }).waitFor();
  assert.equal(
    await staff1.locator('[data-testid="Client-Note-Textarea"]').inputValue(),
    'Черновик первого менеджера',
  );
  assert.equal((await getInquiry(staff1)).inquiry.note, 'Правка второго менеджера');
  const saveConflict = staff1.waitForResponse(
    (r) =>
      r.url().endsWith('/metadata') &&
      r.request().method() === 'POST' &&
      r.status() === 201,
  );
  await staff1
    .getByRole('button', { name: 'Сохранить мои изменения', exact: true })
    .click();
  await saveConflict;
  assert.equal((await getInquiry(staff1)).inquiry.note, 'Черновик первого менеджера');
  console.log('PASS: конфликт двух открытых карточек не теряет черновик.');
  const metrics = await staff1.locator('.client-details').evaluate((element) => ({
    gap: getComputedStyle(element).gap,
    fieldGap: getComputedStyle(element.querySelector('.client-details__field')).gap,
    label: getComputedStyle(element.querySelector('label')).fontSize,
    right: document.querySelector('dialog[open]').getBoundingClientRect().right,
    viewport: innerWidth,
    standardModal: document
      .querySelector('dialog[open]')
      .matches('.chat__user-info-modal.modal-yui-kit.modal-yui-kit_right'),
  }));
  assert.equal(metrics.gap, '15px');
  assert.equal(metrics.fieldGap, '10px');
  assert.equal(metrics.label, '14px');
  assert.equal(metrics.right, metrics.viewport);
  assert.equal(metrics.standardModal, true);
  const secondErpPopupPromise = contexts[1].waitForEvent('page');
  await staff2.locator('[data-testid="Client-ErpButton"]').click();
  const secondErpPopup = await secondErpPopupPromise;
  await secondErpPopup
    .getByText('Создание нового контакта', { exact: true })
    .waitFor({ timeout: 60000 });
  assert.equal(
    await secondErpPopup.getByPlaceholder('Введите ФИО', { exact: true }).inputValue(),
    customer,
  );
  await secondErpPopup.close();
  assert.equal((await getInquiry(staff2)).inquiry.erp_contact_id, null);
  assert.equal(await staff2.locator('[data-testid$="MenuBottomNav-Clients"]').count(), 1);
  console.log('PASS: второй менеджер открывает форму ЕРП; закрытие не создаёт контакт.');
  const erpPopupPromise = contexts[0].waitForEvent('page');
  await staff1.locator('[data-testid="Client-ErpButton"]').click();
  const erpPopup = await erpPopupPromise;
  await erpPopup
    .getByText('Создание нового контакта', { exact: true })
    .waitFor({ timeout: 60000 });
  assert.equal(
    await erpPopup.getByPlaceholder('Введите ФИО', { exact: true }).inputValue(),
    customer,
  );
  assert.equal((await getInquiry(staff1)).inquiry.erp_contact_id, null);
  await erpPopup.locator('[data-testid="ManagerContact-Button-Save"]').click();
  await staff1.getByText('Открыть в СЭП', { exact: true }).waitFor({ timeout: 30000 });
  assert.ok((await getInquiry(staff1)).inquiry.erp_contact_id);
  await erpPopup.close();
  console.log(
    'PASS: клиент создан только после сохранения штатной формы ЕРП и связан с чатом.',
  );
  await staff1.getByText('Файлы', { exact: true }).click();
  await staff1
    .locator('.user-info-panel')
    .getByText('проверка-стенда.txt', { exact: false })
    .waitFor();
  await staff1.screenshot({ path: '.local/clients-card.png' });
  await staff2.locator('.user-info-panel__close').click();
  await staff2.locator('[data-testid="Clients-Filter-mine"]').click();
  await staff2
    .locator('[data-testid^="Clients-Topics-ContactList-Title"]')
    .filter({ hasText: customer })
    .waitFor();
  await staff2.locator('[data-testid="Clients-Filter-new"]').click();
  assert.equal(
    await staff2
      .locator('[data-testid^="Clients-Topics-ContactList-Title"]')
      .filter({ hasText: customer })
      .count(),
    0,
  );
  const mobileContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const mobile = await mobileContext.newPage();
  mobile.setDefaultTimeout(20000);
  mobile.on('pageerror', (e) => errors.push(e.message));
  await mobile.goto('http://127.0.0.2:4312/', { waitUntil: 'domcontentloaded' });
  await mobile
    .locator('[data-testid$="MenuBottomNav-Clients"]')
    .filter({ visible: true })
    .click();
  await mobile
    .getByText(customer, { exact: false })
    .filter({ visible: true })
    .first()
    .click();
  await mobile
    .locator('[data-testid="Client-Header-Profile-UserProfile-Container"]')
    .click();
  await mobile.locator('[data-testid="ClientDetails"]').waitFor();
  await mobile.waitForFunction(() =>
    Array.from(document.getAnimations()).every(
      (animation) => animation.playState !== 'running',
    ),
  );
  await mobile.screenshot({ path: '.local/clients-mobile.png' });
  assert.equal(
    await mobile.locator('[data-testid="Client-Note-Textarea"]').inputValue(),
    'Черновик первого менеджера',
  );
  assert.equal(
    await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    false,
  );
  console.log(
    'PASS: фильтры заявок, файлы карточки и мобильный экран без горизонтального скролла.',
  );
  await staff1.screenshot({ path: '.local/clients-chat.png' });
  await visitor.screenshot({ path: '.local/manual-widget.png' });
  assert.deepEqual(errors, []);
  console.log('PASS: два менеджера, виджет, ответы, ответственный и файл.');
} catch (error) {
  console.log('STAFF TEXT', (await staff1.locator('body').innerText()).slice(-4000));
  console.log('ERRORS', JSON.stringify(errors));
  await staff1.screenshot({ path: '.local/manual-chat-failure.png' });
  throw error;
} finally {
  await browser.close();
}
