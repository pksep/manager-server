import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
  type OnModuleInit,
} from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import sanitizeHtml from 'sanitize-html';
import { Op } from 'sequelize';
import { CONFIG, type Config } from './config';
import { Database, type DatabaseTransaction } from './database';
import { ChatAdapter } from './chat-adapter';
import {
  SessionRequestSchema,
  SendRequestSchema,
  type WidgetMessage,
  type Attachment,
  type Site,
  type ChatEvent,
} from './contracts';
import { normalizeContacts, resolveCustomer } from './identity';
import { multipartFilename } from './filename';
import { SecurityService, type SecurityContext } from './security';
import { FileInspection } from './secure-upload';
import { OperationQueue } from './operation-queue';
import { WidgetSettings } from './widget-settings';

export const hash = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');
export interface Guest {
  id: string;
  visitor_id?: string | null;
  site_id: string;
  source: Record<string, unknown>;
  origin: string;
  expires_at: Date;
}
export type MessageRow = {
  id: string;
  inquiry_id: string;
  session_id: string;
  direction: 'incoming' | 'outgoing';
  author: string;
  avatar_url?: string;
  html: string;
  attachments: Attachment[];
  created_at: Date;
  read_at?: Date;
  operation_id?: string;
};
export function presentMessage(row: MessageRow): WidgetMessage {
  return {
    id: row.id,
    inquiryId: row.inquiry_id,
    direction: row.direction,
    author: row.author,
    html: row.html,
    attachments: row.attachments,
    createdAt: row.created_at.toISOString(),
    ...(row.read_at ? { readAt: row.read_at.toISOString() } : {}),
    ...(row.avatar_url ? { avatarUrl: row.avatar_url } : {}),
    ...(row.operation_id ? { operationId: row.operation_id } : {}),
  };
}
const messageFields =
  'id,inquiry_id,direction,author,avatar_url,html,attachments,created_at,read_at,operation_id';

@Injectable()
export class InquiriesService implements OnModuleInit {
  constructor(
    @Inject(Database) readonly database: Database,
    @Inject(CONFIG) readonly config: Config,
    @Inject(ChatAdapter) readonly chat: ChatAdapter,
    @Inject(SecurityService) readonly security: SecurityService,
    @Inject(FileInspection) private readonly files: FileInspection,
    @Inject(OperationQueue) readonly queue: OperationQueue,
    @Inject(WidgetSettings) private readonly settings: WidgetSettings,
  ) {}
  async onModuleInit() {
    const version = await this.database.query(
      'SELECT version FROM manager_schema_migrations WHERE version=7',
    );
    if (!version.rowCount) throw new Error('Сначала примените миграции manager');
    for (const site of this.config.sites)
      await this.database.models.Site.upsert({
        id: site.id,
        name: site.name,
        origins: site.origins,
        widget_origins: site.widgetOrigins,
        config: site.config,
        enabled: site.enabled,
      });
  }
  site(id: string): Site {
    const site = this.config.sites.find((site) => site.id === id && site.enabled);
    if (!site) throw new NotFoundException('Сайт не подключён');
    return site;
  }
  async ready() {
    this.security.assertReady();
    this.queue.assertReady();
    const result = await this.database.query<{ count: string }>(
      "SELECT count(*) FROM delivery_operations WHERE state IN ('pending','working')",
    );
    if (Number(result.rows[0].count) >= this.config.MANAGER_QUEUE_LIMIT)
      throw new ServiceUnavailableException('Приём обращений временно приостановлен');
  }
  /** Ограничивает публичный приём совместно для всех экземпляров сервиса. */
  async rateLimit(key: string, limit: number) {
    await this.security.consume([{ key, capacity: limit, window: 60000 }]);
  }
  async guest(token: string, origin: string): Promise<Guest> {
    if (!/^[a-f0-9]{64}$/.test(token))
      throw new UnauthorizedException('Сессия недействительна');
    const model = await this.database.models.GuestSession.findOne({
      where: { token_hash: hash(token), expires_at: { [Op.gt]: new Date() } },
      attributes: ['id', 'site_id', 'source', 'origin', 'expires_at', 'visitor_id'],
    });
    const guest = model?.get({ plain: true });
    if (
      !guest ||
      guest.origin !== origin ||
      !this.site(guest.site_id).widgetOrigins.includes(origin)
    )
      throw new UnauthorizedException('Сессия недействительна');
    return guest;
  }
  async session(body: unknown, origin: string, token: string, context: SecurityContext) {
    const input = SessionRequestSchema.parse(body),
      site = this.site(input.siteId);
    const pageUrl = new URL(input.source.pageUrl);
    if (!site.widgetOrigins.includes(origin) || !site.origins.includes(pageUrl.origin))
      throw new ForbiddenException('Источник не разрешён');
    await this.ready();
    const visitorToken = this.security.visitor(input.visitorToken);
    let guest: Guest;
    if (token) {
      guest = await this.guest(token, origin);
      if (guest.site_id !== site.id) throw new ForbiddenException('Сессия другого сайта');
    } else {
      await this.security.newSession(context, site.id, visitorToken);
      token = randomBytes(32).toString('hex');
      const source = {
        siteId: site.id,
        name: site.name,
        channel: 'widget',
        pageUrl: pageUrl.origin + pageUrl.pathname,
        title: input.source.title,
        referrerOrigin: input.source.referrerOrigin,
      };
      const result = await this.database.models.GuestSession.create({
        id: randomUUID(),
        visitor_id: visitorToken.split('.')[0],
        token_hash: hash(token),
        site_id: site.id,
        origin,
        source,
        expires_at: new Date(Date.now() + this.config.MANAGER_SESSION_HOURS * 3600000),
      });
      guest = result.get({ plain: true });
    }
    return {
      token,
      visitorToken,
      config: this.settings.publicConfig(site.config),
      serverTime: new Date().toISOString(),
      ...(await this.snapshot(guest)),
    };
  }
  /** Возвращает только диалог этой гостевой сессии, даже после связывания клиентов. */
  async snapshot(guest: Guest) {
    const inquiry = (
      await this.database.query<{ id: string }>(
        'SELECT inquiry_id AS id FROM guest_sessions WHERE id=$1 AND inquiry_id IS NOT NULL',
        [guest.id],
      )
    ).rows[0];
    if (!inquiry) return { inquiryId: null, messages: [] as WidgetMessage[] };
    const result = await this.database.query<MessageRow>(
      `SELECT ${messageFields} FROM (SELECT * FROM messages WHERE inquiry_id=$1 AND session_id=$2 ORDER BY sequence DESC LIMIT 500) current_messages ORDER BY sequence`,
      [inquiry.id, guest.id],
    );
    return { inquiryId: inquiry.id, messages: result.rows.map(presentMessage) };
  }
  async history(guest: Guest, inquiryId: string, after: string) {
    if (!/^\d{1,18}$/.test(after)) throw new BadRequestException('Некорректный курсор');
    const inquiry = await this.database.query(
      'SELECT i.id FROM guest_sessions g JOIN inquiries i ON i.id=g.inquiry_id WHERE g.id=$2 AND (i.id=$1 OR EXISTS(SELECT 1 FROM inquiries old WHERE old.id=$1 AND old.merged_into=i.id))',
      [inquiryId, guest.id],
    );
    if (!inquiry.rowCount) throw new NotFoundException('Обращение не найдено');
    const result = await this.database.query<MessageRow & { sequence: string }>(
      `SELECT ${messageFields},sequence FROM messages WHERE inquiry_id=$1 AND session_id=$3 AND sequence>$2 ORDER BY sequence LIMIT 100`,
      [inquiry.rows[0].id, after, guest.id],
    );
    return {
      messages: result.rows.map(presentMessage),
      nextCursor: result.rows.at(-1)?.sequence ?? after,
    };
  }
  async send(guest: Guest, body: unknown, inquiryId?: string, context?: SecurityContext) {
    const input = SendRequestSchema.parse(body),
      site = this.site(guest.site_id);
    const html = sanitizeHtml(input.html, {
      allowedTags: [
        'p',
        'br',
        'strong',
        'b',
        'em',
        'i',
        'u',
        's',
        'ul',
        'ol',
        'li',
        'blockquote',
        'code',
      ],
      allowedAttributes: {},
    });
    const text = sanitizeHtml(html, {
      allowedTags: [],
      allowedAttributes: {},
    }).trim();
    if (
      (!text && !input.attachmentIds.length) ||
      text.length > site.config.limits.messageChars ||
      input.attachmentIds.length > site.config.limits.fileCount ||
      new Set(input.attachmentIds).size !== input.attachmentIds.length
    )
      throw new BadRequestException('Проверьте текст и вложения');
    const normalized = input.contacts
      ? normalizeContacts(input.contacts, site.config.contactPolicy)
      : undefined;
    const fingerprint = hash(
      JSON.stringify({
        html,
        ids: [...input.attachmentIds].sort(),
        contacts: input.contacts ?? null,
      }),
    );
    const result = await this.database.transaction(async (client) => {
      await client.query('SELECT id FROM guest_sessions WHERE id=$1 FOR UPDATE', [
        guest.id,
      ]);
      let inquiry = (
        await client.query(
          'SELECT i.* FROM inquiries i JOIN guest_sessions g ON g.inquiry_id=i.id WHERE g.id=$1 FOR UPDATE OF i',
          [guest.id],
        )
      ).rows[0];
      if (inquiryId && inquiry?.id !== inquiryId) {
        const alias =
          inquiry &&
          (await client.query('SELECT id FROM inquiries WHERE id=$1 AND merged_into=$2', [
            inquiryId,
            inquiry.id,
          ]));
        if (!alias?.rowCount) throw new NotFoundException('Обращение не найдено');
      }
      if (inquiry) {
        const existing = (
          await client.query<MessageRow & { fingerprint: string }>(
            'SELECT * FROM messages WHERE session_id=$1 AND operation_id=$2',
            [guest.id, input.operationId],
          )
        ).rows[0];
        if (existing) {
          if (existing.fingerprint !== fingerprint)
            throw new ConflictException('Этот ключ уже использован для другой отправки');
          return {
            inquiryId: inquiry.id as string,
            message: presentMessage(existing),
          };
        }
        if (!inquiryId) throw new ConflictException('В этой сессии уже есть обращение');
        if (inquiry.status !== 'OPEN') throw new ConflictException('Обращение закрыто');
      }
      if (!context) throw new ForbiddenException('Источник запроса не определён');
      context.visitor = guest.visitor_id || guest.id;
      await this.security.message(
        context,
        guest.site_id,
        guest.id,
        input.operationId,
        text,
        input.attachmentIds,
        !inquiry,
      );
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('manager:queue-capacity'))",
      );
      const count = (
        await client.query(
          "SELECT count(*) FROM delivery_operations WHERE state IN ('pending','working')",
        )
      ).rows[0].count;
      if (Number(count) >= this.config.MANAGER_QUEUE_LIMIT)
        throw new ServiceUnavailableException('Очередь приёма заполнена');
      const uploads = (
        await client.query(
          'SELECT * FROM attachments WHERE id=ANY($1::uuid[]) AND session_id=$2 AND chat_id IS NOT NULL FOR UPDATE',
          [input.attachmentIds, guest.id],
        )
      ).rows;
      if (
        uploads.length !== input.attachmentIds.length ||
        uploads.some((file) => file.inquiry_id && file.inquiry_id !== inquiry?.id)
      )
        throw new ForbiddenException('Вложение недоступно этой сессии');
      if (!inquiry) {
        if (!input.contacts || !normalized)
          throw new BadRequestException('Оставьте контакты');
        const customerId = await resolveCustomer(client, input.contacts, normalized);
        for (const [kind, value] of Object.entries({
          session: guest.id,
          ...normalized,
        }))
          if (value)
            await client.query(
              'INSERT INTO customer_identities(id,customer_id,site_id,kind,value,verified) VALUES($1,$2,$3,$4,$5,$6)',
              [randomUUID(), customerId, site.id, kind, value, kind === 'session'],
            );
        inquiry = (
          await client.query(
            "SELECT * FROM inquiries WHERE customer_id=$1 AND status='OPEN' AND merged_into IS NULL FOR UPDATE",
            [customerId],
          )
        ).rows[0];
        if (!inquiry)
          inquiry = (
            await client.query(
              'INSERT INTO inquiries(id,session_id,site_id,customer_id,source) VALUES($1,$2,$3,$4,$5) RETURNING *',
              [randomUUID(), guest.id, site.id, customerId, guest.source],
            )
          ).rows[0];
        await client.query('UPDATE guest_sessions SET inquiry_id=$2 WHERE id=$1', [
          guest.id,
          inquiry.id,
        ]);
      }
      await client.query('UPDATE inquiries SET source=$2 WHERE id=$1', [
        inquiry.id,
        guest.source,
      ]);
      const author = (
        await client.query<{ name: string }>('SELECT name FROM customers WHERE id=$1', [
          inquiry.customer_id,
        ])
      ).rows[0].name;
      const attachments: Attachment[] = input.attachmentIds.map((id) => {
        const file = uploads.find((file) => file.id === id)!;
        return {
          id,
          name: file.name,
          size: Number(file.size),
          mime: file.mime,
        };
      });
      const id = randomUUID();
      const message = (
        await client.query<MessageRow>(
          "INSERT INTO messages(id,inquiry_id,operation_id,fingerprint,direction,author,html,attachments,session_id) VALUES($1,$2,$3,$4,'outgoing',$5,$6,$7,$8) RETURNING *",
          [
            id,
            inquiry.id,
            input.operationId,
            fingerprint,
            author,
            html,
            JSON.stringify(attachments),
            guest.id,
          ],
        )
      ).rows[0];
      await client.query(
        'UPDATE attachments SET inquiry_id=$1 WHERE id=ANY($2::uuid[])',
        [inquiry.id, input.attachmentIds],
      );
      await client.query('INSERT INTO delivery_operations(id,inquiry_id) VALUES($1,$2)', [
        id,
        inquiry.id,
      ]);
      await this.publish(client, guest.id, id);
      return {
        inquiryId: inquiry.id as string,
        message: presentMessage(message),
      };
    });
    await this.queue.enqueue('delivery', result.message.id);
    return result;
  }
  async upload(
    guest: Guest,
    operationId: string,
    file?: Express.Multer.File,
  ): Promise<Attachment> {
    if (!file || !/^[\w:-]{1,100}$/.test(operationId))
      throw new BadRequestException('Выберите файл');
    if (file.size > this.site(guest.site_id).config.limits.fileBytes)
      throw new HttpException('Файл слишком большой', 413);
    const name =
      multipartFilename(file.originalname)
        .replace(/[\x00-\x1f/\\]/g, '_')
        .slice(0, 255) || 'Файл';
    const inspected = await this.files.inspect(file.path, name, file.size, file.mimetype);
    file.mimetype = inspected.mime;
    const fingerprint = inspected.fingerprint;
    const attachment = await this.database.transaction(async (client) => {
      await client.query('SELECT id FROM guest_sessions WHERE id=$1 FOR UPDATE', [
        guest.id,
      ]);
      const existing = (
        await client.query(
          'SELECT * FROM attachments WHERE session_id=$1 AND operation_id=$2',
          [guest.id, operationId],
        )
      ).rows[0];
      if (existing) {
        if (
          existing.fingerprint !== fingerprint &&
          existing.fingerprint !== inspected.legacyFingerprint
        )
          throw new ConflictException('Ключ загрузки уже использован');
        return existing;
      }
      const count = Number(
        (
          await client.query(
            'SELECT count(*) FROM attachments WHERE session_id=$1 AND inquiry_id IS NULL',
            [guest.id],
          )
        ).rows[0].count,
      );
      if (count >= this.site(guest.site_id).config.limits.fileCount)
        throw new HttpException('Слишком много незавершённых вложений', 429);
      return (
        await client.query(
          'INSERT INTO attachments(id,session_id,operation_id,fingerprint,name,size,mime) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',
          [
            randomUUID(),
            guest.id,
            operationId,
            fingerprint,
            name,
            file.size,
            file.mimetype,
          ],
        )
      ).rows[0];
    });
    if (!attachment.chat_id) {
      const receipt = await this.chat.upload(attachment.id, guest.id, {
        ...file,
        originalname: name,
      });
      if (receipt.id !== attachment.id || receipt.size !== file.size)
        throw new ServiceUnavailableException('Чат не подтвердил загрузку файла');
      await this.database.query('UPDATE attachments SET chat_id=$1 WHERE id=$1', [
        attachment.id,
      ]);
    }
    return { id: attachment.id, name, size: file.size, mime: file.mimetype };
  }
  async download(guest: Guest, id: string) {
    const result = await this.database.query(
      'SELECT * FROM attachments WHERE id=$1 AND session_id=$2 AND chat_id IS NOT NULL',
      [id, guest.id],
    );
    if (!result.rowCount) throw new NotFoundException('Файл недоступен');
    return {
      response: await this.chat.download(result.rows[0].chat_id, guest.id),
      file: result.rows[0],
    };
  }
  async publish(client: DatabaseTransaction, sessionId: string, messageId: string) {
    await client.query('INSERT INTO widget_events(session_id,message_id) VALUES($1,$2)', [
      sessionId,
      messageId,
    ]);
  }
  /** Применяет события строго по порядку чата; чужие ответы не меняют ответственного. */
  async acceptEvents(inquiryId: string, events: ChatEvent[]) {
    if (!events.length) return;
    await this.database.transaction(async (client) => {
      const header = (
        await client.query('SELECT session_id FROM inquiries WHERE id=$1', [inquiryId])
      ).rows[0];
      if (!header) throw new NotFoundException('Обращение не найдено');
      await client.query('SELECT id FROM guest_sessions WHERE id=$1 FOR UPDATE', [
        header.session_id,
      ]);
      const inquiry = (
        await client.query('SELECT * FROM inquiries WHERE id=$1 FOR UPDATE', [inquiryId])
      ).rows[0];
      let cursor = Number(inquiry.chat_cursor);
      for (const event of events) {
        if (event.sequence <= cursor) continue;
        if (event.sequence !== cursor + 1)
          throw new ConflictException('Пропуск в событиях чата');
        const recipient = await client.query(
          'SELECT id FROM guest_sessions WHERE id=$1 AND inquiry_id=$2',
          [event.guestSessionId, inquiryId],
        );
        if (!recipient.rowCount)
          throw new ConflictException('Сессия события не связана с обращением');
        let messageId: string | undefined;
        let sessionId = event.guestSessionId;
        if (event.direction === 'outgoing') {
          const updated = await client.query(
            'UPDATE messages SET chat_message_id=$1,read_at=COALESCE(read_at,$2) WHERE inquiry_id=$3 AND (chat_message_id=$1 OR id=$4) RETURNING id,session_id',
            [event.messageId, event.readAt ?? null, inquiryId, event.operationId ?? null],
          );
          messageId = updated.rows[0]?.id;
          sessionId = updated.rows[0]?.session_id || sessionId;
        } else if (event.type === 'message') {
          messageId = event.messageId;
          for (const file of event.attachments)
            await client.query(
              'INSERT INTO attachments(id,session_id,operation_id,fingerprint,name,size,mime,chat_id,inquiry_id) VALUES($1,$2,$3,$4,$5,$6,$7,$1,$8) ON CONFLICT(id) DO NOTHING',
              [
                file.id,
                sessionId,
                `chat:${file.id}`,
                'chat',
                file.name,
                file.size,
                file.mime,
                inquiryId,
              ],
            );
          await client.query(
            "INSERT INTO messages(id,inquiry_id,direction,author,actor_id,avatar_url,html,attachments,chat_message_id,created_at,session_id) VALUES($1,$2,'incoming',$3,$4,$5,$6,$7,$1,$8,$9) ON CONFLICT(id) DO NOTHING",
            [
              messageId,
              inquiryId,
              event.author,
              event.senderId,
              event.avatarUrl ?? null,
              sanitizeHtml(event.html, {
                allowedTags: [
                  'p',
                  'br',
                  'strong',
                  'b',
                  'em',
                  'i',
                  'u',
                  's',
                  'ul',
                  'ol',
                  'li',
                  'blockquote',
                  'code',
                  'a',
                ],
                allowedAttributes: { a: ['href', 'title'] },
                allowedSchemes: ['https', 'http', 'mailto'],
                allowProtocolRelative: false,
              }),
              JSON.stringify(event.attachments),
              event.createdAt,
              sessionId,
            ],
          );
          const assigned = await client.query(
            'UPDATE inquiries SET assignee_id=$2,manager_ids=ARRAY[$2::uuid],metadata_version=metadata_version+1 WHERE id=$1 AND assignee_id IS NULL AND NOT manually_assigned RETURNING id',
            [inquiryId, event.senderId],
          );
          if (assigned.rowCount)
            await client.query(
              "INSERT INTO assignment_events(id,inquiry_id,user_id,reason) VALUES($1,$2,$3,'first_reply')",
              [randomUUID(), inquiryId, event.senderId],
            );
        }
        if (messageId) await this.publish(client, sessionId, messageId);
        cursor = event.sequence;
      }
      await client.query('UPDATE inquiries SET chat_cursor=$2 WHERE id=$1', [
        inquiryId,
        cursor,
      ]);
    });
  }
}
