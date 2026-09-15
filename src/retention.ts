import {
  Inject,
  Injectable,
  type OnModuleInit,
  type OnModuleDestroy,
} from '@nestjs/common';
import { InquiriesService } from './inquiries.service';
import { readdir, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname, basename } from 'node:path';

/** Удаляет только неотправленные файлы истёкших сессий, ограниченными пачками. */
@Injectable()
export class RetentionWorker implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private pending?: Promise<void>;

  constructor(@Inject(InquiriesService) private readonly inquiries: InquiriesService) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.tick();
    }, 60000);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.timer);
    await this.pending;
  }

  async tick(): Promise<void> {
    if (this.pending) return this.pending;
    this.pending = this.cleanup()
      .catch(() => this.inquiries.security.audit('retention_failed'))
      .finally(() => {
        this.pending = undefined;
      });
    await this.pending;
  }

  private async cleanup(): Promise<void> {
    await this.cleanupTemporaryFiles();
    const db = this.inquiries.database;
    const rows = await db.query<{ id: string; session_id: string }>(
      "SELECT a.id,a.session_id FROM attachments a JOIN guest_sessions g ON g.id=a.session_id WHERE a.inquiry_id IS NULL AND g.expires_at<now()-interval '1 hour' ORDER BY a.created_at LIMIT 50",
    );
    for (const row of rows.rows) {
      await db.transaction(async (transaction) => {
        await transaction.query('SELECT id FROM guest_sessions WHERE id=$1 FOR UPDATE', [
          row.session_id,
        ]);
        const current = await transaction.query(
          'SELECT id FROM attachments WHERE id=$1 AND inquiry_id IS NULL FOR UPDATE',
          [row.id],
        );
        if (!current.rowCount) return;
        await this.inquiries.chat.request(
          `/attachments/${row.id}?guestSessionId=${row.session_id}`,
          { method: 'DELETE' },
        );
        await transaction.query(
          'DELETE FROM attachments WHERE id=$1 AND inquiry_id IS NULL',
          [row.id],
        );
      });
    }
    await db.query(
      "DELETE FROM guest_sessions WHERE id IN (SELECT g.id FROM guest_sessions g WHERE g.expires_at<now()-interval '1 day' AND g.inquiry_id IS NULL AND NOT EXISTS(SELECT 1 FROM attachments a WHERE a.session_id=g.id) AND NOT EXISTS(SELECT 1 FROM inquiries i WHERE i.session_id=g.id) AND NOT EXISTS(SELECT 1 FROM messages m WHERE m.session_id=g.id) AND NOT EXISTS(SELECT 1 FROM widget_events e WHERE e.session_id=g.id) LIMIT 100)",
    );
    await db.query("DELETE FROM rate_buckets WHERE window_start<now()-interval '1 day'");
    await db.query(
      "DELETE FROM reply_routes WHERE id IN (SELECT r.id FROM reply_routes r WHERE r.channel='widget' AND r.inquiry_id IS NULL AND NOT EXISTS(SELECT 1 FROM guest_sessions g WHERE g.id=r.id) AND NOT EXISTS(SELECT 1 FROM attachments a WHERE a.session_id=r.id) LIMIT 100)",
    );
    // Сохраняем ключи дедупликации, убирая лишнюю копию содержимого доставленных уведомлений.
    await db.query(
      "UPDATE channel_inbox SET payload='{}',normalized=NULL WHERE id IN (SELECT id FROM channel_inbox WHERE state='delivered' AND updated_at<now()-interval '7 days' AND payload<>'{}'::jsonb LIMIT 100)",
    );
  }

  /** После аварийного завершения убирает только собственные временные каталоги старше суток. */
  private async cleanupTemporaryFiles(): Promise<void> {
    const root = resolve(tmpdir());
    const entries = await readdir(root, { withFileTypes: true });
    let removed = 0;
    for (const entry of entries) {
      if (removed >= 20) break;
      if (
        !entry.isDirectory() ||
        entry.isSymbolicLink() ||
        !entry.name.startsWith('sep-manager-upload-')
      )
        continue;
      const target = resolve(root, entry.name);
      if (dirname(target) !== root || !basename(target).startsWith('sep-manager-upload-'))
        throw new Error('Некорректный путь очистки');
      const info = await lstat(target).catch(() => null);
      if (!info || info.isSymbolicLink() || info.mtimeMs >= Date.now() - 86400000)
        continue;
      await rm(target, { recursive: true, force: true });
      removed++;
    }
  }
}
