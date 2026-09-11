import { existsSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
const secret = () => randomBytes(32).toString('hex');
if (existsSync('.env.local'))
  throw new Error('.env.local уже существует; действующие ключи сохранены');
const password = secret();
writeFileSync(
  '.env.local',
  [
    'HOST=127.0.0.1',
    'PORT=4314',
    `DATABASE_URL=postgres://manager_local:${password}@127.0.0.1:56441/manager_local`,
    `LOCAL_POSTGRES_PASSWORD=${password}`,
    `LOCAL_MINIO_PASSWORD=${secret()}`,
    `MANAGER_INTERNAL_KEY=${secret()}`,
    `CHAT_MANAGER_KEY=${secret()}`,
    `CHAT_MANAGER_ACCESS_KEY=${secret()}`,
    `CHAT_JWT_SECRET=${secret()}`,
    `CHAT_DATA_ENCRYPTION_KEY=${secret()}`,
    'CHAT_SERVICE_URL=http://127.0.0.1:4501',
    'MANAGER_SITES_PATH=config/sites.example.json',
    'MANAGER_QUEUE_LIMIT=10000',
    'MANAGER_SESSION_HOURS=24',
    'MANAGER_WORKER_MS=250',
    '',
  ].join('\n'),
  { mode: 0o600 },
);
console.log('Создан .env.local с отдельными локальными ключами. Значения не выводятся.');
