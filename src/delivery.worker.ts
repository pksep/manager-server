import {
  Inject,
  Injectable,
  Logger,
  type OnModuleInit,
  type OnModuleDestroy,
} from '@nestjs/common';
import { InquiriesService, type MessageRow } from './inquiries.service';
import type { Contacts } from './contracts';
import { deliveryFailure } from './delivery-policy';

type DeliveryDependencies = Pick<
  InquiriesService,
  'database' | 'queue' | 'config' | 'chat' | 'acceptEvents'
>;

interface DeliveryJob {
  id: string;
  inquiry_id: string;
  attempts: number;
}

interface DeliveryInquiry {
  id: string;
  customer_id: string;
  contacts: Contacts;
}

@Injectable()
export class DeliveryWorker implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private stopped = false;
  private pollCursor: string | null = null;
  private readonly logger = new Logger('ManagerDelivery');

  constructor(
    @Inject(InquiriesService) private readonly inquiries: DeliveryDependencies,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.inquiries.queue.register('delivery', (id) => this.process(id));

    this.timer = setInterval(() => {
      void this.tick();
    }, this.inquiries.config.MANAGER_WORKER_MS);
    this.timer.unref();
    void this.tick();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    await this.running;
  }

  /** Получает ответы и отметки прочтения из канонической истории Чата. */
  tick(): Promise<void> {
    if (this.running || this.stopped) return this.running ?? Promise.resolve();

    this.running = this.run()
      .catch(() => {
        /* Следующий проход повторит недоступную базу/интеграцию. */
      })
      .finally(() => {
        this.running = undefined;
      });

    return this.running;
  }

  private async process(operationId: string): Promise<'done' | 'retry'> {
    const db = this.inquiries.database;

    const job = await db.transaction(async (client): Promise<DeliveryJob | null> => {
      const row = (
        await client.query<DeliveryJob>(
          `SELECT d.id,d.inquiry_id,d.attempts FROM delivery_operations d JOIN messages m ON m.id=d.id
          WHERE d.id=$1 AND ((d.state='pending' AND d.next_attempt_at<=now()) OR (d.state='working' AND d.locked_until<now()))
          AND NOT EXISTS(SELECT 1 FROM delivery_operations previous JOIN messages pm ON pm.id=previous.id WHERE previous.inquiry_id=d.inquiry_id AND pm.sequence<m.sequence AND previous.state IN ('pending','working'))
          ORDER BY m.sequence FOR UPDATE OF d SKIP LOCKED LIMIT 1`,
          [operationId],
        )
      ).rows[0];

      if (!row) return null;

      await client.query(
        "UPDATE delivery_operations SET state='working',attempts=attempts+1,locked_until=now()+interval '30 seconds',updated_at=now() WHERE id=$1",
        [row.id],
      );

      return row;
    });

    if (!job) {
      const existing = await db.query<{ state: string }>(
        'SELECT state FROM delivery_operations WHERE id=$1',
        [operationId],
      );

      return ['pending', 'working'].includes(existing.rows[0]?.state) ? 'retry' : 'done';
    }

    try {
      const inquiry = (
        await db.query<DeliveryInquiry>(
          'SELECT i.*,c.contacts FROM inquiries i JOIN customers c ON c.id=i.customer_id WHERE i.id=$1',
          [job.inquiry_id],
        )
      ).rows[0];

      const message = (
        await db.query<MessageRow>('SELECT * FROM messages WHERE id=$1', [job.id])
      ).rows[0];
      const session = (
        await db.query<{ source: unknown }>(
          'SELECT source FROM reply_routes WHERE id=$1',
          [message.session_id],
        )
      ).rows[0];

      const receipt = await this.inquiries.chat.deliver(
        { ...inquiry, session_id: message.session_id, source: session.source },
        {
          id: message.id,
          html: message.html,
          attachmentIds: message.attachments.map((file) => file.id),
        },
      );

      await db.transaction(async (client): Promise<void> => {
        const bound = await client.query(
          'UPDATE inquiries SET topic_id=$2 WHERE id=$1 AND (topic_id IS NULL OR topic_id=$2) RETURNING id',
          [inquiry.id, receipt.topicId],
        );

        if (!bound.rowCount) throw new Error('Связь обращения с топиком изменилась');

        await client.query('UPDATE messages SET chat_message_id=$2 WHERE id=$1', [
          job.id,
          receipt.messageId,
        ]);
        await client.query(
          "UPDATE delivery_operations SET state='delivered',locked_until=NULL,last_error=NULL,updated_at=now() WHERE id=$1",
          [job.id],
        );
      });

      return 'done';
    } catch (cause) {
      const attempts = job.attempts + 1;
      const failure = deliveryFailure(cause, attempts);

      await db.query(
        "UPDATE delivery_operations SET state=$2,locked_until=NULL,next_attempt_at=now()+$3*interval '1 second',last_error=$4,updated_at=now() WHERE id=$1 AND state='working'",
        [job.id, failure.state, failure.delaySeconds, failure.code],
      );

      this.logger.warn({
        event:
          failure.state === 'failed' ? 'chat_message_rejected' : 'chat_delivery_deferred',
        operationId: job.id,
        attempts,
      });

      return failure.state === 'pending' ? 'retry' : 'done';
    }
  }

  private async run(): Promise<void> {
    const db = this.inquiries.database;
    const inquiries = await db.query(
      'SELECT id,chat_cursor FROM inquiries WHERE topic_id IS NOT NULL AND status=$1 AND ($2::uuid IS NULL OR id>$2::uuid) ORDER BY id LIMIT 50',
      ['OPEN', this.pollCursor],
    );

    this.pollCursor = inquiries.rows.at(-1)?.id ?? null;

    for (const inquiry of inquiries.rows) {
      if (this.stopped) break;

      try {
        const events = await this.inquiries.chat.events(
          inquiry.id,
          String(inquiry.chat_cursor),
        );
        await this.inquiries.acceptEvents(inquiry.id, events);
      } catch {
        /* Курсор остаётся прежним: пропуск или сбой будут перечитаны. */
      }
    }
  }
}
