import 'reflect-metadata';
import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { promisify } from 'node:util';
import type { Server } from 'bun';
import { connect } from 'amqplib';
import { createClient } from 'redis';
import { z } from 'zod';
import { createApplication } from '../dist/app';
import { readConfig, type Config } from '../dist/config';
import { Database } from '../dist/database';
import { RetentionWorker } from '../dist/retention';
import type { ChannelConnection } from '../src/channels/config';
import type { ChannelTransport } from '../src/channels/http-client';

const run = promisify(execFile);
const testId = randomUUID().slice(0, 8);
const password = randomUUID();
const containers: string[] = [];
const packetSchema = z.object({
  operationId: z.uuid(),
  customerName: z.string().min(1).max(100),
  html: z.string(),
  source: z.object({ channel: z.enum(['avito', 'widget']) }).passthrough(),
});
const packets = new Map<string, z.infer<typeof packetSchema>>();
const receipts = new Map<
  string,
  { topicId: string; messageId: string; sequence: number }
>();
const pages = new Map<string, unknown>();
let messageRequests = 0;
let upstream: Server<undefined> | undefined;
let runtime: Awaited<ReturnType<typeof createApplication>> | undefined;
let database: Database | undefined;
let base = '';
let config: Config;

const connection: ChannelConnection = {
  id: `avito-isolated-${testId}`,
  name: 'Изолированный тест Авито',
  platform: 'avito',
  accountId: '100',
  enabled: true,
  webhookSecretEnv: 'TEST_WEBHOOK_SECRET',
  webhookSecret: randomUUID().replaceAll('-', ''),
  clientIdEnv: 'TEST_CLIENT_ID',
  clientSecretEnv: 'TEST_CLIENT_SECRET',
  clientId: 'test-client',
  clientSecret: 'test-secret',
};

async function docker(args: string[]): Promise<string> {
  const result = await run('docker', args, { timeout: 30000 });

  return result.stdout.trim();
}

async function container(image: string, port: number, env: string[]): Promise<number> {
  const name = `manager-avito-${testId}-${port}`;
  containers.push(name);

  await docker([
    'run',
    '--rm',
    '-d',
    '--name',
    name,
    '--label',
    `pksep.avito-test=${testId}`,
    '--cpus',
    '1',
    '--memory',
    '512m',
    '-p',
    `127.0.0.1::${port}`,
    ...env.flatMap((value) => ['-e', value]),
    image,
  ]);
  const binding = await docker(['port', name, `${port}/tcp`]);

  if (!/^127\.0\.0\.1:\d+$/.test(binding))
    throw new Error('Тестовая зависимость должна слушать только loopback');

  return Number(binding.split(':')[1]);
}

async function until<T>(
  work: () => Promise<T>,
  accepts: (result: T) => boolean,
): Promise<T> {
  const deadline = Date.now() + 30000;

  while (Date.now() < deadline) {
    const result = await work();

    if (accepts(result)) return result;

    await Bun.sleep(100);
  }

  throw new Error('Изолированный сценарий Авито не завершился вовремя');
}

const transport: ChannelTransport = async (url, init): Promise<Response> => {
  if (url.hostname !== 'api.avito.ru')
    throw new Error('Тест не должен обращаться к другим площадкам');

  if (url.pathname === '/token/')
    return Response.json({ access_token: 'test-access', expires_in: 3600 });

  expect(new Headers(init.headers).get('authorization')).toBe('Bearer test-access');
  const chatId = /\/chats\/([^/]+)/.exec(url.pathname)?.[1];

  if (chatId && url.pathname.endsWith('/messages/')) {
    messageRequests++;

    return Response.json(pages.get(chatId));
  }

  if (chatId && init.method === 'GET')
    return Response.json({
      id: chatId,
      users: [{ id: '200', name: 'Тестовый посетитель Авито' }],
      context: {
        value: {
          id: '300',
          title: 'Тестовое оборудование',
          url: 'https://www.avito.ru/items/300',
        },
      },
    });

  throw new Error('Неожиданный запрос Авито в изолированном тесте');
};

function event(chatId: string, messageId: string): object {
  return {
    id: randomUUID(),
    payload: {
      type: 'message',
      value: { id: messageId, chat_id: chatId, user_id: '100', author_id: '200' },
    },
  };
}

async function callback(body: object): Promise<void> {
  const response = await fetch(
    `${base}/v1/channels/avito/${connection.id}/${connection.webhookSecret}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    },
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
}

beforeAll(async (): Promise<void> => {
  // Не используем существующие базы/брокеры. Не более двух одновременных запусков.
  const first = await Promise.allSettled([
    container('postgres:18-alpine', 5432, [
      'POSTGRES_DB=manager_avito_test',
      'POSTGRES_USER=avito_test',
      `POSTGRES_PASSWORD=${password}`,
    ]),
    container('redis:8-alpine', 6379, []),
  ]);
  const [postgresPort, redisPort] = first.map((result): number => {
    if (result.status !== 'fulfilled')
      throw new Error('Не удалось создать отдельные зависимости Авито');

    return result.value;
  });
  const rabbitPort = await container('rabbitmq:4-alpine', 5672, [
    'RABBITMQ_DEFAULT_USER=avito_test',
    `RABBITMQ_DEFAULT_PASS=${password}`,
  ]);

  upstream = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (request): Promise<Response> => {
      expect(request.headers.get('x-manager-key')).toBe('c'.repeat(32));
      const url = new URL(request.url);

      if (url.pathname.endsWith('/events')) return Response.json({ events: [] });
      if (url.pathname.endsWith('/ready'))
        return Response.json({ ready: true, version: 1 });

      if (
        request.method === 'POST' &&
        /\/inquiries\/[^/]+\/messages$/.test(url.pathname)
      ) {
        const packet = packetSchema.parse(await request.json());
        packets.set(packet.operationId, packet);

        if (!receipts.has(packet.operationId))
          receipts.set(packet.operationId, {
            topicId: randomUUID(),
            messageId: randomUUID(),
            sequence: receipts.size + 1,
          });

        return Response.json(receipts.get(packet.operationId));
      }

      return new Response('Unexpected local test request', { status: 404 });
    },
  });
  config = {
    ...readConfig({
      HOST: '127.0.0.1',
      DATABASE_URL: `postgresql://avito_test:${password}@127.0.0.1:${postgresPort}/manager_avito_test`,
      REDIS_URL: `redis://127.0.0.1:${redisPort}/0`,
      MANAGER_RABBITMQ_URL: `amqp://avito_test:${password}@127.0.0.1:${rabbitPort}`,
      MANAGER_INTERNAL_KEY: 'm'.repeat(32),
      CHAT_MANAGER_KEY: 'c'.repeat(32),
      CHAT_SERVICE_URL: `http://127.0.0.1:${upstream.port}/api`,
      MANAGER_SITES_PATH: 'config/sites.example.json',
      MANAGER_QUEUE_PREFIX: `avito-${testId}`,
      MANAGER_REDIS_PREFIX: `avito-${testId}`,
      MANAGER_CAPTCHA_MODE: 'disabled',
      MANAGER_SCAN_MODE: 'disabled',
    }),
    channels: [connection],
  };
  const bootstrap = new Database(config);

  try {
    await until(async (): Promise<boolean> => {
      try {
        await bootstrap.query('SELECT 1');
        return true;
      } catch {
        return false;
      }
    }, Boolean);
    await bootstrap.migrate();
  } finally {
    await bootstrap.onModuleDestroy();
  }

  await until(async (): Promise<boolean> => {
    try {
      const broker = await connect(config.MANAGER_RABBITMQ_URL!, { timeout: 1000 });
      await broker.close();

      return true;
    } catch {
      return false;
    }
  }, Boolean);
  const redis = createClient({
    url: config.REDIS_URL,
    socket: { reconnectStrategy: false },
  });
  redis.on('error', (): void => {});

  try {
    await redis.connect();
    await redis.ping();
  } finally {
    if (redis.isOpen) await redis.disconnect();
  }

  // Общая очистка временных файлов не относится к проверке Авито и не должна
  // касаться файлов других локальных задач, даже если тест затянется.
  const retention = spyOn(RetentionWorker.prototype, 'onModuleInit').mockImplementation(
    (): void => {},
  );

  try {
    runtime = await createApplication(config, { channelTransport: transport });
  } finally {
    retention.mockRestore();
  }

  await runtime.app.listen(0, '127.0.0.1');
  const address = runtime.app.getHttpServer().address() as AddressInfo;
  base = `http://127.0.0.1:${address.port}`;
  database = runtime.app.get(Database);
}, 90000);

afterAll(async (): Promise<void> => {
  await runtime?.close();
  await upstream?.stop(true);

  for (const name of containers) {
    let label: string;

    try {
      label = await docker([
        'inspect',
        '--format',
        '{{index .Config.Labels "pksep.avito-test"}}',
        name,
      ]);
    } catch (error) {
      if (error instanceof Error && /No such (object|container)/i.test(error.message))
        continue;

      throw error;
    }

    if (label !== testId) throw new Error('Нельзя удалять чужую тестовую зависимость');

    await docker(['rm', '-f', name]);
  }
}, 60000);

test('webhook с историей messages/meta доходит через БД и RabbitMQ до HTTP Чата', async (): Promise<void> => {
  pages.set('chat-good', {
    messages: [
      {
        id: 'message-good',
        author_id: '200',
        created: 1791878400,
        direction: 'in',
        type: 'text',
        content: { text: 'Проверка Авито → Чат' },
      },
    ],
    meta: { futureField: 'not-a-message' },
  });
  await callback(event('chat-good', 'message-good'));
  await until(
    async (): Promise<number> => packets.size,
    (size) => size === 1,
  );
  await until(
    async (): Promise<string | undefined> =>
      (await database!.query<{ state: string }>('SELECT state FROM channel_inbox'))
        .rows[0]?.state,
    (state) => state === 'delivered',
  );
  const packet = [...packets.values()][0];

  expect(packet.html).toBe('<p>Проверка Авито → Чат</p>');
  expect(packet.source).toMatchObject({
    channel: 'avito',
    connectionId: connection.id,
    itemId: '300',
  });
  expect(
    (
      await database!.query<{ state: string; last_error: string | null }>(
        'SELECT state,last_error FROM channel_inbox',
      )
    ).rows[0],
  ).toEqual({ state: 'delivered', last_error: null });
});

test('повтор уведомления не повторяет чтение истории и не создаёт сообщение-дубль', async (): Promise<void> => {
  const before = messageRequests;
  await callback(event('chat-good', 'message-good'));
  await Bun.sleep(100);

  expect(messageRequests).toBe(before);
  expect(packets.size).toBe(1);
  expect((await database!.query('SELECT id FROM messages')).rowCount).toBe(1);
  expect(
    (await database!.query('SELECT external_message_id FROM channel_message_receipts'))
      .rows,
  ).toEqual([{ external_message_id: 'message-good' }]);
});

test('повреждённая страница не создаёт обращение и сохраняет ошибку для повторной обработки', async (): Promise<void> => {
  pages.set('chat-bad', { messages: {}, meta: {} });
  await callback(event('chat-bad', 'message-bad'));
  const job = await until(
    async (): Promise<{ state: string; attempts: number; last_error: string | null }> => {
      const result = await database!.query<{
        state: string;
        attempts: number;
        last_error: string | null;
      }>('SELECT state,attempts,last_error FROM channel_inbox WHERE event_key=$1', [
        'chat-bad:message-bad',
      ]);

      return result.rows[0];
    },
    (value) => value?.attempts >= 1 && value.state === 'pending',
  );

  expect(job.last_error).toBe('CHANNEL_PROCESSING_FAILED');
  expect((await database!.query('SELECT id FROM messages')).rowCount).toBe(1);
  expect(
    (
      await database!.query('SELECT id FROM reply_routes WHERE external_chat_id=$1', [
        'chat-bad',
      ])
    ).rowCount,
  ).toBe(0);
  expect(packets.size).toBe(1);
});

test('виджет принимает телефон или email без имени и доставляет непустой профиль в Чат', async (): Promise<void> => {
  const origin = 'http://127.0.0.1:4310';

  for (const contacts of [
    { phone: '+7 (999) 123-45-67' },
    { email: 'Visitor+sales@Example.Test' },
  ]) {
    const sessionResponse = await fetch(`${base}/v1/widget/session`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        siteId: 'amotiv-demo',
        source: {
          pageUrl: origin + '/contact-test',
          title: 'Проверка контактов',
          referrerOrigin: '',
        },
      }),
    });
    expect(sessionResponse.status).toBe(201);
    const session = z.object({ token: z.string() }).parse(await sessionResponse.json());
    const response = await fetch(`${base}/v1/widget/inquiries`, {
      method: 'POST',
      headers: {
        Origin: origin,
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.token}`,
      },
      body: JSON.stringify({
        operationId: randomUUID(),
        html: '<p>Нужна помощь</p>',
        attachmentIds: [],
        contacts,
      }),
    });
    expect(response.status).toBe(201);
    const result = z
      .object({ inquiryId: z.uuid(), message: z.object({ id: z.uuid() }) })
      .parse(await response.json());
    const packet = await until(
      async (): Promise<z.infer<typeof packetSchema> | undefined> =>
        packets.get(result.message.id),
      (value) => !!value,
    );
    expect(packet?.customerName).toBe('Посетитель сайта');
    expect(packet?.source.channel).toBe('widget');
    const customer = (
      await database!.query<{
        name: string;
        contacts: { name: string; phone: string; email: string };
      }>(
        'SELECT c.name,c.contacts FROM customers c JOIN inquiries i ON i.customer_id=c.id WHERE i.id=$1',
        [result.inquiryId],
      )
    ).rows[0];
    expect(customer.name).toBe('Посетитель сайта');
    expect(customer.contacts.name).toBe('');
    expect(customer.contacts).toMatchObject(
      'phone' in contacts
        ? { phone: contacts.phone, email: '' }
        : { phone: '', email: contacts.email },
    );
  }
});

test('пустое и неверное средство связи не создаёт обращение, а старая форма продолжает работать', async (): Promise<void> => {
  const origin = 'http://127.0.0.1:4310';
  const headers = { Origin: origin, 'Content-Type': 'application/json' };
  const sessionResponse = await fetch(`${base}/v1/widget/session`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      siteId: 'amotiv-demo',
      source: { pageUrl: origin + '/validation-test', title: '', referrerOrigin: '' },
    }),
  });
  const session = z.object({ token: z.string() }).parse(await sessionResponse.json());
  const before = (
    await database!.query<{ count: string }>('SELECT count(*) FROM inquiries')
  ).rows[0].count;
  for (const contacts of [{}, { phone: '123' }, { email: 'wrong@' }]) {
    const response = await fetch(`${base}/v1/widget/inquiries`, {
      method: 'POST',
      headers: { ...headers, Authorization: `Bearer ${session.token}` },
      body: JSON.stringify({
        operationId: randomUUID(),
        html: 'Проверка',
        attachmentIds: [],
        contacts,
      }),
    });
    expect(response.status).toBe(400);
  }
  expect(
    (await database!.query<{ count: string }>('SELECT count(*) FROM inquiries')).rows[0]
      .count,
  ).toBe(before);
  const response = await fetch(`${base}/v1/widget/inquiries`, {
    method: 'POST',
    headers: { ...headers, Authorization: `Bearer ${session.token}` },
    body: JSON.stringify({
      operationId: randomUUID(),
      html: 'Старая форма',
      attachmentIds: [],
      contacts: { name: 'Иван', phone: '+79991234567', email: 'legacy@example.test' },
    }),
  });
  expect(response.status).toBe(201);
});
