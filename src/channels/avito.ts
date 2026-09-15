import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ChannelHttp } from './http-client';
import { ChannelFiles } from './files';
import { ChannelError, type IncomingMessage, type IncomingFile } from './contracts';
import type { ChannelConnection } from './config';

const id = z
  .union([z.string().min(1).max(200), z.number().int().safe()])
  .transform(String);

export const AvitoWebhookSchema = z.object({
  id: z.string().min(1).max(200),
  payload: z.object({
    type: z.literal('message'),
    value: z.object({ id, chat_id: id, user_id: id, author_id: id }),
  }),
});

const contentSchema = z.object({
  text: z.string().nullish(),
  image: z.object({ sizes: z.record(z.string(), z.string()) }).nullish(),
  link: z.object({ text: z.string().optional(), url: z.string().optional() }).nullish(),
  item: z
    .object({ title: z.string().optional(), item_url: z.string().optional() })
    .nullish(),
  location: z
    .object({ title: z.string().optional(), text: z.string().optional() })
    .nullish(),
});

const messageSchema = z.object({
  id,
  author_id: id,
  created: z.number().int().positive(),
  direction: z.enum(['in', 'out']),
  type: z.string(),
  content: contentSchema,
});

@Injectable()
export class AvitoAdapter {
  private readonly tokens = new Map<string, { value: string; expiresAt: number }>();
  private readonly pendingTokens = new Map<string, Promise<string>>();

  constructor(
    @Inject(ChannelHttp) private readonly http: ChannelHttp,
    @Inject(ChannelFiles) private readonly files: ChannelFiles,
  ) {}

  private async token(connection: ChannelConnection): Promise<string> {
    const cached = this.tokens.get(connection.id);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const pending = this.pendingTokens.get(connection.id);
    if (pending) return pending;
    const request = (async (): Promise<string> => {
      const token = z
        .object({
          access_token: z.string().min(1),
          expires_in: z.number().positive(),
          token_type: z.string().optional(),
        })
        .parse(
          await this.http.json('avito', 'https://api.avito.ru/token/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              grant_type: 'client_credentials',
              client_id: connection.clientId || '',
              client_secret: connection.clientSecret || '',
            }),
          }),
        );
      this.tokens.set(connection.id, {
        value: token.access_token,
        expiresAt: Date.now() + Math.max(1, token.expires_in - 60) * 1000,
      });
      return token.access_token;
    })()
      .catch((error: unknown) => {
        if (error instanceof ChannelError)
          throw new ChannelError(error.code, error.retryable, false, error.retryAfter);
        throw new ChannelError('AVITO_TOKEN_INVALID', true);
      })
      .finally(() => this.pendingTokens.delete(connection.id));
    this.pendingTokens.set(connection.id, request);
    return request;
  }

  /** Токен обновляется при истечении; повторять POST автоматически после сетевого сбоя нельзя. */
  async call(
    connection: ChannelConnection,
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.token(connection);
      try {
        return await this.http.json('avito', `https://api.avito.ru${path}`, {
          method: body === undefined ? 'GET' : 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch (error) {
        if (
          error instanceof ChannelError &&
          error.code === 'CHANNEL_ACCESS_DENIED' &&
          attempt === 0
        ) {
          this.tokens.delete(connection.id);
          continue;
        }
        throw error;
      }
    }
    throw new ChannelError('CHANNEL_ACCESS_DENIED');
  }

  /** Содержимое уведомления сверяется с историей аккаунта, прежде чем попасть менеджерам. */
  async incoming(
    connection: ChannelConnection,
    payload: unknown,
  ): Promise<IncomingMessage | null> {
    const envelope = AvitoWebhookSchema.parse(payload);
    const value = envelope.payload.value;
    if (value.user_id !== connection.accountId)
      throw new ChannelError('CHANNEL_ACCOUNT_MISMATCH');
    if (value.author_id === connection.accountId) return null;
    const path = `/accounts/${encodeURIComponent(connection.accountId)}/chats/${encodeURIComponent(value.chat_id)}`;
    let message: z.infer<typeof messageSchema> | undefined;
    for (let offset = 0; offset <= 1000; offset += 100) {
      const messages = z
        .array(messageSchema)
        .max(100)
        .parse(
          await this.call(
            connection,
            `/messenger/v3${path}/messages/?limit=100&offset=${offset}`,
          ),
        );
      message = messages.find((item) => item.id === value.id);
      if (message || messages.length < 100) break;
    }
    if (!message) throw new ChannelError('AVITO_MESSAGE_NOT_FOUND', true);
    if (message.direction !== 'in' || message.author_id !== value.author_id)
      throw new ChannelError('AVITO_MESSAGE_MISMATCH');
    const chat = z
      .object({
        id,
        context: z
          .object({
            value: z
              .object({
                id: id.optional(),
                title: z.string().optional(),
                url: z.string().optional(),
              })
              .optional(),
          })
          .optional(),
        users: z
          .array(
            z.object({
              id,
              name: z.string().optional(),
              public_user_profile: z
                .object({
                  avatar: z.object({ default: z.string().optional() }).optional(),
                })
                .optional(),
            }),
          )
          .max(100),
      })
      .parse(await this.call(connection, `/messenger/v2${path}`));
    if (chat.id !== value.chat_id) throw new ChannelError('AVITO_CHAT_MISMATCH');
    const user = chat.users.find((item) => item.id === message.author_id);
    if (!user) throw new ChannelError('AVITO_AUTHOR_NOT_FOUND', true);
    const files: IncomingFile[] = [];
    let text = message.content.text || '';
    if (message.type === 'image' && message.content.image) {
      const images = Object.entries(message.content.image.sizes).filter(([size]) =>
        /^\d+x\d+$/.test(size),
      );
      images.sort(
        ([left], [right]) =>
          right
            .split('x')
            .map(Number)
            .reduce((a, b) => a * b, 1) -
          left
            .split('x')
            .map(Number)
            .reduce((a, b) => a * b, 1),
      );
      const image = images[0]?.[1];
      if (image) {
        const extension =
          /\.(png|gif|webp)(?:$|\?)/i.exec(image)?.[1]?.toLowerCase() || 'jpg';
        files.push({
          id: message.id,
          url: image,
          name: `Фото-${message.id.replace(/[^\w-]/g, '').slice(0, 80)}.${extension}`,
          mime: extension === 'jpg' ? 'image/jpeg' : `image/${extension}`,
        });
      }
    } else if (message.type === 'link')
      text = message.content.link?.text || message.content.link?.url || text;
    else if (message.type === 'item')
      text = [message.content.item?.title, message.content.item?.item_url]
        .filter(Boolean)
        .join('\n');
    else if (message.type === 'location')
      text = message.content.location?.text || message.content.location?.title || text;
    if (!text && !files.length)
      text = `Сообщение «${message.type}»: содержимое доступно в переписке Авито.`;
    const context = chat.context?.value;
    return {
      conversationId: value.chat_id,
      userId: message.author_id,
      messageId: message.id,
      author: user.name?.trim().slice(0, 100) || 'Клиент Авито',
      text,
      files,
      createdAt: new Date(message.created * 1000).toISOString(),
      source: {
        channel: 'avito',
        connectionId: connection.id,
        name: connection.name,
        pageUrl: context?.url || 'https://www.avito.ru/profile/messenger',
        title: context?.title?.slice(0, 200) || 'Авито',
        ...(context?.id ? { itemId: context.id } : {}),
        ...(user.public_user_profile?.avatar?.default
          ? { avatarUrl: user.public_user_profile.avatar.default }
          : {}),
      },
    };
  }

  /** API Авито принимает изображения отдельной загрузкой. */
  async upload(
    connection: ChannelConnection,
    file: Express.Multer.File,
  ): Promise<string> {
    const token = await this.token(connection);
    const response = z
      .record(z.string(), z.record(z.string(), z.string()))
      .parse(
        await this.files.upload(
          'avito',
          `https://api.avito.ru/messenger/v1/accounts/${encodeURIComponent(connection.accountId)}/uploadImages`,
          'uploadfile[]',
          file,
          { Authorization: `Bearer ${token}` },
        ),
      );
    const ids = Object.keys(response);
    if (ids.length !== 1) throw new ChannelError('AVITO_INVALID_UPLOAD');
    return ids[0];
  }

  /** Отправляет одну часть сообщения; API не предоставляет ключ предотвращения повторной отправки. */
  async send(
    connection: ChannelConnection,
    chatId: string,
    text: string,
    imageId?: string,
  ): Promise<string> {
    const base = `/messenger/v1/accounts/${encodeURIComponent(connection.accountId)}/chats/${encodeURIComponent(chatId)}/messages`;
    const response = await this.call(
      connection,
      base + (imageId ? '/image' : ''),
      imageId ? { image_id: imageId } : { type: 'text', message: { text } },
    );
    const receipt = z.object({ id }).safeParse(response);
    if (!receipt.success) throw new ChannelError('AVITO_INVALID_RECEIPT', false, true);
    return receipt.data.id;
  }
}
