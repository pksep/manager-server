import 'reflect-metadata';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { createApplication } from '../dist/app';
import { readConfig } from '../dist/config';
import { localActors, awaitManagerAccess } from './support/local-managers';

const config = {
  ...readConfig(),
  MANAGER_REDIS_PREFIX: `manager-erp-test-${randomUUID()}`,
};
const url = new URL(config.DATABASE_URL);
if (
  url.hostname !== '127.0.0.1' ||
  url.port !== '56441' ||
  url.pathname !== '/manager_local' ||
  !['http://127.0.0.1:4502/api', 'http://127.0.0.1:4503/api'].includes(
    config.ERP_SERVICE_URL || '',
  ) ||
  config.CHAT_SERVICE_URL !== 'http://127.0.0.1:4501/api'
)
  throw new Error('Разрешён только изолированный стенд manager');
const db = new Pool({ connectionString: url.toString() });
url.pathname = '/manager_erp_local';
const erpDb = new Pool({ connectionString: url.toString() });
url.pathname = '/manager_chat_local';
const chatDb = new Pool({ connectionString: url.toString() });
const actor = JSON.parse(
  readFileSync('../.worktrees/manager-erp-server/.local/erp-actor.json', 'utf8'),
) as { userId: number; roleId: number };
const erp = config.ERP_SERVICE_URL!,
  chat = config.CHAT_SERVICE_URL,
  manager = 'http://127.0.0.1:4314',
  origin = 'http://127.0.0.1:4310';
const erpHeaders = {
  'x-manager-key': config.ERP_MANAGER_KEY!,
  'x-erp-actor-id': String(actor.userId),
};
let runtime: Awaited<ReturnType<typeof createApplication>>;
let proxy: ReturnType<typeof Bun.serve>;
let dropAck = false,
  dropped = false,
  offline = false;
let staff: { id: string; token: string }, unmapped: { id: string; token: string };
let contactId: number;
const identity = freshIdentity();
const first = {
  operationId: randomUUID(),
  customerId: randomUUID(),
  name: 'Проверка синхронизации',
  identity,
};

function freshIdentity() {
  return {
    phone: '+7999' + String(Math.floor(Math.random() * 10000000)).padStart(7, '0'),
    email: `manager-${randomUUID()}@example.test`,
  };
}
function json(body: unknown, headers: Record<string, string> = {}): RequestInit {
  return {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
async function request(path: string, options: RequestInit, status: number) {
  const response = await fetch(path, { ...options, signal: AbortSignal.timeout(20000) });
  if (response.status !== status)
    console.error(new URL(path).pathname, response.status, await response.clone().text());
  expect(response.status).toBe(status);
  return response;
}
async function erpCall(path: string, body: unknown, status = 201, headers = erpHeaders) {
  return (
    await request(erp + '/internal/manager/contacts/' + path, json(body, headers), status)
  ).json() as Promise<any>;
}
async function login(name: string) {
  const local = name === 'Менеджер ЕРП' ? localActors[0] : undefined;
  const existing = local
    ? (await chatDb.query('SELECT initials FROM users WHERE nickname=$1', [local.tabel]))
        .rows[0]
    : undefined;
  const body = (await (
    await request(
      chat + '/auth/login',
      json(
        {
          nickname: local?.tabel || 'manager-erp-' + randomUUID(),
          initials: existing?.initials || name,
        },
        { 'x-service-key': config.MANAGER_INTERNAL_KEY },
      ),
      201,
    )
  ).json()) as any;
  return { token: body.accessToken || body.token, id: body.user.id };
}
async function grants() {
  await awaitManagerAccess(chat, staff.token, true);
  await awaitManagerAccess(chat, unmapped.token, false);
}
async function staffCall(
  path: string,
  body?: unknown,
  status = body === undefined ? 200 : 201,
  user = staff,
) {
  const headers = { Authorization: `Bearer ${user.token}` };
  return (
    await request(
      chat + '/manager/inquiries/' + path,
      body === undefined ? { headers } : json(body, headers),
      status,
    )
  ).json() as Promise<any>;
}
async function until<T>(
  work: () => Promise<T>,
  accepts: (value: T) => boolean,
): Promise<T> {
  for (let index = 0; index < 200; index++) {
    const result = await work();
    if (accepts(result)) return result;
    await Bun.sleep(100);
  }
  throw new Error('Ожидаемое состояние не наступило');
}
async function openInquiry(
  contacts = { name: 'Клиент сквозного теста', ...freshIdentity() },
) {
  const guest = (await (
    await request(
      manager + '/v1/widget/session',
      json(
        {
          siteId: 'amotiv-demo',
          source: { pageUrl: origin + '/', title: 'ЕРП', referrerOrigin: '' },
        },
        { Origin: origin },
      ),
      201,
    )
  ).json()) as any;
  const result = (await (
    await request(
      manager + '/v1/widget/inquiries',
      json(
        {
          operationId: randomUUID(),
          html: '<p>Проверка ЕРП</p>',
          attachmentIds: [],
          contacts,
        },
        { Origin: origin, Authorization: `Bearer ${guest.token}` },
      ),
      201,
    )
  ).json()) as any;
  return { ...result, guest, contacts };
}
async function completed(id: string) {
  return (
    await until(
      () => db.query('SELECT * FROM erp_sync_operations WHERE id=$1', [id]),
      (result) => result.rows[0]?.state === 'completed',
    )
  ).rows[0];
}
async function startManager() {
  runtime = await createApplication({
    ...config,
    ERP_SERVICE_URL: 'http://127.0.0.1:4504/api',
  });
  await runtime.app.listen(4314, '127.0.0.1');
}

beforeAll(async () => {
  proxy = Bun.serve({
    hostname: '127.0.0.1',
    port: 4504,
    async fetch(incoming) {
      if (offline) return new Response('unavailable', { status: 503 });
      const body = await incoming.arrayBuffer();
      const response = await fetch(
        erp + new URL(incoming.url).pathname.replace(/^\/api/, ''),
        {
          method: incoming.method,
          headers: incoming.headers,
          ...(incoming.method === 'GET' || incoming.method === 'HEAD' ? {} : { body }),
        },
      );
      if (dropAck && new URL(incoming.url).pathname.endsWith('/sync') && response.ok) {
        dropAck = false;
        dropped = true;
        await response.arrayBuffer();
        return new Response('lost acknowledgement', { status: 503 });
      }
      return response;
    },
  });
  staff = await login('Менеджер ЕРП');
  unmapped = await login('Без связи с ЕРП');
  await grants();
  await startManager();
}, 60000);
afterAll(async () => {
  runtime?.app.getHttpServer().closeAllConnections();
  await runtime?.close();
  await proxy?.stop(true);
  await Promise.all([db.end(), erpDb.end(), chatDb.end()]);
}, 30000);

test('внутренний ключ не открывает обычные маршруты, инициатор и данные проверяются', async () => {
  await erpCall('candidates', identity, 401, {
    ...erpHeaders,
    'x-manager-key': 'invalid',
  });
  await erpCall('candidates', identity, 401, { ...erpHeaders, 'x-erp-actor-id': '0' });
  await erpCall('candidates', { ...identity, admin: true }, 400);
  await erpCall('sync', { ...first, identity: { phone: '123' } }, 400);
  await request(
    erp + '/contacts',
    json({}, { ...erpHeaders, Origin: 'http://127.0.0.3:4315' }),
    401,
  );
});

test('пять одновременных запросов создают один контакт и одно штатное действие', async () => {
  const responses = await Promise.all(
    Array.from({ length: 5 }, () => erpCall('sync', first)),
  );
  contactId = responses[0].contactId;
  expect(
    responses.every((result) => result.contactId === contactId && result.created),
  ).toBe(true);
  const matches = await erpCall('candidates', {
    phone: identity.phone.replace('+7999', '+7 (999) '),
    email: identity.email.toUpperCase(),
  });
  expect(matches.map((contact: any) => contact.id)).toContain(contactId);
  expect(matches.find((contact: any) => contact.id === contactId).initial).toBe(
    first.name,
  );
  const actions = await erpDb.query(
    'SELECT id,responsible_id FROM actions WHERE contact_id=$1',
    [contactId],
  );
  expect(actions.rows).toHaveLength(1);
  expect(actions.rows[0].responsible_id).toBe(actor.userId);
  expect(
    (
      await erpDb.query('SELECT id FROM action_chain WHERE parent_action_id=$1', [
        actions.rows[0].id,
      ])
    ).rows,
  ).toHaveLength(1);
  await erpCall('sync', { ...first, name: 'Другой запрос' }, 409);
});

test('совпадения требуют выбора, связь не перезаписывает реквизиты, архив запрещён', async () => {
  const duplicate = {
    ...first,
    operationId: randomUUID(),
    customerId: randomUUID(),
    name: 'Другое введённое имя',
  };
  await erpCall('sync', duplicate, 409);
  expect((await erpCall('sync', { ...duplicate, contactId })).created).toBe(false);
  expect((await erpCall('candidates', identity))[0].initial).toBe(first.name);
  expect((await erpCall('sync', { ...first, operationId: randomUUID() })).contactId).toBe(
    contactId,
  );
  await erpDb.query('UPDATE contacts SET ban=true WHERE id=$1', [contactId]);
  try {
    expect((await erpCall('candidates', identity))[0].ban).toBe(true);
    await erpCall('sync', { ...duplicate, operationId: randomUUID(), contactId }, 409);
    await erpCall(
      'sync',
      { ...first, operationId: randomUUID(), customerId: randomUUID() },
      409,
    );
  } finally {
    await erpDb.query('UPDATE contacts SET ban=false WHERE id=$1', [contactId]);
  }
});

test('параллельные создания разных карточек с одним телефоном дают один контакт', async () => {
  const identity = freshIdentity();
  const responses = await Promise.all(
    Array.from({ length: 2 }, () =>
      fetch(
        erp + '/internal/manager/contacts/sync',
        json(
          {
            operationId: randomUUID(),
            customerId: randomUUID(),
            name: 'Параллельная карточка',
            identity,
          },
          erpHeaders,
        ),
      ),
    ),
  );
  expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
  await Promise.all(responses.map((response) => response.arrayBuffer()));
  expect(await erpCall('candidates', identity)).toHaveLength(1);
});

test('конфликт синхронизации разрешается явным выбором контакта менеджером', async () => {
  const inquiry = await openInquiry({ name: first.name, ...identity });
  const operationId = randomUUID();
  await staffCall(inquiry.inquiryId + '/erp/sync', { operationId });
  await until(
    () => db.query('SELECT state FROM erp_sync_operations WHERE id=$1', [operationId]),
    (value) => value.rows[0]?.state === 'conflict',
  );
  const other = await openInquiry();
  await staffCall(other.inquiryId + '/erp/sync', { operationId }, 409);
  const selected = randomUUID();
  await staffCall(inquiry.inquiryId + '/erp/sync', { operationId: selected, contactId });
  expect((await completed(selected)).erp_contact_id).toBe(String(contactId));
  await staffCall(inquiry.inquiryId + '/erp/retry', { operationId }, 409);
});

test('отказ записи журнала откатывает контакт, действие и связь', async () => {
  const input = {
    ...first,
    operationId: randomUUID(),
    customerId: randomUUID(),
    identity: freshIdentity(),
    name: 'rollback-' + randomUUID(),
  };
  await erpDb.query(
    `CREATE OR REPLACE FUNCTION manager_test_reject_operation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'isolated rollback test'; END $$`,
  );
  await erpDb.query(
    'CREATE TRIGGER manager_test_reject_operation BEFORE INSERT ON manager_contact_operations FOR EACH ROW EXECUTE FUNCTION manager_test_reject_operation()',
  );
  try {
    await erpCall('sync', input, 503);
    expect((await erpCall('candidates', input.identity)).length).toBe(0);
    expect(
      (
        await erpDb.query(
          'SELECT customer_id FROM manager_contact_bindings WHERE customer_id=$1',
          [input.customerId],
        )
      ).rowCount,
    ).toBe(0);
  } finally {
    await erpDb.query(
      'DROP TRIGGER manager_test_reject_operation ON manager_contact_operations',
    );
    await erpDb.query('DROP FUNCTION manager_test_reject_operation()');
  }
  expect((await erpCall('sync', input)).created).toBe(true);
});

test('актуальные права ЕРП проверяются для чтения, создания и повторов', async () => {
  const previous = (
    await erpDb.query('SELECT permission_id FROM role_permissions WHERE role_id=$1', [
      actor.roleId,
    ])
  ).rows.map((row) => row.permission_id);
  async function setPermissions(ids: number[]) {
    const client = await erpDb.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'UPDATE roles SET permissions_version=permissions_version+1 WHERE id=$1',
        [actor.roleId],
      );
      await client.query('DELETE FROM role_permissions WHERE role_id=$1', [actor.roleId]);
      await client.query(
        'INSERT INTO role_permissions(role_id,permission_id,"createdAt","updatedAt") SELECT $1,unnest($2::int[]),now(),now()',
        [actor.roleId, ids],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  try {
    await setPermissions([]);
    await erpCall('candidates', identity, 403);
    await erpCall('sync', first, 403);
    const permission = (
      await erpDb.query(
        "SELECT p.id FROM authorization_permissions p JOIN authorization_resources r ON r.id=p.resource_id WHERE r.code='chat.clients' AND p.action='view'",
      )
    ).rows[0].id;
    await setPermissions([permission]);
    await erpCall(
      'sync',
      {
        ...first,
        operationId: randomUUID(),
        customerId: randomUUID(),
        identity: freshIdentity(),
      },
      201,
    );
    expect(
      (
        await erpCall('sync', {
          ...first,
          operationId: randomUUID(),
          customerId: randomUUID(),
          contactId,
        })
      ).created,
    ).toBe(false);
  } finally {
    await setPermissions(previous);
  }
});

test('manager получает кандидатов и синхронизирует через доверенную связь сотрудника', async () => {
  const inquiry = await openInquiry();
  await staffCall(inquiry.inquiryId + '/erp/candidates', undefined, 403, unmapped);
  // Редактируемое ex не является источником прав или ERP actor.
  const previousEx = (await chatDb.query('SELECT ex FROM users WHERE id=$1', [staff.id]))
    .rows[0].ex;
  await chatDb.query('UPDATE users SET ex=$2 WHERE id=$1', [
    staff.id,
    { erpUserId: 2147483647 },
  ]);
  try {
    expect(await staffCall(inquiry.inquiryId + '/erp/candidates')).toEqual([]);
  } finally {
    await chatDb.query('UPDATE users SET ex=$2 WHERE id=$1', [staff.id, previousEx]);
  }
  const operationId = randomUUID();
  const responses = await Promise.all(
    Array.from({ length: 3 }, () =>
      staffCall(inquiry.inquiryId + '/erp/sync', { operationId }),
    ),
  );
  expect(responses.every((result) => result.id === operationId)).toBe(true);
  const operation = await completed(operationId);
  const detail = await staffCall(inquiry.inquiryId);
  expect(detail.inquiry.erp_contact_id).toBe(operation.erp_contact_id);
  expect(detail.erpOperations[0].state).toBe('completed');
  expect(
    (
      await erpDb.query('SELECT responsible_id FROM actions WHERE contact_id=$1', [
        operation.erp_contact_id,
      ])
    ).rows[0].responsible_id,
  ).toBe(actor.userId);
  const next = await openInquiry(inquiry.contacts);
  expect(next.inquiryId).toBe(inquiry.inquiryId);
  expect((await staffCall(next.inquiryId)).inquiry.customer_id).toBe(
    detail.inquiry.customer_id,
  );
  expect(
    (await staffCall(next.inquiryId + '/erp/candidates')).map((row: any) => row.id),
  ).toContain(Number(operation.erp_contact_id));
  expect((await staffCall(next.inquiryId)).inquiry.erp_contact_id).toBe(
    operation.erp_contact_id,
  );
  const history = await staffCall(next.inquiryId + '/history');
  expect(new Set(history.messages.map((message: any) => message.inquiry_id))).toEqual(
    new Set([inquiry.inquiryId, next.inquiryId]),
  );
  const guestHistory = (await (
    await request(
      manager + `/v1/widget/inquiries/${next.inquiryId}/messages`,
      {
        headers: { Origin: origin, Authorization: `Bearer ${next.guest.token}` },
      },
      200,
    )
  ).json()) as any;
  expect(guestHistory.messages).toHaveLength(1);
  const repeatedHistory = (await (
    await request(
      manager + `/v1/widget/inquiries/${inquiry.inquiryId}/messages`,
      {
        headers: { Origin: origin, Authorization: `Bearer ${next.guest.token}` },
      },
      200,
    )
  ).json()) as any;
  expect(repeatedHistory.messages).toEqual(guestHistory.messages);
});

test('потеря ответа ЕРП и перезапуск manager не создают второй контакт', async () => {
  const inquiry = await openInquiry();
  const operationId = randomUUID();
  dropAck = true;
  dropped = false;
  await staffCall(inquiry.inquiryId + '/erp/sync', { operationId });
  await until(async () => dropped, Boolean);
  runtime.app.getHttpServer().closeAllConnections();
  await runtime.close();
  const before = (
    await erpDb.query(
      'SELECT contact_id FROM manager_contact_bindings WHERE customer_id=(SELECT customer_id FROM manager_contact_operations WHERE id=$1)',
      [operationId],
    )
  ).rows[0].contact_id;
  await startManager();
  expect((await completed(operationId)).erp_contact_id).toBe(String(before));
  expect(
    (await erpDb.query('SELECT id FROM actions WHERE contact_id=$1', [before])).rowCount,
  ).toBe(1);
});

test('при недоступной ЕРП сообщения доставляются, а синхронизация ждёт повтора', async () => {
  const inquiry = await openInquiry();
  const operationId = randomUUID();
  offline = true;
  try {
    await staffCall(inquiry.inquiryId + '/erp/sync', { operationId });
    await until(
      () =>
        db.query('SELECT last_error FROM erp_sync_operations WHERE id=$1', [operationId]),
      (value) => value.rows[0]?.last_error === 'erp_503',
    );
    const sent = (await (
      await request(
        manager + `/v1/widget/inquiries/${inquiry.inquiryId}/messages`,
        json(
          {
            operationId: randomUUID(),
            html: '<p>Переписка продолжается</p>',
            attachmentIds: [],
          },
          { Origin: origin, Authorization: `Bearer ${inquiry.guest.token}` },
        ),
        201,
      )
    ).json()) as any;
    await until(
      () =>
        db.query('SELECT state FROM delivery_operations WHERE id=$1', [sent.message.id]),
      (value) => value.rows[0]?.state === 'delivered',
    );
    expect(
      (await db.query('SELECT state FROM erp_sync_operations WHERE id=$1', [operationId]))
        .rows[0].state,
    ).not.toBe('completed');
  } finally {
    offline = false;
  }
  await completed(operationId);
});
