import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { Pool } from 'pg';
const root = resolve(process.argv[2] || '../.worktrees/manager-erp-server');
if (!existsSync(resolve(root, 'src/modules/contact/manager-contacts.service.ts')))
  throw new Error('Нужна ветка manager сервера ЕРП');
const text = readFileSync('.env.local', 'utf8');
const env = Object.fromEntries(
  text
    .split('\n')
    .filter((line) => line.includes('='))
    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
);
const url = new URL(env.DATABASE_URL);
if (
  url.hostname !== '127.0.0.1' ||
  url.port !== '56441' ||
  url.pathname !== '/manager_local'
)
  throw new Error('Разрешено только изолированное окружение manager');
const db = new Pool({ connectionString: url.toString() });
try {
  if (
    !(await db.query("SELECT 1 FROM pg_database WHERE datname='manager_erp_local'"))
      .rowCount
  )
    await db.query('CREATE DATABASE manager_erp_local');
} finally {
  await db.end();
}
url.pathname = '/manager_erp_local';
const key = env.ERP_MANAGER_KEY || randomBytes(32).toString('hex');
mkdirSync(resolve(root, 'env'), { recursive: true });
writeFileSync(
  resolve(root, 'env/.manager.env'),
  `DATABASE_URL=${url}\nERP_MANAGER_KEY=${key}\nNODE_ENV=manager\nAPPLICATION_TYPE=test\n`,
  { mode: 0o600 },
);
writeFileSync(
  '.env.local',
  text.replace(/^ERP_(SERVICE_URL|MANAGER_KEY)=.*\r?\n?/gm, '').trimEnd() +
    `\nERP_SERVICE_URL=http://127.0.0.1:4502/api\nERP_MANAGER_KEY=${key}\n`,
  { mode: 0o600 },
);
console.log('Подготовлены изолированная база ЕРП и закрытая конфигурация manager.');
