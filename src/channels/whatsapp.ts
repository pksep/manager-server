import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { ChannelConnection } from './config';
import {
  capabilities,
  ChannelError,
  type IncomingFile,
  type IncomingMessage,
} from './contracts';
import { ChannelFiles } from './files';
import { ChannelHttp, readChannelJson } from './http-client';

const identifier = z.string().regex(/^[0-9]{1,32}$/);
const media = z.object({
  id: identifier,
  mime_type: z.string().max(255),
  caption: z.string().max(100000).optional(),
  filename: z.string().max(1024).optional(),
});

const messageSchema = z.object({
  from: identifier,
  id: z.string().min(1).max(512),
  timestamp: z.string().regex(/^[0-9]{1,12}$/),
  type: z.string().max(64),
  text: z.object({ body: z.string().max(100000) }).optional(),
  image: media.optional(),
  document: media.optional(),
  interactive: z
    .object({
      button_reply: z.object({ title: z.string().max(4096) }).optional(),
      list_reply: z.object({ title: z.string().max(4096) }).optional(),
    })
    .optional(),
  button: z.object({ text: z.string().max(4096) }).optional(),
});

export const WhatsAppValueSchema = z.object({
  messaging_product: z.literal('whatsapp'),
  metadata: z.object({ phone_number_id: identifier }),
  contacts: z
    .array(
      z.object({
        wa_id: identifier,
        profile: z.object({ name: z.string().max(512) }),
      }),
    )
    .max(100)
    .default([]),
  messages: z.array(messageSchema).max(100).default([]),
});

export const WhatsAppWebhookSchema = z.object({
  object: z.literal('whatsapp_business_account'),
  entry: z
    .array(
      z.object({
        id: identifier,
        changes: z.array(z.object({ field: z.string(), value: z.unknown() })).max(100),
      }),
    )
    .max(100),
});

/** Meta может прислать несколько сообщений сразу, каждое сохраняется своей операцией. */
export function whatsAppEvents(connection: ChannelConnection, body: unknown): unknown[] {
  if (connection.platform !== 'whatsapp')
    throw new ChannelError('WHATSAPP_CONFIGURATION');

  const result: unknown[] = [];

  for (const entry of WhatsAppWebhookSchema.parse(body).entry) {
    if (entry.id !== connection.businessAccountId) continue;

    for (const change of entry.changes) {
      if (change.field !== 'messages') continue;

      const value = WhatsAppValueSchema.parse(change.value);
      if (value.metadata.phone_number_id !== connection.accountId) continue;

      for (const message of value.messages) {
        if (message.type === 'reaction') continue;
        if (result.length >= 100) throw new ChannelError('WHATSAPP_BATCH_TOO_LARGE');

        result.push({ ...value, messages: [message] });
      }
    }
  }

  return result;
}

@Injectable()
export class WhatsAppAdapter {
  constructor(
    @Inject(ChannelHttp) private readonly http: ChannelHttp,
    @Inject(ChannelFiles) private readonly files: ChannelFiles,
  ) {}

  private address(connection: ChannelConnection, path: string): string {
    if (connection.platform !== 'whatsapp' || !connection.token)
      throw new ChannelError('WHATSAPP_CONFIGURATION');

    return `https://graph.facebook.com/${connection.apiVersion}/${path}`;
  }

  private headers(connection: ChannelConnection): Record<string, string> {
    if (!connection.token) throw new ChannelError('WHATSAPP_CONFIGURATION');

    return { Authorization: `Bearer ${connection.token}` };
  }

  async call(
    connection: ChannelConnection,
    path: string,
    values?: object,
  ): Promise<unknown> {
    const sending = values !== undefined;
    const response = await this.http.request('whatsapp', this.address(connection, path), {
      method: sending ? 'POST' : 'GET',
      headers: { ...this.headers(connection), 'Content-Type': 'application/json' },
      ...(sending ? { body: JSON.stringify(values) } : {}),
    });
    const body = await readChannelJson(response, sending && response.ok);

    if (!response.ok) {
      const code = z
        .object({ error: z.object({ code: z.number().int() }) })
        .safeParse(body);
      const error = code.success ? code.data.error.code : response.status;

      throw new ChannelError(
        error === 131047 ? 'WHATSAPP_WINDOW_EXPIRED' : `WHATSAPP_API_${error}`,
        response.status === 429 || response.status >= 500,
        sending && response.status >= 500,
      );
    }

    return body;
  }

  async check(connection: ChannelConnection): Promise<void> {
    if (connection.platform !== 'whatsapp')
      throw new ChannelError('WHATSAPP_CONFIGURATION');

    const phone = z
      .object({ id: identifier })
      .parse(
        await this.call(
          connection,
          `${connection.accountId}?fields=id,display_phone_number`,
        ),
      );
    if (phone.id !== connection.accountId)
      throw new ChannelError('WHATSAPP_ACCOUNT_MISMATCH');
    const numbers = z
      .object({ data: z.array(z.object({ id: identifier })) })
      .parse(
        await this.call(
          connection,
          `${connection.businessAccountId}/phone_numbers?fields=id&limit=100`,
        ),
      );
    if (!numbers.data.some((item) => item.id === connection.accountId))
      throw new ChannelError('WHATSAPP_ACCOUNT_MISMATCH');
  }

  async subscribe(connection: ChannelConnection): Promise<void> {
    if (connection.platform !== 'whatsapp')
      throw new ChannelError('WHATSAPP_CONFIGURATION');

    await this.check(connection);
    const response = z.object({ success: z.literal(true) });
    response.parse(
      await this.call(connection, `${connection.businessAccountId}/subscribed_apps`, {}),
    );
  }

  incoming(connection: ChannelConnection, payload: unknown): IncomingMessage | null {
    const value = WhatsAppValueSchema.parse(payload);
    if (value.metadata.phone_number_id !== connection.accountId)
      throw new ChannelError('WHATSAPP_ACCOUNT_MISMATCH');

    const message = value.messages[0];
    if (!message) return null;

    const timestamp = Number(message.timestamp) * 1000;
    if (
      !Number.isSafeInteger(timestamp) ||
      timestamp < 1 ||
      timestamp > Date.now() + 300000
    )
      throw new ChannelError('WHATSAPP_TIMESTAMP_INVALID');

    const attachment =
      message.type === 'image'
        ? message.image
        : message.type === 'document'
          ? message.document
          : undefined;
    const files: IncomingFile[] = [];
    if (attachment) {
      const extension = attachment.mime_type === 'image/png' ? 'png' : 'jpg';
      files.push({
        id: attachment.id,
        providerFileId: attachment.id,
        mime: attachment.mime_type,
        name:
          attachment.filename ||
          (message.type === 'image'
            ? `Фото-${attachment.id}.${extension}`
            : `Документ-${attachment.id}`),
      });
    }

    const text =
      message.text?.body ||
      attachment?.caption ||
      message.button?.text ||
      message.interactive?.button_reply?.title ||
      message.interactive?.list_reply?.title ||
      '';
    const unsupported = !['text', 'image', 'document', 'interactive', 'button'].includes(
      message.type,
    );
    const contact = value.contacts.find((item) => item.wa_id === message.from);

    return {
      conversationId: message.from,
      userId: message.from,
      messageId: message.id,
      text: unsupported
        ? `${text}\nВложение доступно в исходной переписке WhatsApp.`.trim()
        : text,
      author: contact?.profile.name.trim().slice(0, 100) || 'Клиент WhatsApp',
      contacts: {
        name: contact?.profile.name.trim().slice(0, 100) || '',
        phone: `+${message.from}`,
        email: '',
      },
      createdAt: new Date(timestamp).toISOString(),
      source: {
        channel: 'whatsapp',
        connectionId: connection.id,
        name: connection.name,
        pageUrl: `https://wa.me/${message.from}`,
        title: 'WhatsApp',
      },
      files,
    };
  }

  async receive<T>(
    connection: ChannelConnection,
    file: IncomingFile,
    use: (upload: Express.Multer.File) => Promise<T>,
  ): Promise<T> {
    if (!file.providerFileId || !/^[0-9]{1,32}$/.test(file.providerFileId))
      throw new ChannelError('WHATSAPP_MEDIA_INVALID');

    const remote = z
      .object({
        id: identifier,
        url: z.url(),
        mime_type: z.string(),
        file_size: z.number().int().positive(),
      })
      .parse(
        await this.call(
          connection,
          `${file.providerFileId}?phone_number_id=${connection.accountId}`,
        ),
      );
    if (
      remote.id !== file.providerFileId ||
      remote.mime_type !== file.mime ||
      !capabilities.whatsapp.mimeTypes.includes(remote.mime_type) ||
      remote.file_size > capabilities.whatsapp.fileBytes
    )
      throw new ChannelError('CHANNEL_ATTACHMENT_UNSUPPORTED');

    // Токен передаётся только точному домену Meta, ни один redirect его не получает.
    const address = new URL(remote.url);
    if (address.hostname !== 'lookaside.fbsbx.com')
      throw new ChannelError('CHANNEL_ADDRESS_DENIED');

    const response = await this.http.request(
      'whatsapp',
      remote.url,
      { headers: this.headers(connection) },
      false,
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new ChannelError(
        'CHANNEL_FILE_UNAVAILABLE',
        response.status >= 500 || response.status === 429,
      );
    }

    return this.files.fromResponse(response, file.name, file.mime, use, remote.file_size);
  }

  async upload(
    connection: ChannelConnection,
    file: Express.Multer.File,
  ): Promise<string> {
    if (file.mimetype.startsWith('image/') && file.size > 5 * 1024 * 1024)
      throw new ChannelError('CHANNEL_FILE_TOO_LARGE');

    const result = await this.files.upload(
      'whatsapp',
      this.address(connection, `${connection.accountId}/media`),
      'file',
      file,
      this.headers(connection),
      { messaging_product: 'whatsapp', type: file.mimetype },
    );

    return z.object({ id: identifier }).parse(result).id;
  }

  async send(
    connection: ChannelConnection,
    to: string,
    text: string,
    attachment?: { id: string; mime: string; name: string },
  ): Promise<string> {
    const type = attachment
      ? attachment.mime.startsWith('image/')
        ? 'image'
        : 'document'
      : 'text';
    const content = attachment
      ? {
          id: attachment.id,
          ...(type === 'document' ? { filename: attachment.name } : {}),
        }
      : { body: text, preview_url: false };
    const result = await this.call(connection, `${connection.accountId}/messages`, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type,
      [type]: content,
    });

    return z
      .object({
        messages: z.array(z.object({ id: z.string().min(1).max(512) })).length(1),
      })
      .parse(result).messages[0].id;
  }
}
