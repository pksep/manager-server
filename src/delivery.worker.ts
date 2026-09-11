import {
  Inject,
  Injectable,
  type OnModuleInit,
  type OnModuleDestroy,
} from '@nestjs/common';
import { InquiriesService } from './inquiries.service';

@Injectable()
export class DeliveryWorker implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private stopped = false;
  private pollCursor: string | null = null;
  constructor(@Inject(InquiriesService) private readonly inquiries: InquiriesService) {}
  onModuleInit() {
    this.timer = setInterval(() => {
      void this.tick();
    }, this.inquiries.config.MANAGER_WORKER_MS);
    this.timer.unref();
    void this.tick();
  }
  async onModuleDestroy() {
    this.stopped = true;
    clearInterval(this.timer);
    await this.running;
  }
  /** Восстанавливает незавершённые доставки после перезапуска, сохраняя порядок топика. */
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
  private async run() {
    const db = this.inquiries.database;
    for (let index = 0; index < 20 && !this.stopped; index++) {
      const job = await db.transaction(async (client) => {
        const row = (
          await client.query(`SELECT d.id,d.inquiry_id,d.attempts FROM delivery_operations d JOIN messages m ON m.id=d.id
          WHERE ((d.state='pending' AND d.next_attempt_at<=now()) OR (d.state='working' AND d.locked_until<now()))
          AND NOT EXISTS(SELECT 1 FROM delivery_operations previous JOIN messages pm ON pm.id=previous.id WHERE previous.inquiry_id=d.inquiry_id AND pm.sequence<m.sequence AND previous.state<>'delivered')
          ORDER BY m.sequence FOR UPDATE OF d SKIP LOCKED LIMIT 1`)
        ).rows[0];
        if (!row) return null;
        await client.query(
          "UPDATE delivery_operations SET state='working',attempts=attempts+1,locked_until=now()+interval '30 seconds',updated_at=now() WHERE id=$1",
          [row.id],
        );
        return row;
      });
      if (!job) break;
      try {
        const inquiry = (
          await db.query(
            'SELECT i.*,c.contacts FROM inquiries i JOIN customers c ON c.id=i.customer_id WHERE i.id=$1',
            [job.inquiry_id],
          )
        ).rows[0];
        const message = (await db.query('SELECT * FROM messages WHERE id=$1', [job.id]))
          .rows[0];
        const receipt = await this.inquiries.chat.deliver(inquiry as any, {
          id: message.id,
          html: message.html,
          attachmentIds: message.attachments.map((file: { id: string }) => file.id),
        });
        await db.transaction(async (client) => {
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
      } catch {
        const attempts = job.attempts + 1;
        await db.query(
          "UPDATE delivery_operations SET state=$2,locked_until=NULL,next_attempt_at=now()+$3*interval '1 second',last_error='CHAT_DELIVERY_FAILED',updated_at=now() WHERE id=$1 AND state='working'",
          [job.id, attempts >= 10 ? 'failed' : 'pending', Math.min(60, 2 ** attempts)],
        );
      }
    }
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
