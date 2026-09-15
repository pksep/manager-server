import {
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import {
  connect,
  type ChannelModel,
  type ConfirmChannel,
  type ConsumeMessage,
} from 'amqplib';
import { CONFIG, type Config } from './config';
import { Database } from './database';

const operationTables = {
  delivery: 'delivery_operations',
  erp: 'erp_sync_operations',
  'channel-inbox': 'channel_inbox',
  'channel-outbox': 'channel_outbox',
} as const;

export type OperationKind = keyof typeof operationTables;

const operationKinds = Object.keys(operationTables) as OperationKind[];
type Handler = (id: string) => Promise<'done' | 'retry'>;

/** RabbitMQ доставляет задания, БД сохраняет намерение и результат для восстановления после сбоя публикации. */
@Injectable()
export class OperationQueue implements OnModuleInit, OnModuleDestroy {
  private connection?: ChannelModel;
  private publisher?: ConfirmChannel;
  private readonly handlers = new Map<OperationKind, Handler>();
  private readonly consumers = new Map<OperationKind, ConfirmChannel>();
  private readonly logger = new Logger('ManagerQueue');
  private reconnect?: ReturnType<typeof setTimeout>;
  private recovery?: ReturnType<typeof setInterval>;
  private recovering = false;
  private stopped = false;
  private connecting?: Promise<void>;
  private readonly startingConsumers = new Set<OperationKind>();
  private readonly active = new Set<Promise<void>>();
  private blocked = false;

  constructor(
    @Inject(CONFIG) private readonly config: Config,
    @Inject(Database) private readonly database: Database,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.ensureConnection();
    this.recovery = setInterval(() => {
      void this.recover();
    }, 10000);
    this.recovery.unref();
    void this.recover();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.reconnect);
    clearInterval(this.recovery);
    await this.connection?.close().catch(() => {});
    await Promise.allSettled([...this.active]);
  }

  assertReady(): void {
    if (!this.publisher || this.blocked || this.stopped)
      throw new ServiceUnavailableException('Очередь приёма временно недоступна');
  }

  private queue(kind: OperationKind): string {
    return `${this.config.MANAGER_QUEUE_PREFIX}.${kind}`;
  }

  private async ensureConnection(): Promise<void> {
    if (this.connecting) return this.connecting;
    this.connecting = this.open().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private async open(): Promise<void> {
    if (!this.config.MANAGER_RABBITMQ_URL)
      throw new Error('MANAGER_RABBITMQ_URL не настроен');
    const address = new URL(this.config.MANAGER_RABBITMQ_URL);
    address.searchParams.set('heartbeat', '10');
    const connection = await connect(address.href, { timeout: 5000 });
    if (this.stopped) {
      await connection.close();
      return;
    }
    this.connection = connection;
    this.blocked = false;
    connection.on('blocked', () => {
      this.blocked = true;
    });
    connection.on('unblocked', () => {
      this.blocked = false;
    });
    connection.on('error', () => this.logger.warn({ event: 'rabbitmq_unavailable' }));
    connection.on('close', () => {
      if (this.connection !== connection) return;
      this.publisher = undefined;
      this.connection = undefined;
      this.consumers.clear();
      if (!this.stopped)
        this.reconnect = setTimeout(() => {
          void this.ensureConnection().catch(() => this.scheduleReconnect());
        }, 1000);
    });
    const publisher = await connection.createConfirmChannel();
    publisher.on('error', () => {
      this.publisher = undefined;
      void connection.close().catch(() => {});
    });
    for (const kind of operationKinds) {
      const queue = this.queue(kind);
      await publisher.assertQueue(`${queue}.failed`, {
        durable: true,
        arguments: {
          'x-max-length': this.config.MANAGER_QUEUE_LIMIT,
          'x-message-ttl': 7 * 86400000,
        },
      });
      await publisher.assertQueue(queue, {
        durable: true,
        arguments: {
          'x-max-length': this.config.MANAGER_QUEUE_LIMIT,
          'x-overflow': 'reject-publish',
          'x-dead-letter-exchange': '',
          'x-dead-letter-routing-key': `${queue}.failed`,
        },
      });
      await publisher.assertQueue(`${queue}.retry`, {
        durable: true,
        arguments: {
          'x-message-ttl': 2000,
          'x-dead-letter-exchange': '',
          'x-dead-letter-routing-key': queue,
          'x-max-length': this.config.MANAGER_QUEUE_LIMIT,
          'x-overflow': 'reject-publish',
        },
      });
    }
    this.publisher = publisher;
    for (const [kind, handler] of this.handlers) await this.consume(kind, handler);
  }

  private scheduleReconnect(): void {
    if (!this.stopped)
      this.reconnect = setTimeout(() => {
        void this.ensureConnection().catch(() => this.scheduleReconnect());
      }, 3000);
  }

  /** Обработчик получает только ID: персональные данные остаются в базе сервиса. */
  async register(kind: OperationKind, handler: Handler): Promise<void> {
    this.handlers.set(kind, handler);
    if (this.publisher) await this.consume(kind, handler);
  }

  private async consume(kind: OperationKind, handler: Handler): Promise<void> {
    if (!this.connection || this.consumers.has(kind) || this.startingConsumers.has(kind))
      return;
    this.startingConsumers.add(kind);
    const connection = this.connection;
    try {
      const channel = await connection.createConfirmChannel();
      this.consumers.set(kind, channel);
      channel.on('error', () => {
        void connection.close().catch(() => {});
      });
      await channel.prefetch(1);
      await channel.consume(
        this.queue(kind),
        (message): void => {
          if (message) {
            const work = this.handle(channel, kind, message, handler);
            this.active.add(work);
            void work.finally(() => this.active.delete(work)).catch(() => {});
          }
        },
        { noAck: false },
      );
    } finally {
      this.startingConsumers.delete(kind);
    }
  }

  private async handle(
    channel: ConfirmChannel,
    kind: OperationKind,
    message: ConsumeMessage,
    handler: Handler,
  ): Promise<void> {
    const id = message.content.toString('utf8');
    if (!/^[a-f0-9-]{36}$/.test(id) || message.content.length !== 36) {
      channel.nack(message, false, false);
      return;
    }
    try {
      const result = await handler(id);
      if (result === 'retry') await this.publish(kind, id, true);
      channel.ack(message);
    } catch {
      this.logger.warn({ event: 'operation_deferred', kind });
      // Журнал намерений восстановит задание; немедленный requeue создавал бы горячий цикл.
      try {
        channel.nack(message, false, false);
      } catch {
        /* Канал уже закрыт, брокер вернёт неподтверждённое сообщение. */
      }
    }
  }

  private async publish(kind: OperationKind, id: string, retry = false): Promise<void> {
    this.assertReady();
    const channel = this.publisher!;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('rabbitmq_confirm_timeout'));
        if (this.publisher === channel) {
          this.publisher = undefined;
          void this.connection?.close().catch(() => {});
        }
      }, 5000);
      try {
        channel.sendToQueue(
          this.queue(kind) + (retry ? '.retry' : ''),
          Buffer.from(id),
          { persistent: true, contentType: 'text/plain', messageId: id },
          (error: unknown): void => {
            clearTimeout(timer);
            if (error) reject(error);
            else resolve();
          },
        );
      } catch (error) {
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  /** Вызывается после commit. Ошибка брокера не отменяет уже сохранённое сообщение. */
  async enqueue(kind: OperationKind, id: string): Promise<void> {
    try {
      await this.publish(kind, id);
      const table = operationTables[kind];
      await this.database.query(
        `UPDATE ${table} SET queued_until=now()+interval '60 seconds' WHERE id=$1`,
        [id],
      );
    } catch {
      this.logger.warn({ event: 'outbox_pending', kind });
    }
  }

  /** Переотправляет только намерения без подтверждённой публикации и потерянные аренды. */
  private async recover(): Promise<void> {
    if (this.recovering || !this.publisher || this.stopped) return;
    this.recovering = true;
    try {
      for (const kind of operationKinds) {
        if (!this.handlers.has(kind)) continue;
        const table = operationTables[kind];
        const rows = await this.database.query<{ id: string }>(
          `SELECT id FROM ${table} WHERE ((state='pending' AND next_attempt_at<=now()) OR (state='working' AND locked_until<now())) AND (queued_until IS NULL OR queued_until<now()) ORDER BY next_attempt_at,id LIMIT 100`,
        );
        for (const row of rows.rows) await this.enqueue(kind, row.id);
      }
    } catch {
      this.logger.warn({ event: 'outbox_recovery_failed' });
    } finally {
      this.recovering = false;
    }
  }
}
