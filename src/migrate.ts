import 'reflect-metadata';
import { readConfig } from './config';
import { Database } from './database';
const database = new Database(
  readConfig({
    ...process.env,
    DATABASE_URL: process.env.MANAGER_MIGRATION_DATABASE_URL || process.env.DATABASE_URL,
  }),
);
const direction = process.argv[2] || 'up';
if (!['up', 'down', 'status'].includes(direction))
  throw new Error('Ожидается up, down или status');
void database
  .migrate(direction as 'up' | 'down' | 'status')
  .then((status) => console.info(JSON.stringify(status)))
  .catch(() => {
    console.error('Миграция не выполнена; транзакция отменена');
    process.exitCode = 1;
  })
  .finally(() => database.onModuleDestroy());
