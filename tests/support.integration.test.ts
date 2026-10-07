import 'reflect-metadata';
import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { WebSocket } from 'ws';
import { createApplication } from '../dist/app';
import { readConfig } from '../dist/config';
import { Database } from '../dist/database';
import { SupportService } from '../dist/support';
import { SiteSchema } from '../src/contracts';
import type { SupportSession } from '../src/support';

const original = readConfig();
const databaseUrl = new URL(original.DATABASE_URL);

if (
  databaseUrl.hostname !== '127.0.0.1' ||
  databaseUrl.port !== '56441' ||
  databaseUrl.pathname !== '/manager_support_qa' ||
  original.REDIS_URL !== 'redis://127.0.0.1:6391/1'
)
  throw new Error('Проверка разрешена только в отдельном контуре smart-press-support');

const databaseName = `manager_support_test_${Date.now()}`;
const admin = new Pool({ connectionString: databaseUrl.href });
databaseUrl.pathname = '/' + databaseName;
const db = new Pool({ connectionString: databaseUrl.href });
const widgetOrigin = 'http://127.0.0.1:44310';
const parentOrigin = 'http://127.0.0.1:8086';
const base = 'http://127.0.0.1:44315';
const key = randomBytes(32).toString('hex');
const profile = SiteSchema.parse({
  ...original.sites.find((site) => site.support),
  id: 'support-test-a',
  origins: [parentOrigin],
  widgetOrigins: [widgetOrigin],
  support: {
    clientId: 'support-test-a',
    name: 'Умный пресс - Тула',
    keyEnv: 'SUPPORT_TEST_KEY',
  },
});
const config = {
  ...original,
  DATABASE_URL: databaseUrl.href,
  PORT: 44315,
  CHAT_SERVICE_URL: 'http://127.0.0.1:44515/api',
  MANAGER_QUEUE_PREFIX: databaseName,
  MANAGER_REDIS_PREFIX: databaseName,
  sites: [
    profile,
    {
      ...profile,
      id: 'support-test-b',
      support: { ...profile.support!, clientId: 'support-test-b', name: 'Другой клиент' },
    },
  ],
  supportKeys: {
    'support-test-a': key,
    'support-test-b': randomBytes(32).toString('hex'),
  },
};
let runtime: Awaited<ReturnType<typeof createApplication>>;
let started = false;
let guest: SupportSession;
let inquiryId: string;
let loseNextProvision = false;
const topics = new Map<string, { topicId: string; clientId: string }>();
const upstream = createServer(async (request, response): Promise<void> => {
  if (request.headers['x-manager-key'] !== config.CHAT_MANAGER_KEY) {
    response.writeHead(401).end();
    return;
  }

  const url = new URL(request.url || '/', 'http://localhost');
  response.setHeader('Content-Type', 'application/json');

  if (url.pathname.endsWith('/ready')) {
    response.end(JSON.stringify({ ready: true, version: 1 }));
    return;
  }
  if (url.pathname.endsWith('/events')) {
    response.end(JSON.stringify({ events: [] }));
    return;
  }
  if (url.pathname.includes('/managers/')) {
    response.end(JSON.stringify({ allowed: true, erpUserId: null }));
    return;
  }
  if (request.method === 'PUT' && url.pathname.includes('/inquiries/')) {
    let body = '';

    for await (const chunk of request) body += String(chunk);

    const input = JSON.parse(body) as {
      version: number;
      customerName: string;
      source: { supportClientId: string };
    };
    expect(input.version).toBe(1);
    expect(input.customerName).toBeTruthy();
    const id = url.pathname.split('/').at(-1)!;
    const saved = topics.get(id) || {
      topicId: randomUUID(),
      clientId: input.source.supportClientId,
    };
    topics.set(id, saved);

    if (loseNextProvision) {
      response.destroy();
      return;
    }

    response.end(JSON.stringify({ topicId: saved.topicId }));
    return;
  }

  response.writeHead(404).end('{}');
});

const json = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(15000),
});

const connect = async (clientId = 'support-test-a', supplied = key): Promise<Response> =>
  fetch(
    base + `/v1/support/${clientId}/session`,
    json({}, { 'x-support-key': supplied }),
  );

const snapshot = async (token = guest.token, origin = widgetOrigin): Promise<Response> =>
  fetch(
    base + '/v1/widget/session',
    json(
      {
        siteId: profile.id,
        source: { pageUrl: parentOrigin + '/', title: 'Пресс', referrerOrigin: '' },
      },
      { Origin: origin, Authorization: 'Bearer ' + token },
    ),
  );

beforeAll(async (): Promise<void> => {
  await admin.query('CREATE DATABASE ' + databaseName);
  const schema = new Database(config);

  try {
    await schema.migrate();
  } finally {
    await schema.onModuleDestroy();
  }

  await new Promise<void>((resolve) => upstream.listen(44515, '127.0.0.1', resolve));
  const prepare = spyOn(SupportService.prototype, 'onModuleInit').mockImplementation(
    (): void => {},
  );

  try {
    runtime = await createApplication(config);
    await runtime.app.listen(44315, '127.0.0.1');
    started = true;
  } finally {
    prepare.mockRestore();
  }
}, 30000);

afterAll(async (): Promise<void> => {
  if (started) {
    runtime.app.getHttpServer().closeAllConnections();
    await runtime.close();
  }
  upstream.closeAllConnections();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  await db.end();

  if (!/^manager_support_test_\d+$/.test(databaseName))
    throw new Error('Неверная тестовая база');

  await admin.query('DROP DATABASE IF EXISTS ' + databaseName + ' WITH (FORCE)');
  await admin.end();
}, 30000);

test('нельзя открыть клиента с чужим ключом или подменить тело подключения', async (): Promise<void> => {
  expect((await connect('support-test-a', 'wrong')).status).toBe(403);
  expect((await connect('unknown', key)).status).toBe(403);
  expect(
    (
      await fetch(
        base + '/v1/support/support-test-a/session',
        json({ clientId: 'support-test-b' }, { 'x-support-key': key }),
      )
    ).status,
  ).toBe(400);
  expect(topics.size).toBe(0);
});

test('параллельное первое открытие создаёт один чат без фиктивного сообщения', async (): Promise<void> => {
  const responses = await Promise.all(
    Array.from({ length: 5 }, (): Promise<Response> => connect()),
  );

  for (const response of responses) expect(response.status).toBe(201);

  const sessions = await Promise.all(
    responses.map(async (response): Promise<SupportSession> => response.json()),
  );
  guest = sessions[0];
  expect(new Set(sessions.map((session) => session.token)).size).toBe(1);
  expect(topics.size).toBe(1);
  expect((await db.query('SELECT 1 FROM support_clients')).rowCount).toBe(1);
  expect((await db.query('SELECT 1 FROM guest_sessions')).rowCount).toBe(1);
  expect((await db.query('SELECT 1 FROM messages')).rowCount).toBe(0);
  const response = await snapshot();
  expect(response.status).toBe(201);
  const body = (await response.json()) as { inquiryId: string; messages: unknown[] };
  inquiryId = body.inquiryId;
  expect(inquiryId).toBeTruthy();
  expect(body.messages).toEqual([]);
});

test('гостевой сайт поддержки не создаёт анонимный чат и проверяет origin', async (): Promise<void> => {
  expect((await snapshot('', widgetOrigin)).status).toBe(403);
  expect((await snapshot(guest.token, 'https://other.example.test')).status).toBe(403);
  expect((await snapshot('a'.repeat(64))).status).toBe(401);
});

test('несколько операторов одновременно подключаются к общему чату поддержки', async (): Promise<void> => {
  const sockets: WebSocket[] = [];

  try {
    const ready = Array.from(
      { length: 5 },
      (): Promise<string> =>
        new Promise((resolve, reject) => {
          const socket = new WebSocket(
            base.replace('http:', 'ws:') + '/v1/widget/events',
            { headers: { Origin: widgetOrigin } },
          );
          sockets.push(socket);
          const timer = setTimeout(
            (): void => reject(new Error('Оператор не подключился')),
            8000,
          );

          socket.on('open', (): void => {
            socket.send(JSON.stringify({ type: 'authenticate', token: guest.token }));
          });
          socket.on('message', (raw): void => {
            const event = JSON.parse(String(raw)) as { type: string; inquiryId: string };

            if (event.type !== 'ready') return;

            clearTimeout(timer);
            resolve(event.inquiryId);
          });
          socket.on('error', (error): void => {
            clearTimeout(timer);
            reject(error);
          });
          socket.on('close', (): void => {
            clearTimeout(timer);
            reject(new Error('Подключение оператора закрыто'));
          });
        }),
    );

    expect(await Promise.all(ready)).toEqual(
      Array.from({ length: 5 }, (): string => inquiryId),
    );
  } finally {
    await Promise.all(
      sockets.map(
        (socket): Promise<void> =>
          new Promise((resolve) => {
            if (socket.readyState === WebSocket.CLOSED) return resolve();

            socket.once('close', resolve);
            socket.close();
          }),
      ),
    );
  }
});

test('возвращение после истечения доступа сохраняет идентификаторы, менеджер может ответить в отсутствие клиента', async (): Promise<void> => {
  await db.query("UPDATE guest_sessions SET expires_at=now()-interval '1 day'");
  const actor = randomUUID();
  const staffHeaders = {
    'x-manager-key': config.MANAGER_INTERNAL_KEY,
    'x-actor-id': actor,
  };
  const routes = await fetch(base + `/internal/staff/inquiries/${inquiryId}/routes`, {
    headers: staffHeaders,
  });
  expect(routes.status).toBe(200);
  const body = (await routes.json()) as Array<{ id: string; canReply: boolean }>;
  expect(body[0].canReply).toBe(true);
  expect(
    (
      await fetch(
        base + `/internal/staff/inquiries/${inquiryId}/reply-route`,
        json({ routeId: body[0].id }, staffHeaders),
      )
    ).status,
  ).toBe(201);
  expect((await snapshot()).status).toBe(401);
  const renewed = await connect();
  expect(renewed.status).toBe(201);
  expect(((await renewed.json()) as SupportSession).token).toBe(guest.token);
  const restored = await snapshot();
  expect(((await restored.json()) as { inquiryId: string }).inquiryId).toBe(inquiryId);
  expect((await db.query('SELECT 1 FROM support_clients')).rowCount).toBe(1);
});

test('повтор после потери ответа использует тот же чат и не раскрывает историю соседнего клиента', async (): Promise<void> => {
  loseNextProvision = true;
  expect(
    (await connect('support-test-b', config.supportKeys['support-test-b'])).status,
  ).toBe(503);
  loseNextProvision = false;
  const response = await connect('support-test-b', config.supportKeys['support-test-b']);
  expect(response.status).toBe(201);
  const other = (await response.json()) as SupportSession;
  expect(other.token).not.toBe(guest.token);
  expect(topics.size).toBe(2);
  const history = await fetch(base + `/v1/widget/inquiries/${inquiryId}/messages`, {
    headers: { Origin: widgetOrigin, Authorization: 'Bearer ' + other.token },
  });
  expect(history.status).toBe(404);
  expect((await db.query('SELECT 1 FROM support_clients')).rowCount).toBe(2);
});
