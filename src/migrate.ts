import 'reflect-metadata';
import { readConfig } from './config';
import { Database } from './database';
const database = new Database(readConfig());
void database
  .migrate()
  .then(() => console.info('Миграции manager применены'))
  .finally(() => database.onModuleDestroy());
