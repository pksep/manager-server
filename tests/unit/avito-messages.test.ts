import 'reflect-metadata';
import { expect, test } from 'bun:test';
import { AvitoAdapter } from '../../src/channels/avito';
import { ChannelFiles } from '../../src/channels/files';
import { ChannelHttp } from '../../src/channels/http-client';
import type { ChannelConnection } from '../../src/channels/config';

const connection: ChannelConnection = {
  id: 'avito-test',
  platform: 'avito',
  name: 'Тест Авито',
  accountId: '100',
  enabled: true,
  webhookSecretEnv: 'TEST_WEBHOOK_SECRET',
  webhookSecret: 'test-webhook-secret-not-used-in-http',
  clientIdEnv: 'TEST_CLIENT_ID',
  clientSecretEnv: 'TEST_CLIENT_SECRET',
  clientId: 'test-client',
  clientSecret: 'test-secret',
};

const event = {
  id: 'event-1',
  payload: {
    type: 'message',
    value: { id: 'wanted', chat_id: 'chat-1', user_id: '100', author_id: '200' },
  },
};

interface WireMessage {
  id: string;
  author_id: string;
  created: number;
  direction: 'in' | 'out';
  type: string;
  content: { text: string };
}

function message(id = 'wanted'): WireMessage {
  return {
    id,
    author_id: '200',
    created: 1791878400,
    direction: 'in',
    type: 'text',
    content: { text: 'Нужно оборудование' },
  };
}

function fixture(pages: unknown[]): { adapter: AvitoAdapter; calls: URL[] } {
  const calls: URL[] = [];
  const http = new ChannelHttp(async (url): Promise<Response> => {
    calls.push(url);

    if (url.pathname === '/token/')
      return Response.json({ access_token: 'test-access', expires_in: 3600 });

    if (url.pathname.endsWith('/messages/')) {
      const index = Number(url.searchParams.get('offset')) / 100;

      return Response.json(pages[index] ?? { messages: [], meta: {} });
    }

    if (url.pathname === '/messenger/v2/accounts/100/chats/chat-1')
      return Response.json({
        id: 'chat-1',
        users: [{ id: '200', name: 'Посетитель Авито' }],
        context: {
          value: {
            id: '300',
            title: 'Оборудование',
            url: 'https://www.avito.ru/items/300',
          },
        },
      });

    throw new Error('Неожиданный запрос теста');
  });

  return { adapter: new AvitoAdapter(http, new ChannelFiles(http)), calls };
}

test('успешный Avito v3 ответ messages/meta превращается во входящее сообщение', async (): Promise<void> => {
  const { adapter } = fixture([
    { messages: [message()], meta: { cursor: 'opaque-test-value' } },
  ]);
  const result = await adapter.incoming(connection, event);

  expect(result).toMatchObject({
    conversationId: 'chat-1',
    userId: '200',
    messageId: 'wanted',
    author: 'Посетитель Авито',
    text: 'Нужно оборудование',
    files: [],
    source: { channel: 'avito', connectionId: 'avito-test', itemId: '300' },
  });
});

test('метаданные необязательны и не подменяют проверку сообщения', async (): Promise<void> => {
  const { adapter } = fixture([{ messages: [message()] }]);

  expect((await adapter.incoming(connection, event))?.messageId).toBe('wanted');
});

test('ранее поддерживаемый ответ-массив остаётся совместимым', async (): Promise<void> => {
  const { adapter } = fixture([[message()]]);

  expect((await adapter.incoming(connection, event))?.messageId).toBe('wanted');
});

test('поиск по следующим страницам работает внутри messages, не по объекту ответа', async (): Promise<void> => {
  const { adapter, calls } = fixture([
    {
      messages: Array.from({ length: 100 }, (_, index) => message(`other-${index}`)),
      meta: {},
    },
    { messages: [message()], meta: {} },
  ]);

  expect((await adapter.incoming(connection, event))?.messageId).toBe('wanted');
  expect(
    calls
      .filter((url) => url.pathname.endsWith('/messages/'))
      .map((url) => url.searchParams.get('offset')),
  ).toEqual(['0', '100']);
});

test('пустая страница остаётся повторяемой ошибкой поиска без создания диалога', async (): Promise<void> => {
  const { adapter, calls } = fixture([{ messages: [], meta: {} }]);

  await expect(adapter.incoming(connection, event)).rejects.toMatchObject({
    code: 'AVITO_MESSAGE_NOT_FOUND',
    retryable: true,
  });
  expect(calls).toHaveLength(2);
});

for (const [name, response] of [
  ['пустое значение', null],
  ['отсутствует messages', { meta: {} }],
  ['messages не массив', { messages: {} }],
  ['неверное сообщение', { messages: [{ ...message(), author_id: null }] }],
  ['слишком много сообщений', { messages: Array.from({ length: 101 }, () => message()) }],
] as const) {
  test(`ошибочный ответ не проходит проверку: ${name}`, async (): Promise<void> => {
    const { adapter } = fixture([response]);

    await expect(adapter.incoming(connection, event)).rejects.toThrow();
  });
}

test('обёртка messages/meta не разрешает входящее сообщение с чужим автором', async (): Promise<void> => {
  const { adapter } = fixture([
    { messages: [{ ...message(), author_id: '201' }], meta: {} },
  ]);

  await expect(adapter.incoming(connection, event)).rejects.toMatchObject({
    code: 'AVITO_MESSAGE_MISMATCH',
  });
});

test('обёртка messages/meta не превращает исходящее сообщение во входящее', async (): Promise<void> => {
  const { adapter } = fixture([
    { messages: [{ ...message(), direction: 'out' }], meta: {} },
  ]);

  await expect(adapter.incoming(connection, event)).rejects.toMatchObject({
    code: 'AVITO_MESSAGE_MISMATCH',
  });
});
