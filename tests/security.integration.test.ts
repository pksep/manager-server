import 'reflect-metadata';
import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { Pool } from 'pg';
import { connect } from 'amqplib';
import { WebSocket } from 'ws';
import { readConfig } from '../dist/config';
import { Database } from '../dist/database';
import { SecurityService, SecurityError } from '../dist/security';
import { createApplication } from '../dist/app';
import { FileInspection } from '../dist/secure-upload';

const original = readConfig();
const url = new URL(original.DATABASE_URL);
if (
  url.hostname !== '127.0.0.1' ||
  url.port !== '56441' ||
  url.pathname !== '/manager_local'
)
  throw new Error('Разрешён только изолированный стенд manager');
const databaseName = `manager_security_${Date.now()}`;
url.pathname = '/' + databaseName;
const prefix = `manager-security-${Date.now()}`;
const origin = 'http://127.0.0.1:4310';
const base = 'http://127.0.0.1:4324';
const config = {
  ...original,
  DATABASE_URL: url.href,
  PORT: 4324,
  CHAT_SERVICE_URL: 'http://127.0.0.1:4504/api',
  ERP_SERVICE_URL: undefined,
  ERP_MANAGER_KEY: undefined,
  MANAGER_QUEUE_PREFIX: prefix,
  MANAGER_REDIS_PREFIX: prefix,
  MANAGER_CAPTCHA_MODE: 'disabled' as const,
  MANAGER_SCAN_MODE: 'required' as const,
  MANAGER_SESSIONS_IP_MINUTE: 5,
  MANAGER_TRUSTED_PROXIES: '127.0.0.1/32',
  MANAGER_WORKER_MS: 1000,
};
let runtime: Awaited<ReturnType<typeof createApplication>>;
let db: Database;
let security: SecurityService;
const receipts = new Map<
  string,
  { topicId: string; messageId: string; sequence: number }
>();
const delivered: string[] = [];
let loseReply = false;
let upstreamBytes = 0;
const upstream = createServer(async (request, response) => {
  if (request.headers['x-manager-key'] !== original.CHAT_MANAGER_KEY) {
    response.writeHead(401).end();
    return;
  }
  response.setHeader('Content-Type', 'application/json');
  const path = new URL(request.url!, 'http://localhost').pathname;
  if (path.endsWith('/events')) {
    response.end('{"events":[]}');
    return;
  }
  if (path.endsWith('/ready')) {
    response.end('{"ready":true,"version":1}');
    return;
  }
  if (path.endsWith('/messages')) {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const previous = receipts.get(body.operationId);
    const receipt = previous || {
      topicId: path.split('/')[5],
      messageId: randomUUID(),
      sequence: receipts.size + 1,
    };
    if (!previous) {
      receipts.set(body.operationId, receipt);
      delivered.push(body.html);
    }
    if (loseReply) {
      loseReply = false;
      request.socket.destroy();
      return;
    }
    response.end(JSON.stringify(receipt));
    return;
  }
  if (path.endsWith('/attachments')) {
    // Здесь проверяется сам исходящий multipart, без сохранения второй копии файла.
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    upstreamBytes += body.length;
    const decoded = body.toString();
    const id = /name="id"\r\n\r\n([^\r]+)/.exec(decoded)![1];
    const start = decoded.indexOf('\r\n\r\n', decoded.indexOf('filename=')) + 4;
    const end = decoded.lastIndexOf('\r\n--');
    response.end(
      JSON.stringify({
        id,
        name: 'note.txt',
        mime: 'text/plain',
        size: Buffer.byteLength(decoded.slice(start, end)),
      }),
    );
    return;
  }
  response.writeHead(404).end('{}');
});

async function until(action: () => Promise<boolean>, timeout = 18000): Promise<void> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await action()) return;
    await Bun.sleep(100);
  }
  throw new Error('Не дождались результата');
}

function context(ip = '198.51.100.1'): ReturnType<SecurityService['context']> {
  return security.context({
    socket: { remoteAddress: '127.0.0.1' },
    headers: { 'x-forwarded-for': ip, origin },
  } as Parameters<SecurityService['context']>[0]);
}

let address = 10;
async function session(
  ip = `198.51.100.${address++}`,
): Promise<{ token: string; ip: string }> {
  const response = await fetch(base + '/v1/widget/session', {
    method: 'POST',
    headers: {
      Origin: origin,
      'Content-Type': 'application/json',
      'X-Forwarded-For': ip,
    },
    body: JSON.stringify({
      siteId: 'amotiv-demo',
      source: { pageUrl: origin + '/', title: 'Безопасность', referrerOrigin: '' },
    }),
  });
  expect(response.status).toBe(201);
  return { ...(await response.json()), ip };
}

async function send(
  guest: { token: string; ip: string },
  html: string,
  operationId = randomUUID(),
  inquiryId?: string,
): Promise<Response> {
  return fetch(
    base +
      (inquiryId ? `/v1/widget/inquiries/${inquiryId}/messages` : '/v1/widget/inquiries'),
    {
      method: 'POST',
      headers: {
        Origin: origin,
        Authorization: `Bearer ${guest.token}`,
        'Content-Type': 'application/json',
        'X-Forwarded-For': guest.ip,
      },
      body: JSON.stringify({
        operationId,
        html,
        attachmentIds: [],
        ...(!inquiryId
          ? {
              contacts: {
                name: 'Проверка SQL',
                phone: '+79990000000',
                email: `${guest.token.slice(0, 8)}@example.test`,
              },
            }
          : {}),
      }),
    },
  );
}

beforeAll(async () => {
  const admin = new Pool({ connectionString: original.DATABASE_URL, max: 1 });
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await admin.end();
  }
  db = new Database(config);
  await db.migrate();
  for (let version = 8; version > 0; version--) await db.migrate('down');
  expect((await db.migrate('status')).executed).toEqual([]);
  await db.migrate();
  await new Promise<void>((resolve) => upstream.listen(4504, '127.0.0.1', resolve));
  runtime = await createApplication(config);
  security = runtime.app.get(SecurityService);
  await runtime.app.listen(4324, '127.0.0.1');
}, 30000);

afterAll(async () => {
  runtime?.app.getHttpServer().closeAllConnections();
  await runtime?.close();
  await db?.onModuleDestroy();
  upstream.closeAllConnections();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  const connection = await connect(original.MANAGER_RABBITMQ_URL!);
  const channel = await connection.createChannel();
  for (const kind of ['delivery', 'erp', 'channel-inbox', 'channel-outbox'])
    for (const suffix of ['', '.retry', '.failed'])
      await channel.deleteQueue(`${prefix}.${kind}${suffix}`);
  await connection.close();
  const admin = new Pool({ connectionString: original.DATABASE_URL, max: 1 });
  try {
    await admin.query(`DROP DATABASE "${databaseName}"`);
  } finally {
    await admin.end();
  }
});

test('полный цикл up/down и повторное применение миграций; откат последней версии сохраняет записи', async () => {
  expect((await db.migrate()).executed.length).toBe(8);
  expect((await db.migrate('down')).pending).toEqual(['008_channels.sql']);
  expect((await db.migrate()).pending).toEqual([]);
});

test('runtime роль работает через ORM, но не создаёт и не удаляет таблицы', async () => {
  const role = `manager_test_${randomUUID().replaceAll('-', '')}`;
  const password = randomUUID().replaceAll('-', '');
  const identifier = (value: string): string => '"' + value.replaceAll('"', '""') + '"';
  await db.query(
    `CREATE ROLE ${identifier(role)} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
  );
  const address = new URL(config.DATABASE_URL);
  const permissions = (await readFile('config/database-permissions.sql', 'utf8'))
    .replaceAll(':"runtime_role"', identifier(role))
    .replaceAll(':"migration_role"', identifier(decodeURIComponent(address.username)));
  address.username = role;
  address.password = password;
  const limited = new Database({ ...config, DATABASE_URL: address.href });
  try {
    await db.query(permissions);
    const site = await limited.models.Site.findByPk('amotiv-demo');
    expect(site?.get('id')).toBe('amotiv-demo');
    await limited.models.Site.update({ enabled: true }, { where: { id: 'amotiv-demo' } });
    for (const statement of [
      'CREATE TABLE runtime_should_not_create(id int)',
      'DROP TABLE customers',
      'DELETE FROM manager_schema_migrations',
    ]) {
      const result = await limited.query(statement).catch((error: unknown) => error);
      expect((result as { original?: { code: string } }).original?.code).toBe('42501');
    }
  } finally {
    await limited.onModuleDestroy();
    await db.query(`DROP OWNED BY ${identifier(role)}`);
    await db.query(`DROP ROLE ${identifier(role)}`);
  }
});

test('прямой клиент не может подменить IP, доверенная цепочка и IPv6 /64 нормализуются', async () => {
  const direct = new SecurityService({ ...config, MANAGER_TRUSTED_PROXIES: '' });
  const forged = direct.context({
    socket: { remoteAddress: '::ffff:192.0.2.7' },
    headers: { 'x-forwarded-for': '8.8.8.8' },
  } as Parameters<SecurityService['context']>[0]);
  expect(forged.ip).toBe('192.0.2.7');
  expect(context('2001:db8:1234:5678::1').network).toBe(
    context('2001:db8:1234:5678::ff').network,
  );
  expect(context('2001:db8:1234:5679::1').network).not.toBe(
    context('2001:db8:1234:5678::1').network,
  );
});

test('новые сессии и новые visitorId не обходят общий лимит IP', async () => {
  const ip = '198.51.100.2';
  for (let index = 0; index < 5; index++) await session(ip);
  const response = await fetch(base + '/v1/widget/session', {
    method: 'POST',
    headers: {
      Origin: origin,
      'Content-Type': 'application/json',
      'X-Forwarded-For': ip,
    },
    body: JSON.stringify({
      siteId: 'amotiv-demo',
      source: { pageUrl: origin + '/', title: '', referrerOrigin: '' },
    }),
  });
  expect(response.status).toBe(429);
  expect(response.headers.get('Retry-After')).not.toBeNull();
  await session('198.51.100.3');
});

test('лимит атомарен между экземплярами и не открывается при недоступном Redis', async () => {
  const second = new SecurityService(config);
  await second.onModuleInit();
  try {
    const key = randomUUID();
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, index) =>
        (index % 2 ? second : security).consume([{ key, capacity: 4, window: 60000 }]),
      ),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(4);
  } finally {
    await second.onModuleDestroy();
  }
  await expect(
    second.consume([{ key: randomUUID(), capacity: 4, window: 60000 }]),
  ).rejects.toThrow();
});

test('общие аренды не допускают параллельный обход; освобождение возвращает место', async () => {
  const key = randomUUID();
  const results = await Promise.allSettled(
    Array.from({ length: 10 }, () => security.acquire([{ key, capacity: 2 }])),
  );
  const leases = results.flatMap((result) =>
    result.status === 'fulfilled' ? [result.value] : [],
  );
  expect(leases).toHaveLength(2);
  await Promise.all(leases.map((lease) => lease.release()));
  await (await security.acquire([{ key, capacity: 2 }])).release();
});

test('SQL остаётся текстом, HTML очищается, повтор одной отправки создаёт одну запись', async () => {
  const guest = await session();
  const operationId = randomUUID();
  const payload =
    "<p>Robert'); DROP TABLE customers;--</p><script>alert(1)</script><img src=x onerror=alert(1)>";
  const responses = await Promise.all(
    Array.from({ length: 5 }, () => send(guest, payload, operationId)),
  );
  for (const response of responses) expect(response.status).toBe(201);
  const result = await responses[0].json();
  expect(result.message.html).toContain('DROP TABLE customers;--');
  expect(result.message.html).not.toContain('<script');
  expect(result.message.html).not.toContain('onerror');
  expect(
    (await db.query('SELECT id FROM messages WHERE operation_id=$1', [operationId]))
      .rowCount,
  ).toBe(1);
  await until(
    async () =>
      (
        await db.query(
          "SELECT id FROM delivery_operations WHERE id=$1 AND state='delivered'",
          [result.message.id],
        )
      ).rowCount === 1,
  );
});

test('потеря ответа не дублирует доставку RabbitMQ и не меняет порядок сообщений', async () => {
  const guest = await session();
  loseReply = true;
  const first = await (await send(guest, 'Порядок 1')).json();
  const second = await (
    await send(guest, 'Порядок 2', randomUUID(), first.inquiryId)
  ).json();
  await until(
    async () =>
      (
        await db.query(
          "SELECT id FROM delivery_operations WHERE id=$1 AND state='delivered'",
          [second.message.id],
        )
      ).rowCount === 1,
  );
  expect(delivered.filter((value) => value === 'Порядок 1')).toHaveLength(1);
  expect(delivered.indexOf('Порядок 1')).toBeLessThan(delivered.indexOf('Порядок 2'));
}, 25000);

test('чужая сессия не получает историю обращения и не может подменить его ID', async () => {
  const guest = await session();
  const inquiry = await (await send(guest, 'Приватная переписка')).json();
  const stranger = await session();
  const response = await fetch(
    `${base}/v1/widget/inquiries/${inquiry.inquiryId}/messages`,
    {
      headers: {
        Origin: origin,
        Authorization: `Bearer ${stranger.token}`,
        'X-Forwarded-For': stranger.ip,
      },
    },
  );
  expect(response.status).toBe(404);
  expect((await send(stranger, 'Подмена', randomUUID(), inquiry.inquiryId)).status).toBe(
    404,
  );
});

test('много одинаковых сообщений из разных сессий вызывает ограничение', async () => {
  const ctx = context('198.51.100.190');
  for (let index = 0; index < 10; index++)
    await security.message(
      ctx,
      'amotiv-demo',
      randomUUID(),
      randomUUID(),
      'массовый повтор',
      [],
      false,
    );
  const blocked = await security
    .message(ctx, 'amotiv-demo', randomUUID(), randomUUID(), 'массовый повтор', [], false)
    .catch((error: unknown) => error);
  expect(blocked).toBeInstanceOf(SecurityError);
  await security.message(
    context('198.51.100.191'),
    'amotiv-demo',
    randomUUID(),
    randomUUID(),
    'Здравствуйте',
    [],
    false,
  );
});

test('SmartCaptcha проверяет ключ, host, одноразовость и привязку к операции; сбой не пропускает запрос', async () => {
  const captcha = new SecurityService({
    ...config,
    MANAGER_CAPTCHA_MODE: 'required',
    SMARTCAPTCHA_CLIENT_KEY: 'test-client',
    SMARTCAPTCHA_SERVER_KEY: 'test-server-key-only-for-fixture',
  });
  await captcha.onModuleInit();
  const actualFetch = globalThis.fetch;
  const validate = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (String(input) !== 'https://smartcaptcha.cloud.yandex.ru/validate')
      return actualFetch(input, init);
    expect((init!.body as URLSearchParams).get('secret')).toBe(
      'test-server-key-only-for-fixture',
    );
    return Response.json({ status: 'ok', host: '127.0.0.1:4310' });
  });
  try {
    const ctx = context('198.51.100.192');
    let challenge = '';
    try {
      await captcha.captcha(ctx, 'amotiv-demo', 'op1', true);
    } catch (error) {
      challenge = String((error as SecurityError).details.challenge);
    }
    await captcha.captcha(
      { ...ctx, challenge, captchaToken: 'test-token' },
      'amotiv-demo',
      'op1',
      true,
    );
    expect(
      await captcha
        .captcha(
          { ...ctx, challenge, captchaToken: 'test-token' },
          'amotiv-demo',
          'op1',
          true,
        )
        .catch((error: unknown) => error),
    ).toBeInstanceOf(SecurityError);
    try {
      await captcha.captcha(ctx, 'amotiv-demo', 'op2', true);
    } catch (error) {
      challenge = String((error as SecurityError).details.challenge);
    }
    expect(
      await captcha
        .captcha(
          { ...ctx, challenge, captchaToken: 'test-token' },
          'amotiv-demo',
          'op3',
          true,
        )
        .catch((error: unknown) => error),
    ).toBeInstanceOf(SecurityError);
    try {
      await captcha.captcha(ctx, 'amotiv-demo', 'op4', true);
    } catch (error) {
      challenge = String((error as SecurityError).details.challenge);
    }
    validate.mockResolvedValueOnce(
      Response.json({ status: 'ok', host: 'attacker.example' }),
    );
    expect(
      await captcha
        .captcha(
          { ...ctx, challenge, captchaToken: 'test-token' },
          'amotiv-demo',
          'op4',
          true,
        )
        .catch((error: unknown) => error),
    ).toBeInstanceOf(SecurityError);
    try {
      await captcha.captcha(ctx, 'amotiv-demo', 'op5', true);
    } catch (error) {
      challenge = String((error as SecurityError).details.challenge);
    }
    validate.mockRejectedValueOnce(new Error('provider down'));
    const outage = await captcha
      .captcha(
        { ...ctx, challenge, captchaToken: 'test-token' },
        'amotiv-demo',
        'op5',
        true,
      )
      .catch((error: unknown) => error);
    expect((outage as Error).message).toBe('Проверка временно недоступна');
  } finally {
    validate.mockRestore();
    await captcha.onModuleDestroy();
  }
});

test('файл проверяется настоящим ClamAV до передачи; активный формат не попадает в чат', async () => {
  const guest = await session();
  const upload = async (name: string, content: string): Promise<Response> => {
    const operationId = randomUUID();
    const form = new FormData();
    form.set('operationId', operationId);
    form.set('file', new File([content], name, { type: 'text/plain' }));
    return fetch(base + '/v1/widget/attachments', {
      method: 'POST',
      headers: {
        Origin: origin,
        Authorization: `Bearer ${guest.token}`,
        'X-Forwarded-For': guest.ip,
        'X-Operation-Id': operationId,
      },
      body: form,
    });
  };
  const before = upstreamBytes;
  expect((await upload('note.txt', 'Проверка безопасного файла')).status).toBe(201);
  expect(upstreamBytes).toBeGreaterThan(before);
  const after = upstreamBytes;
  expect((await upload('image.svg', '<svg onload="alert(1)"></svg>')).status).toBe(422);
  expect(upstreamBytes).toBe(after);
  // Официальная безвредная тестовая сигнатура EICAR, не исполняемый файл.
  const eicar =
    'X5O!P%@AP[4\\PZX54(P^)7CC)7}$' + 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
  const blockedStatus = (await upload('scan-test.txt', eicar)).status;
  // Windows Defender может удалить временный файл раньше ClamAV: запрос остаётся закрытым (503).
  expect(process.platform === 'win32' ? [422, 503] : [422]).toContain(blockedStatus);
  expect(upstreamBytes).toBe(after);
  const scan = await new Promise<string>((resolve, reject) => {
    const socket = createConnection({
      host: config.MANAGER_CLAMAV_HOST,
      port: config.MANAGER_CLAMAV_PORT,
    });
    let answer = '';
    socket.setTimeout(10000, () => socket.destroy(new Error('scan timeout')));
    socket.on('error', reject);
    socket.on('connect', () => {
      const bytes = Buffer.from(eicar),
        length = Buffer.alloc(4);
      length.writeUInt32BE(bytes.length);
      socket.write(
        Buffer.concat([Buffer.from('zINSTREAM\0'), length, bytes, Buffer.alloc(4)]),
      );
    });
    socket.on('data', (data) => {
      answer += data.toString();
      if (answer.includes('\0')) {
        socket.destroy();
        resolve(answer);
      }
    });
    socket.on('close', () => {
      if (!answer.includes('\0')) reject(new Error('scan incomplete'));
    });
  });
  expect(scan).toContain('FOUND');
});

test('недоступность антивируса и опасные пути в ZIP не пропускают файл', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sep-manager-security-test-'));
  try {
    const path = join(directory, 'file');
    await writeFile(path, 'Безопасный текст');
    const inspector = new FileInspection(
      { ...config, MANAGER_CLAMAV_PORT: 53311 },
      security,
    );
    const unavailable = await inspector
      .inspect(path, 'note.txt', Buffer.byteLength('Безопасный текст'))
      .catch((error: unknown) => error);
    expect((unavailable as { status: number }).status).toBe(503);
    const name = Buffer.from('../outside.txt');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(name.length, 28);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50);
    end.writeUInt16LE(1, 8);
    end.writeUInt16LE(1, 10);
    end.writeUInt32LE(central.length + name.length, 12);
    end.writeUInt32LE(local.length, 16);
    const zip = Buffer.concat([local, central, name, end]);
    await writeFile(path, zip);
    const rejected = await inspector
      .inspect(path, 'unsafe.zip', zip.length)
      .catch((error: unknown) => error);
    expect(rejected).toBeInstanceOf(SecurityError);
  } finally {
    const target = resolve(directory);
    if (
      dirname(target) !== resolve(tmpdir()) ||
      !basename(target).startsWith('sep-manager-security-test-')
    )
      throw new Error('Некорректный путь теста');
    await rm(target, { recursive: true, force: true });
  }
});

test('четвёртое WebSocket-подключение одной сессии отклоняется', async () => {
  const guest = await session();
  const sockets: WebSocket[] = [];
  const connectWidget = (): Promise<'ready' | 'closed'> =>
    new Promise((resolve) => {
      const socket = new WebSocket(base.replace('http', 'ws') + '/v1/widget/events', {
        headers: { Origin: origin, 'X-Forwarded-For': guest.ip },
      });
      sockets.push(socket);
      socket.on('open', () =>
        socket.send(JSON.stringify({ type: 'authenticate', token: guest.token })),
      );
      socket.on('message', (raw) => {
        if (JSON.parse(String(raw)).type === 'ready') resolve('ready');
      });
      socket.on('close', (code, reason) => {
        if (sockets.length < 4)
          console.error('Unexpected socket close', code, String(reason));
        resolve('closed');
      });
      socket.on('error', (error) => {
        console.error('Socket test error', error.message);
        resolve('closed');
      });
    });
  try {
    for (let index = 0; index < 3; index++) expect(await connectWidget()).toBe('ready');
    expect(await connectWidget()).toBe('closed');
  } finally {
    sockets.forEach((socket) => socket.terminate());
  }
});
