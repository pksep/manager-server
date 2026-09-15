import 'reflect-metadata';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { connect } from 'amqplib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { createApplication } from '../dist/app';
import { readConfig } from '../dist/config';
import { ChannelService } from '../dist/channels/service';
import { InquiriesService } from '../dist/inquiries.service';
import { OperationQueue } from '../dist/operation-queue';
import { Database } from '../dist/database';
import {
  localActors,
  awaitManagerAccess,
  clientPermission,
} from './support/local-managers';
import type { ChannelTransport } from '../src/channels/http-client';

const original = readConfig();
const address = new URL(original.DATABASE_URL);
if (
  address.hostname !== '127.0.0.1' ||
  address.port !== '56441' ||
  address.pathname !== '/manager_local' ||
  original.CHAT_SERVICE_URL !== 'http://127.0.0.1:4501/api'
)
  throw new Error('Тест разрешён только на изолированном стенде manager');
const suffix = randomUUID().slice(0, 8);
const shared = {
  name: 'Тест каналов',
  enabled: true,
  webhookSecretEnv: 'TEST_SECRET',
  webhookSecret: randomUUID().replaceAll('-', ''),
};
const vk = {
  ...shared,
  id: `vk-test-${suffix}`,
  platform: 'vk' as const,
  accountId: String(100000000 + Math.floor(Math.random() * 100000000)),
  tokenEnv: 'TEST_TOKEN',
  confirmationEnv: 'TEST_CONFIRM',
  token: 'local-test',
  confirmation: 'local-confirmation',
};
const avito = {
  ...shared,
  id: `avito-test-${suffix}`,
  platform: 'avito' as const,
  accountId: String(200000000 + Math.floor(Math.random() * 100000000)),
  webhookSecret: randomUUID().replaceAll('-', ''),
  clientIdEnv: 'TEST_CLIENT',
  clientSecretEnv: 'TEST_CLIENT_SECRET',
  clientId: 'local-test',
  clientSecret: 'local-test',
};
const config = {
  ...original,
  channels: [vk, avito],
  MANAGER_REDIS_PREFIX: `manager-channels-${suffix}`,
  MANAGER_QUEUE_PREFIX: `manager-channels-${suffix}`,
};
const db = new Pool({ connectionString: config.DATABASE_URL, max: 2 });
address.pathname = '/manager_chat_local';
const chatDb = new Pool({ connectionString: address.href, max: 2 });
address.pathname = '/manager_erp_local';
const erpDb = new Pool({ connectionString: address.href, max: 1 });
const base = 'http://127.0.0.1:4314';
const chat = config.CHAT_SERVICE_URL;
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWLsAAAAASUVORK5CYII=',
  'base64',
);
const fixtures = new Map<string, any>();
const sent: Array<{
  platform: string;
  chatId: string;
  text: string;
  image?: string;
  randomId?: string;
}> = [];
const vkIds = new Map<string, number>();
let nextId = 1000;
let lostAvito = false,
  lostVk = false;
let runtime: Awaited<ReturnType<typeof createApplication>>;
let alice: { id: string; token: string }, bob: { id: string; token: string };
let oldPermission = true;
let peer = 500000000 + Math.floor(Math.random() * 100000000);

const transport: ChannelTransport = async (url, init) => {
  const reply = (value: unknown) => Response.json(value);
  if (url.hostname === 'sun9.userapi.com' || url.hostname === 'img.avito.st')
    return new Response(png, { headers: { 'Content-Type': 'image/png' } });
  if (url.hostname === 'upload.vk.com') {
    await new Response(init.body).arrayBuffer();
    return reply({ file: 'uploaded-document' });
  }
  if (url.hostname === 'api.vk.com') {
    const body = new URLSearchParams(String(init.body));
    if (url.pathname.endsWith('/users.get'))
      return reply({
        response: [{ first_name: 'Клиент ВКонтакте', last_name: body.get('user_ids') }],
      });
    if (url.pathname.endsWith('/docs.getMessagesUploadServer'))
      return reply({ response: { upload_url: 'https://upload.vk.com/document' } });
    if (url.pathname.endsWith('/docs.save'))
      return reply({ response: { type: 'doc', doc: { owner_id: -777, id: 1 } } });
    if (url.pathname.endsWith('/messages.send')) {
      const randomId = body.get('random_id')!;
      if (!vkIds.has(randomId)) {
        vkIds.set(randomId, ++nextId);
        sent.push({
          platform: 'vk',
          chatId: body.get('peer_id')!,
          text: body.get('message')!,
          randomId,
        });
      }
      if (lostVk) {
        lostVk = false;
        throw new Error('Lost VK acknowledgement');
      }
      return reply({ response: vkIds.get(randomId) });
    }
  }
  if (url.hostname === 'api.avito.ru') {
    if (url.pathname === '/token/')
      return reply({ access_token: 'test-access', expires_in: 3600 });
    const match = /\/chats\/([^/]+)/.exec(url.pathname);
    const chatId = match ? decodeURIComponent(match[1]) : '';
    if (init.method === 'GET' && url.pathname.includes('/messages/'))
      return reply([fixtures.get(chatId)]);
    if (init.method === 'GET' && match)
      return reply({
        id: chatId,
        users: [
          {
            id: fixtures.get(chatId).author_id,
            name: `Клиент Авито ${fixtures.get(chatId).author_id}`,
          },
        ],
        context: {
          value: {
            id: 123,
            title: 'Оборудование',
            url: 'https://www.avito.ru/items/123',
          },
        },
      });
    if (url.pathname.endsWith('/uploadImages')) {
      await new Response(init.body).arrayBuffer();
      return reply({ 'image-1': { '1x1': 'https://img.avito.st/image.png' } });
    }
    if (init.method === 'POST' && match) {
      const body = JSON.parse(String(init.body));
      sent.push({
        platform: 'avito',
        chatId,
        text: body.message?.text || '',
        image: body.image_id,
      });
      if (lostAvito) {
        lostAvito = false;
        throw new Error('Lost Avito acknowledgement');
      }
      return reply({ id: `out-${++nextId}` });
    }
  }
  throw new Error(`Unexpected test request: ${url.origin}${url.pathname}`);
};

const json = (body: unknown, token?: string): RequestInit => ({
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  },
  body: JSON.stringify(body),
});
async function request(path: string, init: RequestInit = {}, status = 200): Promise<any> {
  const response = await fetch(path, { ...init, signal: AbortSignal.timeout(15000) });
  const value = await response.text();
  if (response.status !== status)
    throw new Error(
      `${new URL(path).pathname}: ${response.status}, expected ${status}: ${value.slice(0, 200)}`,
    );
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
async function until<T>(
  work: () => Promise<T>,
  accepts: (result: T) => boolean,
  timeout = 25000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await work();
    if (accepts(value)) return value;
    await Bun.sleep(150);
  }
  throw new Error('Не дождались результата канала');
}
const headers = () => ({ Authorization: `Bearer ${alice.token}` });
async function login(index: number) {
  const actor = localActors[index];
  const user = (
    await chatDb.query('SELECT initials FROM users WHERE nickname=$1', [actor.tabel])
  ).rows[0];
  const response = await request(
    chat + '/auth/login',
    {
      ...json({ nickname: actor.tabel, initials: user.initials }),
      headers: {
        'Content-Type': 'application/json',
        'x-service-key': config.MANAGER_INTERNAL_KEY,
      },
    },
    201,
  );
  return { id: response.user.id, token: response.accessToken || response.token };
}
function event(platform: 'vk' | 'avito', image = false) {
  const person = String(++peer);
  if (platform === 'vk')
    return {
      type: 'message_new',
      group_id: Number(vk.accountId),
      secret: vk.webhookSecret,
      object: {
        message: {
          id: peer,
          conversation_message_id: peer,
          peer_id: peer,
          from_id: peer,
          date: Math.floor(Date.now() / 1000),
          text: `Проверка ВК ${suffix}`,
          attachments: image
            ? [
                {
                  type: 'doc',
                  doc: {
                    id: peer,
                    title: 'Проверка.png',
                    url: 'https://sun9.userapi.com/image.png',
                    size: png.length,
                  },
                },
              ]
            : [],
        },
      },
    };
  const chatId = `u2i-${randomUUID()}`;
  const id = randomUUID();
  fixtures.set(chatId, {
    id,
    author_id: person,
    created: Math.floor(Date.now() / 1000),
    direction: 'in',
    type: image ? 'image' : 'text',
    content: image
      ? { image: { sizes: { '1x1': 'https://img.avito.st/image.png' } } }
      : { text: `Проверка Авито ${suffix}` },
  });
  return {
    id: randomUUID(),
    payload: {
      type: 'message',
      value: { id, user_id: avito.accountId, author_id: person, chat_id: chatId },
    },
  };
}
const callback = (platform: 'vk' | 'avito') =>
  platform === 'vk'
    ? `${base}/v1/channels/vk/${vk.id}`
    : `${base}/v1/channels/avito/${avito.id}/${avito.webhookSecret}`;
async function incoming(platform: 'vk' | 'avito', image = false) {
  const body: any = event(platform, image);
  await request(callback(platform), json(body));
  const external =
    platform === 'vk' ? String(body.object.message.peer_id) : body.payload.value.chat_id;
  const result = await until(
    () =>
      db.query(
        'SELECT r.*,i.topic_id,i.customer_id FROM reply_routes r JOIN inquiries i ON i.id=r.inquiry_id WHERE connection_id=$1 AND external_chat_id=$2',
        [platform === 'vk' ? vk.id : avito.id, external],
      ),
    (result) => !!result.rows[0]?.topic_id,
  );
  return { ...result.rows[0], body };
}
async function reply(
  route: any,
  text: string,
  actor = alice,
  attachments: string[] = [],
  operationId = randomUUID(),
) {
  await request(
    `${chat}/manager/inquiries/${route.inquiry_id}/messages`,
    json(
      {
        operationId,
        routeId: route.id,
        html: `<p>${text}</p>`,
        attachmentIds: attachments,
      },
      actor.token,
    ),
    201,
  );
  return (
    await until(
      () =>
        db.query(
          'SELECT o.* FROM channel_outbox o JOIN messages m ON m.id=o.id WHERE o.route_id=$1 AND m.html LIKE $2 ORDER BY m.sequence DESC LIMIT 1',
          [route.id, `%${text}%`],
        ),
      (rows) => !!rows.rows[0],
    )
  ).rows[0];
}
async function delivery(id: string, state = 'delivered') {
  return (
    await until(
      () => db.query('SELECT * FROM channel_outbox WHERE id=$1', [id]),
      (value) => value.rows[0]?.state === state,
    )
  ).rows[0];
}

beforeAll(async () => {
  const database = new Database(config);
  await database.migrate();
  await database.onModuleDestroy();
  alice = await login(0);
  bob = await login(1);
  const saved = await clientPermission(erpDb, localActors[1].roleId, true);
  oldPermission = saved;
  await awaitManagerAccess(chat, alice.token, true);
  await awaitManagerAccess(chat, bob.token, true);
  runtime = await createApplication(config, { channelTransport: transport });
  await runtime.app.listen(4314, '127.0.0.1');
}, 60000);

afterAll(async () => {
  runtime?.app.getHttpServer().closeAllConnections();
  await runtime?.close();
  await clientPermission(erpDb, localActors[1].roleId, oldPermission);
  const connection = await connect(config.MANAGER_RABBITMQ_URL!);
  try {
    const channel = await connection.createChannel();
    for (const kind of ['delivery', 'erp', 'channel-inbox', 'channel-outbox'])
      for (const ending of ['', '.retry', '.failed'])
        await channel.deleteQueue(`${config.MANAGER_QUEUE_PREFIX}.${kind}${ending}`);
  } finally {
    await connection.close();
  }
  await Promise.all([db.end(), chatDb.end(), erpDb.end()]);
}, 30000);

test('подтверждение ВК и проба Авито; неверный секрет и аккаунт не принимаются', async () => {
  expect(
    await request(
      callback('vk'),
      json({
        type: 'confirmation',
        group_id: Number(vk.accountId),
        secret: vk.webhookSecret,
      }),
    ),
  ).toBe(vk.confirmation);
  await request(
    callback('vk'),
    json({
      type: 'confirmation',
      group_id: Number(vk.accountId) + 1,
      secret: vk.webhookSecret,
    }),
    403,
  );
  await request(
    callback('vk'),
    json({ type: 'confirmation', group_id: Number(vk.accountId), secret: 'wrong' }),
    403,
  );
  expect(await request(callback('avito'), json({}))).toEqual({ ok: true });
  await request(callback('avito').replace(avito.webhookSecret, 'wrong'), json({}), 403);
});

test('параллельные повторы ВК создают одну заявку и одно каноническое сообщение', async () => {
  const body: any = event('vk');
  await Promise.all(Array.from({ length: 6 }, () => request(callback('vk'), json(body))));
  const route = (
    await until(
      () =>
        db.query(
          'SELECT r.*,i.topic_id FROM reply_routes r JOIN inquiries i ON i.id=r.inquiry_id WHERE connection_id=$1 AND external_chat_id=$2',
          [vk.id, String(body.object.message.peer_id)],
        ),
      (result) => !!result.rows[0]?.topic_id,
    )
  ).rows[0];
  expect(
    (
      await db.query(
        'SELECT id FROM channel_inbox WHERE connection_id=$1 AND event_key=$2',
        [
          vk.id,
          `${body.object.message.peer_id}:${body.object.message.conversation_message_id}`,
        ],
      )
    ).rowCount,
  ).toBe(1);
  expect(
    (await db.query('SELECT id FROM messages WHERE session_id=$1', [route.id])).rowCount,
  ).toBe(1);
  expect(
    (await db.query('SELECT id FROM guest_sessions WHERE id=$1', [route.id])).rowCount,
  ).toBe(0);
  expect(
    (
      await chatDb.query(
        'SELECT m.id FROM messages m JOIN manager_message_receipts r ON r.message_id=m.id WHERE r.topic_id=$1',
        [route.topic_id],
      )
    ).rowCount,
  ).toBe(1);
});

test('оба менеджера отвечают в ВК; назначение остаётся у первого', async () => {
  const route = await incoming('vk');
  const first = await reply(route, 'Первый ответ');
  await delivery(first.id);
  const second = await reply(route, 'Второй ответ', bob);
  await delivery(second.id);
  expect(
    (await db.query('SELECT assignee_id FROM inquiries WHERE id=$1', [route.inquiry_id]))
      .rows[0].assignee_id,
  ).toBe(alice.id);
  expect(
    sent.some(
      (item) =>
        item.platform === 'vk' &&
        item.chatId === route.external_chat_id &&
        item.text === 'Второй ответ',
    ),
  ).toBe(true);
});

test('Авито сверяет сообщение через API и отправляет длинный ответ по частям', async () => {
  const route = await incoming('avito');
  const job = await reply(route, 'я'.repeat(2100));
  await delivery(job.id);
  const parts = sent.filter(
    (item) => item.platform === 'avito' && item.chatId === route.external_chat_id,
  );
  expect(parts.map((item) => item.text.length)).toEqual([1000, 1000, 100]);
  const result = await request(`${chat}/manager/inquiries/${route.inquiry_id}/routes`, {
    headers: headers(),
  });
  expect(result[0].capabilities.mimeTypes).not.toContain('application/pdf');
  expect(result[0].canReply).toBe(true);
});

test('чужой маршрут ответа и отсутствие роли закрывают доступ', async () => {
  const left = await incoming('vk'),
    right = await incoming('avito');
  await request(
    `${chat}/manager/inquiries/${left.inquiry_id}/messages`,
    json(
      { operationId: randomUUID(), routeId: right.id, html: 'чужой', attachmentIds: [] },
      alice.token,
    ),
    404,
  );
  await clientPermission(erpDb, localActors[1].roleId, false);
  try {
    await awaitManagerAccess(chat, bob.token, false);
    await request(
      `${chat}/manager/inquiries/${left.inquiry_id}/routes`,
      { headers: { Authorization: `Bearer ${bob.token}` } },
      403,
    );
    await request(
      `${chat}/manager/inquiries/${left.inquiry_id}/messages`,
      json(
        {
          operationId: randomUUID(),
          routeId: left.id,
          html: 'без роли',
          attachmentIds: [],
        },
        bob.token,
      ),
      403,
    );
  } finally {
    await clientPermission(erpDb, localActors[1].roleId, true);
    await awaitManagerAccess(chat, bob.token, true);
  }
});

test('потеря подтверждения ВК повторяет тот же random_id без второго сообщения', async () => {
  const route = await incoming('vk');
  lostVk = true;
  const job = await reply(route, 'Сохраняем идентификатор');
  await until(
    () => db.query('SELECT state,attempts FROM channel_outbox WHERE id=$1', [job.id]),
    (value) => value.rows[0]?.state === 'pending' && value.rows[0]?.attempts > 0,
  );
  await db.query('UPDATE channel_outbox SET next_attempt_at=now() WHERE id=$1', [job.id]);
  await runtime.app.get(OperationQueue).enqueue('channel-outbox', job.id);
  await delivery(job.id);
  expect(sent.filter((item) => item.chatId === route.external_chat_id)).toHaveLength(1);
});

test('потеря подтверждения Авито требует проверки перед повтором', async () => {
  const route = await incoming('avito');
  lostAvito = true;
  const job = await reply(route, 'Проверка неопределённости');
  await delivery(job.id, 'uncertain');
  await runtime.app.get(OperationQueue).enqueue('channel-outbox', job.id);
  await Bun.sleep(500);
  expect(sent.filter((item) => item.chatId === route.external_chat_id)).toHaveLength(1);
  await request(
    `${chat}/manager/inquiries/${route.inquiry_id}/channel-deliveries/retry`,
    json({ messageId: job.id }, alice.token),
    409,
  );
  await request(
    `${chat}/manager/inquiries/${route.inquiry_id}/channel-deliveries/retry`,
    json({ messageId: job.id, checkedOriginalChat: true }, alice.token),
    201,
  );
  await delivery(job.id);
  expect(sent.filter((item) => item.chatId === route.external_chat_id)).toHaveLength(2);
});

test('подтверждённая менеджером часть Авито не повторяется; оставшийся текст отправляется', async () => {
  const route = await incoming('avito');
  lostAvito = true;
  const text = 'р'.repeat(1005);
  const job = await reply(route, text);
  await delivery(job.id, 'uncertain');
  await request(
    `${chat}/manager/inquiries/${route.inquiry_id}/channel-deliveries/confirm`,
    json({ messageId: job.id, checkedOriginalChat: true }, alice.token),
    201,
  );
  const result = await delivery(job.id);
  expect(result.progress[0].confirmedBy).toBe(alice.id);
  expect(
    sent
      .filter((item) => item.chatId === route.external_chat_id)
      .map((item) => item.text)
      .join(''),
  ).toBe(text);
  const states = await request(
    `${chat}/manager/inquiries/${route.inquiry_id}/channel-deliveries`,
    { headers: headers() },
  );
  expect(states[0].confirmed_by_manager).toBe(true);
  await request(
    `${chat}/manager/inquiries/${route.inquiry_id}/channel-deliveries/confirm`,
    json({ messageId: job.id, checkedOriginalChat: true }, alice.token),
    409,
  );
});

test('вложения обоих каналов проходят настоящий сканер и приватное хранилище Чата', async () => {
  for (const platform of ['vk', 'avito'] as const) {
    const route = await incoming(platform, true);
    const message = (
      await db.query(
        'SELECT * FROM messages WHERE session_id=$1 ORDER BY sequence LIMIT 1',
        [route.id],
      )
    ).rows[0];
    expect(message.attachments).toHaveLength(1);
    const file = message.attachments[0];
    const downloaded = await runtime.app
      .get(InquiriesService)
      .chat.download(file.id, route.id);
    expect(Buffer.from(await downloaded.arrayBuffer()).equals(png)).toBe(true);
    const form = new FormData();
    form.set('operationId', randomUUID());
    form.set('file', new Blob([png], { type: 'image/png' }), 'Ответ.png');
    const upload = await request(
      `${chat}/manager/inquiries/${route.inquiry_id}/attachments?routeId=${route.id}`,
      { method: 'POST', headers: headers(), body: form },
      201,
    );
    const job = await reply(route, `Файл ${platform}`, alice, [upload.id]);
    await delivery(job.id);
    expect(sent.filter((item) => item.chatId === route.external_chat_id)).toHaveLength(2);
    if (platform === 'avito')
      expect(
        sent.some(
          (item) => item.chatId === route.external_chat_id && item.image === 'image-1',
        ),
      ).toBe(true);
  }
}, 60000);

test('Авито не принимает PDF, а новая сессия сайта не получает чужую историю', async () => {
  const route = await incoming('avito');
  const form = new FormData();
  form.set('operationId', randomUUID());
  form.set('file', new Blob(['%PDF-1.7\n'], { type: 'application/pdf' }), 'file.pdf');
  await request(
    `${chat}/manager/inquiries/${route.inquiry_id}/attachments?routeId=${route.id}`,
    { method: 'POST', headers: headers(), body: form },
    400,
  );
  const session = await request(
    `${base}/v1/widget/session`,
    {
      ...json({
        siteId: 'amotiv-demo',
        source: { pageUrl: 'http://127.0.0.1:4310/', title: 'Тест', referrerOrigin: '' },
      }),
      headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:4310' },
    },
    201,
  );
  expect(session.inquiryId).toBeNull();
  expect(
    (await db.query('SELECT 1 FROM widget_events WHERE session_id=$1', [route.id]))
      .rowCount,
  ).toBe(0);
});

test('новое сообщение Авито не перенаправляет ответ в выбранный диалог ВК', async () => {
  const route = await incoming('vk');
  const body: any = event('avito');
  // Подготавливаем уже сопоставленного клиента двух платформ; механизм отправки использует настоящие маршруты.
  await db.query(
    'INSERT INTO channel_customers(connection_id,external_user_id,customer_id) VALUES($1,$2,$3)',
    [avito.id, body.payload.value.author_id, route.customer_id],
  );
  await request(callback('avito'), json(body));
  await until(
    () => db.query('SELECT id FROM reply_routes WHERE inquiry_id=$1', [route.inquiry_id]),
    (result) => result.rowCount === 2,
  );
  await until(
    () =>
      chatDb.query('SELECT id FROM manager_routes WHERE inquiry_id=$1', [
        route.inquiry_id,
      ]),
    (result) => result.rowCount === 2,
  );
  const job = await reply(route, 'Ответ именно ВКонтакте');
  await delivery(job.id);
  expect(
    sent.some(
      (item) =>
        item.platform === 'vk' &&
        item.chatId === route.external_chat_id &&
        item.text === 'Ответ именно ВКонтакте',
    ),
  ).toBe(true);
  expect(sent.some((item) => item.chatId === body.payload.value.chat_id)).toBe(false);
  expect((await runtime.app.get(ChannelService).routes(route.inquiry_id)).length).toBe(2);
});

test('клиент без реквизитов открывает создание в ЕРП и связывает выбранный контакт', async () => {
  const route = await incoming('vk');
  expect(
    await request(`${chat}/manager/inquiries/${route.inquiry_id}/erp/candidates`, {
      headers: headers(),
    }),
  ).toEqual([]);
  const contact = (
    await erpDb.query('SELECT id FROM contacts WHERE ban=false ORDER BY id LIMIT 1')
  ).rows[0];
  expect(contact).toBeTruthy();
  const operationId = randomUUID();
  await request(
    `${chat}/manager/inquiries/${route.inquiry_id}/erp/sync`,
    json({ operationId, contactId: contact.id }, alice.token),
    201,
  );
  const completed = await until(
    () => db.query('SELECT state FROM erp_sync_operations WHERE id=$1', [operationId]),
    (result) => ['completed', 'failed', 'conflict'].includes(result.rows[0]?.state),
  );
  expect(completed.rows[0].state).toBe('completed');
});

test('обычный редактор Чата отправляет ответы в площадки на ПК и мобильном экране', async () => {
  const fixtures = [];
  for (const [platform, width] of [
    ['vk', 1440],
    ['avito', 390],
  ] as const) {
    const route = await incoming(platform);
    const name = (
      await db.query('SELECT name FROM customers WHERE id=$1', [route.customer_id])
    ).rows[0].name;
    fixtures.push({
      platform,
      width,
      routeId: route.id,
      external: route.external_chat_id,
      name,
      text: `Ответ ${platform} с экрана ${width}`,
    });
  }
  await writeFile('.local/channels-browser-fixtures.json', JSON.stringify(fixtures));
  // Драйвер Playwright запускается в Node; сам сервис и проверки продолжают работать в Bun.
  const result = await promisify(execFile)('node', ['scripts/verify-channels.mjs'], {
    timeout: 180000,
    windowsHide: true,
  });
  console.info(result.stdout);
  for (const fixture of fixtures)
    expect(
      sent.some((item) => item.chatId === fixture.external && item.text === fixture.text),
    ).toBe(true);
}, 200000);
