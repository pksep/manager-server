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

const id = z.number().int().positive().safe();
const telegramFile = z.object({
  file_id: z.string().min(1).max(1024),
  file_unique_id: z.string().min(1).max(1024),
  file_size: z.number().int().nonnegative().optional(),
});

export const TelegramUpdateSchema = z.object({
  update_id: z.number().int().nonnegative().safe(),
  message: z
    .object({
      message_id: id,
      date: id,
      chat: z.object({ id: z.number().int().safe(), type: z.string() }),
      from: z
        .object({
          id,
          is_bot: z.boolean(),
          first_name: z.string().max(256),
          last_name: z.string().max(256).optional(),
        })
        .optional(),
      text: z.string().max(100000).optional(),
      caption: z.string().max(100000).optional(),
      photo: z
        .array(telegramFile.extend({ width: id, height: id }))
        .max(30)
        .optional(),
      document: telegramFile
        .extend({
          file_name: z.string().max(1024).optional(),
          mime_type: z.string().max(255).optional(),
        })
        .optional(),
      video: z.unknown().optional(),
      audio: z.unknown().optional(),
      voice: z.unknown().optional(),
      sticker: z.unknown().optional(),
      animation: z.unknown().optional(),
      contact: z.unknown().optional(),
      location: z.unknown().optional(),
    })
    .optional(),
});

const envelopeSchema = z.object({
  ok: z.boolean(),
  result: z.unknown().optional(),
  error_code: z.number().int().optional(),
  parameters: z.object({ retry_after: z.number().positive().optional() }).optional(),
});

@Injectable()
export class TelegramAdapter {
  constructor(
    @Inject(ChannelHttp) private readonly http: ChannelHttp,
    @Inject(ChannelFiles) private readonly files: ChannelFiles,
  ) {}

  private address(connection: ChannelConnection, method: string): string {
    if (!connection.token || !/^[0-9]+:[A-Za-z0-9_-]+$/.test(connection.token))
      throw new ChannelError('TELEGRAM_TOKEN_INVALID');

    return `https://api.telegram.org/bot${connection.token}/${method}`;
  }

  private result(value: unknown, sending: boolean): unknown {
    const parsed = envelopeSchema.safeParse(value);

    if (!parsed.success)
      throw new ChannelError('TELEGRAM_INVALID_RESPONSE', true, sending);

    const response = parsed.data;

    if (!response.ok) {
      const code = response.error_code || 500;

      throw new ChannelError(
        code === 401 || code === 403 ? 'TELEGRAM_ACCESS_DENIED' : `TELEGRAM_HTTP_${code}`,
        code === 429 || code >= 500,
        sending && code >= 500,
        Math.min(3600, Math.max(1, response.parameters?.retry_after || 30)),
      );
    }

    if (response.result === undefined)
      throw new ChannelError('TELEGRAM_INVALID_RESPONSE', true, sending);

    return response.result;
  }

  async call(
    connection: ChannelConnection,
    method: string,
    values: Record<string, unknown> = {},
    sending = false,
  ): Promise<unknown> {
    const response = await this.http.request(
      'telegram',
      this.address(connection, method),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      },
    );

    if (response.status >= 500) {
      await response.body?.cancel();
      throw new ChannelError('TELEGRAM_UNAVAILABLE', true, sending);
    }

    return this.result(await readChannelJson(response, sending && response.ok), sending);
  }

  async check(connection: ChannelConnection): Promise<void> {
    const bot = z
      .object({ id, is_bot: z.literal(true) })
      .parse(await this.call(connection, 'getMe'));

    if (String(bot.id) !== connection.accountId)
      throw new ChannelError('TELEGRAM_ACCOUNT_MISMATCH');
  }

  async subscribe(connection: ChannelConnection, url: string): Promise<void> {
    await this.check(connection);
    const result = await this.call(connection, 'setWebhook', {
      url,
      secret_token: connection.webhookSecret,
      allowed_updates: ['message'],
      drop_pending_updates: false,
    });

    if (result !== true) throw new ChannelError('TELEGRAM_SUBSCRIPTION_FAILED');
  }

  async incoming(
    connection: ChannelConnection,
    payload: unknown,
  ): Promise<IncomingMessage | null> {
    const message = TelegramUpdateSchema.parse(payload).message;

    if (
      !message ||
      message.chat.type !== 'private' ||
      !message.from ||
      message.from.is_bot
    )
      return null;

    if (
      message.chat.id !== message.from.id ||
      String(message.from.id) === connection.accountId
    )
      return null;

    const files: IncomingFile[] = [];
    const photo = [...(message.photo || [])].sort(
      (a, b) => b.width * b.height - a.width * a.height,
    )[0];

    if (photo)
      files.push({
        id: photo.file_unique_id,
        providerFileId: photo.file_id,
        name: `Фото-${message.message_id}.jpg`,
        mime: 'image/jpeg',
        size: photo.file_size,
      });

    if (message.document)
      files.push({
        id: message.document.file_unique_id,
        providerFileId: message.document.file_id,
        name: message.document.file_name || 'Документ',
        mime: message.document.mime_type || 'application/octet-stream',
        size: message.document.file_size,
      });

    const unsupported = [
      'video',
      'audio',
      'voice',
      'sticker',
      'animation',
      'contact',
      'location',
    ].some((key) => key in message);

    return {
      conversationId: String(message.chat.id),
      userId: String(message.from.id),
      messageId: String(message.message_id),
      text: [
        message.text || message.caption,
        unsupported ? 'Вложение доступно в исходной переписке Telegram.' : '',
      ]
        .filter(Boolean)
        .join('\n'),
      author:
        `${message.from.first_name} ${message.from.last_name || ''}`
          .trim()
          .slice(0, 100) || 'Клиент Telegram',
      createdAt: new Date(message.date * 1000).toISOString(),
      source: {
        channel: 'telegram',
        connectionId: connection.id,
        name: connection.name,
        pageUrl: 'https://web.telegram.org/',
        title: 'Telegram',
      },
      files,
    };
  }

  /** URL с токеном используется только в памяти и не сохраняется в нормализованном сообщении. */
  async receive<T>(
    connection: ChannelConnection,
    file: IncomingFile,
    use: (upload: Express.Multer.File) => Promise<T>,
  ): Promise<T> {
    if (
      !file.providerFileId ||
      (file.size !== undefined &&
        (file.size < 1 || file.size > capabilities.telegram.fileBytes))
    )
      throw new ChannelError('CHANNEL_FILE_TOO_LARGE');

    const remote = z
      .object({
        file_path: z.string().regex(/^[A-Za-z0-9_/-]+\.[A-Za-z0-9]+$/),
        file_size: z.number().optional(),
      })
      .parse(await this.call(connection, 'getFile', { file_id: file.providerFileId }));

    if (
      remote.file_path.split('/').some((part) => !part || part === '..') ||
      (remote.file_size || 0) > capabilities.telegram.fileBytes
    )
      throw new ChannelError('CHANNEL_FILE_TOO_LARGE');

    const response = await this.http.request(
      'telegram',
      `https://api.telegram.org/file/bot${connection.token}/${remote.file_path}`,
    );

    if (!response.ok) {
      await response.body?.cancel();
      throw new ChannelError(
        'TELEGRAM_FILE_UNAVAILABLE',
        response.status === 429 || response.status >= 500,
      );
    }

    return this.files.fromResponse(response, file.name, file.mime, use, file.size);
  }

  private messageId(result: unknown): string {
    const parsed = z.object({ message_id: id }).safeParse(result);

    if (!parsed.success) throw new ChannelError('TELEGRAM_INVALID_RESPONSE', false, true);

    return String(parsed.data.message_id);
  }

  async send(
    connection: ChannelConnection,
    chatId: string,
    text: string,
  ): Promise<string> {
    return this.messageId(
      await this.call(connection, 'sendMessage', { chat_id: chatId, text }, true),
    );
  }

  /** В Telegram multipart одновременно загружает и отправляет файл, отдельной загрузки нет. */
  async sendFile(
    connection: ChannelConnection,
    chatId: string,
    file: Express.Multer.File,
  ): Promise<string> {
    const photo = ['image/jpeg', 'image/png'].includes(file.mimetype);
    const url = new URL(this.address(connection, photo ? 'sendPhoto' : 'sendDocument'));
    url.searchParams.set('chat_id', chatId);
    const result = await this.files.upload(
      'telegram',
      url.href,
      photo ? 'photo' : 'document',
      file,
    );

    return this.messageId(this.result(result, true));
  }
}
