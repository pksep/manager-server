import {
  ForbiddenException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { z } from 'zod';
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
      if (!response.ok) throw new Error(`chat_http_${response.status}`);
      return response;
    } catch {
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
    const form = new FormData();
    form.set('id', id);
    form.set('guestSessionId', sessionId);
    form.set(
      'file',
      new Blob([new Uint8Array(file.buffer)], { type: file.mimetype }),
      file.originalname,
    );
    return AttachmentSchema.parse(
      await (await this.request('/attachments', { method: 'POST', body: form })).json(),
    );
  }
  async download(id: string, sessionId: string) {
    return this.request(
      `/attachments/${id}?guestSessionId=${encodeURIComponent(sessionId)}`,
    );
  }
}
