import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readConfig } from '../../src/config';
import type { Site } from '../../src/contracts';

const directory = mkdtempSync(join(tmpdir(), 'manager-support-config-'));
const path = join(directory, 'sites.json');
const profile = JSON.parse(
  readFileSync('config/support.example.json', 'utf8'),
)[0] as Site;
const env = {
  DATABASE_URL: 'postgresql://localhost/unused',
  CHAT_SERVICE_URL: 'http://127.0.0.1:4501/api',
  CHAT_MANAGER_KEY: 'c'.repeat(32),
  MANAGER_INTERNAL_KEY: 'm'.repeat(32),
  MANAGER_SITES_PATH: path,
  MANAGER_SUPPORT_SMART_PRESS_TULA_KEY: 's'.repeat(32),
};

afterAll((): void => {
  if (!directory.startsWith(join(tmpdir(), 'manager-support-config-')))
    throw new Error('Неверный тестовый каталог');

  rmSync(directory, { recursive: true });
});

test('ключ поддержки хранится отдельно от публичной конфигурации виджета', (): void => {
  writeFileSync(path, JSON.stringify([profile]));
  const result = readConfig(env);

  expect(result.supportKeys['smart-press-tula']).toBe(
    env.MANAGER_SUPPORT_SMART_PRESS_TULA_KEY,
  );
  expect(JSON.stringify(result.sites)).not.toContain(
    env.MANAGER_SUPPORT_SMART_PRESS_TULA_KEY,
  );
  expect(() =>
    readConfig({ ...env, MANAGER_SUPPORT_SMART_PRESS_TULA_KEY: 'short' }),
  ).toThrow();
  expect(() =>
    readConfig({ ...env, MANAGER_SUPPORT_SMART_PRESS_TULA_KEY: undefined }),
  ).toThrow();
});

test('один клиент не может иметь несколько профилей или несколько origin виджета', (): void => {
  writeFileSync(path, JSON.stringify([profile, { ...profile, id: 'duplicate-profile' }]));
  expect(() => readConfig(env)).toThrow();
  writeFileSync(
    path,
    JSON.stringify([
      { ...profile, widgetOrigins: ['http://127.0.0.1:44310', 'http://127.0.0.1:44311'] },
    ]),
  );
  expect(() => readConfig(env)).toThrow();
});
