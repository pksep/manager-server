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
import type { PoolClient } from 'pg';
import { CONFIG, type Config } from './config';
import { Database } from './database';
import { ChatAdapter } from './chat-adapter';
import {
  SessionRequestSchema,
  SendRequestSchema,
  type WidgetMessage,
  type Attachment,
  type Site,
  type ChatEvent,
} from './contracts';
import { normalizeContacts } from './identity';
import { multipartFilename } from './filename';

export const hash = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');
export interface Guest {
  id: string;
  site_id: string;
  source: Record<string, unknown>;
  origin: string;
  expires_at: Date;
}
type MessageRow = {
  id: string;
  inquiry_id: string;
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
  ) {}
  async onModuleInit() {
    const version = await this.database.query(
      'SELECT version FROM manager_schema_migrations WHERE version=3',
    );
    if (!version.rowCount) throw new Error('Сначала примените миграции manager');
    for (const site of this.config.sites)
      await this.database.query(
        'INSERT INTO sites(id,name,origins,widget_origins,config,enabled) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO UPDATE SET name=excluded.name,origins=excluded.origins,widget_origins=excluded.widget_origins,config=excluded.config,enabled=excluded.enabled',
        [
          site.id,
          site.name,
          JSON.stringify(site.origins),
          JSON.stringify(site.widgetOrigins),
          site.config,
          site.enabled,
        ],
      );
  }
  site(id: string): Site {
    const site = this.config.sites.find((site) => site.id === id && site.enabled);
    if (!site) throw new NotFoundException('Сайт не подключён');
    return site;
  }
  async ready() {
    const result = await this.database.query<{ count: string }>(
      "SELECT count(*) FROM delivery_operations WHERE state IN ('pending','working')",
    );
    if (Number(result.rows[0].count) >= this.config.MANAGER_QUEUE_LIMIT)
      throw new ServiceUnavailableException('Приём обращений временно приостановлен');
  }
  /** Ограничивает публичный приём совместно для всех экземпляров сервиса. */
  async rateLimit(key: string, limit: number) {
    const result = await this.database.query<{ count: number }>(
      `INSERT INTO rate_buckets(key,window_start,count) VALUES($1,now(),1) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN rate_buckets.window_start<now()-interval '1 minute' THEN 1 ELSE rate_buckets.count+1 END, window_start=CASE WHEN rate_buckets.window_start<now()-interval '1 minute' THEN now() ELSE rate_buckets.window_start END RETURNING count`,
      [key],
    );
    if (result.rows[0].count > limit)
      throw new HttpException('Слишком много запросов', 429);
  }
  async guest(token: string, origin: string): Promise<Guest> {
    if (!/^[a-f0-9]{64}$/.test(token))
      throw new UnauthorizedException('Сессия недействительна');
    const result = await this.database.query<Guest>(
      'SELECT id,site_id,source,origin,expires_at FROM guest_sessions WHERE token_hash=$1 AND expires_at>now()',
      [hash(token)],
    );
    const guest = result.rows[0];
    if (
      !guest ||
      guest.origin !== origin ||
      !this.site(guest.site_id).widgetOrigins.includes(origin)
    )
      throw new UnauthorizedException('Сессия недействительна');
    return guest;
  }
  async session(body: unknown, origin: string, token: string) {
    const input = SessionRequestSchema.parse(body),
      site = this.site(input.siteId);
    const pageUrl = new URL(input.source.pageUrl);
    if (!site.widgetOrigins.includes(origin) || !site.origins.includes(pageUrl.origin))
      throw new ForbiddenException('Источник не разрешён');
    await this.ready();
    let guest: Guest;
    if (token) {
      guest = await this.guest(token, origin);
      if (guest.site_id !== site.id) throw new ForbiddenException('Сессия другого сайта');
    } else {
      token = randomBytes(32).toString('hex');
      const source = {
        siteId: site.id,
        name: site.name,
        channel: 'widget',
        pageUrl: pageUrl.origin + pageUrl.pathname,
        title: input.source.title,
        referrerOrigin: input.source.referrerOrigin,
      };
      const result = await this.database.query<Guest>(
        "INSERT INTO guest_sessions(id,token_hash,site_id,origin,source,expires_at) VALUES($1,$2,$3,$4,$5,now()+$6*interval '1 hour') RETURNING id,site_id,source,origin,expires_at",
        [
          randomUUID(),
          hash(token),
          site.id,
          origin,
          source,
          this.config.MANAGER_SESSION_HOURS,
        ],
      );
      guest = result.rows[0];
    }
    return {
      token,
      config: site.config,
      serverTime: new Date().toISOString(),
      ...(await this.snapshot(guest)),
    };
  }
  /** Возвращает только диалог этой гостевой сессии, даже после связывания клиентов. */
  async snapshot(guest: Guest) {
    const inquiry = (
      await this.database.query<{ id: string }>(
        'SELECT id FROM inquiries WHERE session_id=$1',
        [guest.id],
      )
    ).rows[0];
    if (!inquiry) return { inquiryId: null, messages: [] as WidgetMessage[] };
    const result = await this.database.query<MessageRow>(
      `SELECT ${messageFields} FROM (SELECT * FROM messages WHERE inquiry_id=$1 ORDER BY sequence DESC LIMIT 500) current_messages ORDER BY sequence`,
      [inquiry.id],
    );
    return { inquiryId: inquiry.id, messages: result.rows.map(presentMessage) };
  }
  async history(guest: Guest, inquiryId: string, after: string) {
    if (!/^\d{1,18}$/.test(after)) throw new BadRequestException('Некорректный курсор');
    const inquiry = await this.database.query(
      'SELECT id FROM inquiries WHERE id=$1 AND session_id=$2',
      [inquiryId, guest.id],
    );
    if (!inquiry.rowCount) throw new NotFoundException('Обращение не найдено');
    const result = await this.database.query<MessageRow & { sequence: string }>(
      `SELECT ${messageFields},sequence FROM messages WHERE inquiry_id=$1 AND sequence>$2 ORDER BY sequence LIMIT 100`,
      [inquiryId, after],
    );
    return {
      messages: result.rows.map(presentMessage),
      nextCursor: result.rows.at(-1)?.sequence ?? after,
    };
  }
  async send(guest: Guest, body: unknown, inquiryId?: string) {
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
    return this.database.transaction(async (client) => {
      await client.query('SELECT id FROM guest_sessions WHERE id=$1 FOR UPDATE', [
        guest.id,
      ]);
      let inquiry = (
        await client.query('SELECT * FROM inquiries WHERE session_id=$1 FOR UPDATE', [
          guest.id,
        ])
      ).rows[0];
      if (inquiryId && inquiry?.id !== inquiryId)
        throw new NotFoundException('Обращение не найдено');
      if (inquiry) {
        const existing = (
          await client.query(
            'SELECT * FROM messages WHERE inquiry_id=$1 AND operation_id=$2',
            [inquiry.id, input.operationId],
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
        const customerId = randomUUID(),
          id = randomUUID();
        await client.query('INSERT INTO customers(id,name,contacts) VALUES($1,$2,$3)', [
          customerId,
          input.contacts.name,
          input.contacts,
        ]);
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
            'INSERT INTO inquiries(id,session_id,site_id,customer_id,source) VALUES($1,$2,$3,$4,$5) RETURNING *',
            [id, guest.id, site.id, customerId, guest.source],
          )
        ).rows[0];
      }
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
          "INSERT INTO messages(id,inquiry_id,operation_id,fingerprint,direction,author,html,attachments) VALUES($1,$2,$3,$4,'outgoing',$5,$6,$7) RETURNING *",
          [
            id,
            inquiry.id,
            input.operationId,
            fingerprint,
            author,
            html,
            JSON.stringify(attachments),
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
    const fingerprint = hash(
      Buffer.concat([Buffer.from(`${name}\0${file.mimetype}\0`), file.buffer]),
    );
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
        if (existing.fingerprint !== fingerprint)
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
  async publish(client: PoolClient, sessionId: string, messageId: string) {
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
        let messageId: string | undefined;
        if (event.direction === 'outgoing') {
          const updated = await client.query(
            'UPDATE messages SET chat_message_id=$1,read_at=COALESCE(read_at,$2) WHERE inquiry_id=$3 AND (chat_message_id=$1 OR id=$4) RETURNING id',
            [event.messageId, event.readAt ?? null, inquiryId, event.operationId ?? null],
          );
          messageId = updated.rows[0]?.id;
        } else if (event.type === 'message') {
          messageId = event.messageId;
          for (const file of event.attachments)
            await client.query(
              'INSERT INTO attachments(id,session_id,operation_id,fingerprint,name,size,mime,chat_id,inquiry_id) VALUES($1,$2,$3,$4,$5,$6,$7,$1,$8) ON CONFLICT(id) DO NOTHING',
              [
                file.id,
                header.session_id,
                `chat:${file.id}`,
                'chat',
                file.name,
                file.size,
                file.mime,
                inquiryId,
              ],
            );
          await client.query(
            "INSERT INTO messages(id,inquiry_id,direction,author,actor_id,avatar_url,html,attachments,chat_message_id,created_at) VALUES($1,$2,'incoming',$3,$4,$5,$6,$7,$1,$8) ON CONFLICT(id) DO NOTHING",
            [
              messageId,
              inquiryId,
              event.author,
              event.senderId,
              event.avatarUrl ?? null,
              event.html,
              JSON.stringify(event.attachments),
              event.createdAt,
            ],
          );
          const assigned = await client.query(
            'UPDATE inquiries SET assignee_id=$2 WHERE id=$1 AND assignee_id IS NULL AND NOT manually_assigned RETURNING id',
            [inquiryId, event.senderId],
          );
          if (assigned.rowCount)
            await client.query(
              "INSERT INTO assignment_events(id,inquiry_id,user_id,reason) VALUES($1,$2,$3,'first_reply')",
              [randomUUID(), inquiryId, event.senderId],
            );
        }
        if (messageId) await this.publish(client, header.session_id, messageId);
        cursor = event.sequence;
      }
      await client.query('UPDATE inquiries SET chat_cursor=$2 WHERE id=$1', [
        inquiryId,
        cursor,
      ]);
    });
  }
}
