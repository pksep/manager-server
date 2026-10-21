import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { Database } from './database';
import { ChatAdapter } from './chat-adapter';

/** Снимает назначения сотрудников без доступа, не создавая сообщений в переписке. */
@Injectable()
export class ManagerAssignmentsWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ManagerAssignmentsWorker.name);
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private stopped = false;

  constructor(
    @Inject(Database) private readonly database: Pick<Database, 'query'>,
    @Inject(ChatAdapter) private readonly chat: Pick<ChatAdapter, 'managerIds'>,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.reconcile().catch(() => {
        this.logger.warn('Проверка назначений отложена до восстановления связи с Чатом');
      });
    }, 10000);
    this.timer.unref();

    void this.reconcile().catch(() => {
      this.logger.warn('Проверка назначений отложена до восстановления связи с Чатом');
    });
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    await this.running?.catch(() => {});
  }

  /** Повтор после сбоя читает актуальные права; параллельные проходы объединяются. */
  reconcile(): Promise<void> {
    if (this.running || this.stopped) return this.running ?? Promise.resolve();

    this.running = this.apply().finally(() => {
      this.running = undefined;
    });

    return this.running;
  }

  private async apply(): Promise<void> {
    const allowedIds = await this.chat.managerIds();

    const result = await this.database.query(
      `UPDATE inquiries
       SET manager_ids=ARRAY(
         SELECT manager_id FROM unnest(manager_ids) AS manager_id
         WHERE manager_id=ANY($1::uuid[])
       ),
       assignee_id=CASE WHEN assignee_id=ANY($1::uuid[]) THEN assignee_id ELSE NULL END,
       manually_assigned=manually_assigned AND EXISTS(
         SELECT 1 FROM unnest(manager_ids) AS manager_id
         WHERE manager_id=ANY($1::uuid[])
       ),
       metadata_version=metadata_version+1
       WHERE (assignee_id IS NOT NULL AND NOT (assignee_id=ANY($1::uuid[])))
         OR EXISTS(
           SELECT 1 FROM unnest(manager_ids) AS manager_id
           WHERE NOT (manager_id=ANY($1::uuid[]))
         )`,
      [allowedIds],
    );

    if (result.rowCount)
      this.logger.log(`Сняты недействующие назначения: ${result.rowCount}`);
  }
}
