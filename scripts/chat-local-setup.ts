import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { createRequire } from 'node:module';
const chatRoot = resolve(process.argv[2] || '../.worktrees/manager-chat-server');
if (!existsSync(resolve(chatRoot, 'src/modules/manager/manager.module.ts')))
  throw new Error('Нужна ветка manager сервера чата');
const vapid = createRequire(resolve(chatRoot, 'package.json'))(
  'web-push',
).generateVAPIDKeys();
const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
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
if (
  !(await db.query("SELECT 1 FROM pg_database WHERE datname='manager_chat_local'"))
    .rowCount
)
  await db.query('CREATE DATABASE manager_chat_local');
await db.end();
url.pathname = '/manager_chat_local';
const values = {
  NODE_ENV: 'manager',
  PORT: '4501',
  APPLICATION_TYPE: 'test',
  DATABASE_URL: url.toString(),
  REDIS_URL: 'redis://127.0.0.1:56394',
  RABBITMQ_URL: `amqp://manager-local:${env.LOCAL_POSTGRES_PASSWORD}@127.0.0.1:55675`,
  JWT_SECRET: env.CHAT_JWT_SECRET,
  PRIVATE_KEY: env.CHAT_JWT_SECRET,
  ADMIN_PASSWORD: env.CHAT_JWT_SECRET,
  VAPID_PUBLIC_KEY: vapid.publicKey,
  VAPID_PRIVATE_KEY: vapid.privateKey,
  VAPID_MAIL_TO: 'mailto:manager-local@example.test',
  SERVICE_API_KEY: env.MANAGER_INTERNAL_KEY,
  CHAT_MANAGER_KEY: env.CHAT_MANAGER_KEY,
  CHAT_MANAGER_ACCESS_KEY: env.CHAT_MANAGER_ACCESS_KEY,
  MANAGER_SERVICE_URL: 'http://127.0.0.1:4314',
  MANAGER_INTERNAL_KEY: env.MANAGER_INTERNAL_KEY,
  CHAT_DATA_ENCRYPTION_KEY: env.CHAT_DATA_ENCRYPTION_KEY,
  KAFKA_DISABLED: 'true',
  FIREBASE_DISABLED: 'true',
  INIT_SEP: 'false',
  MINIO_ROOT_USER: 'manager-local',
  MINIO_ROOT_PASSWORD: env.LOCAL_MINIO_PASSWORD,
  MINIO_BUCKET_NAME: 'manager-chat',
  MINIO_ENDPOINT: '127.0.0.1',
  MINIO_PORT: '59008',
  MINIO_USE_SSL: 'false',
  MINIO_PATH_STYLE: 'true',
  MINIO_PUBLIC_BASE_URL: 'http://127.0.0.1:59008',
  MINIO_LOCAL_BASE_URL: 'http://127.0.0.1:59008',
  VITE_CHAT_API_DOMAIN: 'http://127.0.0.1:4501/api',
  VITE_CHAT_WS_DOMAIN: 'http://127.0.0.1:4501',
  VITE_PATH_TO_FILE_CDN: 'http://127.0.0.1:4501/api/media/object',
  VITE_AUTH_API: 'http://127.0.0.1:4502',
  VITE_ERP_URL: 'http://127.0.0.1:4502',
  VITE_MASTRA_URL: 'http://127.0.0.1:4503',
  ALLOWED_ORIGIN: 'http://127.0.0.1:4310,http://127.0.0.1:5173',
};
mkdirSync(resolve(chatRoot, 'env'), { recursive: true });
writeFileSync(
  resolve(chatRoot, 'env/.manager.env'),
  Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n') + '\n',
  { mode: 0o600 },
);
// URL включает принятый в СЭП Чате префикс /api.
writeFileSync(
  '.env.local',
  readFileSync('.env.local', 'utf8').replace(
    /^CHAT_SERVICE_URL=.*$/m,
    'CHAT_SERVICE_URL=http://127.0.0.1:4501/api',
  ),
);
console.log('Созданы отдельная база чата и локальная конфигурация; ключи не выводятся.');
