import 'reflect-metadata';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { WebSocket } from 'ws';
// Nest получает метаданные аргументов контроллеров из обычной TypeScript-сборки.
import { createApplication } from '../dist/app';
import { readConfig } from '../dist/config';
import { ChatAdapter } from '../dist/chat-adapter';
import { ChatEventSchema } from '../src/contracts';

const config = readConfig();
const databaseUrl = new URL(config.DATABASE_URL);
if (
  databaseUrl.hostname !== '127.0.0.1' ||
  databaseUrl.port !== '56441' ||
  databaseUrl.pathname !== '/manager_local' ||
  config.CHAT_SERVICE_URL !== 'http://127.0.0.1:4501/api'
)
  throw new Error('Тест разрешён только на изолированном стенде manager');
const origin = 'http://127.0.0.1:4310',
  base = 'http://127.0.0.1:4314',
  chatBase = config.CHAT_SERVICE_URL;
const db = new Pool({ connectionString: config.DATABASE_URL });
databaseUrl.pathname = '/manager_chat_local';
const chatDb = new Pool({ connectionString: databaseUrl.toString() });
let runtime: Awaited<ReturnType<typeof createApplication>>;
let alice: { token: string; id: string },
  bob: { token: string; id: string },
  outsider: { token: string; id: string };
let guest: any, inquiryId: string, topicId: string, guestMessageId: string;
let revision = Date.now();
const contacts = {
  name: 'Проверка Manager',
  phone: '+7999' + String(Date.now()).slice(-7),
  email: `manager-${randomUUID()}@example.test`,
};
const sockets: WebSocket[] = [];

async function request(url: string, options: RequestInit = {}, status?: number) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(15000),
  });
  if (status !== undefined && response.status !== status) {
    const body = (await response
      .clone()
      .json()
      .catch(() => ({}))) as any;
    console.error(
      new URL(url).pathname,
      response.status,
      body.message || body.error || 'Без описания',
    );
  }
  if (status !== undefined) expect(response.status).toBe(status);
  return response;
}
function json(body: unknown, headers: Record<string, string> = {}): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  };
}
function guestHeaders(token = guest.token) {
  return { Origin: origin, Authorization: `Bearer ${token}` };
}
function staffHeaders(actor = alice) {
  return { Authorization: `Bearer ${actor.token}` };
}
async function until<T>(
  work: () => Promise<T>,
  accepts: (result: T) => boolean,
  timeout = 15000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await work();
    if (accepts(result)) return result;
    await Bun.sleep(100);
  }
  throw new Error('Не дождались проверяемого состояния');
}
async function start() {
  runtime = await createApplication({ ...config, PORT: 4314 });
  await runtime.app.listen(4314, '127.0.0.1');
}
async function session() {
  return (
    await request(
      base + '/v1/widget/session',
      json(
        {
          siteId: 'amotiv-demo',
          source: {
            pageUrl: origin + '/equipment?private=discard#anchor',
            title: 'Проверка оборудования',
            referrerOrigin: '',
          },
        },
        { Origin: origin },
      ),
      201,
    )
  ).json();
}
async function login(name: string) {
  const response = await request(
    chatBase + '/auth/login',
    json(
      { nickname: `manager-test-${name}-${randomUUID()}`, initials: name },
      { 'x-service-key': config.MANAGER_INTERNAL_KEY },
    ),
    201,
  );
  const body = (await response.json()) as any;
  return { token: body.accessToken || body.token, id: body.user.id };
}
async function grants(ids: string[]) {
  await request(
    chatBase + '/internal/manager-access/snapshot',
    {
      ...json(
        {
          revision: ++revision,
          expiresAt: new Date(Date.now() + 14 * 60 * 1000).toISOString(),
          userIds: ids,
        },
        { 'x-manager-access-key': process.env.CHAT_MANAGER_ACCESS_KEY! },
      ),
      method: 'PUT',
    },
    200,
  );
}
async function staffDetail(id = inquiryId) {
  return (
    await request(chatBase + '/manager/inquiries/' + id, { headers: staffHeaders() }, 200)
  ).json() as Promise<any>;
}
async function delivered(id: string) {
  const result = await until(
    () =>
      db.query(
        'SELECT i.topic_id,m.chat_message_id FROM inquiries i JOIN messages m ON m.inquiry_id=i.id JOIN delivery_operations d ON d.id=m.id WHERE i.id=$1 AND d.state=$2 ORDER BY m.sequence',
        [id, 'delivered'],
      ),
    (result) => !!result.rows[0]?.chat_message_id,
  );
  return result.rows[0] as { topic_id: string; chat_message_id: string };
}
async function sendGuest(
  token: string,
  html: string,
  target?: string,
  files: string[] = [],
) {
  return (
    await request(
      base + '/v1/widget/' + (target ? `inquiries/${target}/messages` : 'inquiries'),
      json(
        {
          operationId: randomUUID(),
          html,
          attachmentIds: files,
          ...(target ? {} : { contacts }),
        },
        guestHeaders(token),
      ),
      201,
    )
  ).json() as Promise<any>;
}
async function reply(html: string, actor = alice, files: string[] = [], id = inquiryId) {
  return (
    await request(
      chatBase + `/manager/inquiries/${id}/messages`,
      json(
        { operationId: randomUUID(), html, attachmentIds: files },
        staffHeaders(actor),
      ),
      201,
    )
  ).json() as Promise<any>;
}
async function connect(token = guest.token) {
  const socket = new WebSocket(base.replace('http:', 'ws:') + '/v1/widget/events', {
    origin,
    headers: { Origin: origin },
  });
  sockets.push(socket);
  const frames: any[] = [];
  socket.on('message', (raw) => frames.push(JSON.parse(String(raw))));
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.once('open', () => resolve());
  });
  socket.send(JSON.stringify({ type: 'authenticate', token }));
  await until(
    async () => frames,
    (frames) => frames.some((frame) => frame.type === 'ready'),
  );
  return { socket, frames };
}

beforeAll(async () => {
  await request(
    chatBase + '/internal/manager/ready',
    { headers: { 'x-manager-key': config.CHAT_MANAGER_KEY } },
    200,
  );
  await start();
  alice = await login('Менеджер А');
  bob = await login('Менеджер Б');
  outsider = await login('Без права');
  await grants([alice.id, bob.id]);
}, 60000);
afterAll(async () => {
  sockets.forEach((socket) => socket.terminate());
  runtime?.app.getHttpServer().closeAllConnections();
  await runtime?.close();
  await db.end();
  await chatDb.end();
}, 30000);

test('источник проверяется, чужой origin и запрос без сессии отклоняются', async () => {
  await request(
    base + '/v1/widget/session',
    json(
      {
        siteId: 'amotiv-demo',
        source: { pageUrl: origin, title: '', referrerOrigin: '' },
      },
      { Origin: 'https://foreign.example' },
    ),
    403,
  );
  await request(base + '/v1/widget/inquiries', json({}), 401);
  await request(chatBase + '/internal/manager/ready', {}, 401);
  guest = await session();
  expect(guest.messages).toEqual([]);
  expect(guest.inquiryId).toBeNull();
  await request(
    base + '/v1/widget/session',
    json(
      {
        siteId: 'amotiv-demo',
        source: { pageUrl: origin, title: '', referrerOrigin: '' },
      },
      { ...guestHeaders(), Origin: 'https://foreign.example' },
    ),
    403,
  );
});

test('пять одновременных отправок создают одно обращение и одно сообщение в настоящем чате', async () => {
  const operation = {
    operationId: randomUUID(),
    html: '<p>Подберите оборудование</p>',
    attachmentIds: [],
    contacts,
  };
  const sent = await Promise.all(
    Array.from(
      { length: 5 },
      async () =>
        (
          await request(
            base + '/v1/widget/inquiries',
            json(operation, guestHeaders()),
            201,
          )
        ).json() as any,
    ),
  );
  expect(new Set(sent.map((row) => row.inquiryId)).size).toBe(1);
  expect(new Set(sent.map((row) => row.message.id)).size).toBe(1);
  inquiryId = sent[0].inquiryId;
  guestMessageId = sent[0].message.id;
  const receipt = await delivered(inquiryId);
  topicId = receipt.topic_id;
  const messages = await chatDb.query(
    'SELECT id FROM messages WHERE topic_id=$1 AND NOT is_system',
    [topicId],
  );
  expect(messages.rowCount).toBe(1);
  expect(
    (await chatDb.query('SELECT id FROM manager_inquiries WHERE id=$1', [inquiryId]))
      .rowCount,
  ).toBe(1);
  const events = (await (
    await request(
      chatBase + `/internal/manager/inquiries/${inquiryId}/events?after=0`,
      { headers: { 'x-manager-key': config.CHAT_MANAGER_KEY } },
      200,
    )
  ).json()) as any;
  expect(
    events.events.map((event: unknown) => ChatEventSchema.parse(event)),
  ).toHaveLength(1);
  const detail = await staffDetail();
  expect(detail.inquiry.source.pageUrl).toBe(origin + '/equipment');
  expect(detail.inquiry.source.name).toBe('Локальная проверка Амотив');
  await request(
    base + '/v1/widget/inquiries',
    json({ ...operation, html: 'Подмена повтора' }, guestHeaders()),
    409,
  );
}, 25000);

test('ответы и прочтения приходят по WebSocket, первый ответственный сохраняется', async () => {
  const beforeReply = (await staffDetail()).inquiry;
  await request(
    chatBase + `/manager/inquiries/${inquiryId}/metadata`,
    json(
      {
        version: beforeReply.metadata_version,
        note: 'Внутренняя заметка до первого ответа',
      },
      staffHeaders(),
    ),
    201,
  );
  const live = await connect();
  expect(
    live.frames[0].messages.some((message: any) => message.id === guestMessageId),
  ).toBe(true);
  const answer = await reply('<p>Поможем с подбором</p>');
  await until(
    async () => live.frames,
    (frames) => frames.some((frame) => frame.message?.id === answer.id),
  );
  await reply('<p>Дополнение другого менеджера</p>', bob);
  await until(
    () => staffDetail(),
    (detail) =>
      detail.messages.filter((message: any) => message.direction === 'incoming')
        .length === 2,
  );
  expect((await staffDetail()).inquiry.assignee_id).toBe(alice.id);
  expect((await staffDetail()).inquiry.manager_ids).toEqual([alice.id]);
  const receipt = await delivered(inquiryId);
  await request(
    chatBase + `/messages/topic/${topicId}/read`,
    json({ messageId: receipt.chat_message_id }, staffHeaders()),
    201,
  );
  await until(
    async () => live.frames,
    (frames) =>
      frames.some(
        (frame) => frame.message?.id === guestMessageId && frame.message.readAt,
      ),
  );
  await request(
    chatBase + `/manager/inquiries/${inquiryId}/assignee`,
    json({ userId: bob.id }, staffHeaders()),
    201,
  );
  await reply('<p>Ответ после ручного назначения</p>');
  await until(
    () => staffDetail(),
    (detail) =>
      detail.messages.filter((message: any) => message.direction === 'incoming')
        .length === 3,
  );
  expect((await staffDetail()).inquiry.assignee_id).toBe(bob.id);
  live.socket.terminate();
}, 30000);

test('файлы проходят в обе стороны через S3 чата и недоступны другой сессии или публичной ссылке', async () => {
  const uploadOperation = randomUUID(),
    content = 'Синтетическое вложение посетителя';
  const upload = async () => {
    const form = new FormData();
    form.set('operationId', uploadOperation);
    form.set(
      'file',
      new Blob([content], { type: 'text/plain' }),
      'Техническое задание.txt',
    );
    return (
      await request(
        base + '/v1/widget/attachments',
        { method: 'POST', headers: guestHeaders(), body: form },
        201,
      )
    ).json() as Promise<any>;
  };
  const attachment = await upload();
  expect(attachment.name).toBe('Техническое задание.txt');
  expect((await upload()).id).toBe(attachment.id);
  await sendGuest(guest.token, '', inquiryId, [attachment.id]);
  await until(
    () =>
      chatDb.query('SELECT id FROM manager_attachments WHERE id=$1 AND inquiry_id=$2', [
        attachment.id,
        inquiryId,
      ]),
    (result) => result.rowCount === 1,
  );
  expect(
    await (
      await request(
        base + '/v1/widget/attachments/' + attachment.id,
        { headers: guestHeaders() },
        200,
      )
    ).text(),
  ).toBe(content);
  const stranger = await session();
  await request(
    base + '/v1/widget/attachments/' + attachment.id,
    { headers: guestHeaders(stranger.token) },
    404,
  );
  await request(chatBase + '/media/object/manager-private/' + attachment.id, {}, 401);
  expect(
    await (
      await request(
        chatBase + '/media/object/manager-private/' + attachment.id,
        { headers: staffHeaders() },
        200,
      )
    ).text(),
  ).toBe(content);
  const staffFile = new FormData();
  staffFile.set('operationId', randomUUID());
  staffFile.set(
    'file',
    new Blob(['Предложение менеджера'], { type: 'text/plain' }),
    'Коммерческое предложение.txt',
  );
  const offer = (await (
    await request(
      chatBase + `/manager/inquiries/${inquiryId}/attachments`,
      { method: 'POST', headers: staffHeaders(), body: staffFile },
      201,
    )
  ).json()) as any;
  expect(offer.name).toBe('Коммерческое предложение.txt');
  await reply('', alice, [offer.id]);
  await until(
    () => db.query('SELECT id FROM attachments WHERE id=$1', [offer.id]),
    (result) => result.rowCount === 1,
  );
  expect(
    await (
      await request(
        base + '/v1/widget/attachments/' + offer.id,
        { headers: guestHeaders() },
        200,
      )
    ).text(),
  ).toBe('Предложение менеджера');
  await request(
    base + `/v1/widget/inquiries/${inquiryId}/messages`,
    json(
      { operationId: randomUUID(), html: '', attachmentIds: [attachment.id] },
      guestHeaders(stranger.token),
    ),
    404,
  );
}, 30000);

test('те же телефон и email продолжают один чат, а история остаётся разделённой по сессиям', async () => {
  const newGuest = await session();
  expect(newGuest.messages).toEqual([]);
  const originalDetail = await staffDetail();
  const form = new FormData();
  form.set('operationId', randomUUID());
  form.set(
    'file',
    new Blob(['Файл новой сессии'], { type: 'text/plain' }),
    'repeat-session.txt',
  );
  const attachment = (await (
    await request(
      base + '/v1/widget/attachments',
      {
        method: 'POST',
        headers: guestHeaders(newGuest.token),
        body: form,
      },
      201,
    )
  ).json()) as any;
  const created = await sendGuest(
    newGuest.token,
    'Новое обращение с теми же контактами',
    undefined,
    [attachment.id],
  );
  expect(created.inquiryId).toBe(inquiryId);
  await until(
    () =>
      db.query('SELECT state FROM delivery_operations WHERE id=$1', [created.message.id]),
    (result) => result.rows[0]?.state === 'delivered',
  );
  const detail = await staffDetail(created.inquiryId);
  expect(detail.inquiry.customer_id).toBe(originalDetail.inquiry.customer_id);
  expect(detail.inquiry.topic_id).toBe(topicId);
  expect(detail.inquiry.manager_ids).toEqual(originalDetail.inquiry.manager_ids);
  expect(detail.inquiry.note).toBe(originalDetail.inquiry.note);
  await request(
    base + '/v1/widget/attachments/' + attachment.id,
    { headers: guestHeaders(newGuest.token) },
    200,
  );
  await request(
    base + '/v1/widget/attachments/' + attachment.id,
    { headers: guestHeaders() },
    404,
  );
  await request(
    chatBase + `/manager/inquiries/${created.inquiryId}/assignee`,
    json({ userId: bob.id }, staffHeaders()),
    201,
  );
  await reply('Первый ответ после ручного выбора', alice, [], created.inquiryId);
  await until(
    () => staffDetail(created.inquiryId),
    (value) => value.messages.length === detail.messages.length + 1,
  );
  expect((await staffDetail(created.inquiryId)).inquiry.assignee_id).toBe(bob.id);
  const snapshot = (await (
    await request(
      base + '/v1/widget/session',
      json(
        {
          siteId: 'amotiv-demo',
          source: { pageUrl: origin, title: '', referrerOrigin: '' },
        },
        guestHeaders(newGuest.token),
      ),
      201,
    )
  ).json()) as any;
  expect(snapshot.messages.map((message: any) => message.html)).toEqual([
    'Новое обращение с теми же контактами',
    'Первый ответ после ручного выбора',
  ]);
  const stream = await connect(newGuest.token);
  expect(stream.frames.find((frame) => frame.type === 'ready').messages).toEqual(
    snapshot.messages,
  );
  stream.socket.terminate();
  const previousHistory = (await (
    await request(
      base + `/v1/widget/inquiries/${inquiryId}/messages`,
      { headers: guestHeaders() },
      200,
    )
  ).json()) as any;
  expect(
    previousHistory.messages.some((message: any) => message.id === created.message.id),
  ).toBe(false);
  expect(
    previousHistory.messages.some(
      (message: any) => message.html === 'Первый ответ после ручного выбора',
    ),
  ).toBe(false);
}, 30000);

test('параллельные сессии с нормализованными контактами не создают дубль, одинаковые ключи отправки независимы', async () => {
  const guests = await Promise.all([session(), session()]);
  const operationId = randomUUID();
  const results = await Promise.all(
    guests.map(
      async (session, index) =>
        (
          await request(
            base + '/v1/widget/inquiries',
            json(
              {
                operationId,
                html: `Параллельная сессия ${index}`,
                attachmentIds: [],
                contacts: {
                  ...contacts,
                  phone: contacts.phone.replace(/(\d{3})/, '$1 '),
                  email: contacts.email.toUpperCase(),
                },
              },
              guestHeaders(session.token),
            ),
            201,
          )
        ).json() as Promise<any>,
    ),
  );
  expect(new Set(results.map((row) => row.inquiryId))).toEqual(new Set([inquiryId]));
  expect(new Set(results.map((row) => row.message.id)).size).toBe(2);
  for (let index = 0; index < guests.length; index++) {
    const history = (await (
      await request(
        base + `/v1/widget/inquiries/${inquiryId}/messages`,
        { headers: guestHeaders(guests[index].token) },
        200,
      )
    ).json()) as any;
    expect(history.messages.map((message: any) => message.html)).toEqual([
      `Параллельная сессия ${index}`,
    ]);
  }
  const stranger = await session();
  const different = (await (
    await request(
      base + '/v1/widget/inquiries',
      json(
        {
          operationId: randomUUID(),
          html: 'Другой email',
          attachmentIds: [],
          contacts: { ...contacts, email: `other-${randomUUID()}@example.test` },
        },
        guestHeaders(stranger.token),
      ),
      201,
    )
  ).json()) as any;
  expect(different.inquiryId).not.toBe(inquiryId);
  await until(
    () =>
      db.query(
        "SELECT id FROM delivery_operations WHERE id=ANY($1::uuid[]) AND state<>'delivered'",
        [[...results.map((row) => row.message.id), different.message.id]],
      ),
    (result) => result.rowCount === 0,
  );
}, 30000);

test('потеря подтверждения и перезапуск сервиса не дублируют сообщение в чате', async () => {
  const adapter = runtime.app.get(ChatAdapter),
    original = adapter.deliver.bind(adapter);
  let lost = false;
  adapter.deliver = async (...args) => {
    const result = await original(...args);
    if (!lost) {
      lost = true;
      throw new Error('Тест потери ответа после фиксации в чате');
    }
    return result;
  };
  const message = await sendGuest(
    guest.token,
    'Доставка после потери подтверждения',
    inquiryId,
  );
  await until(
    () =>
      db.query('SELECT state,attempts FROM delivery_operations WHERE id=$1', [
        message.message.id,
      ]),
    (result) =>
      lost && result.rows[0]?.state === 'pending' && result.rows[0]?.attempts === 1,
  );
  runtime.app.getHttpServer().closeAllConnections();
  await runtime.close();
  await start();
  await until(
    () =>
      db.query('SELECT state FROM delivery_operations WHERE id=$1', [message.message.id]),
    (result) => result.rows[0]?.state === 'delivered',
  );
  expect(
    (
      await chatDb.query(
        'SELECT message_id FROM manager_message_receipts WHERE operation_id=$1',
        [message.message.id],
      )
    ).rowCount,
  ).toBe(1);
  const live = await connect();
  expect(
    live.frames[0].messages.filter((row: any) => row.id === message.message.id),
  ).toHaveLength(1);
  live.socket.terminate();
}, 30000);

test('карточка хранит нескольких менеджеров и примечание, отклоняет устаревшие версии и посторонних', async () => {
  expect(
    await (
      await request(chatBase + '/manager/access', { headers: staffHeaders() }, 200)
    ).json(),
  ).toEqual({ allowed: true });
  expect(
    await (
      await request(
        chatBase + '/manager/access',
        { headers: staffHeaders(outsider) },
        200,
      )
    ).json(),
  ).toEqual({ allowed: false });
  const people = (await (
    await request(chatBase + '/manager/managers', { headers: staffHeaders() }, 200)
  ).json()) as any[];
  expect(people.map((person) => person.id).sort()).toEqual([alice.id, bob.id].sort());
  const item = (await staffDetail()).inquiry;
  expect(item.guest_user_id).toBeTruthy();
  const endpoint = chatBase + `/manager/inquiries/${inquiryId}/metadata`;
  await request(
    endpoint,
    json(
      { version: item.metadata_version, managerIds: [alice.id, outsider.id] },
      staffHeaders(),
    ),
    400,
  );
  await request(
    endpoint,
    json(
      { version: item.metadata_version, managerIds: [alice.id, alice.id] },
      staffHeaders(),
    ),
    400,
  );
  await request(
    endpoint,
    json({ version: item.metadata_version, note: 'x'.repeat(10001) }, staffHeaders()),
    400,
  );
  const updated = (await (
    await request(
      endpoint,
      json(
        {
          version: item.metadata_version,
          managerIds: [alice.id, bob.id],
          note: 'Позвонить после согласования',
        },
        staffHeaders(),
      ),
      201,
    )
  ).json()) as any;
  expect(updated.managerIds).toEqual([alice.id, bob.id]);
  expect(updated.assigneeId).toBe(bob.id);
  const simultaneous = await Promise.all(
    ['А', 'Б'].map((note) =>
      request(endpoint, json({ version: updated.version, note }, staffHeaders())),
    ),
  );
  expect(simultaneous.map((response) => response.status).sort()).toEqual([201, 409]);
  const current = (await staffDetail()).inquiry;
  expect(['А', 'Б']).toContain(current.note);
  expect(current.metadata_version).toBe(updated.version + 1);
  await reply('<p>Ответ сохраняет всех выбранных менеджеров</p>');
  await until(
    () => staffDetail(),
    (detail) =>
      detail.messages.some((message: any) => message.html?.includes('всех выбранных')),
  );
  expect((await staffDetail()).inquiry.manager_ids).toEqual([alice.id, bob.id]);
  await request(
    endpoint,
    json({ version: current.metadata_version, managerIds: [] }, staffHeaders()),
    201,
  );
  await reply('<p>Ответ после снятия менеджеров</p>', bob);
  await until(
    () => staffDetail(),
    (detail) =>
      detail.messages.some((message: any) => message.html?.includes('снятия менеджеров')),
  );
  expect((await staffDetail()).inquiry.manager_ids).toEqual([]);
  expect((await staffDetail()).inquiry.assignee_id).toBeNull();
  await request(
    endpoint,
    json(
      { version: current.metadata_version + 1, note: 'Чужая правка' },
      staffHeaders(outsider),
    ),
    403,
  );
}, 30000);

test('право раздела обязательно; отзыв закрывает историю, файлы и ответы', async () => {
  await grants([alice.id]);
  await request(
    chatBase + `/manager/inquiries/${inquiryId}`,
    { headers: staffHeaders(bob) },
    403,
  );
  await grants([alice.id, bob.id]);
  await request(
    chatBase + `/manager/inquiries/${inquiryId}`,
    { headers: staffHeaders(bob) },
    200,
  );
  const restored = await chatDb.query(
    'SELECT count(*)::int AS count FROM topic_settings WHERE topic_id=$1 AND user_id=$2 AND "deletedAt" IS NULL',
    [topicId, bob.id],
  );
  expect(restored.rows[0].count).toBe(1);
  await request(
    chatBase + '/manager/inquiries',
    { headers: staffHeaders(outsider) },
    403,
  );
  await grants([alice.id]);
  await request(
    chatBase + `/manager/inquiries/${inquiryId}`,
    { headers: staffHeaders(bob) },
    403,
  );
  await request(
    chatBase + `/messages/topic/${topicId}`,
    { headers: staffHeaders(bob) },
    403,
  );
  await request(
    chatBase + `/manager/inquiries/${inquiryId}/messages`,
    json(
      { operationId: randomUUID(), html: 'Нет права', attachmentIds: [] },
      staffHeaders(bob),
    ),
    403,
  );
  const [file] = (
    await chatDb.query('SELECT id FROM manager_attachments WHERE inquiry_id=$1 LIMIT 1', [
      inquiryId,
    ])
  ).rows;
  await request(
    chatBase + '/media/object/manager-private/' + file.id,
    { headers: staffHeaders(bob) },
    403,
  );
  const profile = (
    await chatDb.query(
      'SELECT u.nickname FROM users u JOIN manager_inquiries i ON i.guest_user_id=u.id WHERE i.id=$1',
      [inquiryId],
    )
  ).rows[0];
  await request(
    chatBase + '/auth/login',
    json(
      { nickname: profile.nickname, initials: 'Попытка входа посетителя' },
      { 'x-service-key': config.MANAGER_INTERNAL_KEY },
    ),
    403,
  );
}, 20000);
