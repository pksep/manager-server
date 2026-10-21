import { expect, test } from 'bun:test';
import { readConfig } from '../../src/config';

test('публичная конфигурация передаёт правильное имя отправителя приветствия', (): void => {
  const config = readConfig({
    DATABASE_URL: 'postgresql://localhost/unused',
    CHAT_SERVICE_URL: 'http://127.0.0.1:4501/api',
    CHAT_MANAGER_KEY: 'c'.repeat(32),
    MANAGER_INTERNAL_KEY: 'm'.repeat(32),
  });

  expect(
    config.sites.find((site) => site.id === 'amotiv-demo')?.config.company.name,
  ).toBe('НПО Автомотив');
});
