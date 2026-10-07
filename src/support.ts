import {
  Body,
  Controller,
  ConflictException,
  ForbiddenException,
  Headers,
  Inject,
  Injectable,
  Logger,
  Param,
  Post,
  type OnModuleInit,
  type OnModuleDestroy,
} from '@nestjs/common';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Site } from './contracts';
import { InquiriesService } from './inquiries.service';

interface SupportClient {
  client_id: string;
  site_id: string;
  guest_session_id: string;
  customer_id: string;
  inquiry_id: string;
}

export interface SupportSession {
  token: string;
  siteId: string;
  widgetOrigin: string;
}

const hash = (value: string): Buffer => createHash('sha256').update(value).digest();

@Injectable()
export class SupportService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setTimeout>;
  private preparing?: Promise<void>;
  private stopped = false;

  constructor(@Inject(InquiriesService) private readonly inquiries: InquiriesService) {}

  /** Настроенные постоянные чаты появляются в поддержке ещё до первого сообщения. */
  onModuleInit(): void {
    const pending = new Set(
      this.inquiries.config.sites
        .filter((site) => site.enabled && site.support)
        .map((site) => site.support!.clientId),
    );
    const prepare = async (): Promise<void> => {
      for (const id of pending) {
        if (this.stopped) return;

        try {
          await this.session(id, this.inquiries.config.supportKeys[id]);
          pending.delete(id);
        } catch {
          Logger.warn(
            'Не удалось подготовить постоянный чат поддержки; подключение будет повторено',
            'Support',
          );
        }
      }

      if (pending.size && !this.stopped) {
        this.timer = setTimeout(start, 10000);
        this.timer.unref();
      }
    };
    const start = (): void => {
      this.preparing = prepare();
    };

    if (pending.size) {
      this.timer = setTimeout(start, 0);
      this.timer.unref();
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.preparing;
  }

  /** Только сервер конкретного клиента может открыть его постоянную переписку. */
  async session(
    clientId: string,
    suppliedKey: string | undefined,
  ): Promise<SupportSession> {
    const site = this.inquiries.config.sites.find(
      (item) => item.enabled && item.support?.clientId === clientId,
    );
    const key = this.inquiries.config.supportKeys[clientId];

    if (!site?.support || !key || !timingSafeEqual(hash(key), hash(suppliedKey || '')))
      throw new ForbiddenException('Подключение к поддержке недоступно');

    await this.inquiries.ready();
    await this.inquiries.rateLimit(`support-session:${clientId}`, 180);

    const token = createHmac('sha256', key)
      .update(`support-session:v1:${clientId}`)
      .digest('hex');
    const client = await this.ensureClient(site, token);
    const source = await this.inquiries.database.query<{
      source: Record<string, unknown>;
    }>('SELECT source FROM guest_sessions WHERE id=$1', [client.guest_session_id]);
    const receipt = await this.inquiries.chat.ensureInquiry({
      id: client.inquiry_id,
      session_id: client.guest_session_id,
      customer_id: client.customer_id,
      customerName: site.support.name,
      source: source.rows[0].source,
    });

    const updated = await this.inquiries.database.query(
      'UPDATE inquiries SET topic_id=$2 WHERE id=$1 AND (topic_id IS NULL OR topic_id=$2)',
      [client.inquiry_id, receipt.topicId],
    );

    if (updated.rowCount !== 1)
      throw new ConflictException('Переписка поддержки связана с другим чатом');

    return {
      token,
      siteId: site.id,
      widgetOrigin: site.widgetOrigins[0],
    };
  }

  /** Блокировка клиента не даёт двум первым открытиям создать разные чаты. */
  private async ensureClient(site: Site, token: string): Promise<SupportClient> {
    const support = site.support!;

    return this.inquiries.database.transaction(async (db): Promise<SupportClient> => {
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `manager:support:${support.clientId}`,
      ]);

      const existing = (
        await db.query<SupportClient>(
          'SELECT * FROM support_clients WHERE client_id=$1',
          [support.clientId],
        )
      ).rows[0];
      const expiresAt = new Date(
        Date.now() + this.inquiries.config.MANAGER_SESSION_HOURS * 3600000,
      );

      if (existing) {
        if (existing.site_id !== site.id)
          throw new ForbiddenException('Настройки клиента поддержки изменились');

        await db.query(
          'UPDATE guest_sessions SET token_hash=$2,expires_at=$3,origin=$4 WHERE id=$1',
          [
            existing.guest_session_id,
            hash(token).toString('hex'),
            expiresAt,
            site.widgetOrigins[0],
          ],
        );

        return existing;
      }

      const client: SupportClient = {
        client_id: support.clientId,
        site_id: site.id,
        guest_session_id: randomUUID(),
        customer_id: randomUUID(),
        inquiry_id: randomUUID(),
      };
      const source = {
        siteId: site.id,
        name: site.name,
        channel: 'widget',
        pageUrl: `${site.origins[0]}/`,
        title: support.name,
        referrerOrigin: '',
        supportClientId: support.clientId,
      };

      await db.models.GuestSession.create(
        {
          id: client.guest_session_id,
          token_hash: hash(token).toString('hex'),
          site_id: site.id,
          origin: site.widgetOrigins[0],
          source,
          expires_at: expiresAt,
        },
        { transaction: db.transaction },
      );
      await db.query('INSERT INTO customers(id,name,contacts) VALUES($1,$2,$3)', [
        client.customer_id,
        support.name,
        JSON.stringify({ name: support.name, phone: '', email: '' }),
      ]);
      await db.query(
        "INSERT INTO reply_routes(id,channel,source) VALUES($1,'widget',$2)",
        [client.guest_session_id, source],
      );
      await db.query(
        'INSERT INTO inquiries(id,session_id,site_id,customer_id,source) VALUES($1,$2,$3,$4,$5)',
        [client.inquiry_id, client.guest_session_id, site.id, client.customer_id, source],
      );
      await db.query('UPDATE reply_routes SET inquiry_id=$2 WHERE id=$1', [
        client.guest_session_id,
        client.inquiry_id,
      ]);
      await db.query('UPDATE guest_sessions SET inquiry_id=$2 WHERE id=$1', [
        client.guest_session_id,
        client.inquiry_id,
      ]);
      await db.query(
        'INSERT INTO support_clients(client_id,site_id,guest_session_id,customer_id,inquiry_id) VALUES($1,$2,$3,$4,$5)',
        [
          client.client_id,
          site.id,
          client.guest_session_id,
          client.customer_id,
          client.inquiry_id,
        ],
      );

      return client;
    });
  }
}

@Controller('v1/support')
export class SupportController {
  constructor(@Inject(SupportService) private readonly support: SupportService) {}

  /** Служебный ключ остаётся на сервере Умного пресса и не передаётся в виджет. */
  @Post(':clientId/session')
  session(
    @Param('clientId') clientId: string,
    @Headers('x-support-key') key: string | undefined,
    @Body() body: unknown,
  ): Promise<SupportSession> {
    z.object({}).strict().parse(body);

    return this.support.session(clientId, key);
  }
}
