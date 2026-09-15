import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import sanitizeHtml from 'sanitize-html';
import { z } from 'zod';
import { CONFIG, type Config } from '../config';
import { Database } from '../database';
import { InquiriesService, hash } from '../inquiries.service';
import { OperationQueue } from '../operation-queue';
import { SecurityService } from '../security';
import { FileInspection } from '../secure-upload';
import type { Attachment } from '../contracts';
import type { ChannelConnection } from './config';
import {
  capabilities,
  ChannelError,
  type DeliveredPart,
  type IncomingMessage,
  type Platform,
  type ReplyRoute,
} from './contracts';
import { VkAdapter, VkMessageSchema } from './vk';
import { AvitoAdapter, AvitoWebhookSchema } from './avito';
import { ChannelFiles } from './files';

interface Job {
  id: string;
  attempts: number;
  lease_token: string;
  connection_id?: string;
  payload?: unknown;
  normalized?: IncomingMessage;
  route_id?: string;
  inquiry_id?: string;
  progress?: DeliveredPart[];
  sending_part?: number | null;
  random_id?: number;
}

type Table = 'channel_inbox' | 'channel_outbox';

/** Не превращает HTML-разметку менеджера в видимые теги во внешней переписке. */
export function channelText(html: string): string {
  return sanitizeHtml(
    html.replace(/<br\s*\/?\s*>/gi, '\n').replace(/<\/(p|li|blockquote)>/gi, '\n'),
    {
      allowedTags: [],
      allowedAttributes: {},
      parser: { decodeEntities: true },
      textFilter: (text) => text,
    },
  )
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

/** Делит длинный текст без разрыва Unicode-символа. */
export function textParts(text: string, maximum: number): string[] {
  const parts: string[] = [];
  let current = '';
  for (const character of text) {
    if (current.length + character.length > maximum) {
      parts.push(current);
      current = '';
    }
    current += character;
  }
  if (current) parts.push(current);
  return parts;
}

@Injectable()
export class ChannelService implements OnModuleInit {
  constructor(
    @Inject(CONFIG) private readonly config: Config,
    @Inject(Database) private readonly db: Database,
    @Inject(InquiriesService) private readonly inquiries: InquiriesService,
    @Inject(OperationQueue) private readonly queue: OperationQueue,
    @Inject(SecurityService) private readonly security: SecurityService,
    @Inject(FileInspection) private readonly inspection: FileInspection,
    @Inject(ChannelFiles) private readonly files: ChannelFiles,
    @Inject(VkAdapter) private readonly vk: VkAdapter,
    @Inject(AvitoAdapter) private readonly avito: AvitoAdapter,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.db.transaction(async (transaction): Promise<void> => {
      for (const connection of this.config.channels) {
        const previous = (
          await transaction.query<{ platform: string; account_id: string }>(
            'SELECT platform,account_id FROM channel_connections WHERE id=$1 FOR UPDATE',
            [connection.id],
          )
        ).rows[0];
        if (
          previous &&
          (previous.platform !== connection.platform ||
            previous.account_id !== connection.accountId)
        )
          throw new Error(
            'Нельзя заменить аккаунт существующего подключения: создайте новый идентификатор',
          );
        await transaction.query(
          'INSERT INTO channel_connections(id,platform,account_id,name,enabled) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET name=excluded.name,enabled=excluded.enabled',
          [
            connection.id,
            connection.platform,
            connection.accountId,
            connection.name,
            connection.enabled,
          ],
        );
      }
      await transaction.query(
        'UPDATE channel_connections SET enabled=false WHERE NOT(id=ANY($1::text[]))',
        [this.config.channels.map((connection) => connection.id)],
      );
    });
    await this.queue.register('channel-inbox', (id) => this.process('channel_inbox', id));
    await this.queue.register('channel-outbox', (id) =>
      this.process('channel_outbox', id),
    );
  }

  /** Секрет проверяется до сохранения уведомления; неизвестные подключения закрыты. */
  connection(platform: Platform, id: string, secret: string): ChannelConnection {
    const connection = this.config.channels.find(
      (item) => item.platform === platform && item.id === id && item.enabled,
    );
    if (
      !connection ||
      secret.length > 128 ||
      !timingSafeEqual(
        Buffer.from(hash(secret)),
        Buffer.from(hash(connection.webhookSecret)),
      )
    )
      throw new ForbiddenException('Подключение не авторизовано');
    return connection;
  }

  /** Подтверждает приём только после сохранения события и намерения доставки. */
  async receive(connection: ChannelConnection, body: unknown): Promise<string> {
    let payload: unknown;
    let eventKey: string;
    if (connection.platform === 'vk') {
      const event = z
        .object({
          type: z.string().max(60),
          group_id: z.number().int().safe(),
          object: z.unknown().optional(),
        })
        .parse(body);
      if (String(event.group_id) !== connection.accountId)
        throw new ForbiddenException('Сообщество не совпадает');
      if (event.type === 'confirmation') return connection.confirmation || '';
      if (event.type !== 'message_new') return 'ok';
      const object = z.object({ message: VkMessageSchema }).parse(event.object);
      if (
        object.message.out ||
        object.message.from_id <= 0 ||
        object.message.peer_id >= 2000000000
      )
        return 'ok';
      eventKey = `${object.message.peer_id}:${object.message.conversation_message_id}`;
      payload = { type: event.type, object };
    } else {
      if (body && typeof body === 'object' && Object.keys(body).length === 0) return 'ok';
      const event = AvitoWebhookSchema.parse(body);
      if (event.payload.value.user_id !== connection.accountId)
        throw new ForbiddenException('Аккаунт не совпадает');
      if (event.payload.value.author_id === connection.accountId) return 'ok';
      eventKey = `${event.payload.value.chat_id}:${event.payload.value.id}`;
      payload = event;
    }
    const prior = (
      await this.db.query<{ id: string }>(
        'SELECT id FROM channel_inbox WHERE connection_id=$1 AND event_key=$2',
        [connection.id, eventKey],
      )
    ).rows[0];
    if (prior) return 'ok';
    await this.security.consume([
      { key: `channel:${connection.id}:events`, capacity: 3000, window: 60000 },
    ]);
    const jobId = await this.db.transaction(async (transaction): Promise<string> => {
      await transaction.query(
        "SELECT pg_advisory_xact_lock(hashtext('manager:queue-capacity'))",
      );
      const queued = (
        await transaction.query<{ count: string }>(
          "SELECT count(*) FROM channel_inbox WHERE state IN ('pending','working')",
        )
      ).rows[0];
      if (Number(queued.count) >= this.config.MANAGER_QUEUE_LIMIT)
        throw new ChannelError('CHANNEL_INBOX_FULL', true);
      const saved = await transaction.query<{ id: string }>(
        'INSERT INTO channel_inbox(id,connection_id,event_key,payload) VALUES($1,$2,$3,$4) ON CONFLICT(connection_id,event_key) DO UPDATE SET event_key=excluded.event_key RETURNING id',
        [randomUUID(), connection.id, eventKey, payload],
      );
      await transaction.query(
        'UPDATE channel_connections SET last_event_at=now() WHERE id=$1',
        [connection.id],
      );
      return saved.rows[0].id;
    });
    // Публикация восстанавливается из БД и не задерживает короткий callback платформы.
    void this.queue.enqueue('channel-inbox', jobId);
    return 'ok';
  }

  private async claim(table: Table, id: string): Promise<Job | null> {
    return this.db.transaction(async (transaction): Promise<Job | null> => {
      const ordering =
        table === 'channel_outbox'
          ? `AND NOT EXISTS(SELECT 1 FROM channel_outbox previous JOIN messages pm ON pm.id=previous.id JOIN messages current ON current.id=job.id WHERE previous.route_id=job.route_id AND pm.sequence<current.sequence AND previous.state<>'delivered')`
          : '';
      const job = (
        await transaction.query<Job>(
          `SELECT * FROM ${table} job WHERE id=$1 AND ((state='pending' AND next_attempt_at<=now()) OR (state='working' AND locked_until<now())) ${ordering} FOR UPDATE SKIP LOCKED`,
          [id],
        )
      ).rows[0];
      if (!job) return null;
      job.lease_token = randomUUID();
      await transaction.query(
        `UPDATE ${table} SET state='working',attempts=attempts+1,lease_token=$2,locked_until=now()+interval '90 seconds',updated_at=now() WHERE id=$1`,
        [id, job.lease_token],
      );
      return job;
    });
  }

  private async process(table: Table, id: string): Promise<'done' | 'retry'> {
    const job = await this.claim(table, id);
    if (!job) {
      const row = (
        await this.db.query<{ state: string }>(`SELECT state FROM ${table} WHERE id=$1`, [
          id,
        ])
      ).rows[0];
      return row && ['pending', 'working'].includes(row.state) ? 'retry' : 'done';
    }
    let lostLease = false;
    const heartbeat = setInterval(() => {
      void this.db
        .query(
          `UPDATE ${table} SET locked_until=now()+interval '90 seconds' WHERE id=$1 AND lease_token=$2 AND state='working'`,
          [id, job.lease_token],
        )
        .then((result) => {
          if (!result.rowCount) lostLease = true;
        })
        .catch(() => {
          lostLease = true;
        });
    }, 20000);
    heartbeat.unref();
    const assertLease = async (): Promise<void> => {
      if (lostLease) throw new ChannelError('CHANNEL_LEASE_LOST', true);
      const row = await this.db.query(
        `SELECT id FROM ${table} WHERE id=$1 AND lease_token=$2 AND state='working' AND locked_until>now()`,
        [id, job.lease_token],
      );
      if (!row.rowCount) throw new ChannelError('CHANNEL_LEASE_LOST', true);
    };
    try {
      if (table === 'channel_inbox') await this.receiveJob(job);
      else await this.sendJob(job, assertLease);
      await this.db.query(
        `UPDATE ${table} SET state='delivered',locked_until=NULL,last_error=NULL,updated_at=now() WHERE id=$1 AND lease_token=$2`,
        [id, job.lease_token],
      );
      return 'done';
    } catch (cause) {
      const error =
        cause instanceof ChannelError
          ? cause
          : new ChannelError('CHANNEL_PROCESSING_FAILED', true);
      const state = error.uncertain
        ? 'uncertain'
        : error.retryable && job.attempts < 9
          ? 'pending'
          : 'failed';
      await this.db.query(
        `UPDATE ${table} SET state=$3,locked_until=NULL,last_error=$4,next_attempt_at=now()+$5*interval '1 second',updated_at=now() WHERE id=$1 AND lease_token=$2`,
        [
          id,
          job.lease_token,
          table === 'channel_inbox' && state === 'uncertain' ? 'pending' : state,
          error.code,
          Math.min(3600, Math.max(error.retryAfter, 2 ** Math.min(job.attempts + 1, 8))),
        ],
      );
      this.security.audit('channel_operation_failed');
      await this.db.query(
        'UPDATE channel_connections SET last_error=$2 WHERE id=COALESCE($1,(SELECT connection_id FROM reply_routes WHERE id=$3))',
        [job.connection_id || null, error.code, job.route_id || null],
      );
      return state === 'pending' || (table === 'channel_inbox' && state === 'uncertain')
        ? 'retry'
        : 'done';
    } finally {
      clearInterval(heartbeat);
    }
  }

  private configured(id: string): ChannelConnection {
    const connection = this.config.channels.find(
      (item) => item.id === id && item.enabled,
    );
    if (!connection) throw new ChannelError('CHANNEL_DISABLED');
    return connection;
  }

  private async receiveJob(job: Job): Promise<void> {
    const connection = this.configured(job.connection_id!);
    const message =
      job.normalized ||
      (await (connection.platform === 'vk' ? this.vk : this.avito).incoming(
        connection,
        job.payload,
      ));
    if (!message) return;
    if (!job.normalized)
      await this.db.query(
        'UPDATE channel_inbox SET normalized=$3 WHERE id=$1 AND lease_token=$2',
        [job.id, job.lease_token, message],
      );
    const existing = (
      await this.db.query<{ id: string }>(
        'SELECT m.id FROM messages m JOIN reply_routes r ON r.id=m.session_id WHERE m.operation_id=$1 AND r.connection_id=$2',
        [`channel:${job.id}`, connection.id],
      )
    ).rows[0];
    if (existing) {
      await this.db.query(
        'INSERT INTO channel_message_receipts(connection_id,external_chat_id,external_message_id,message_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
        [connection.id, message.conversationId, message.messageId, existing.id],
      );
      return;
    }
    if (message.files.length > capabilities[connection.platform].fileCount) {
      message.text +=
        '\nЧасть вложений доступна в исходной переписке: превышено допустимое количество.';
      message.files = message.files.slice(0, capabilities[connection.platform].fileCount);
    }
    const route = await this.ensureRoute(connection, message);
    const attachments: string[] = [];
    for (const file of message.files) {
      try {
        const attachment = await this.files.receive(connection.platform, file, (upload) =>
          this.inquiries.uploadForRoute(
            route,
            `channel:${hash(`${job.id}:${file.id}`)}`,
            upload,
          ),
        );
        attachments.push(attachment.id);
      } catch (error) {
        if (
          (error instanceof ChannelError && !error.retryable) ||
          error instanceof BadRequestException ||
          (error &&
            typeof error === 'object' &&
            'getStatus' in error &&
            typeof error.getStatus === 'function' &&
            [413, 422].includes(error.getStatus()))
        ) {
          message.text += `\nВложение «${file.name.slice(0, 100)}» не принято: формат или проверка безопасности. Доступно в исходной переписке.`;
        } else throw error;
      }
    }
    if (!message.text.trim() && !attachments.length) message.text = 'Новое обращение';
    const accepted = await this.inquiries.acceptChannel(
      route,
      message,
      attachments,
      `channel:${job.id}`,
    );
    await this.db.query(
      'INSERT INTO channel_message_receipts(connection_id,external_chat_id,external_message_id,message_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
      [connection.id, message.conversationId, message.messageId, accepted.message.id],
    );
    await this.db.query('UPDATE channel_connections SET last_error=NULL WHERE id=$1', [
      connection.id,
    ]);
  }

  private async ensureRoute(
    connection: ChannelConnection,
    message: IncomingMessage,
  ): Promise<ReplyRoute> {
    return this.db.transaction(async (transaction): Promise<ReplyRoute> => {
      await transaction.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `manager:route:${connection.id}:${message.conversationId}`,
      ]);
      const current = (
        await transaction.query<ReplyRoute>(
          'SELECT * FROM reply_routes WHERE connection_id=$1 AND external_chat_id=$2 FOR UPDATE',
          [connection.id, message.conversationId],
        )
      ).rows[0];
      if (current) {
        if (current.external_user_id !== message.userId)
          throw new ChannelError('CHANNEL_PARTICIPANT_CHANGED');
        await transaction.query('UPDATE reply_routes SET source=$2 WHERE id=$1', [
          current.id,
          message.source,
        ]);
        return { ...current, source: { ...message.source } };
      }
      return (
        await transaction.query<ReplyRoute>(
          'INSERT INTO reply_routes(id,channel,connection_id,external_chat_id,external_user_id,source) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
          [
            randomUUID(),
            connection.platform,
            connection.id,
            message.conversationId,
            message.userId,
            message.source,
          ],
        )
      ).rows[0];
    });
  }

  private async sendJob(job: Job, assertLease: () => Promise<void>): Promise<void> {
    const route = (
      await this.db.query<ReplyRoute>('SELECT * FROM reply_routes WHERE id=$1', [
        job.route_id,
      ])
    ).rows[0];
    if (!route?.connection_id || !route.external_chat_id)
      throw new ChannelError('CHANNEL_ROUTE_NOT_FOUND');
    const connection = this.configured(route.connection_id);
    if (
      connection.platform === 'avito' &&
      job.sending_part !== null &&
      job.sending_part !== undefined
    )
      throw new ChannelError('AVITO_DELIVERY_UNCONFIRMED', false, true);
    const message = (
      await this.db.query<{ html: string; attachments: Attachment[] }>(
        'SELECT html,attachments FROM messages WHERE id=$1 AND session_id=$2',
        [job.id, route.id],
      )
    ).rows[0];
    if (!message) throw new ChannelError('CHANNEL_MESSAGE_NOT_FOUND');
    const progress = job.progress || [];
    const parts: Array<{ text: string } | { file: Attachment }> = textParts(
      channelText(message.html),
      capabilities[connection.platform].textChars,
    ).map((text) => ({ text }));
    for (const file of message.attachments) {
      if (
        file.size > capabilities[connection.platform].fileBytes ||
        !capabilities[connection.platform].mimeTypes.includes(file.mime)
      )
        throw new ChannelError('CHANNEL_ATTACHMENT_UNSUPPORTED');
      parts.push({ file });
    }
    if (!parts.length) throw new ChannelError('CHANNEL_MESSAGE_EMPTY');
    for (let index = 0; index < parts.length; index++) {
      if (progress.some((part) => part.index === index)) continue;
      await assertLease();
      const part = parts[index];
      let attachmentId: string | undefined;
      if ('file' in part) {
        const response = await this.inquiries.chat.download(part.file.id, route.id);
        attachmentId = await this.files
          .fromResponse(
            response,
            part.file.name,
            part.file.mime,
            async (upload) => {
              await this.inspection.inspect(
                upload.path,
                upload.originalname,
                upload.size,
                upload.mimetype,
              );
              return connection.platform === 'vk'
                ? this.vk.upload(connection, route.external_chat_id!, upload)
                : this.avito.upload(connection, upload);
            },
            part.file.size,
          )
          .catch((error: unknown) => {
            // Загрузка файла ещё не отправляет сообщение: её можно безопасно повторять.
            if (error instanceof ChannelError)
              throw new ChannelError(
                error.code,
                error.retryable,
                false,
                error.retryAfter,
              );
            throw error;
          });
      }
      await assertLease();
      await this.db.query(
        'UPDATE channel_outbox SET sending_part=$3 WHERE id=$1 AND lease_token=$2',
        [job.id, job.lease_token, index],
      );
      let externalId: string;
      try {
        externalId =
          connection.platform === 'vk'
            ? await this.vk.send(
                connection,
                route.external_chat_id,
                'text' in part ? part.text : '',
                attachmentId ? [attachmentId] : [],
                job.random_id! * 1024 + index,
              )
            : await this.avito.send(
                connection,
                route.external_chat_id,
                'text' in part ? part.text : '',
                attachmentId,
              );
      } catch (error) {
        if (
          connection.platform === 'vk' ||
          (error instanceof ChannelError && !error.uncertain)
        ) {
          await this.db.query(
            'UPDATE channel_outbox SET sending_part=NULL WHERE id=$1 AND lease_token=$2',
            [job.id, job.lease_token],
          );
          if (error instanceof ChannelError)
            throw new ChannelError(error.code, error.retryable, false, error.retryAfter);
        }
        if (connection.platform === 'avito')
          throw new ChannelError('AVITO_DELIVERY_UNCONFIRMED', false, true);
        throw error;
      }
      progress.push({ index, externalId });
      await this.db
        .transaction(async (transaction): Promise<void> => {
          const updated = await transaction.query(
            'UPDATE channel_outbox SET progress=$3,sending_part=NULL WHERE id=$1 AND lease_token=$2 AND state=$4 RETURNING id',
            [job.id, job.lease_token, JSON.stringify(progress), 'working'],
          );
          if (!updated.rowCount)
            throw new ChannelError(
              'CHANNEL_LEASE_LOST',
              true,
              connection.platform === 'avito',
            );
          await transaction.query(
            'INSERT INTO channel_message_receipts(connection_id,external_chat_id,external_message_id,message_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
            [connection.id, route.external_chat_id, externalId, job.id],
          );
        })
        .catch((error: unknown) => {
          if (connection.platform === 'avito')
            throw new ChannelError('AVITO_DELIVERY_UNCONFIRMED', false, true);
          throw error;
        });
    }
  }

  /** Список маршрутов содержит только данные для выбора адресата, без внешних ключей. */
  async routes(inquiryId: string): Promise<unknown[]> {
    const rows = await this.db.query<
      ReplyRoute & { enabled: boolean; expires_at: Date | null }
    >(
      `SELECT r.*,COALESCE(c.enabled,true) AS enabled,g.expires_at FROM reply_routes r LEFT JOIN channel_connections c ON c.id=r.connection_id LEFT JOIN guest_sessions g ON g.id=r.id WHERE r.inquiry_id=$1 ORDER BY last_inbound_at DESC,id`,
      [inquiryId],
    );
    return rows.rows.map((route) => ({
      id: route.id,
      channel: route.channel,
      name: route.source.name,
      title: route.source.title,
      pageUrl: route.source.pageUrl,
      canReply:
        route.enabled &&
        (route.channel !== 'widget' ||
          (!!route.expires_at && route.expires_at > new Date())),
      capabilities: capabilities[route.channel],
    }));
  }

  /** Проверяет выбранный маршрут до сохранения менеджерского ответа. */
  async replyRoute(
    inquiryId: string,
    routeId: string,
  ): Promise<{ id: string; source: Record<string, unknown> }> {
    const route = (
      await this.db.query<ReplyRoute>(
        'SELECT * FROM reply_routes WHERE id=$1 AND inquiry_id=$2',
        [routeId, inquiryId],
      )
    ).rows[0];
    if (!route) throw new NotFoundException('Канал не принадлежит обращению');
    if (route.connection_id) this.configured(route.connection_id);
    else if (
      !(
        await this.db.query(
          'SELECT id FROM guest_sessions WHERE id=$1 AND expires_at>now()',
          [routeId],
        )
      ).rowCount
    )
      throw new ConflictException('Посетитель завершил сессию. Выберите другой канал');
    return { id: route.id, source: route.source };
  }

  /** Повтор неопределённой отправки требует явного подтверждения после проверки переписки. */
  async retry(inquiryId: string, messageId: string, checked: boolean): Promise<void> {
    await this.db.transaction(async (transaction) => {
      const row = (
        await transaction.query<{ state: string }>(
          'SELECT state FROM channel_outbox WHERE id=$1 AND inquiry_id=$2 FOR UPDATE',
          [messageId, inquiryId],
        )
      ).rows[0];
      if (!row) throw new NotFoundException('Отправка не найдена');
      if (row.state === 'uncertain' && !checked)
        throw new ConflictException(
          'Сначала проверьте исходную переписку: сообщение могло быть отправлено',
        );
      await transaction.query(
        "UPDATE channel_outbox SET state='pending',attempts=0,sending_part=NULL,locked_until=NULL,lease_token=NULL,queued_until=NULL,next_attempt_at=now() WHERE id=$1 AND state IN ('failed','uncertain')",
        [messageId],
      );
    });
    await this.queue.enqueue('channel-outbox', messageId);
  }

  /** Проверив исходную переписку, менеджер может подтвердить спорную часть без её повторной отправки. */
  async confirmPart(
    inquiryId: string,
    messageId: string,
    actorId: string,
  ): Promise<void> {
    await this.db.transaction(async (transaction) => {
      const row = (
        await transaction.query<{
          state: string;
          sending_part: number | null;
          progress: DeliveredPart[];
        }>(
          'SELECT state,sending_part,progress FROM channel_outbox WHERE id=$1 AND inquiry_id=$2 FOR UPDATE',
          [messageId, inquiryId],
        )
      ).rows[0];
      if (!row || row.state !== 'uncertain' || row.sending_part === null)
        throw new ConflictException('Нет части сообщения, ожидающей подтверждения');
      const progress = [
        ...row.progress.filter((part) => part.index !== row.sending_part),
        { index: row.sending_part, externalId: '', confirmedBy: actorId },
      ];
      await transaction.query(
        "UPDATE channel_outbox SET progress=$2,state='pending',sending_part=NULL,attempts=0,lease_token=NULL,locked_until=NULL,queued_until=NULL,next_attempt_at=now() WHERE id=$1",
        [messageId, JSON.stringify(progress)],
      );
    });
    this.security.audit('channel_delivery_confirmed_by_manager');
    await this.queue.enqueue('channel-outbox', messageId);
  }
}
