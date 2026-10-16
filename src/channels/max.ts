import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { ChannelConnection } from './config';
import { ChannelError, type IncomingFile, type IncomingMessage } from './contracts';
import { ChannelFiles } from './files';
import { ChannelHttp, readChannelJson } from './http-client';

const id = z.number().int().positive().safe();
const media = z.object({
  type: z.string().max(100),
  payload: z.object({ url: z.url().optional() }).optional(),
  filename: z.string().max(1024).optional(),
  size: z.number().int().nonnegative().optional(),
});

export const MaxUpdateSchema = z.object({
  update_type: z.string().max(100),
  message: z
    .object({
      sender: z
        .object({
          user_id: id,
          is_bot: z.boolean(),
          first_name: z.string().max(256).optional(),
          last_name: z.string().max(256).optional(),
          name: z.string().max(512).optional(),
        })
        .nullish(),
      recipient: z.object({
        chat_id: z.number().int().safe().nullable(),
        chat_type: z.string(),
        user_id: id.nullish(),
      }),
      timestamp: z.number().int().positive().max(8640000000000000),
      body: z
        .object({
          mid: z.string().min(1).max(256),
          text: z.string().max(100000).nullish(),
          attachments: z.array(media).max(50).nullish(),
        })
        .nullish(),
    })
    .optional(),
});

export type MaxUpload = {
  type: 'image' | 'file';
  payload: { token: string } | { photos: Record<string, { token: string }> };
};

@Injectable()
export class MaxAdapter {
  constructor(
    @Inject(ChannelHttp) private readonly http: ChannelHttp,
    @Inject(ChannelFiles) private readonly files: ChannelFiles,
  ) {}

  async call(
    connection: ChannelConnection,
    path: string,
    values?: Record<string, unknown>,
    sending = false,
  ): Promise<unknown> {
    const response = await this.http.request(
      'max',
      `https://platform-api2.max.ru${path}`,
      {
        method: values === undefined ? 'GET' : 'POST',
        headers: {
          Authorization: connection.token || '',
          'Content-Type': 'application/json',
        },
        ...(values === undefined ? {} : { body: JSON.stringify(values) }),
      },
    );

    if (response.status === 429 || response.status >= 500) {
      await response.body?.cancel();
      throw new ChannelError(
        'MAX_UNAVAILABLE',
        true,
        sending && response.status >= 500,
        Math.min(3600, Math.max(1, Number(response.headers.get('retry-after')) || 30)),
      );
    }

    const result = await readChannelJson(response, sending && response.ok);

    if (!response.ok) {
      const code = z.object({ code: z.string() }).safeParse(result);

      if (code.success && code.data.code === 'attachment.not.ready')
        throw new ChannelError('MAX_ATTACHMENT_NOT_READY', true, false, 5);

      throw new ChannelError(
        response.status === 401 || response.status === 403
          ? 'MAX_ACCESS_DENIED'
          : `MAX_HTTP_${response.status}`,
      );
    }

    return result;
  }

  async check(connection: ChannelConnection): Promise<void> {
    const bot = z
      .object({ user_id: id, is_bot: z.literal(true) })
      .parse(await this.call(connection, '/me'));

    if (String(bot.user_id) !== connection.accountId)
      throw new ChannelError('MAX_ACCOUNT_MISMATCH');
  }

  async subscribe(connection: ChannelConnection, url: string): Promise<void> {
    await this.check(connection);
    const result = z.object({ success: z.boolean() }).parse(
      await this.call(connection, '/subscriptions', {
        url,
        update_types: ['message_created'],
        secret: connection.webhookSecret,
      }),
    );

    if (!result.success) throw new ChannelError('MAX_SUBSCRIPTION_FAILED');
  }

  async incoming(
    connection: ChannelConnection,
    payload: unknown,
  ): Promise<IncomingMessage | null> {
    const event = MaxUpdateSchema.parse(payload);
    const message = event.message;

    if (
      event.update_type !== 'message_created' ||
      !message?.body ||
      !message.sender ||
      message.sender.is_bot ||
      message.recipient.chat_type !== 'dialog' ||
      message.recipient.chat_id === null
    )
      return null;

    if (
      String(message.sender.user_id) === connection.accountId ||
      (message.recipient.user_id != null &&
        String(message.recipient.user_id) !== connection.accountId)
    )
      return null;

    const files: IncomingFile[] = [];
    const notes: string[] = [];

    for (const [index, attachment] of (message.body.attachments || []).entries()) {
      if (['image', 'file'].includes(attachment.type) && attachment.payload?.url) {
        files.push({
          id: `${message.body.mid}:${index}`,
          url: attachment.payload.url,
          name:
            attachment.filename ||
            (attachment.type === 'image' ? `Фото-${index + 1}.jpg` : 'Документ'),
          mime: attachment.type === 'image' ? 'image/jpeg' : 'application/octet-stream',
          size: attachment.size,
        });
      } else {
        notes.push(`Вложение «${attachment.type}» доступно в исходной переписке MAX.`);
      }
    }

    return {
      conversationId: String(message.recipient.chat_id),
      userId: String(message.sender.user_id),
      messageId: message.body.mid,
      author:
        [message.sender.first_name, message.sender.last_name]
          .filter(Boolean)
          .join(' ')
          .trim()
          .slice(0, 100) ||
        message.sender.name?.slice(0, 100) ||
        'Клиент MAX',
      text: [message.body.text, ...notes].filter(Boolean).join('\n'),
      files,
      createdAt: new Date(message.timestamp).toISOString(),
      source: {
        channel: 'max',
        connectionId: connection.id,
        name: connection.name,
        pageUrl: 'https://web.max.ru/',
        title: 'MAX',
      },
    };
  }

  async upload(
    connection: ChannelConnection,
    file: Express.Multer.File,
  ): Promise<MaxUpload> {
    const image = ['image/jpeg', 'image/png', 'image/gif'].includes(file.mimetype);
    const remote = z
      .object({ url: z.url(), token: z.string().min(1).optional() })
      .parse(
        await this.call(connection, `/uploads?type=${image ? 'image' : 'file'}`, {}),
      );

    if (remote.token) {
      await this.files.uploadRange(remote.url, file);

      return { type: image ? 'image' : 'file', payload: { token: remote.token } };
    }

    const uploaded = await this.files.upload('max', remote.url, 'data', file);

    if (image) {
      const result = z
        .object({ photos: z.record(z.string(), z.object({ token: z.string().min(1) })) })
        .parse(uploaded);

      if (!Object.keys(result.photos).length) throw new ChannelError('MAX_UPLOAD_FAILED');

      return { type: 'image', payload: result };
    }

    const result = z.object({ token: z.string().min(1) }).parse(uploaded);

    return { type: 'file', payload: result };
  }

  async send(
    connection: ChannelConnection,
    chatId: string,
    text: string,
    attachment?: MaxUpload,
  ): Promise<string> {
    const result = z
      .object({
        message: z.object({ body: z.object({ mid: z.string().min(1).max(256) }) }),
      })
      .safeParse(
        await this.call(
          connection,
          `/messages?chat_id=${encodeURIComponent(chatId)}`,
          {
            text: text || null,
            attachments: attachment ? [attachment] : null,
          },
          true,
        ),
      );

    if (!result.success) throw new ChannelError('MAX_INVALID_RESPONSE', false, true);

    return result.data.message.body.mid;
  }
}
