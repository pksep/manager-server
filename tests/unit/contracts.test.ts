import { expect, test } from 'bun:test';
import { SessionRequestSchema, SourceSchema } from '../../src/contracts';
import { normalizeContacts } from '../../src/identity';
import { readConfig } from '../../src/config';

test('подключение ЕРП требует пару настроек и безопасный серверный адрес', () => {
  const env = {
    DATABASE_URL: 'postgresql://localhost/unused',
    CHAT_SERVICE_URL: 'http://127.0.0.1:4501/api',
    CHAT_MANAGER_KEY: 'c'.repeat(32),
    MANAGER_INTERNAL_KEY: 'm'.repeat(32),
  };
  expect(readConfig(env).ERP_SERVICE_URL).toBeUndefined();
  expect(() =>
    readConfig({ ...env, ERP_SERVICE_URL: 'https://erp.example.test/api' }),
  ).toThrow();
  expect(() =>
    readConfig({
      ...env,
      ERP_SERVICE_URL: 'http://erp.example.test/api',
      ERP_MANAGER_KEY: 'e'.repeat(32),
    }),
  ).toThrow();
  expect(() =>
    readConfig({
      ...env,
      ERP_SERVICE_URL: 'https://user:password@erp.example.test/api',
      ERP_MANAGER_KEY: 'e'.repeat(32),
    }),
  ).toThrow();
  expect(
    readConfig({
      ...env,
      ERP_SERVICE_URL: 'http://127.0.0.1:4502/api',
      ERP_MANAGER_KEY: 'e'.repeat(32),
    }).ERP_SERVICE_URL,
  ).toBe('http://127.0.0.1:4502/api');
});

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

test('ключи CAPTCHA обязательны вне локального режима; ссылка ВК появляется только из настройки', () => {
  const env = {
    DATABASE_URL: 'postgresql://localhost/unused',
    CHAT_SERVICE_URL: 'http://127.0.0.1:4501/api',
    CHAT_MANAGER_KEY: 'c'.repeat(32),
    MANAGER_INTERNAL_KEY: 'm'.repeat(32),
  };
  expect(
    readConfig(env).sites.every((site) =>
      site.config.socialLinks.every((link) => link.icon !== 'vk'),
    ),
  ).toBe(true);
  expect(
    readConfig({
      ...env,
      VK_BUSINESS_URL: 'https://vk.com/company',
    }).sites[0].config.socialLinks.some((link) => link.url === 'https://vk.com/company'),
  ).toBe(true);
  expect(() => readConfig({ ...env, HOST: '0.0.0.0' })).toThrow();
  expect(() => readConfig({ ...env, MANAGER_CAPTCHA_MODE: 'required' })).toThrow();
  expect(() =>
    readConfig({ ...env, VK_BUSINESS_URL: 'https://vk.com.attacker.test' }),
  ).toThrow();
});
