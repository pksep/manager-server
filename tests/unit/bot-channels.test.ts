import 'reflect-metadata';
import { expect, spyOn, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { ChannelConnection } from '../../src/channels/config';
import { readChannels } from '../../src/channels/config';
import {
  ChannelHttp,
  assertPlatformUrl,
  type ChannelTransport,
} from '../../src/channels/http-client';
import { ChannelFiles } from '../../src/channels/files';
import { TelegramAdapter } from '../../src/channels/telegram';
import { MaxAdapter } from '../../src/channels/max';
import { ChannelError } from '../../src/channels/contracts';

const telegram: ChannelConnection = {
  id: 'telegram-company',
  platform: 'telegram',
  name: 'Компания',
  accountId: '123',
  enabled: true,
  tokenEnv: 'TG_TOKEN',
  token: '123:test-token',
  webhookSecretEnv: 'TG_SECRET',
  webhookSecret: 't'.repeat(32),
};

const max: ChannelConnection = {
  id: 'max-company',
  platform: 'max',
  name: 'Компания',
  accountId: '456',
  enabled: true,
  tokenEnv: 'MAX_TOKEN',
  token: 'max-test-token',
  webhookSecretEnv: 'MAX_SECRET',
  webhookSecret: 'm'.repeat(32),
};

function adapters(transport: ChannelTransport): {
  telegram: TelegramAdapter;
  max: MaxAdapter;
} {
  const http = new ChannelHttp(transport);
  const files = new ChannelFiles(http);

  return { telegram: new TelegramAdapter(http, files), max: new MaxAdapter(http, files) };
}

function telegramEvent(): object {
  return {
    update_id: 1,
    message: {
      message_id: 2,
      date: 1792100000,
      chat: { id: 100, type: 'private' },
      from: { id: 100, is_bot: false, first_name: 'Иван', last_name: 'Иванов' },
      caption: 'Здравствуйте',
      photo: [
        {
          file_id: 'remote-photo',
          file_unique_id: 'unique-photo',
          width: 100,
          height: 200,
          file_size: 3,
        },
      ],
    },
  };
}

function maxEvent(): object {
  return {
    update_type: 'message_created',
    message: {
      sender: { user_id: 100, is_bot: false, first_name: 'Иван', last_name: 'Иванов' },
      recipient: { chat_id: 200, chat_type: 'dialog', user_id: 456 },
      timestamp: 1792100000000,
      body: {
        mid: 'mid.1',
        text: 'Здравствуйте',
        attachments: [
          { type: 'image', payload: { url: 'https://i.oneme.ru/photo.jpg' } },
        ],
      },
    },
  };
}

test('подключения ботов читают токены из окружения, а не из JSON', async (): Promise<void> => {
  const directory = await mkdtemp(join(tmpdir(), 'manager-bot-config-'));

  try {
    const path = join(directory, 'channels.json');
    await writeFile(
      path,
      JSON.stringify([telegram, max].map(({ token, webhookSecret, ...entry }) => entry)),
    );
    const entries = readChannels(path, {
      TG_TOKEN: telegram.token,
      TG_SECRET: telegram.webhookSecret,
      MAX_TOKEN: max.token,
      MAX_SECRET: max.webhookSecret,
    });

    expect(entries).toEqual([telegram, max]);
    expect(() => readChannels(path, { TG_SECRET: telegram.webhookSecret })).toThrow();
    expect(() =>
      readChannels(path, {
        TG_TOKEN: telegram.token,
        TG_SECRET: telegram.webhookSecret,
        MAX_TOKEN: max.token,
        MAX_SECRET: telegram.webhookSecret,
      }),
    ).toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('боты используют только официальные API и проверяемые домены файлов', (): void => {
  expect(
    assertPlatformUrl('telegram', 'https://api.telegram.org/bot123:x/getMe', true)
      .hostname,
  ).toBe('api.telegram.org');
  expect(assertPlatformUrl('max', 'https://platform-api2.max.ru/me', true).hostname).toBe(
    'platform-api2.max.ru',
  );
  expect(assertPlatformUrl('max', 'https://fd.oneme.ru/upload').hostname).toBe(
    'fd.oneme.ru',
  );

  for (const address of [
    'http://platform-api2.max.ru',
    'https://platform-api.max.ru/me',
    'https://platform-api2.max.ru.attacker.test',
    'https://secret@platform-api2.max.ru',
    'https://127.0.0.1',
  ])
    expect(() => assertPlatformUrl('max', address, true)).toThrow();

  expect(() =>
    assertPlatformUrl('telegram', 'https://api.telegram.org.attacker.test/file'),
  ).toThrow();
  expect(() =>
    assertPlatformUrl('max', 'https://fd.oneme.ru.attacker.test/file'),
  ).toThrow();
});

test('Telegram сохраняет file_id и текст фото без URL с секретом бота', async (): Promise<void> => {
  const bot = adapters(async (): Promise<Response> => {
    throw new Error('Сеть не нужна');
  }).telegram;
  const message = await bot.incoming(telegram, telegramEvent());

  expect(message).toMatchObject({
    conversationId: '100',
    userId: '100',
    messageId: '2',
    text: 'Здравствуйте',
    author: 'Иван Иванов',
    source: { channel: 'telegram' },
    files: [{ providerFileId: 'remote-photo', id: 'unique-photo' }],
  });
  expect(JSON.stringify(message)).not.toContain(telegram.token!);
  expect(message?.files[0].url).toBeUndefined();
  expect(await bot.incoming(telegram, { update_id: 2 })).toBeNull();

  for (const changes of [
    { chat: { id: 100, type: 'group' } },
    { from: { id: 100, is_bot: true, first_name: 'Бот' } },
    { chat: { id: 99, type: 'private' } },
  ]) {
    const event = telegramEvent() as { message: Record<string, unknown> };

    expect(
      await bot.incoming(telegram, {
        ...event,
        message: { ...event.message, ...changes },
      }),
    ).toBeNull();
  }
});

test('MAX принимает только личные входящие сообщения своего бота', async (): Promise<void> => {
  const bot = adapters(async (): Promise<Response> => {
    throw new Error('Сеть не нужна');
  }).max;

  expect(await bot.incoming(max, maxEvent())).toMatchObject({
    conversationId: '200',
    userId: '100',
    messageId: 'mid.1',
    text: 'Здравствуйте',
    source: { channel: 'max' },
    files: [{ url: 'https://i.oneme.ru/photo.jpg' }],
  });
  expect(await bot.incoming(max, { update_type: 'bot_started' })).toBeNull();

  for (const recipient of [
    { chat_id: 200, chat_type: 'chat', user_id: 456 },
    { chat_id: 200, chat_type: 'dialog', user_id: 999 },
  ]) {
    const event = maxEvent() as { message: Record<string, unknown> };

    expect(
      await bot.incoming(max, { ...event, message: { ...event.message, recipient } }),
    ).toBeNull();
  }
});

test('getFile Telegram получает файл только по временному адресу в памяти', async (): Promise<void> => {
  const calls: string[] = [];
  const bot = adapters(async (url): Promise<Response> => {
    calls.push(url.pathname);

    return url.pathname.endsWith('/getFile')
      ? Response.json({
          ok: true,
          result: { file_path: 'photos/file_1.jpg', file_size: 3 },
        })
      : new Response('abc');
  }).telegram;
  const message = await bot.incoming(telegram, telegramEvent());
  const content = await bot.receive(
    telegram,
    message!.files[0],
    async (file): Promise<string> => (await readFile(file.path)).toString(),
  );

  expect(content).toBe('abc');
  expect(calls).toEqual([
    '/bot123:test-token/getFile',
    '/file/bot123:test-token/photos/file_1.jpg',
  ]);
  expect(JSON.stringify(message)).not.toContain('test-token');
});

test('неподдерживаемые вложения остаются видимыми оператору текстом', async (): Promise<void> => {
  const bots = adapters(async (): Promise<Response> => {
    throw new Error();
  });
  const tg = telegramEvent() as { message: Record<string, unknown> };
  const mx = maxEvent() as { message: Record<string, unknown> };

  expect(
    (
      await bots.telegram.incoming(telegram, {
        ...tg,
        message: { ...tg.message, photo: undefined, voice: {} },
      })
    )?.text,
  ).toContain('исходной переписке Telegram');
  expect(
    (
      await bots.max.incoming(max, {
        ...mx,
        message: {
          ...mx.message,
          body: {
            mid: '2',
            text: null,
            attachments: [
              { type: 'video', payload: { url: 'https://fd.oneme.ru/video' } },
            ],
          },
        },
      })
    )?.text,
  ).toContain('исходной переписке MAX');
});

test('подписки проверяют аккаунт и передают секрет в штатном поле API', async (): Promise<void> => {
  const calls: Array<{ url: URL; body: Record<string, unknown>; auth: string | null }> =
    [];
  const bots = adapters(async (url, init): Promise<Response> => {
    const body =
      typeof init.body === 'string'
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : {};
    calls.push({ url, body, auth: new Headers(init.headers).get('authorization') });

    if (url.pathname.endsWith('/getMe'))
      return Response.json({ ok: true, result: { id: 123, is_bot: true } });
    if (url.pathname === '/me') return Response.json({ user_id: 456, is_bot: true });

    return Response.json(
      url.pathname.endsWith('/setWebhook')
        ? { ok: true, result: true }
        : { success: true },
    );
  });
  await bots.telegram.subscribe(
    telegram,
    'https://manager.pksep.ru/v1/channels/telegram/telegram-company',
  );
  await bots.max.subscribe(max, 'https://manager.pksep.ru/v1/channels/max/max-company');

  expect(calls[1].body).toMatchObject({
    secret_token: telegram.webhookSecret,
    allowed_updates: ['message'],
    drop_pending_updates: false,
  });
  expect(calls[3].body).toMatchObject({
    secret: max.webhookSecret,
    update_types: ['message_created'],
  });
  expect(calls[3].auth).toBe(max.token!);
  expect(calls[3].url.search).toBe('');
});

test('ключ другого бота не регистрирует webhook', async (): Promise<void> => {
  let calls = 0;
  const bots = adapters(async (url): Promise<Response> => {
    calls++;

    return Response.json(
      url.hostname === 'api.telegram.org'
        ? { ok: true, result: { id: 999, is_bot: true } }
        : { user_id: 999, is_bot: true },
    );
  });

  await expect(
    bots.telegram.subscribe(telegram, 'https://manager.pksep.ru/'),
  ).rejects.toMatchObject({ code: 'TELEGRAM_ACCOUNT_MISMATCH' });
  await expect(
    bots.max.subscribe(max, 'https://manager.pksep.ru/'),
  ).rejects.toMatchObject({ code: 'MAX_ACCOUNT_MISMATCH' });
  expect(calls).toBe(2);
});

test('Telegram возвращает ID отправки без HTML-разметки', async (): Promise<void> => {
  const bot = adapters(async (_url, init): Promise<Response> => {
    expect(JSON.parse(String(init.body))).toEqual({ chat_id: '100', text: '<текст>' });

    return Response.json({ ok: true, result: { message_id: 42 } });
  }).telegram;

  expect(await bot.send(telegram, '100', '<текст>')).toBe('42');
});

test('крупное фото и фото с неподдерживаемыми пропорциями уходят в Telegram как документ', async (): Promise<void> => {
  const urls: string[] = [];
  const upload = spyOn(ChannelFiles.prototype, 'upload').mockImplementation(
    async (_platform, address): Promise<unknown> => {
      urls.push(new URL(address).pathname.split('/').at(-1)!);

      if (address.includes('/sendPhoto')) throw new ChannelError('CHANNEL_HTTP_400');

      return { ok: true, result: { message_id: 5 } };
    },
  );
  const stream = Readable.from([]);
  const file: Express.Multer.File = {
    fieldname: 'file',
    originalname: 'photo.png',
    encoding: '7bit',
    mimetype: 'image/png',
    size: 11 * 1024 * 1024,
    path: 'unused',
    destination: '',
    filename: 'photo.png',
    stream,
    buffer: Buffer.alloc(0),
  };

  try {
    const bot = adapters(async (): Promise<Response> => {
      throw new Error('Сеть не нужна');
    }).telegram;

    expect(await bot.sendFile(telegram, '100', file)).toBe('5');
    expect(await bot.sendFile(telegram, '100', { ...file, size: 100 })).toBe('5');
    expect(urls).toEqual(['sendDocument', 'sendPhoto', 'sendDocument']);
  } finally {
    upload.mockRestore();
    stream.destroy();
  }
});

test('429 повторяется с задержкой, MAX attachment.not.ready не означает отправку', async (): Promise<void> => {
  const bots = adapters(
    async (url): Promise<Response> =>
      url.hostname === 'api.telegram.org'
        ? Response.json(
            {
              ok: false,
              error_code: 429,
              description: 'secret',
              parameters: { retry_after: 7 },
            },
            { status: 429 },
          )
        : Response.json(
            { code: 'attachment.not.ready', message: 'secret' },
            { status: 400 },
          ),
  );

  await expect(bots.telegram.send(telegram, '100', 'test')).rejects.toMatchObject({
    code: 'TELEGRAM_HTTP_429',
    retryable: true,
    uncertain: false,
    retryAfter: 7,
  });
  await expect(bots.max.send(max, '200', 'test')).rejects.toMatchObject({
    code: 'MAX_ATTACHMENT_NOT_READY',
    retryable: true,
    uncertain: false,
  });
});

test('потерянный или некорректный ответ отправки требует проверки, а не слепого повтора', async (): Promise<void> => {
  for (const transport of [
    async (): Promise<Response> => {
      throw new Error('token=secret');
    },
    async (): Promise<Response> => Response.json({}),
    async (): Promise<Response> => new Response('<html>secret</html>'),
    async (): Promise<Response> => new Response('', { status: 503 }),
  ]) {
    const bots = adapters(transport);

    await expect(bots.telegram.send(telegram, '100', 'test')).rejects.toMatchObject({
      uncertain: true,
    });
    await expect(bots.max.send(max, '200', 'test')).rejects.toMatchObject({
      uncertain: true,
    });
  }
});

test('Telegram отправляет файл multipart, MAX загружает фото и документ штатными протоколами', async (): Promise<void> => {
  const directory = await mkdtemp(join(tmpdir(), 'manager-bot-upload-'));
  const path = join(directory, 'photo.png');
  await writeFile(path, 'abc');
  const stream = Readable.from(['abc']);
  const file: Express.Multer.File = {
    fieldname: 'file',
    originalname: 'photo.png',
    encoding: '7bit',
    mimetype: 'image/png',
    size: 3,
    path,
    destination: directory,
    filename: 'photo.png',
    stream,
    buffer: Buffer.alloc(0),
  };
  const bots = adapters(async (url, init): Promise<Response> => {
    if (url.pathname.endsWith('/sendPhoto')) {
      expect(url.searchParams.get('chat_id')).toBe('100');
      expect(await new Response(init.body).text()).toContain(
        'name="photo"; filename="photo.png"',
      );

      return Response.json({ ok: true, result: { message_id: 3 } });
    }

    if (url.pathname === '/uploads')
      return Response.json(
        url.searchParams.get('type') === 'image'
          ? { url: 'https://i.oneme.ru/upload' }
          : { url: 'https://fd.oneme.ru/upload', token: 'file-token' },
      );

    if (url.hostname === 'i.oneme.ru') {
      expect(await new Response(init.body).text()).toContain('name="data"');

      return Response.json({ photos: { first: { token: 'image-token' } } });
    }

    if (url.hostname === 'fd.oneme.ru') {
      expect(new Headers(init.headers).get('content-range')).toBe('bytes 0-2/3');
      expect(await new Response(init.body).text()).toBe('abc');

      return new Response('uploaded');
    }

    throw new Error('Неожиданный запрос');
  });

  try {
    expect(await bots.telegram.sendFile(telegram, '100', file)).toBe('3');
    expect(await bots.max.upload(max, file)).toEqual({
      type: 'image',
      payload: { photos: { first: { token: 'image-token' } } },
    });
    expect(await bots.max.upload(max, { ...file, mimetype: 'application/pdf' })).toEqual({
      type: 'file',
      payload: { token: 'file-token' },
    });
  } finally {
    stream.destroy();
    await rm(directory, { recursive: true, force: true });
  }
});
