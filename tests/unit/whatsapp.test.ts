import 'reflect-metadata';
import { expect, test } from 'bun:test';
import { mkdtemp, writeFile, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readChannels, type ChannelConnection } from '../../src/channels/config';
import { ChannelFiles } from '../../src/channels/files';
import { ChannelHttp, assertPlatformUrl } from '../../src/channels/http-client';
import { WhatsAppAdapter, whatsAppEvents } from '../../src/channels/whatsapp';

const connection: ChannelConnection = {
  id: 'whatsapp-company',
  platform: 'whatsapp',
  accountId: '12345678901234567',
  businessAccountId: '999',
  apiVersion: 'v25.0',
  name: 'Компания',
  enabled: true,
  tokenEnv: 'WA_TOKEN',
  token: 'local-test-only',
  appSecretEnv: 'WA_APP_SECRET',
  appSecret: 'local-test-app-secret',
  webhookSecretEnv: 'WA_VERIFY_TOKEN',
  webhookSecret: 'v'.repeat(32),
};

function event(type = 'text'): object {
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
              metadata: { phone_number_id: connection.accountId },
              contacts: [{ wa_id: '79990000000', profile: { name: 'Клиент' } }],
              messages: [1, 2].map((id) => ({
                id: `wamid.${id}`,
                from: '79990000000',
                timestamp: String(Math.floor(Date.now() / 1000)),
                type,
                text: { body: 'Тест' },
                image: { id: '111', mime_type: 'image/png' },
              })),
            },
          },
        ],
      },
    ],
  };
}

test('WhatsApp разбивает пакет на отдельные сообщения и выбирает контакт по wa_id', (): void => {
  const http = new ChannelHttp(async (): Promise<Response> => {
    throw new Error('Сеть не нужна');
  });
  const adapter = new WhatsAppAdapter(http, new ChannelFiles(http));
  const events = whatsAppEvents(connection, event('image'));
  expect(events).toHaveLength(2);
  const message = adapter.incoming(connection, events[0]);
  expect(message?.messageId).toBe('wamid.1');
  expect(message?.contacts?.phone).toBe('+79990000000');
  expect(message?.files[0].providerFileId).toBe('111');
  expect(JSON.stringify(message)).not.toContain(connection.token!);
  expect(whatsAppEvents(connection, event('reaction'))).toEqual([]);
  expect(whatsAppEvents({ ...connection, accountId: '456' }, event())).toEqual([]);
  expect(whatsAppEvents({ ...connection, businessAccountId: '456' }, event())).toEqual(
    [],
  );
});

test('WhatsApp статусы не превращаются во входящие сообщения', (): void => {
  expect(
    whatsAppEvents(connection, {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: '999',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { phone_number_id: connection.accountId },
                statuses: [{ id: 'wamid.1', status: 'read' }],
              },
            },
          ],
        },
      ],
    }),
  ).toEqual([]);
});

test('WhatsApp отправляет ответ на нужный номер без токена в URL и классифицирует закрытое окно', async (): Promise<void> => {
  let fail = false;
  const http = new ChannelHttp(async (url, init): Promise<Response> => {
    expect(url.hostname).toBe('graph.facebook.com');
    expect(url.href).not.toContain(connection.token!);
    expect(new Headers(init.headers).get('authorization')).toBe(
      `Bearer ${connection.token}`,
    );
    expect(JSON.parse(String(init.body)).to).toBe('79990000000');

    return fail
      ? Response.json(
          { error: { code: 131047, message: 'Не журналировать' } },
          { status: 400 },
        )
      : Response.json({ messages: [{ id: 'wamid.sent' }] });
  });
  const adapter = new WhatsAppAdapter(http, new ChannelFiles(http));
  expect(await adapter.send(connection, '79990000000', 'Ответ')).toBe('wamid.sent');
  fail = true;
  await expect(adapter.send(connection, '79990000000', 'Ответ')).rejects.toMatchObject({
    code: 'WHATSAPP_WINDOW_EXPIRED',
    retryable: false,
    uncertain: false,
  });
});

test('WhatsApp защищает адреса скачивания и не пересылает токен по redirect', async (): Promise<void> => {
  let calls = 0;
  const http = new ChannelHttp(async (): Promise<Response> => {
    calls++;
    return Response.json({
      id: '111',
      url: 'https://attacker.test/file',
      mime_type: 'image/png',
      file_size: 2,
    });
  });
  const adapter = new WhatsAppAdapter(http, new ChannelFiles(http));
  await expect(
    adapter.receive(
      connection,
      { id: '111', providerFileId: '111', name: 'x.png', mime: 'image/png' },
      async (): Promise<void> => {},
    ),
  ).rejects.toMatchObject({ code: 'CHANNEL_ADDRESS_DENIED' });
  expect(calls).toBe(1);
  expect(() =>
    assertPlatformUrl('whatsapp', 'https://graph.facebook.com.attacker.test/', true),
  ).toThrow();
});

test('WhatsApp конфигурация требует секрет приложения, допускает длинный phone_number_id и выключенные записи', async (): Promise<void> => {
  const directory = await mkdtemp(join(tmpdir(), 'wa-config-'));
  const path = join(directory, 'channels.json');
  try {
    await writeFile(path, JSON.stringify([connection]));
    expect(() =>
      readChannels(path, { WA_TOKEN: 'token', WA_VERIFY_TOKEN: 'v'.repeat(32) }),
    ).toThrow();
    expect(
      readChannels(path, {
        WA_TOKEN: 'token',
        WA_VERIFY_TOKEN: 'v'.repeat(32),
        WA_APP_SECRET: 's'.repeat(32),
      })[0].accountId,
    ).toBe(connection.accountId);
    await writeFile(path, JSON.stringify([{ ...connection, enabled: false }]));
    expect(readChannels(path, {})[0].enabled).toBe(false);
  } finally {
    await rm(path, { force: true });
    await rmdir(directory);
  }
});
