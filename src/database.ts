import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { readFile } from 'node:fs/promises';
import { CONFIG, type Config } from './config';

@Injectable()
export class Database implements OnModuleDestroy {
  readonly pool: Pool;
  constructor(@Inject(CONFIG) config: Config) {
    this.pool = new Pool({
      connectionString: config.DATABASE_URL,
      max: 10,
      connectionTimeoutMillis: 3000,
      statement_timeout: 15000,
      idle_in_transaction_session_timeout: 20000,
    });
    this.pool.on('error', () => console.error('Соединение с базой manager потеряно'));
  }
  query<T extends QueryResultRow = QueryResultRow>(sql: string, values: unknown[] = []) {
    return this.pool.query<T>(sql, values);
  }
  async transaction<T>(action: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await action(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  /** Применяет миграции только базы сервиса обращений под общей блокировкой. */
  async migrate() {
    await this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('manager:migrations'))");
      await client.query(
        'CREATE TABLE IF NOT EXISTS manager_schema_migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
      );
      const migrations = [
        '001_initial.sql',
        '002_erp_sync.sql',
        '003_customer_history.sql',
      ];
      for (const [index, file] of migrations.entries()) {
        const version = index + 1;
        const result = await client.query(
          'SELECT version FROM manager_schema_migrations WHERE version=$1',
          [version],
        );
        if (!result.rowCount) {
          await client.query(await readFile(`migrations/${file}`, 'utf8'));
          await client.query(
            'INSERT INTO manager_schema_migrations(version) VALUES ($1)',
            [version],
          );
        }
      }
    });
  }
  async onModuleDestroy() {
    await this.pool.end();
  }
}
