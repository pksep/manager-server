import 'reflect-metadata';
import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import type { Server } from 'bun';
import { execFile } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
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
    id: 'whatsapp-test',
    platform: 'whatsapp',
    name: 'WhatsApp тест',
    accountId: '123',
    businessAccountId: '999',
    apiVersion: 'v25.0',
    enabled: true,
    tokenEnv: 'WA_TOKEN',
    token: 'test-token',
    appSecretEnv: 'WA_APP_SECRET',
    appSecret: 'local-test-app-secret',
    webhookSecretEnv: 'WA_VERIFY_TOKEN',
    webhookSecret: 'v'.repeat(32),
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
  const name = `manager-whatsapp-${testId}-${port}`;
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
  if (url.pathname.endsWith('/111'))
    return Response.json({
      id: '111',
      url: 'https://lookaside.fbsbx.com/file',
      mime_type: 'image/png',
      file_size: png.length,
    });
  if (url.hostname === 'lookaside.fbsbx.com')
    return new Response(png, { headers: { 'Content-Type': 'image/png' } });
  if (url.pathname.endsWith('/media')) {
    const form = await new Response(init.body, { headers: init.headers }).formData();
    expect(form.get('messaging_product')).toBe('whatsapp');
    expect(form.get('file')).toBeInstanceOf(File);
    return Response.json({ id: '222' });
  }
  if (url.pathname.endsWith('/messages')) {
    const body = JSON.parse(String(init.body));
    expect(body.to).toBe('79990000000');
    sent.push('whatsapp');
    if (lost.delete('whatsapp'))
      throw new Error('Потерян ответ после принятия сообщения');
    return Response.json({ messages: [{ id: 'wamid.sent.' + sent.length }] });
  }
  throw new Error('Неожиданный запрос WhatsApp');
};

function event(messageId = 1, image = false): object {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '999',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: '123' },
              contacts: [{ wa_id: '79990000000', profile: { name: 'Клиент WhatsApp' } }],
              messages: [
                {
                  id: 'wamid.' + messageId,
                  from: '79990000000',
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: image ? 'image' : 'text',
                  text: { body: 'WhatsApp → Клиенты' },
                  ...(image ? { image: { id: '111', mime_type: 'image/png' } } : {}),
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

async function callback(
  body: object,
  secret = connections[0].appSecret!,
): Promise<Response> {
  const raw = JSON.stringify(body);
  return fetch(base + '/v1/channels/whatsapp/whatsapp-test', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Hub-Signature-256':
        'sha256=' + createHmac('sha256', secret).update(raw).digest('hex'),
    },
    body: raw,
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

test('проверяет Verify Token и подпись исходных байтов до записи', async (): Promise<void> => {
  const verify =
    base +
    '/v1/channels/whatsapp/whatsapp-test?hub.mode=subscribe&hub.challenge=123&hub.verify_token=';
  expect((await fetch(verify + 'wrong')).status).toBe(403);
  expect(await (await fetch(verify + connections[0].webhookSecret)).text()).toBe('123');
  expect((await callback(event(), 'wrong')).status).toBe(403);
  expect((await database!.query('SELECT id FROM channel_inbox')).rowCount).toBe(0);
});

test('доставляет фото и телефон в Чат через очередь без дублей', async (): Promise<void> => {
  expect((await callback(event(1, true))).status).toBe(200);
  expect((await callback(event(1, true))).status).toBe(200);
  await until(
    async (): Promise<number> =>
      (await database!.query("SELECT id FROM channel_inbox WHERE state='delivered'"))
        .rowCount,
    (n) => n === 1,
  );
  await until(
    async (): Promise<number> => packets.length,
    (n) => n === 1,
  );
  expect(packets).toHaveLength(1);
  expect(packets[0].source.channel).toBe('whatsapp');
  expect(packets[0].attachmentIds).toHaveLength(1);
  expect((await database!.query('SELECT id FROM messages')).rowCount).toBe(1);
  expect(
    JSON.stringify((await database!.query('SELECT normalized FROM channel_inbox')).rows),
  ).not.toContain('test-token');
});

test('отправляет операторский ответ с картинкой и фиксирует принятие Meta', async (): Promise<void> => {
  const id = await outgoing('whatsapp', true);
  await until(
    async (): Promise<string> => (await state(id)).state,
    (value) => value === 'delivered',
  );
  expect(sent).toHaveLength(1);
  expect((await state(id)).progress).toHaveLength(1);
});

test('закрытое окно запрещает ответ, повтор webhook его не открывает', async (): Promise<void> => {
  const current = await route('whatsapp');
  await database!.query(
    "UPDATE reply_routes SET provider_inbound_at=now()-interval '25 hours' WHERE id=$1",
    [current.id],
  );
  const channels = runtime!.app.get(ChannelService);
  let message = '';
  try {
    await channels.replyRoute(current.inquiry_id, current.id);
  } catch (error) {
    message = error instanceof Error ? error.message : '';
  }
  expect(message).toContain('Окно ответа WhatsApp истекло');
  expect((await callback(event(1, true))).status).toBe(200);
  const routes = await channels.routes(current.inquiry_id);
  expect(routes[0]).toMatchObject({ canReply: false });
  const id = await outgoing('whatsapp');
  await until(
    async (): Promise<string> => (await state(id)).state,
    (value) => value === 'failed',
  );
  expect((await state(id)).last_error).toBe('WHATSAPP_WINDOW_EXPIRED');
  await database!.query('DELETE FROM channel_outbox WHERE id=$1', [id]);
});

test('новое сообщение открывает окно, обрыв после отправки не повторяет ответ', async (): Promise<void> => {
  expect((await callback(event(2))).status).toBe(200);
  await until(
    async (): Promise<number> => packets.length,
    (n) => n === 2,
  );
  lost.add('whatsapp');
  const id = await outgoing('whatsapp');
  await until(
    async (): Promise<string> => (await state(id)).state,
    (value) => value === 'uncertain',
  );
  expect(sent).toHaveLength(2);
  const current = await route('whatsapp');
  let refused = false;
  try {
    await runtime!.app.get(ChannelService).retry(current.inquiry_id, id, false);
  } catch {
    refused = true;
  }
  expect(refused).toBe(true);
});
