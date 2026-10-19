import {
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  type OnModuleInit,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { InquiriesService } from './inquiries.service';
import type { Contacts } from './contracts';
import { ErpContactSnapshotSchema, erpContactProfile } from './erp-contact-profile';

interface ErpDependencies {
  database: InquiriesService['database'];
  config: Pick<InquiriesService['config'], 'ERP_SERVICE_URL' | 'ERP_MANAGER_KEY'>;
  chat: Pick<InquiriesService['chat'], 'erpActor'>;
  queue: Pick<InquiriesService['queue'], 'register' | 'enqueue'>;
}

interface Customer {
  id: string;
  name: string;
  contacts: Contacts;
  erp_contact_id: string | null;
}

interface PublicErpJob {
  id: string;
  customerId: string;
  state: string;
}

const CandidateSchema = z.object({
  id: z.number().int().positive(),
  initial: z.string(),
  ban: z.boolean(),
  requisites: z.array(z.unknown()),
});

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
export class ErpSyncService implements OnModuleInit {
  constructor(@Inject(InquiriesService) private readonly inquiries: ErpDependencies) {}

  async onModuleInit(): Promise<void> {
    if (!this.inquiries.config.ERP_SERVICE_URL) return;
    const migration = await this.inquiries.database.query(
      'SELECT version FROM manager_schema_migrations WHERE version=11',
    );

    if (!migration.rowCount)
      throw new Error('Сначала примените миграцию обновления контактов Manager');

    await this.inquiries.queue.register('erp', (id) => this.process(id));
  }

  private async customer(inquiryId: string): Promise<Customer> {
    const row = (
      await this.inquiries.database.query<Customer>(
        'SELECT c.* FROM customers c JOIN inquiries i ON i.customer_id=c.id WHERE i.id=$1',
        [inquiryId],
      )
    ).rows[0];
    if (!row) throw new NotFoundException('Обращение не найдено');
    return row;
  }
  private identity(contacts: Contacts): { phone?: string; email?: string } {
    return {
      ...(contacts.phone ? { phone: contacts.phone } : {}),
      ...(contacts.email ? { email: contacts.email } : {}),
    };
  }
  private async request(actorId: number, path: string, body: unknown): Promise<unknown> {
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
            compress: 'no-compress',
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
  async candidates(
    inquiryId: string,
    actorId: string,
  ): Promise<z.infer<typeof CandidateSchema>[]> {
    const customer = await this.customer(inquiryId);
    const erpActor = await this.inquiries.chat.erpActor(actorId);
    if (!customer.contacts.phone && !customer.contacts.email) return [];
    return z
      .array(CandidateSchema)
      .max(21)
      .parse(
        await this.request(erpActor, 'candidates', this.identity(customer.contacts)),
      );
  }
  /** Сохраняет намерение до запроса к ЕРП: перезапуск или потеря ответа не теряют операцию. */
  async enqueue(
    inquiryId: string,
    actorId: string,
    body: unknown,
  ): Promise<PublicErpJob> {
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
    const result = await this.inquiries.database.transaction(async (db) => {
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
          "SELECT * FROM erp_sync_operations WHERE customer_id=$1 AND state IN ('pending','working')",
          [customer.id],
        )
      ).rows[0];
      if (active) {
        throw new ConflictException('Сначала завершите текущую синхронизацию');
      }
      if (
        current.erp_contact_id &&
        input.contactId &&
        String(input.contactId) !== current.erp_contact_id
      )
        throw new ConflictException('Клиент уже связан с другим контактом');
      const contactId = input.contactId || Number(current.erp_contact_id) || undefined;
      const payload = {
        operationId: input.operationId,
        customerId: customer.id,
        name: customer.name,
        // Выбранная карточка читается по ID, старые реквизиты не являются её новым содержимым.
        identity: contactId ? {} : this.identity(customer.contacts),
        ...(contactId ? { contactId } : {}),
      };
      const job = (
        await db.query<ErpJob>(
          'INSERT INTO erp_sync_operations(id,customer_id,actor_id,erp_actor_id,request,fingerprint) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
          [input.operationId, customer.id, actorId, erpActor, payload, fingerprint],
        )
      ).rows[0];
      return this.publicJob(job);
    });
    await this.inquiries.queue.enqueue('erp', result.id);
    return result;
  }
  private publicJob(job: ErpJob): PublicErpJob {
    return { id: job.id, customerId: job.customer_id, state: job.state };
  }

  /** Возобновляет тот же запрос; исходный инициатор и параметры сохраняются. */
  async retry(inquiryId: string, operationId: string): Promise<PublicErpJob> {
    const customer = await this.customer(inquiryId);
    const result = await this.inquiries.database.transaction(async (db) => {
      await db.query('SELECT id FROM customers WHERE id=$1 FOR UPDATE', [customer.id]);
      const active = await db.query(
        "SELECT id FROM erp_sync_operations WHERE customer_id=$1 AND state IN ('pending','working')",
        [customer.id],
      );
      if (active.rowCount)
        throw new ConflictException('У клиента уже есть выполняемая синхронизация');
      const job = (
        await db.query<ErpJob>(
          "UPDATE erp_sync_operations SET state='pending',attempts=0,next_attempt_at=now(),last_error=NULL WHERE id=$1 AND customer_id=$2 AND state='failed' RETURNING *",
          [z.uuid().parse(operationId), customer.id],
        )
      ).rows[0];
      if (!job) throw new ConflictException('Операция не ожидает повтора');
      return this.publicJob(job);
    });
    await this.inquiries.queue.enqueue('erp', result.id);
    return result;
  }
  /** Получает задание RabbitMQ, повторяет только ту же операцию с исходным инициатором. */
  private async process(operationId: string): Promise<'done' | 'retry'> {
    const job = await this.inquiries.database.transaction(async (db) => {
      const row = (
        await db.query<ErpJob>(
          `SELECT * FROM erp_sync_operations
          WHERE id=$1 AND ((state='pending' AND next_attempt_at<=now()) OR (state='working' AND locked_until<now()))
          ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1`,
          [operationId],
        )
      ).rows[0];
      if (row)
        await db.query(
          "UPDATE erp_sync_operations SET state='working',attempts=attempts+1,locked_until=now()+interval '30 seconds',updated_at=now() WHERE id=$1",
          [row.id],
        );
      return row;
    });
    if (!job) {
      const existing = await this.inquiries.database.query<{ state: string }>(
        'SELECT state FROM erp_sync_operations WHERE id=$1',
        [operationId],
      );
      return ['pending', 'working'].includes(existing.rows[0]?.state) ? 'retry' : 'done';
    }
    try {
      const actor = await this.inquiries.chat.erpActor(job.actor_id);
      if (actor !== job.erp_actor_id)
        throw new HttpException('Связь сотрудника с ЕРП изменилась', 403);
      const result = z
        .object({
          customerId: z.uuid(),
          contactId: z.number().int().positive(),
          created: z.boolean(),
          contact: ErpContactSnapshotSchema,
        })
        .parse(await this.request(actor, 'sync', job.request));
      if (result.customerId !== job.customer_id) throw new Error('erp_contract_mismatch');
      if (result.contact.id !== result.contactId)
        throw new Error('erp_contract_mismatch');
      if (result.contact.ban) throw new ConflictException('Контакт находится в архиве');
      const profile = erpContactProfile(result.contact);
      await this.inquiries.database.transaction(async (db) => {
        // Один контакт СЭП объединяет реквизиты и историю, но не каналы и сессии посетителей.
        await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `manager:erp-contact:${result.contactId}`,
        ]);
        const newer = (
          await db.query<{
            contacts: Contacts;
            erp_contact_updated_at: Date;
            id: string;
          }>(
            `SELECT id,contacts,erp_contact_updated_at FROM customers
           WHERE erp_contact_id=$1 AND erp_contact_updated_at>$2::timestamptz
           ORDER BY erp_contact_updated_at DESC,id LIMIT 1 FOR UPDATE`,
            [String(result.contactId), result.contact.updatedAt],
          )
        ).rows[0];
        const changed = await db.query(
          'UPDATE customers SET erp_contact_id=$2 WHERE id=$1 AND (erp_contact_id IS NULL OR erp_contact_id=$2) RETURNING id',
          [job.customer_id, String(result.contactId)],
        );
        if (!changed.rowCount) throw new ConflictException('Связь контакта изменилась');
        const identities = newer
          ? (
              await db.query<{ kind: 'phone' | 'email'; value: string }>(
                "SELECT DISTINCT kind,value FROM customer_identities WHERE customer_id=$1 AND kind IN ('phone','email')",
                [newer.id],
              )
            ).rows
          : profile.identities;
        const contacts = newer?.contacts ?? profile;
        await db.query(
          `UPDATE customers SET contacts=contacts || jsonb_build_object('phone',$2::text,'email',$3::text),
           erp_contact_updated_at=$4 WHERE erp_contact_id=$1`,
          [
            String(result.contactId),
            contacts.phone,
            contacts.email,
            newer?.erp_contact_updated_at ?? result.contact.updatedAt,
          ],
        );
        await db.query(
          `DELETE FROM customer_identities i USING customers c
           WHERE i.customer_id=c.id AND c.erp_contact_id=$1 AND i.kind IN ('phone','email')`,
          [String(result.contactId)],
        );
        for (const identity of identities) {
          await db.query(
            `INSERT INTO customer_identities(id,customer_id,site_id,kind,value,verified)
             SELECT gen_random_uuid(),id,NULL,$2,$3,false FROM customers WHERE erp_contact_id=$1`,
            [String(result.contactId), identity.kind, identity.value],
          );
        }
        await db.query(
          "UPDATE erp_sync_operations SET state='completed',erp_contact_id=$2,last_error=NULL,locked_until=NULL,updated_at=now() WHERE id=$1",
          [job.id, String(result.contactId)],
        );
      });
      return 'done';
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
      return state === 'pending' ? 'retry' : 'done';
    }
  }
}
