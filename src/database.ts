import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Sequelize, type Transaction } from 'sequelize';
import type { QueryResultRow } from 'pg';
import { CONFIG, type Config } from './config';
import { defineModels } from './models';
import { runMigrations, type MigrationStatus } from './migrations';

export interface DatabaseResult<T> {
  rows: T[];
  rowCount: number;
}

export interface DatabaseTransaction {
  transaction: Transaction;
  models: ReturnType<typeof defineModels>;
  query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    values?: unknown[],
  ): Promise<DatabaseResult<T>>;
}

@Injectable()
export class Database implements OnModuleDestroy {
  readonly sequelize: Sequelize;
  readonly models: ReturnType<typeof defineModels>;

  constructor(@Inject(CONFIG) config: Config) {
    this.sequelize = new Sequelize(config.DATABASE_URL, {
      dialect: 'postgres',
      logging: false,
      pool: { max: 10, min: 0, acquire: 3000, idle: 10000 },
      dialectOptions: {
        connectionTimeoutMillis: 3000,
        statement_timeout: 15000,
        idle_in_transaction_session_timeout: 20000,
      },
      retry: { max: 0 },
    });
    this.models = defineModels(this.sequelize);
  }

  /** Параметризованный SQL оставлен для блокировок и составных выборок. */
  async query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    values: unknown[] = [],
    transaction?: Transaction,
  ): Promise<DatabaseResult<T>> {
    const [rows, metadata] = await this.sequelize.query(sql, {
      ...(values.length ? { bind: values } : {}),
      transaction,
      raw: true,
    });
    const count =
      metadata && typeof metadata === 'object' && 'rowCount' in metadata
        ? Number(metadata.rowCount)
        : rows.length;
    return { rows: rows as T[], rowCount: Number.isFinite(count) ? count : rows.length };
  }

  /** ORM владеет commit/rollback, все вложенные операции используют одну транзакцию. */
  async transaction<T>(action: (client: DatabaseTransaction) => Promise<T>): Promise<T> {
    return this.sequelize.transaction((transaction) =>
      action({
        transaction,
        models: this.models,
        query: <R extends QueryResultRow = QueryResultRow>(
          sql: string,
          values: unknown[] = [],
        ): Promise<DatabaseResult<R>> => this.query<R>(sql, values, transaction),
      }),
    );
  }

  /** Штатные up/down/status не запускаются из HTTP-приложения. */
  async migrate(direction: 'up' | 'down' | 'status' = 'up'): Promise<MigrationStatus> {
    return runMigrations(this, direction);
  }

  async onModuleDestroy(): Promise<void> {
    await this.sequelize.close();
  }
}
