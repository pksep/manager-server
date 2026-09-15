import {
  ForbiddenException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { z } from 'zod';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { CONFIG, type Config } from './config';
import {
  AttachmentSchema,
  ChatEventSchema,
  ChatReceiptSchema,
  type Contacts,
} from './contracts';

@Injectable()
export class ChatAdapter {
  /** Проверяет право сотрудника по тому же источнику, что использует СЭП Чат. */
  async assertManager(id: string) {
    await this.request(`/managers/${encodeURIComponent(id)}/access`);
  }
  /** Связь с ЕРП выдаёт доверенный поставщик прав, а не редактируемый профиль. */
  async erpActor(id: string): Promise<number> {
    const grant = z
      .object({
        allowed: z.literal(true),
        erpUserId: z.number().int().positive().nullable(),
      })
      .parse(await (await this.request(`/managers/${id}/access`)).json());
    if (!grant.erpUserId) throw new ForbiddenException('Учётная запись не связана с ЕРП');
    return grant.erpUserId;
  }
  constructor(@Inject(CONFIG) private readonly config: Config) {}
  /** Все обращения к чату остаются серверными; гостевой токен здесь не используется. */
  async request(path: string, init: RequestInit = {}) {
    try {
      const headers = new Headers(init.headers);
      headers.set('x-manager-key', this.config.CHAT_MANAGER_KEY);
      const response = await fetch(
        `${this.config.CHAT_SERVICE_URL.replace(/\/$/, '')}/internal/manager${path}`,
        {
          ...init,
          headers,
          signal: AbortSignal.timeout(10000),
          redirect: 'error',
        },
      );
      if (response.status === 403)
        throw new ForbiddenException('У сотрудника нет доступа к обращениям');
      if (!response.ok) throw new Error(`chat_http_${response.status}`);
      return response;
    } catch (error) {
      if (error instanceof ForbiddenException) throw error;
      throw new ServiceUnavailableException('Нет связи с СЭП Чатом');
    }
  }
  async ready() {
    const result = await (await this.request('/ready')).json();
    z.object({ ready: z.literal(true), version: z.literal(1) }).parse(result);
  }
  async deliver(
    inquiry: {
      id: string;
      session_id: string;
      customer_id: string;
      source: unknown;
      contacts: Contacts;
    },
    message: { id: string; html: string; attachmentIds: string[] },
  ) {
    return ChatReceiptSchema.parse(
      await (
        await this.request(`/inquiries/${inquiry.id}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            version: 1,
            operationId: message.id,
            guestSessionId: inquiry.session_id,
            customerId: inquiry.customer_id,
            customerName: inquiry.contacts.name,
            source: inquiry.source,
            html: message.html,
            attachmentIds: message.attachmentIds,
          }),
        })
      ).json(),
    );
  }
  async events(inquiryId: string, after: string) {
    return z
      .object({ events: z.array(ChatEventSchema).max(100) })
      .parse(
        await (
          await this.request(
            `/inquiries/${inquiryId}/events?after=${encodeURIComponent(after)}`,
          )
        ).json(),
      ).events;
  }
  async upload(id: string, sessionId: string, file: Express.Multer.File) {
    const boundary = `manager-${randomBytes(18).toString('hex')}`;
    const filename = file.originalname.replace(/["\r\n\\]/g, '_');
    const prefix = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="id"\r\n\r\n${id}\r\n--${boundary}\r\nContent-Disposition: form-data; name="guestSessionId"\r\n\r\n${sessionId}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${file.mimetype}\r\n\r\n`,
    );
    const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
    const source = createReadStream(file.path);
    const chunks = async function* (): AsyncGenerator<Buffer> {
      yield prefix;
      for await (const chunk of source)
        yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      yield suffix;
    };
    const stream = Readable.from(chunks());
    const init: RequestInit & { duplex: 'half' } = {
      method: 'POST',
      duplex: 'half',
      body: Readable.toWeb(stream) as ReadableStream<Uint8Array>,
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(prefix.length + file.size + suffix.length),
      },
    };
    try {
      return AttachmentSchema.parse(
        await (await this.request('/attachments', init)).json(),
      );
    } finally {
      source.destroy();
      stream.destroy();
    }
  }
  async download(id: string, sessionId: string) {
    return this.request(
      `/attachments/${id}?guestSessionId=${encodeURIComponent(sessionId)}`,
    );
  }
}
