import 'reflect-metadata';
import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import type { Server } from 'bun';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { promisify } from 'node:util';
import { connect } from 'amqplib';
import { createClient } from 'redis';
import { z } from 'zod';
import { createApplication } from '../dist/app';
import { readConfig } from '../dist/config';
import { Database } from '../dist/database';
import { RetentionWorker } from '../dist/retention';
import { ChannelService } from '../dist/channels/service';
import { OperationQueue } from '../dist/operation-queue';
import type { ChannelConnection } from '../src/channels/config';
import type { ChannelTransport } from '../src/channels/http-client';

const run = promisify(execFile);
const testId = randomUUID().slice(0, 8);
const password = randomUUID();
const containers: string[] = [];
const packets: Array<{
  source: { channel: string };
  html: string;
  attachmentIds: string[];
}> = [];
const sent: string[] = [];
const lost = new Set<string>();
let failMaxUpload = false;
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWLsAAAAASUVORK5CYII=',
  'base64',
);
// FileInspection проверяет сигнатуру JPEG для фото Telegram. Содержимое не отправляется наружу.
const jpeg = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');
const connections: ChannelConnection[] = [
  {
    id: 'telegram-test',
    platform: 'telegram',
    accountId: '123',
    name: 'Telegram тест',
    enabled: true,
    tokenEnv: 'TG_TOKEN',
    token: '123:test-token',
    webhookSecretEnv: 'TG_SECRET',
    webhookSecret: 't'.repeat(32),
  },
  {
    id: 'max-test',
    platform: 'max',
    accountId: '456',
    name: 'MAX тест',
    enabled: true,
    tokenEnv: 'MAX_TOKEN',
    token: 'max-test-token',
    webhookSecretEnv: 'MAX_SECRET',
    webhookSecret: 'm'.repeat(32),
  },
];
let upstream: Server<undefined> | undefined;
let runtime: Awaited<ReturnType<typeof createApplication>> | undefined;
let database: Database | undefined;
let base = '';

async function docker(args: string[]): Promise<string> {
  return (await run('docker', args, { timeout: 30000 })).stdout.trim();
}

async function container(image: string, port: number, env: string[]): Promise<number> {
  const name = `manager-bots-${testId}-${port}`;
  await docker([
    'run',
    '--rm',
    '-d',
    '--name',
    name,
    '--label',
    `pksep.bots-test=${testId}`,
    '--cpus',
    '1',
    '--memory',
    '512m',
    '-p',
    `127.0.0.1::${port}`,
    ...env.flatMap((value) => ['-e', value]),
    image,
  ]);
  containers.push(name);
  const binding = await docker(['port', name, `${port}/tcp`]);

  if (!/^127\.0\.0\.1:\d+$/.test(binding))
    throw new Error('Тестовая зависимость должна слушать только loopback');

  return Number(binding.split(':')[1]);
}

async function until<T>(
  work: () => Promise<T>,
  accepts: (value: T) => boolean,
): Promise<T> {
  const deadline = Date.now() + 30000;

  while (Date.now() < deadline) {
    const result = await work();

    if (accepts(result)) return result;

    await Bun.sleep(100);
  }

  throw new Error('Изолированный сценарий ботов не завершился вовремя');
}

const transport: ChannelTransport = async (url, init): Promise<Response> => {
  const platform = url.hostname === 'api.telegram.org' ? 'telegram' : 'max';

  if (url.pathname.endsWith('/getFile'))
    return Response.json({ ok: true, result: { file_path: 'photos/1.jpg' } });
  if (url.pathname.startsWith('/file/'))
    return new Response(jpeg, { headers: { 'Content-Type': 'image/jpeg' } });
  if (url.pathname === '/uploads')
    return Response.json({ url: 'https://i.oneme.ru/upload' });

  if (url.hostname === 'i.oneme.ru' && init.method === 'POST') {
    const row = await database!.query<{ sending_part: number | null }>(
      "SELECT sending_part FROM channel_outbox WHERE state='working' ORDER BY created_at DESC LIMIT 1",
    );
    expect(row.rows[0]?.sending_part).toBeNull();
    await new Response(init.body).arrayBuffer();

    if (failMaxUpload) throw new Error('Имитируем временный сбой загрузки MAX');

    return Response.json({ photos: { first: { token: 'image-token' } } });
  }

  if (url.hostname === 'i.oneme.ru')
    return new Response(png, { headers: { 'Content-Type': 'image/png' } });

  if (
    url.pathname.endsWith('/sendMessage') ||
    url.pathname.endsWith('/sendPhoto') ||
    url.pathname === '/messages'
  ) {
    const row = await database!.query<{ sending_part: number | null }>(
      "SELECT sending_part FROM channel_outbox WHERE state='working' ORDER BY created_at DESC LIMIT 1",
    );
    expect(row.rows[0]?.sending_part).not.toBeNull();
    expect(row.rows[0]?.sending_part).toBeDefined();
    sent.push(platform);

    if (lost.delete(platform))
      throw new Error('Имитируем обрыв после принятия сообщения');

    if (url.pathname.endsWith('/sendPhoto'))
      expect(await new Response(init.body).text()).toContain('name="photo"');

    return Response.json(
      platform === 'telegram'
        ? { ok: true, result: { message_id: sent.length } }
        : { message: { body: { mid: `mid.out.${sent.length}` } } },
    );
  }

  throw new Error('Неожиданный запрос платформы');
};

function event(platform: string, messageId = 1, image = false): object {
  if (platform === 'telegram')
    return {
      update_id: messageId,
      message: {
        message_id: messageId,
        date: 1792100000,
        from: { id: 100, first_name: 'Клиент Telegram', is_bot: false },
        chat: { id: 100, type: 'private' },
        text: 'Telegram → Клиенты',
        ...(image
          ? {
              photo: [
                {
                  file_id: 'photo',
                  file_unique_id: 'unique',
                  width: 1,
                  height: 1,
                  file_size: jpeg.length,
                },
              ],
            }
          : {}),
      },
    };

  return {
    update_type: 'message_created',
    message: {
      sender: { user_id: 200, first_name: 'Клиент MAX', is_bot: false },
      recipient: { chat_id: 300, chat_type: 'dialog', user_id: 456 },
      timestamp: 1792100000000,
      body: {
        mid: `mid.${messageId}`,
        text: 'MAX → Клиенты',
        ...(image
          ? {
              attachments: [
                { type: 'image', payload: { url: 'https://i.oneme.ru/photo.jpg' } },
              ],
            }
          : {}),
      },
    },
  };
}

async function callback(
  connection: ChannelConnection,
  body: object,
  secret = connection.webhookSecret,
): Promise<Response> {
  return fetch(`${base}/v1/channels/${connection.platform}/${connection.id}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      [connection.platform === 'telegram'
        ? 'X-Telegram-Bot-Api-Secret-Token'
        : 'X-Max-Bot-Api-Secret']: secret,
    },
    body: JSON.stringify(body),
  });
}

async function route(platform: string): Promise<{ id: string; inquiry_id: string }> {
  return (
    await database!.query<{ id: string; inquiry_id: string }>(
      'SELECT id,inquiry_id FROM reply_routes WHERE channel=$1',
      [platform],
    )
  ).rows[0];
}

async function outgoing(
  platform: string,
  image = false,
  interrupted = false,
): Promise<string> {
  const current = await route(platform);
  const id = randomUUID();
  const attachments = image
    ? [{ id: randomUUID(), name: 'photo.png', mime: 'image/png', size: png.length }]
    : [];
  await database!.query(
    "INSERT INTO messages(id,inquiry_id,session_id,direction,author,html,attachments) VALUES($1,$2,$3,'incoming','Оператор',$4,$5)",
    [
      id,
      current.inquiry_id,
      current.id,
      image ? '' : '<p>Ответ оператора</p>',
      JSON.stringify(attachments),
    ],
  );
  await database!.query(
    'INSERT INTO channel_outbox(id,inquiry_id,route_id,sending_part) VALUES($1,$2,$3,$4)',
    [id, current.inquiry_id, current.id, interrupted ? 0 : null],
  );
  await runtime!.app.get(OperationQueue).enqueue('channel-outbox', id);

  return id;
}

async function state(id: string): Promise<{
  state: string;
  sending_part: number | null;
  last_error: string | null;
  progress: unknown[];
}> {
  return (
    await database!.query<{
      state: string;
      sending_part: number | null;
      last_error: string | null;
      progress: unknown[];
    }>('SELECT state,sending_part,last_error,progress FROM channel_outbox WHERE id=$1', [
      id,
    ])
  ).rows[0];
}

beforeAll(async (): Promise<void> => {
  const first = await Promise.allSettled([
    container('postgres:18-alpine', 5432, [
      'POSTGRES_DB=manager_bots_test',
      'POSTGRES_USER=bots_test',
      `POSTGRES_PASSWORD=${password}`,
    ]),
    container('redis:8-alpine', 6379, []),
  ]);
  const [postgresPort, redisPort] = first.map((result): number => {
    if (result.status !== 'fulfilled')
      throw new Error('Не удалось создать изолированные зависимости ботов');

    return result.value;
  });
  const rabbitPort = await container('rabbitmq:4-alpine', 5672, [
    'RABBITMQ_DEFAULT_USER=bots_test',
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
      if (url.pathname.endsWith('/attachments') && request.method === 'POST') {
        const form = await request.formData();
        const file = form.get('file');

        if (!(file instanceof File)) throw new Error('Не получен файл');

        const bytes = Buffer.from(await file.arrayBuffer());
        expect(bytes.equals(png) || bytes.equals(jpeg)).toBe(true);

        return Response.json({
          id: form.get('id'),
          name: file.name,
          mime: file.type,
          size: file.size,
        });
      }
      if (/\/attachments\//.test(url.pathname)) return new Response(png);
      if (url.pathname.endsWith('/messages') && request.method === 'POST') {
        const packet = z
          .object({
            operationId: z.uuid(),
            source: z.object({ channel: z.string() }),
            html: z.string(),
            attachmentIds: z.array(z.uuid()),
          })
          .parse(await request.json());
        packets.push(packet);

        return Response.json({
          topicId: randomUUID(),
          messageId: randomUUID(),
          sequence: packets.length,
        });
      }

      return new Response('', { status: 404 });
    },
  });
  const config = {
    ...readConfig({
      DATABASE_URL: `postgresql://bots_test:${password}@127.0.0.1:${postgresPort}/manager_bots_test`,
      REDIS_URL: `redis://127.0.0.1:${redisPort}/0`,
      MANAGER_RABBITMQ_URL: `amqp://bots_test:${password}@127.0.0.1:${rabbitPort}`,
      MANAGER_INTERNAL_KEY: 'm'.repeat(32),
      CHAT_MANAGER_KEY: 'c'.repeat(32),
      CHAT_SERVICE_URL: `http://127.0.0.1:${upstream.port}/api`,
      MANAGER_QUEUE_PREFIX: `bots-${testId}`,
      MANAGER_REDIS_PREFIX: `bots-${testId}`,
      MANAGER_CAPTCHA_MODE: 'disabled',
      MANAGER_SCAN_MODE: 'disabled',
    }),
    channels: connections,
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
    // Схема откатывается до использования ботов и повторно применяется штатным механизмом.
    await bootstrap.migrate('down');
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

  const retention = spyOn(RetentionWorker.prototype, 'onModuleInit').mockImplementation(
    (): void => {},
  );

  try {
    runtime = await createApplication(config, { channelTransport: transport });
  } finally {
    retention.mockRestore();
  }

  database = runtime.app.get(Database);
  await runtime.app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${(runtime.app.getHttpServer().address() as AddressInfo).port}`;
}, 90000);

afterAll(async (): Promise<void> => {
  await runtime?.close();
  await upstream?.stop(true);

  for (const name of containers) {
    const label = await docker([
      'inspect',
      '--format',
      '{{index .Config.Labels "pksep.bots-test"}}',
      name,
    ]);

    if (label !== testId) throw new Error('Нельзя удалять чужие зависимости');

    await docker(['rm', '-f', name]);
  }
}, 60000);

test('секрет заголовка обязателен, поддельный webhook не создаёт записи', async (): Promise<void> => {
  for (const connection of connections) {
    expect((await callback(connection, event(connection.platform), '')).status).toBe(403);
    expect((await callback(connection, event(connection.platform), 'wrong')).status).toBe(
      403,
    );
  }

  expect((await database!.query('SELECT id FROM channel_inbox')).rowCount).toBe(0);
});

test('личные сообщения и фото обоих ботов доходят через очередь до Чата без дублей', async (): Promise<void> => {
  for (const connection of connections) {
    expect((await callback(connection, event(connection.platform, 1, true))).status).toBe(
      200,
    );
    expect((await callback(connection, event(connection.platform, 1, true))).status).toBe(
      200,
    );
  }

  await until(
    async (): Promise<number> => packets.length,
    (count) => count === 2,
  );
  await until(
    async (): Promise<number> =>
      (await database!.query("SELECT id FROM channel_inbox WHERE state='delivered'"))
        .rowCount,
    (count) => count === 2,
  );
  expect(packets.map((packet) => packet.source.channel).sort()).toEqual([
    'max',
    'telegram',
  ]);
  expect(packets.every((packet) => packet.attachmentIds.length === 1)).toBe(true);
  expect((await database!.query('SELECT id FROM messages')).rowCount).toBe(2);
  expect(
    JSON.stringify(
      (await database!.query('SELECT payload,normalized FROM channel_inbox')).rows,
    ),
  ).not.toContain('test-token');
  let rollbackRefused = false;

  try {
    await database!.migrate('down');
  } catch {
    rollbackRefused = true;
  }

  expect(rollbackRefused).toBe(true);
});

test('ответы операторов отправляются в тот же канал с сохранённым намерением', async (): Promise<void> => {
  for (const connection of connections) {
    const id = await outgoing(connection.platform, true);
    await until(
      async (): Promise<string> => (await state(id)).state,
      (value) => value === 'delivered',
    );
    expect((await state(id)).progress).toHaveLength(1);
  }

  expect(sent.sort()).toEqual(['max', 'telegram']);
});

test('сбой загрузки MAX до отправки безопасно повторяется и не помечается неопределённым', async (): Promise<void> => {
  failMaxUpload = true;
  const id = await outgoing('max', true);
  await until(
    async (): Promise<string | null> => (await state(id)).last_error,
    (value) => value === 'CHANNEL_NETWORK_ERROR',
  );
  expect((await state(id)).state).toBe('pending');
  expect((await state(id)).sending_part).toBeNull();
  failMaxUpload = false;
  await database!.query('UPDATE channel_outbox SET next_attempt_at=now() WHERE id=$1', [
    id,
  ]);
  await runtime!.app.get(OperationQueue).enqueue('channel-outbox', id);
  await until(
    async (): Promise<string> => (await state(id)).state,
    (value) => value === 'delivered',
  );
});

test('потерянный ответ и незавершённая отправка после перезапуска не дублируются', async (): Promise<void> => {
  for (const connection of connections) {
    lost.add(connection.platform);
    const id = await outgoing(connection.platform);
    await until(
      async (): Promise<string> => (await state(id)).state,
      (value) => value === 'uncertain',
    );
    expect((await state(id)).last_error).toBe(
      `${connection.platform.toUpperCase()}_DELIVERY_UNCONFIRMED`,
    );
    const current = await route(connection.platform);
    let refused = false;

    try {
      await runtime!.app.get(ChannelService).retry(current.inquiry_id, id, false);
    } catch {
      refused = true;
    }

    expect(refused).toBe(true);
  }

  const before = sent.length;

  for (const connection of connections) {
    const id = await outgoing(connection.platform, false, true);
    // Подтверждаем первую спорную часть без повторной доставки, чтобы освободить порядок ответов.
    const first = (
      await database!.query<{ id: string }>(
        "SELECT id FROM channel_outbox WHERE route_id=$1 AND state='uncertain' ORDER BY created_at LIMIT 1",
        [(await route(connection.platform)).id],
      )
    ).rows[0];
    const current = await route(connection.platform);
    await runtime!.app
      .get(ChannelService)
      .confirmPart(current.inquiry_id, first.id, randomUUID());
    await until(
      async (): Promise<string> => (await state(id)).state,
      (value) => value === 'uncertain',
    );
  }

  expect(sent.length).toBe(before);
});
