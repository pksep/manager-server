import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ChannelHttp } from './http-client';
import { ChannelFiles } from './files';
import { ChannelError, type IncomingMessage, type IncomingFile } from './contracts';
import type { ChannelConnection } from './config';

const positiveId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const imageSize = z.object({
  url: z.url(),
  width: z.number().optional(),
  height: z.number().optional(),
});
const vkAttachment = z.object({
  type: z.string(),
  photo: z.object({ id: z.number(), sizes: z.array(imageSize).max(30) }).optional(),
  doc: z
    .object({
      id: z.number(),
      title: z.string(),
      url: z.url(),
      size: z.number(),
      ext: z.string().optional(),
    })
    .optional(),
  audio_message: z
    .object({
      id: z.number(),
      link_mp3: z.url().optional(),
      transcript: z.string().optional(),
    })
    .optional(),
});

export const VkMessageSchema = z.object({
  id: z.number().int().nonnegative(),
  conversation_message_id: positiveId,
  peer_id: positiveId,
  from_id: z.number().int(),
  date: positiveId,
  text: z.string().max(100000).default(''),
  out: z.union([z.literal(0), z.literal(1)]).default(0),
  attachments: z.array(vkAttachment).max(50).default([]),
});

@Injectable()
export class VkAdapter {
  constructor(
    @Inject(ChannelHttp) private readonly http: ChannelHttp,
    @Inject(ChannelFiles) private readonly files: ChannelFiles,
  ) {}

  /** Вызовы идут только от имени подключённого сообщества. */
  async call(
    connection: ChannelConnection,
    method: string,
    values: Record<string, string | number>,
  ): Promise<unknown> {
    const body = new URLSearchParams({
      access_token: connection.token || '',
      v: '5.199',
      ...Object.fromEntries(
        Object.entries(values).map(([key, value]) => [key, String(value)]),
      ),
    });
    const result = z
      .object({
        response: z.unknown().optional(),
        error: z.object({ error_code: z.number() }).optional(),
      })
      .parse(
        await this.http.json('vk', `https://api.vk.com/method/${method}`, {
          method: 'POST',
          body,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        }),
      );
    if (result.error)
      throw new ChannelError(
        `VK_${result.error.error_code}`,
        [6, 9, 10, 29].includes(result.error.error_code),
      );
    if (result.response === undefined)
      throw new ChannelError('VK_INVALID_RESPONSE', true);
    return result.response;
  }

  /** Преобразует входящее сообщение; неподдерживаемые вложения остаются видимыми в тексте. */
  async incoming(
    connection: ChannelConnection,
    payload: unknown,
  ): Promise<IncomingMessage | null> {
    const envelope = z
      .object({
        type: z.string(),
        object: z.object({ message: VkMessageSchema.optional() }),
      })
      .parse(payload);
    if (envelope.type !== 'message_new' || !envelope.object.message) return null;
    const message = envelope.object.message;
    if (message.out || message.from_id <= 0 || message.peer_id >= 2000000000) return null;
    const users = z
      .array(
        z.object({
          first_name: z.string(),
          last_name: z.string(),
          photo_100: z.url().optional(),
        }),
      )
      .parse(
        await this.call(connection, 'users.get', {
          user_ids: message.from_id,
          fields: 'photo_100',
        }),
      );
    const person = users[0];
    const files: IncomingFile[] = [];
    const notes: string[] = [];
    for (const item of message.attachments) {
      if (item.type === 'photo' && item.photo) {
        const image = [...item.photo.sizes].sort(
          (a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0),
        )[0];
        if (image)
          files.push({
            id: `photo:${item.photo.id}`,
            url: image.url,
            name: `Фото-${item.photo.id}.jpg`,
            mime: 'image/jpeg',
          });
      } else if (item.type === 'doc' && item.doc) {
        files.push({
          id: `doc:${item.doc.id}`,
          url: item.doc.url,
          name: item.doc.title,
          size: item.doc.size,
          mime: 'application/octet-stream',
        });
      } else if (item.type === 'audio_message' && item.audio_message?.transcript) {
        notes.push(`Голосовое сообщение: ${item.audio_message.transcript}`);
      } else notes.push(`Вложение «${item.type}»: доступно в переписке ВКонтакте.`);
    }
    return {
      conversationId: String(message.peer_id),
      userId: String(message.from_id),
      messageId: String(message.conversation_message_id),
      author: person
        ? `${person.first_name} ${person.last_name}`.trim().slice(0, 100)
        : 'Клиент ВКонтакте',
      text: [message.text, ...notes].filter(Boolean).join('\n'),
      files,
      createdAt: new Date(message.date * 1000).toISOString(),
      source: {
        channel: 'vk',
        connectionId: connection.id,
        name: connection.name,
        pageUrl: `https://vk.com/im?sel=-${connection.accountId}`,
        title: 'ВКонтакте',
        ...(person?.photo_100 ? { avatarUrl: person.photo_100 } : {}),
      },
    };
  }

  /** Загружает проверенный файл как документ для сообщения сообщества. */
  async upload(
    connection: ChannelConnection,
    peerId: string,
    file: Express.Multer.File,
  ): Promise<string> {
    const server = z
      .object({ upload_url: z.url() })
      .parse(
        await this.call(connection, 'docs.getMessagesUploadServer', {
          type: 'doc',
          peer_id: peerId,
        }),
      );
    const uploaded = z
      .object({ file: z.string().min(1) })
      .parse(await this.files.upload('vk', server.upload_url, 'file', file));
    const saved = z
      .object({
        type: z.literal('doc'),
        doc: z.object({
          id: z.number().int(),
          owner_id: z.number().int(),
          access_key: z.string().optional(),
        }),
      })
      .parse(
        await this.call(connection, 'docs.save', {
          file: uploaded.file,
          title: file.originalname,
        }),
      );
    return `doc${saved.doc.owner_id}_${saved.doc.id}${saved.doc.access_key ? `_${saved.doc.access_key}` : ''}`;
  }

  /** Один и тот же random_id повторно используется после потери подтверждения. */
  async send(
    connection: ChannelConnection,
    peerId: string,
    text: string,
    attachments: string[],
    randomId: number,
  ): Promise<string> {
    const response = await this.call(connection, 'messages.send', {
      peer_id: peerId,
      message: text,
      attachment: attachments.join(','),
      random_id: randomId,
    });
    return String(z.number().int().nonnegative().parse(response));
  }
}
