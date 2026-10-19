import 'reflect-metadata';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { z } from 'zod';
import { readConfig } from '../dist/config';
import { Database } from '../dist/database';
import { ErpSyncService } from '../dist/erp-sync.service';
import { resolveCustomer } from '../dist/identity';

const run = promisify(execFile);
const testId = randomUUID();
const container = `manager-erp-refresh-${testId}`;
const password = randomUUID();
const actor = randomUUID();
let started = false;
let db: Database;
let service: ErpSyncService;
let processJob: (id: string) => Promise<'done' | 'retry'>;
let upstream: ReturnType<typeof Bun.serve>;
let forbidden = false;
let responseStatus = 200;
let wrongContact = false;
let noProfile = false;
let version = '2026-10-16T10:00:00.000Z';
let phone = '+7 (999) 123-45-67';
let email = 'Client@example.test';
const received: string[] = [];
const command = z.object({
  operationId: z.uuid(),
  customerId: z.uuid(),
  contactId: z.number(),
  identity: z.record(z.string(), z.string()),
});

async function docker(args: string[]): Promise<string> {
  return (await run('docker', args, { timeout: 30000 })).stdout.trim();
}

async function createInquiry(
  channel: 'telegram' | 'max',
): Promise<{ id: string; customerId: string }> {
  const id = randomUUID();
  const customerId = randomUUID();
  const routeId = randomUUID();

  await db.transaction(async (tx): Promise<void> => {
    await tx.query('INSERT INTO customers(id,name,contacts) VALUES($1,$2,$3)', [
      customerId,
      'Клиент платформы',
      { name: 'Клиент платформы', phone: '', email: '' },
    ]);
    await tx.query(
      'INSERT INTO reply_routes(id,channel,connection_id,external_chat_id,external_user_id,source) VALUES($1,$2,$2,$3,$3,$4)',
      [routeId, channel, id, { channel }],
    );
    await tx.query(
      'INSERT INTO inquiries(id,session_id,customer_id,source) VALUES($1,$2,$3,$4)',
      [id, routeId, customerId, { channel }],
    );
    await tx.query('UPDATE reply_routes SET inquiry_id=$2 WHERE id=$1', [routeId, id]);
    await tx.query(
      "INSERT INTO messages(id,inquiry_id,session_id,direction,author,html) VALUES($1,$2,$3,'outgoing','Клиент','Сообщение')",
      [randomUUID(), id, routeId],
    );
  });

  return { id, customerId };
}

async function sync(inquiryId: string, contactId = 15): Promise<string> {
  const job = await service.enqueue(inquiryId, actor, {
    operationId: randomUUID(),
    contactId,
  });
  expect(await processJob(job.id)).toBe('done');
  expect(
    (await db.query('SELECT state FROM erp_sync_operations WHERE id=$1', [job.id]))
      .rows[0].state,
  ).toBe('completed');

  return job.id;
}

beforeAll(async (): Promise<void> => {
  await docker([
    'run',
    '--rm',
    '-d',
    '--name',
    container,
    '--label',
    `pksep.erp-refresh-test=${testId}`,
    '--cpus',
    '1',
    '--memory',
    '512m',
    '-p',
    '127.0.0.1::5432',
    '-e',
    'POSTGRES_USER=erp_refresh',
    '-e',
    `POSTGRES_PASSWORD=${password}`,
    '-e',
    'POSTGRES_DB=erp_refresh',
    'postgres:18-alpine',
  ]);
  started = true;
  const address = await docker(['port', container, '5432/tcp']);

  if (!/^127\.0\.0\.1:\d+$/.test(address))
    throw new Error('Нужна изолированная loopback-база');

  upstream = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (request): Promise<Response> => {
      expect(request.headers.get('x-manager-key')).toBe('e'.repeat(32));
      expect(request.headers.get('x-erp-actor-id')).toBe('1');
      const input = command.parse(await request.json());
      expect(input.identity).toEqual({});
      received.push(input.operationId);

      if (responseStatus !== 200) return new Response('', { status: responseStatus });

      return Response.json({
        customerId: input.customerId,
        contactId: input.contactId,
        created: false,
        ...(!noProfile
          ? {
              contact: {
                id: wrongContact ? input.contactId + 1 : input.contactId,
                initial: 'Контакт СЭП',
                ban: false,
                updatedAt: version,
                requisites: [
                  { title: { type: 'phone' }, value: phone },
                  { title: { type: 'email' }, value: email },
                ],
              },
            }
          : {}),
      });
    },
  });
  const config = readConfig({
    DATABASE_URL: `postgresql://erp_refresh:${password}@${address}/erp_refresh`,
    CHAT_SERVICE_URL: `http://127.0.0.1:${upstream.port}/api`,
    CHAT_MANAGER_KEY: 'c'.repeat(32),
    MANAGER_INTERNAL_KEY: 'm'.repeat(32),
    ERP_SERVICE_URL: `http://127.0.0.1:${upstream.port}/api`,
    ERP_MANAGER_KEY: 'e'.repeat(32),
  });
  db = new Database(config);

  for (let attempt = 0; ; attempt++) {
    try {
      await db.query('SELECT 1');
      break;
    } catch (error) {
      if (attempt >= 100) throw error;
      await Bun.sleep(100);
    }
  }

  await db.migrate();
  service = new ErpSyncService({
    database: db,
    config,
    chat: {
      erpActor: async (): Promise<number> => {
        if (forbidden) throw new ForbiddenException();
        return 1;
      },
    },
    queue: {
      register: async (_kind, handler): Promise<void> => {
        processJob = handler;
      },
      enqueue: async (): Promise<void> => {},
    },
  });
  await service.onModuleInit();
  await db.query(
    "INSERT INTO channel_connections(id,platform,account_id,name) VALUES('telegram','telegram','1','Telegram'),('max','max','2','MAX')",
  );
}, 60000);

afterAll(async (): Promise<void> => {
  await db?.onModuleDestroy();
  await upstream?.stop(true);

  if (started) {
    const label = await docker([
      'inspect',
      '--format',
      '{{index .Config.Labels "pksep.erp-refresh-test"}}',
      container,
    ]);

    if (label !== testId) throw new Error('Нельзя удалять чужой контейнер');

    await docker(['rm', '-f', container]);
  }
}, 60000);

test('миграция обратима до повторных синхронизаций, данные не удаляются', async (): Promise<void> => {
  expect((await db.migrate('down')).pending).toEqual(['011_erp_contact_refresh.sql']);
  expect((await db.migrate()).pending).toEqual([]);
});

test('Telegram без реквизитов получает данные СЭП; повтор обновляет уже связанный контакт', async (): Promise<void> => {
  const inquiry = await createInquiry('telegram');
  const id = await sync(inquiry.id);
  const initial = (
    await db.query('SELECT * FROM customers WHERE id=$1', [inquiry.customerId])
  ).rows[0];
  expect(initial.contacts).toEqual({ name: 'Клиент платформы', phone, email });
  expect(initial.erp_contact_id).toBe('15');
  expect(
    (await service.enqueue(inquiry.id, actor, { operationId: id, contactId: 15 })).id,
  ).toBe(id);
  expect(await processJob(id)).toBe('done');
  expect(received.filter((value) => value === id)).toHaveLength(1);

  phone = '+7 (999) 765-43-21';
  email = 'updated@example.test';
  version = '2026-10-16T11:00:00.000Z';
  await sync(inquiry.id);
  expect(
    (await db.query('SELECT contacts FROM customers WHERE id=$1', [inquiry.customerId]))
      .rows[0].contacts.phone,
  ).toBe(phone);
  expect(
    (
      await db.query(
        "SELECT value FROM customer_identities WHERE customer_id=$1 AND kind='phone'",
        [inquiry.customerId],
      )
    ).rows,
  ).toEqual([{ value: '+79997654321' }]);
});

test('MAX и Telegram имеют единый контакт и историю, но маршруты и сообщения не переносятся', async (): Promise<void> => {
  const inquiry = await createInquiry('max');
  const routes = (
    await db.query('SELECT id,inquiry_id,channel FROM reply_routes ORDER BY id')
  ).rows;
  const messages = (
    await db.query('SELECT id,inquiry_id,session_id FROM messages ORDER BY id')
  ).rows;
  await sync(inquiry.id);
  const linked = (
    await db.query("SELECT contacts FROM customers WHERE erp_contact_id='15'")
  ).rows;
  expect(linked).toHaveLength(2);
  expect(linked.every((row) => row.contacts.email === email)).toBe(true);
  expect(
    (await db.query('SELECT id,inquiry_id,channel FROM reply_routes ORDER BY id')).rows,
  ).toEqual(routes);
  expect(
    (await db.query('SELECT id,inquiry_id,session_id FROM messages ORDER BY id')).rows,
  ).toEqual(messages);
  expect(
    (
      await db.query(
        "SELECT m.id FROM messages m JOIN inquiries i ON i.id=m.inquiry_id JOIN customers c ON c.id=i.customer_id WHERE c.erp_contact_id='15'",
      )
    ).rowCount,
  ).toBe(2);
  const matched = await db.transaction((tx) =>
    resolveCustomer(
      tx,
      { name: 'Повтор', phone, email },
      { phone: '+79997654321', email },
    ),
  );
  expect(
    (await db.query('SELECT erp_contact_id FROM customers WHERE id=$1', [matched]))
      .rows[0].erp_contact_id,
  ).toBe('15');
});

test('запоздавший снимок не затирает свежие реквизиты, в том числе у нового связанного диалога', async (): Promise<void> => {
  const inquiry = await createInquiry('max');
  version = '2026-10-16T09:00:00.000Z';
  const freshPhone = phone;
  phone = '+79990000000';
  await sync(inquiry.id);
  expect(
    (await db.query('SELECT contacts FROM customers WHERE id=$1', [inquiry.customerId]))
      .rows[0].contacts.phone,
  ).toBe(freshPhone);
  phone = freshPhone;
  version = '2026-10-16T12:00:00.000Z';
});

test('разные контакты СЭП не объединяются только из-за одинаковых телефона и почты', async (): Promise<void> => {
  const inquiry = await createInquiry('telegram');
  await sync(inquiry.id, 16);
  const conflict = await db
    .transaction((tx) =>
      resolveCustomer(
        tx,
        { name: 'Повтор', phone, email },
        { phone: '+79997654321', email },
      ),
    )
    .then(
      () => null,
      (error: unknown): unknown => error,
    );
  expect(conflict).toBeInstanceOf(ConflictException);
  const relink = await service
    .enqueue(inquiry.id, actor, { operationId: randomUUID(), contactId: 15 })
    .then(
      () => null,
      (error: unknown): unknown => error,
    );
  expect(relink).toBeInstanceOf(ConflictException);
});

test('конкурентное сохранение не выдаёт прежнюю выполняемую операцию за новое обновление', async (): Promise<void> => {
  const inquiry = await createInquiry('max');
  const results = await Promise.allSettled(
    [1, 2].map(() =>
      service.enqueue(inquiry.id, actor, { operationId: randomUUID(), contactId: 17 }),
    ),
  );
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  const job = results.find((result) => result.status === 'fulfilled');
  if (job?.status !== 'fulfilled') throw new Error('Нет принятой операции');
  expect(await processJob(job.value.id)).toBe('done');
});

test('несовместимый ответ и отказ сети сохраняют прежние данные; повторяет тот же ключ', async (): Promise<void> => {
  const inquiry = await createInquiry('max');
  const job = await service.enqueue(inquiry.id, actor, {
    operationId: randomUUID(),
    contactId: 18,
  });

  for (const failure of ['network', 'missing', 'mismatch']) {
    responseStatus = failure === 'network' ? 503 : 200;
    noProfile = failure === 'missing';
    wrongContact = failure === 'mismatch';
    await db.query('UPDATE erp_sync_operations SET next_attempt_at=now() WHERE id=$1', [
      job.id,
    ]);
    expect(await processJob(job.id)).toBe('retry');
    expect(
      (
        await db.query('SELECT erp_contact_id FROM customers WHERE id=$1', [
          inquiry.customerId,
        ])
      ).rows[0].erp_contact_id,
    ).toBeNull();
  }
  responseStatus = 200;
  noProfile = false;
  wrongContact = false;
  await db.query('UPDATE erp_sync_operations SET next_attempt_at=now() WHERE id=$1', [
    job.id,
  ]);
  expect(await processJob(job.id)).toBe('done');
  expect(received.filter((value) => value === job.id)).toHaveLength(4);
});

test('отзыв права до выполнения блокирует обращение к СЭП', async (): Promise<void> => {
  const inquiry = await createInquiry('max');
  const job = await service.enqueue(inquiry.id, actor, {
    operationId: randomUUID(),
    contactId: 19,
  });
  forbidden = true;
  try {
    expect(await processJob(job.id)).toBe('done');
    expect(
      (await db.query('SELECT state FROM erp_sync_operations WHERE id=$1', [job.id]))
        .rows[0].state,
    ).toBe('failed');
    expect(received).not.toContain(job.id);
  } finally {
    forbidden = false;
  }
});

test('отказ транзакции не сохраняет половину профиля или привязки', async (): Promise<void> => {
  const inquiry = await createInquiry('max');
  const job = await service.enqueue(inquiry.id, actor, {
    operationId: randomUUID(),
    contactId: 20,
  });
  await db.query(
    "CREATE FUNCTION fail_identity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test'; END $$",
  );
  await db.query(
    'CREATE TRIGGER fail_identity BEFORE INSERT ON customer_identities FOR EACH ROW EXECUTE FUNCTION fail_identity()',
  );
  try {
    expect(await processJob(job.id)).toBe('retry');
    expect(
      (
        await db.query('SELECT erp_contact_id,contacts FROM customers WHERE id=$1', [
          inquiry.customerId,
        ])
      ).rows[0],
    ).toEqual({
      erp_contact_id: null,
      contacts: { name: 'Клиент платформы', phone: '', email: '' },
    });
  } finally {
    await db.query('DROP TRIGGER fail_identity ON customer_identities');
    await db.query('DROP FUNCTION fail_identity()');
  }
});

test('очистка реквизита в СЭП удаляет старое совпадение, но сохраняет историю', async (): Promise<void> => {
  const inquiry = await createInquiry('telegram');
  await sync(inquiry.id, 21);
  phone = '';
  email = '';
  version = '2026-10-16T13:00:00.000Z';
  await sync(inquiry.id, 21);
  expect(
    (await db.query('SELECT contacts FROM customers WHERE id=$1', [inquiry.customerId]))
      .rows[0].contacts,
  ).toEqual({ name: 'Клиент платформы', phone: '', email: '' });
  expect(
    (
      await db.query('SELECT id FROM customer_identities WHERE customer_id=$1', [
        inquiry.customerId,
      ])
    ).rowCount,
  ).toBe(0);
  expect(
    (await db.query('SELECT id FROM messages WHERE inquiry_id=$1', [inquiry.id]))
      .rowCount,
  ).toBe(1);
});

test('откат старого индекса не уничтожает журнал повторных синхронизаций', async (): Promise<void> => {
  await expect(db.migrate('down')).rejects.toThrow();
  expect((await db.migrate('status')).pending).toEqual([]);
});
