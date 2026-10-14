import 'reflect-metadata';
import { expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { ContactsSchema, customerDisplayName } from '../../src/contracts';
import { normalizeContacts } from '../../src/identity';
import { ChatAdapter } from '../../src/chat-adapter';
import { readConfig } from '../../src/config';

test('имя необязательно, старые и новые формы сохраняют раздельные контакты', (): void => {
  expect(ContactsSchema.parse({ phone: '+79991234567' })).toEqual({
    name: '',
    phone: '+79991234567',
    email: '',
  });
  expect(ContactsSchema.parse({ email: 'visitor@example.test' })).toEqual({
    name: '',
    phone: '',
    email: 'visitor@example.test',
  });
  expect(
    ContactsSchema.parse({ name: ' Ю ', phone: '', email: 'visitor@example.test' }).name,
  ).toBe('Ю');
  expect(
    customerDisplayName(ContactsSchema.parse({ name: '   ', phone: '+79991234567' })),
  ).toBe('Посетитель сайта');
  expect(
    customerDisplayName(
      ContactsSchema.parse({ name: 'Иван', email: 'visitor@example.test' }),
    ),
  ).toBe('Иван');
  for (const value of [
    { name: 'a'.repeat(101) },
    { name: null },
    { phone: 12 },
    { email: true },
    { actorId: randomUUID() },
  ])
    expect(ContactsSchema.safeParse(value).success).toBe(false);
});

test('одно средство связи принимается при обоих прежних значениях политики', (): void => {
  for (const policy of ['all', 'name-and-one'] as const) {
    expect(
      normalizeContacts(ContactsSchema.parse({ phone: ' +7 (999) 123-45-67 ' }), policy),
    ).toEqual({ phone: '+79991234567', email: '' });
    expect(
      normalizeContacts(
        ContactsSchema.parse({ email: ' Visitor+sales@Example.Test ' }),
        policy,
      ),
    ).toEqual({ phone: '', email: 'visitor+sales@example.test' });
    for (const value of [
      {},
      { phone: '123' },
      { email: 'wrong@' },
      { phone: 'wrong', email: 'valid@example.test' },
    ])
      expect(() => normalizeContacts(ContactsSchema.parse(value), policy)).toThrow();
  }
});

test('пустое имя не уходит в канонический профиль Чата и не меняет контакты посетителя', async (): Promise<void> => {
  const config = readConfig({
    DATABASE_URL: 'postgresql://localhost/unused',
    CHAT_SERVICE_URL: 'http://127.0.0.1:4501/api',
    CHAT_MANAGER_KEY: 'c'.repeat(32),
    MANAGER_INTERNAL_KEY: 'm'.repeat(32),
  });
  const contacts = ContactsSchema.parse({ email: 'visitor@example.test' });
  let body: Record<string, unknown> | undefined;
  const fetchMock = spyOn(globalThis, 'fetch').mockImplementation(
    async (_url, init): Promise<Response> => {
      body = JSON.parse(String(init?.body));

      return Response.json({
        topicId: randomUUID(),
        messageId: randomUUID(),
        sequence: 1,
      });
    },
  );
  try {
    await new ChatAdapter(config).deliver(
      {
        id: randomUUID(),
        session_id: randomUUID(),
        customer_id: randomUUID(),
        contacts,
        source: { channel: 'widget' },
      },
      { id: randomUUID(), html: 'Здравствуйте!', attachmentIds: [] },
    );
    expect(body?.customerName).toBe('Посетитель сайта');
    expect(contacts.name).toBe('');
  } finally {
    fetchMock.mockRestore();
  }
});
