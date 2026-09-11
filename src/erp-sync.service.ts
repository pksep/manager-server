import {
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { InquiriesService } from './inquiries.service';
import type { Contacts } from './contracts';

const command = z
  .object({
    operationId: z.uuid(),
    contactId: z.number().int().positive().max(2147483647).optional(),
  })
  .strict();
interface ErpJob {
  id: string;
  customer_id: string;
  actor_id: string;
  erp_actor_id: number;
  state: string;
  attempts: number;
  fingerprint: string;
  request: {
    operationId: string;
    customerId: string;
    name: string;
    identity: { phone?: string; email?: string };
    contactId?: number;
  };
}

@Injectable()
export class ErpSyncService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private stopped = false;
  constructor(@Inject(InquiriesService) private readonly inquiries: InquiriesService) {}

  onModuleInit() {
    if (!this.inquiries.config.ERP_SERVICE_URL) return;
    this.timer = setInterval(() => void this.tick(), 1000);
    this.timer.unref();
  }
  async onModuleDestroy() {
    this.stopped = true;
    clearInterval(this.timer);
    await this.running;
  }

  private async customer(inquiryId: string) {
    const row = (
      await this.inquiries.database.query<{
        id: string;
        name: string;
        contacts: Contacts;
        erp_contact_id: string | null;
      }>(
        'SELECT c.* FROM customers c JOIN inquiries i ON i.customer_id=c.id WHERE i.id=$1',
        [inquiryId],
      )
    ).rows[0];
    if (!row) throw new NotFoundException('Обращение не найдено');
    return row;
  }
  private identity(contacts: Contacts) {
    return {
      ...(contacts.phone ? { phone: contacts.phone } : {}),
      ...(contacts.email ? { email: contacts.email } : {}),
    };
  }
  private async request(actorId: number, path: string, body: unknown) {
    const { ERP_SERVICE_URL: base, ERP_MANAGER_KEY: key } = this.inquiries.config;
    if (!base || !key)
      throw new ServiceUnavailableException('Интеграция ЕРП не подключена');
    let response: Response;
    try {
      response = await fetch(
        `${base.replace(/\/$/, '')}/internal/manager/contacts/${path}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-manager-key': key,
            'x-erp-actor-id': String(actorId),
          },
          body: JSON.stringify(body),
          redirect: 'error',
          signal: AbortSignal.timeout(7000),
        },
      );
    } catch {
      throw new ServiceUnavailableException('Нет связи с ЕРП');
    }
    if (!response.ok)
      throw new HttpException(
        response.status === 409
          ? 'Нужно выбрать существующий контакт или проверить связь'
          : 'Синхронизация с ЕРП не выполнена',
        [400, 401, 403, 404, 409].includes(response.status) ? response.status : 503,
      );
    return response.json();
  }
  /** Получает совпадения по телефону/почте, не подтверждая личность клиента автоматически. */
  async candidates(inquiryId: string, actorId: string) {
    const customer = await this.customer(inquiryId);
    const erpActor = await this.inquiries.chat.erpActor(actorId);
    return z
      .array(
        z.object({
          id: z.number().int().positive(),
          initial: z.string(),
          ban: z.boolean(),
          requisites: z.array(z.unknown()),
        }),
      )
      .max(21)
      .parse(
        await this.request(erpActor, 'candidates', this.identity(customer.contacts)),
      );
  }
  /** Сохраняет намерение до запроса к ЕРП: перезапуск или потеря ответа не теряют операцию. */
  async enqueue(inquiryId: string, actorId: string, body: unknown) {
    const input = command.parse(body);
    if (!this.inquiries.config.ERP_SERVICE_URL)
      throw new ServiceUnavailableException('Интеграция ЕРП не подключена');
    const erpActor = await this.inquiries.chat.erpActor(actorId);
    const customer = await this.customer(inquiryId);
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({ customerId: customer.id, contactId: input.contactId || null }),
      )
      .digest('hex');
    return this.inquiries.database.transaction(async (db) => {
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `manager:erp-operation:${input.operationId}`,
      ]);
      const current = (
        await db.query('SELECT erp_contact_id FROM customers WHERE id=$1 FOR UPDATE', [
          customer.id,
        ])
      ).rows[0];
      const previous = (
        await db.query<ErpJob>('SELECT * FROM erp_sync_operations WHERE id=$1', [
          input.operationId,
        ])
      ).rows[0];
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          throw new ConflictException('Ключ повтора относится к другому действию');
        return this.publicJob(previous);
      }
      const active = (
        await db.query<ErpJob>(
          "SELECT * FROM erp_sync_operations WHERE customer_id=$1 AND state IN ('pending','working','completed')",
          [customer.id],
        )
      ).rows[0];
      if (active) {
        if (active.fingerprint !== fingerprint)
          throw new ConflictException('Сначала завершите текущую синхронизацию');
        return this.publicJob(active);
      }
      if (
        current.erp_contact_id &&
        input.contactId &&
        String(input.contactId) !== current.erp_contact_id
      )
        throw new ConflictException('Клиент уже связан с другим контактом');
      const payload = {
        operationId: input.operationId,
        customerId: customer.id,
        name: customer.name,
        identity: this.identity(customer.contacts),
        ...(input.contactId ? { contactId: input.contactId } : {}),
      };
      const job = (
        await db.query<ErpJob>(
          'INSERT INTO erp_sync_operations(id,customer_id,actor_id,erp_actor_id,request,fingerprint) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
          [input.operationId, customer.id, actorId, erpActor, payload, fingerprint],
        )
      ).rows[0];
      return this.publicJob(job);
    });
  }
  private publicJob(job: ErpJob) {
    return { id: job.id, customerId: job.customer_id, state: job.state };
  }

  /** Возобновляет тот же запрос; исходный инициатор и параметры сохраняются. */
  async retry(inquiryId: string, operationId: string) {
    const customer = await this.customer(inquiryId);
    return this.inquiries.database.transaction(async (db) => {
      await db.query('SELECT id FROM customers WHERE id=$1 FOR UPDATE', [customer.id]);
      const active = await db.query(
        "SELECT id FROM erp_sync_operations WHERE customer_id=$1 AND state IN ('pending','working','completed')",
        [customer.id],
      );
      if (active.rowCount)
        throw new ConflictException(
          'У клиента уже есть выполняемая или завершённая синхронизация',
        );
      const job = (
        await db.query<ErpJob>(
          "UPDATE erp_sync_operations SET state='pending',attempts=0,next_attempt_at=now(),last_error=NULL WHERE id=$1 AND customer_id=$2 AND state='failed' RETURNING *",
          [z.uuid().parse(operationId), customer.id],
        )
      ).rows[0];
      if (!job) throw new ConflictException('Операция не ожидает повтора');
      return this.publicJob(job);
    });
  }
  /** Обрабатывает сохранённые операции независимо от доставки сообщений. */
  tick(): Promise<void> {
    if (this.running || this.stopped) return this.running ?? Promise.resolve();
    this.running = this.run()
      .catch(() => {})
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }
  private async run() {
    for (let index = 0; index < 10 && !this.stopped; index++) {
      const job = await this.inquiries.database.transaction(async (db) => {
        const row = (
          await db.query<ErpJob>(`SELECT * FROM erp_sync_operations
          WHERE (state='pending' AND next_attempt_at<=now()) OR (state='working' AND locked_until<now())
          ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1`)
        ).rows[0];
        if (row)
          await db.query(
            "UPDATE erp_sync_operations SET state='working',attempts=attempts+1,locked_until=now()+interval '30 seconds',updated_at=now() WHERE id=$1",
            [row.id],
          );
        return row;
      });
      if (!job) return;
      try {
        const actor = await this.inquiries.chat.erpActor(job.actor_id);
        if (actor !== job.erp_actor_id)
          throw new HttpException('Связь сотрудника с ЕРП изменилась', 403);
        const result = z
          .object({
            customerId: z.uuid(),
            contactId: z.number().int().positive(),
            created: z.boolean(),
          })
          .parse(await this.request(actor, 'sync', job.request));
        if (result.customerId !== job.customer_id)
          throw new Error('erp_contract_mismatch');
        await this.inquiries.database.transaction(async (db) => {
          const changed = await db.query(
            'UPDATE customers SET erp_contact_id=$2 WHERE id=$1 AND (erp_contact_id IS NULL OR erp_contact_id=$2) RETURNING id',
            [job.customer_id, String(result.contactId)],
          );
          if (!changed.rowCount) throw new ConflictException('Связь контакта изменилась');
          await db.query(
            "UPDATE erp_sync_operations SET state='completed',erp_contact_id=$2,last_error=NULL,locked_until=NULL,updated_at=now() WHERE id=$1",
            [job.id, String(result.contactId)],
          );
        });
      } catch (error) {
        const status = error instanceof HttpException ? error.getStatus() : 503;
        const state =
          status === 409
            ? 'conflict'
            : status < 500 || job.attempts >= 9
              ? 'failed'
              : 'pending';
        await this.inquiries.database.query(
          "UPDATE erp_sync_operations SET state=$2,last_error=$3,locked_until=NULL,next_attempt_at=now()+($4 * interval '1 second'),updated_at=now() WHERE id=$1",
          [job.id, state, `erp_${status}`, Math.min(60, 2 ** job.attempts)],
        );
      }
    }
  }
}
