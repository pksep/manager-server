import { expect, test } from 'bun:test';
import { SessionRequestSchema, SourceSchema } from '../../src/contracts';
import { normalizeContacts } from '../../src/identity';

test('пустой referrer допустим, неверный URL возвращает ошибку проверки без исключения', () => {
  const source = {
    pageUrl: 'https://example.test/catalog',
    title: '',
    referrerOrigin: '',
  };
  expect(SourceSchema.safeParse(source).success).toBe(true);
  expect(SourceSchema.safeParse({ ...source, pageUrl: 'not a url' }).success).toBe(false);
  expect(
    SourceSchema.safeParse({
      ...source,
      pageUrl: 'https://user:password@example.test',
    }).success,
  ).toBe(false);
  expect(
    SessionRequestSchema.safeParse({
      siteId: 'test',
      source,
      actorId: 'forged',
    }).success,
  ).toBe(false);
});

test('контакты приводятся к сопоставимому виду без удаления частей email или догадок о стране', () => {
  expect(
    normalizeContacts(
      {
        name: 'Иван',
        phone: '+7 (999) 123-45-67',
        email: 'Ivan+sales@Example.Test',
      },
      'all',
    ),
  ).toEqual({
    phone: '+79991234567',
    email: 'ivan+sales@example.test',
  });
  expect(() =>
    normalizeContacts({ name: 'Иван', phone: '123', email: 'test@example.test' }, 'all'),
  ).toThrow();
});
