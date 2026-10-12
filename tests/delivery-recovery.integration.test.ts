import 'reflect-metadata';
import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { connect } from 'amqplib';
import type { Server } from 'bun';
import { z } from 'zod';
import { ChatAdapter } from '../dist/chat-adapter';
import { readConfig, type Config } from '../dist/config';
import { Database } from '../dist/database';
import { DeliveryWorker } from '../dist/delivery.worker';
import { OperationQueue } from '../dist/operation-queue';
import { ChatReceiptSchema } from '../dist/contracts';

const run = promisify(execFile);
const testId = randomUUID().slice(0, 8);
const containers: string[] = [];
const password = randomUUID();
const receipts = new Map<string, z.infer<typeof ChatReceiptSchema>>();
const topics = new Map<string, string>();
const requests: string[] = [];
const failures = new Map<string, number>();
const loseReceipt = new Set<string>();
const slow = new Set<string>();
const activeQueues: OperationQueue[] = [];
const activeWorkers: DeliveryWorker[] = [];
let server: Server<undefined>;
let config: Config;
let db: Database;
let processJob: (id: string) => Promise<'done' | 'retry'>;

interface Operation {
  state: string;
  attempts: number;
  last_error: string | null;
  delay: number;
}

async function docker(args: string[]): Promise<string> {
  const result = await run('docker', args, { timeout: 30000 });

  return result.stdout.trim();
}

async function container(image: string, port: number, env: string[]): Promise<number> {
  const name = `manager-delivery-${testId}-${port}`;

  await docker([
    'run',
    '--rm',
    '-d',
    '--name',
    name,
    '--label',
    `pksep.delivery-test=${testId}`,
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
  accept: (value: T) => boolean,
): Promise<T> {
  const deadline = Date.now() + 20000;

  while (Date.now() < deadline) {
    const value = await work();

    if (accept(value)) return value;

    await Bun.sleep(100);
  }

  throw new Error('Тестовая операция не восстановилась вовремя');
}

function worker(queue: OperationQueue): DeliveryWorker {
  const instance = new DeliveryWorker({
    database: db,
    config,
    queue,
    chat: new ChatAdapter(config),
    acceptEvents: async (): Promise<void> => {},
  });
  activeWorkers.push(instance);

  return instance;
}

async function manualWorker(): Promise<void> {
  const queue = new OperationQueue(config, db);
  const registration = spyOn(queue, 'register').mockImplementation(
    async (kind, handler): Promise<void> => {
      if (kind === 'delivery') processJob = handler;
    },
  );

  try {
    await worker(queue).onModuleInit();
  } finally {
    registration.mockRestore();
  }
}

async function fixture(count: number): Promise<string[]> {
  const customerId = randomUUID();
  const routeId = randomUUID();
  const inquiryId = randomUUID();
  const ids: string[] = [];

  await db.transaction(async (client): Promise<void> => {
    await client.query('INSERT INTO customers(id,name,contacts) VALUES($1,$2,$3)', [
      customerId,
      'Тестовый посетитель',
      { name: 'Тестовый посетитель', phone: '', email: '' },
    ]);
    await client.query(
      "INSERT INTO reply_routes(id,channel,connection_id,external_chat_id,external_user_id,source) VALUES($1,'vk','vk-recovery',$2,'123',$3)",
      [routeId, inquiryId, { channel: 'vk', name: 'Тест ВК' }],
    );
    await client.query(
      'INSERT INTO inquiries(id,session_id,customer_id,source) VALUES($1,$2,$3,$4)',
      [inquiryId, routeId, customerId, { channel: 'vk', name: 'Тест ВК' }],
    );
    await client.query('UPDATE reply_routes SET inquiry_id=$2 WHERE id=$1', [
      routeId,
      inquiryId,
    ]);

    for (let index = 0; index < count; index++) {
      const id = randomUUID();
      ids.push(id);
      await client.query(
        "INSERT INTO messages(id,inquiry_id,session_id,direction,author,html) VALUES($1,$2,$3,'incoming','Посетитель',$4)",
        [id, inquiryId, routeId, `Сообщение ${index + 1}`],
      );
      await client.query('INSERT INTO delivery_operations(id,inquiry_id) VALUES($1,$2)', [
        id,
        inquiryId,
      ]);
    }
  });

  return ids;
}

async function operation(id: string): Promise<Operation> {
  const result = await db.query<Operation>(
    'SELECT state,attempts,last_error,extract(epoch FROM next_attempt_at-updated_at)::float8 AS delay FROM delivery_operations WHERE id=$1',
    [id],
  );

  return result.rows[0];
}

beforeAll(async (): Promise<void> => {
  // Оба запуска завершаются до очистки, даже если одна зависимость не поднялась.
  const dependencies = await Promise.allSettled([
    container('postgres:18-alpine', 5432, [
      'POSTGRES_DB=manager_delivery_test',
      'POSTGRES_USER=delivery_test',
      `POSTGRES_PASSWORD=${password}`,
    ]),
    container('rabbitmq:4-alpine', 5672, [
      'RABBITMQ_DEFAULT_USER=delivery_test',
      `RABBITMQ_DEFAULT_PASS=${password}`,
    ]),
  ]);
  const [postgresPort, rabbitPort] = dependencies.map((result): number => {
    if (result.status !== 'fulfilled')
      throw new Error('Не удалось создать изолированные зависимости теста');

    return result.value;
  });

  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (request): Promise<Response> => {
      expect(request.headers.get('x-manager-key')).toBe('c'.repeat(32));
      const url = new URL(request.url);

      if (url.pathname.endsWith('/events')) return Response.json({ events: [] });

      const inquiryId = url.pathname.match(/\/inquiries\/([^/]+)\/messages$/)?.[1];
      expect(inquiryId).toBeDefined();
      const input = z.object({ operationId: z.uuid() }).parse(await request.json());
      const id = input.operationId;
      requests.push(id);

      if (slow.has(id)) await Bun.sleep(100);
      if (failures.has(id)) return new Response('', { status: failures.get(id) });
      if (!topics.has(inquiryId!)) topics.set(inquiryId!, randomUUID());
      if (!receipts.has(id))
        receipts.set(id, {
          topicId: topics.get(inquiryId!)!,
          messageId: randomUUID(),
          sequence: receipts.size + 1,
        });
      if (loseReceipt.delete(id)) return new Response('', { status: 503 });

      return Response.json(receipts.get(id));
    },
  });
  config = readConfig({
    DATABASE_URL: `postgresql://delivery_test:${password}@127.0.0.1:${postgresPort}/manager_delivery_test`,
    CHAT_SERVICE_URL: `http://127.0.0.1:${server.port}/api`,
    CHAT_MANAGER_KEY: 'c'.repeat(32),
    MANAGER_INTERNAL_KEY: 'm'.repeat(32),
    MANAGER_RABBITMQ_URL: `amqp://delivery_test:${password}@127.0.0.1:${rabbitPort}`,
    MANAGER_QUEUE_PREFIX: `delivery-test-${testId}`,
    MANAGER_WORKER_MS: '60000',
  });
  db = new Database(config);

  await until(async (): Promise<boolean> => {
    try {
      await db.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }, Boolean);
  await db.migrate();
  await until(async (): Promise<boolean> => {
    try {
      const connection = await connect(config.MANAGER_RABBITMQ_URL!, { timeout: 2000 });

      await connection.close();

      return true;
    } catch {
      return false;
    }
  }, Boolean);
  await db.query(
    "INSERT INTO channel_connections(id,platform,account_id,name) VALUES('vk-recovery','vk','123','Тест восстановления')",
  );
  await manualWorker();
}, 60000);

afterAll(async (): Promise<void> => {
  for (const instance of activeWorkers) await instance.onModuleDestroy();
  for (const queue of activeQueues) await queue.onModuleDestroy();
  await db?.onModuleDestroy();
  await server?.stop(true);

  for (const name of containers) {
    const label = await docker([
      'inspect',
      '--format',
      '{{index .Config.Labels "pksep.delivery-test"}}',
      name,
    ]);

    if (label !== testId) throw new Error('Нельзя удалять чужую тестовую зависимость');

    await docker(['rm', '-f', name]);
  }
}, 60000);

test('более десяти сбоев не останавливают доставку, после восстановления сохраняется порядок', async (): Promise<void> => {
  const ids = await fixture(3);
  failures.set(ids[0], 503);

  for (let attempt = 1; attempt <= 12; attempt++) {
    await db.query('UPDATE delivery_operations SET next_attempt_at=now() WHERE id=$1', [
      ids[0],
    ]);
    expect(await processJob(ids[0])).toBe('retry');
    expect((await operation(ids[0])).state).toBe('pending');
  }

  expect(await operation(ids[0])).toMatchObject({ attempts: 12, delay: 60 });
  expect(await processJob(ids[0])).toBe('retry');
  expect((await operation(ids[0])).attempts).toBe(12);
  expect(await processJob(ids[1])).toBe('retry');
  expect((await operation(ids[1])).attempts).toBe(0);
  failures.delete(ids[0]);
  await db.query('UPDATE delivery_operations SET next_attempt_at=now() WHERE id=$1', [
    ids[0],
  ]);

  for (const id of ids) expect(await processJob(id)).toBe('done');

  expect([...receipts.keys()].filter((id) => ids.includes(id))).toEqual(ids);
  expect(await operation(ids[0])).toMatchObject({ state: 'delivered', last_error: null });
});

test('некорректное сообщение сохраняется как ошибка, девять следующих продолжают обрабатываться', async (): Promise<void> => {
  const ids = await fixture(10);
  failures.set(ids[0], 422);

  expect(await processJob(ids[0])).toBe('done');
  expect(await operation(ids[0])).toMatchObject({
    state: 'failed',
    last_error: 'CHAT_MESSAGE_REJECTED',
  });

  for (const id of ids.slice(1)) expect(await processJob(id)).toBe('done');

  expect([...receipts.keys()].filter((id) => ids.includes(id))).toEqual(ids.slice(1));
  expect(
    (await db.query('SELECT html FROM messages WHERE id=$1', [ids[0]])).rowCount,
  ).toBe(1);
});

test('старая ошибка из предыдущей версии не блокирует новые сообщения и может быть повторена вручную', async (): Promise<void> => {
  const ids = await fixture(2);
  await db.query(
    "UPDATE delivery_operations SET state='failed',attempts=10,last_error='CHAT_DELIVERY_FAILED' WHERE id=$1",
    [ids[0]],
  );

  expect(await processJob(ids[1])).toBe('done');
  expect(await processJob(ids[0])).toBe('done');
  expect(receipts.has(ids[0])).toBe(false);
  await db.query(
    "UPDATE delivery_operations SET state='pending',attempts=0,next_attempt_at=now() WHERE id=$1",
    [ids[0]],
  );
  expect(await processJob(ids[0])).toBe('done');
  expect(receipts.has(ids[0])).toBe(true);
});

test('сбой одного обращения не останавливает остальные', async (): Promise<void> => {
  const [failed] = await fixture(1);
  const [healthy] = await fixture(1);
  failures.set(failed, 500);

  expect(await processJob(failed)).toBe('retry');
  expect(await processJob(healthy)).toBe('done');
  expect(receipts.has(healthy)).toBe(true);
});

test('живое задание удерживает следующие, просроченная аренда восстанавливается', async (): Promise<void> => {
  const ids = await fixture(2);
  await db.query(
    "UPDATE delivery_operations SET state='working',locked_until=now()+interval '30 seconds' WHERE id=$1",
    [ids[0]],
  );

  expect(await processJob(ids[1])).toBe('retry');
  expect(await processJob(ids[0])).toBe('retry');
  expect(receipts.has(ids[0])).toBe(false);
  await db.query(
    "UPDATE delivery_operations SET locked_until=now()-interval '1 second' WHERE id=$1",
    [ids[0]],
  );

  for (const id of ids) expect(await processJob(id)).toBe('done');
});

test('параллельные обработчики не отправляют одно задание дважды', async (): Promise<void> => {
  const [id] = await fixture(1);
  slow.add(id);
  const results = await Promise.all([processJob(id), processJob(id)]);

  expect(results).toContain('done');
  expect(requests.filter((value) => value === id)).toHaveLength(1);
  expect((await operation(id)).attempts).toBe(1);
});

test('потерянное подтверждение повторяется с прежним ID после перезапуска обработчика', async (): Promise<void> => {
  const [id] = await fixture(1);
  loseReceipt.add(id);

  expect(await processJob(id)).toBe('retry');
  const receipt = receipts.get(id);
  await activeWorkers.at(-1)!.onModuleDestroy();
  await manualWorker();
  await db.query('UPDATE delivery_operations SET next_attempt_at=now() WHERE id=$1', [
    id,
  ]);

  expect(await processJob(id)).toBe('done');
  expect(receipts.get(id)).toEqual(receipt);
  expect(requests.filter((value) => value === id)).toHaveLength(2);
  expect(
    (
      await db.query<{ chat_message_id: string }>(
        'SELECT chat_message_id FROM messages WHERE id=$1',
        [id],
      )
    ).rows[0].chat_message_id,
  ).toBe(receipt!.messageId);
});

test('RabbitMQ продолжает сохранённую доставку после перезапуска сервиса без ручного retry', async (): Promise<void> => {
  await activeWorkers.at(-1)!.onModuleDestroy();
  const ids = await fixture(2);
  await db.query('UPDATE delivery_operations SET attempts=10 WHERE id=$1', [ids[0]]);
  failures.set(ids[0], 503);
  const queue = new OperationQueue(config, db);
  activeQueues.push(queue);

  await queue.onModuleInit();
  const firstWorker = worker(queue);
  await firstWorker.onModuleInit();
  await queue.enqueue('delivery', ids[0]);
  await queue.enqueue('delivery', ids[1]);
  await until(
    () => operation(ids[0]),
    (value) => value.state === 'pending' && value.attempts === 11,
  );
  await firstWorker.onModuleDestroy();
  await queue.onModuleDestroy();
  failures.delete(ids[0]);
  // Ускоряем истечение минутной паузы, не меняя состояние, ID или счётчик попыток.
  await db.query('UPDATE delivery_operations SET next_attempt_at=now() WHERE id=$1', [
    ids[0],
  ]);
  const restarted = new OperationQueue(config, db);
  activeQueues.push(restarted);
  await restarted.onModuleInit();
  await worker(restarted).onModuleInit();

  for (const id of ids)
    await until(
      () => operation(id),
      (value) => value.state === 'delivered',
    );

  expect([...receipts.keys()].filter((id) => ids.includes(id))).toEqual(ids);
  expect((await operation(ids[0])).attempts).toBeGreaterThan(11);
}, 30000);
