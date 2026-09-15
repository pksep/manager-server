import { z } from 'zod';
import type { Attachment, Contacts } from '../contracts';

export const PlatformSchema = z.enum(['vk', 'avito']);

export type Platform = z.infer<typeof PlatformSchema>;

export interface ChannelSource {
  channel: Platform;
  connectionId: string;
  name: string;
  pageUrl: string;
  title: string;
  avatarUrl?: string;
  itemId?: string;
}

export interface ReplyRoute {
  id: string;
  channel: 'widget' | Platform;
  connection_id: string | null;
  inquiry_id: string | null;
  external_chat_id: string | null;
  external_user_id: string | null;
  source: Record<string, unknown>;
  last_inbound_at: Date;
}

export interface IncomingFile {
  id: string;
  url: string;
  name: string;
  mime: string;
  size?: number;
}

export interface IncomingMessage {
  conversationId: string;
  userId: string;
  messageId: string;
  text: string;
  author: string;
  createdAt: string;
  source: ChannelSource;
  files: IncomingFile[];
  contacts?: Contacts;
}

export interface OutboundMessage {
  id: string;
  text: string;
  attachments: Attachment[];
  randomId: number;
}

export interface DeliveredPart {
  index: number;
  externalId: string;
  confirmedBy?: string;
}

export interface ChannelCapabilities {
  textChars: number;
  fileBytes: number;
  fileCount: number;
  mimeTypes: string[];
  readReceipts: boolean;
}

export const capabilities: Record<'widget' | Platform, ChannelCapabilities> = {
  widget: {
    textChars: 10000,
    fileBytes: 20 * 1024 * 1024,
    fileCount: 10,
    mimeTypes: ['*'],
    readReceipts: true,
  },
  vk: {
    textChars: 4096,
    fileBytes: 20 * 1024 * 1024,
    fileCount: 10,
    mimeTypes: [
      'image/jpeg',
      'image/png',
      'image/gif',
      'image/webp',
      'application/pdf',
      'text/plain',
      'text/csv',
      'application/zip',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ],
    readReceipts: false,
  },
  avito: {
    textChars: 1000,
    fileBytes: 20 * 1024 * 1024,
    fileCount: 10,
    mimeTypes: ['image/jpeg', 'image/png', 'image/gif'],
    readReceipts: false,
  },
};

/** Ошибка содержит только фиксированный код: токены и ответы провайдера не журналируются. */
export class ChannelError extends Error {
  constructor(
    readonly code: string,
    readonly retryable = false,
    readonly uncertain = false,
    readonly retryAfter = 30,
  ) {
    super(code);
    this.name = 'ChannelError';
  }
}
