import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Umzug } from 'umzug';
import type { Database } from './database';

const files = [
  '001_initial.sql',
  '002_erp_sync.sql',
  '003_customer_history.sql',
  '004_inquiry_metadata.sql',
  '005_customer_sessions.sql',
  '006_queue_delivery.sql',
  '007_visitor_limits.sql',
  '008_channels.sql',
];

export interface MigrationStatus {
  executed: string[];
  pending: string[];
}

/** Сохраняем прежний журнал версий: обновление работающего стенда не повторяет DDL. */
export async function runMigrations(
  database: Database,
  direction: 'up' | 'down' | 'status',
): Promise<MigrationStatus> {
  return database.transaction(async (db) => {
    await db.query("SELECT pg_advisory_xact_lock(hashtext('manager:migrations'))");
    await db.query(
      'CREATE TABLE IF NOT EXISTS manager_schema_migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const umzug = new Umzug({
      context: db,
      logger: undefined,
      migrations: files.map((name) => ({
        name,
        up: async (): Promise<void> => {
          await db.query(
            await readFile(resolve(__dirname, '../migrations', name), 'utf8'),
          );
        },
        down: async (): Promise<void> => {
          await db.query(
            await readFile(resolve(__dirname, '../migrations/down', name), 'utf8'),
          );
        },
      })),
      storage: {
        executed: async (): Promise<string[]> => {
          const result = await db.query<{ version: number }>(
            'SELECT version FROM manager_schema_migrations ORDER BY version',
          );
          return result.rows.map(({ version }) => {
            const name = files[version - 1];
            if (!name) throw new Error('База использует более новую версию схемы');
            return name;
          });
        },
        logMigration: async ({ name }): Promise<void> => {
          await db.query('INSERT INTO manager_schema_migrations(version) VALUES($1)', [
            files.indexOf(name) + 1,
          ]);
        },
        unlogMigration: async ({ name }): Promise<void> => {
          await db.query('DELETE FROM manager_schema_migrations WHERE version=$1', [
            files.indexOf(name) + 1,
          ]);
        },
      },
    });
    if (direction === 'up') await umzug.up();
    if (direction === 'down') await umzug.down();
    return {
      executed: (await umzug.executed()).map(({ name }) => name),
      pending: (await umzug.pending()).map(({ name }) => name),
    };
  });
}
