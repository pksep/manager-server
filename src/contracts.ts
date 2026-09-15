import { z } from 'zod';

const identifier = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[\w:-]+$/);
const safeUrl = z
  .url()
  .max(2048)
  .refine((value) => {
    if (!URL.canParse(value)) return false;
    const url = new URL(value);
    return (
      !url.username &&
      !url.password &&
      (url.protocol === 'https:' ||
        (url.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    );
  }, 'Требуется HTTPS или локальный адрес');
const origin = safeUrl.refine(
  (value) => URL.canParse(value) && new URL(value).origin === value,
  'Ожидается origin без пути',
);
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const WidgetConfigSchema = z.object({
  company: z.object({
    name: z.string().trim().min(1).max(100),
    avatarUrl: safeUrl.optional(),
  }),
  welcomeMessages: z.array(z.string().max(2000)).max(10),
  socialLinks: z
    .array(
      z.object({
        label: z.string().max(80),
        url: safeUrl,
        icon: z.enum(['vk', 'telegram', 'chat']),
      }),
    )
    .max(6),
  schedule: z.object({
    timezone: z.string().refine((value) => {
      try {
        new Intl.DateTimeFormat('ru', { timeZone: value });
        return true;
      } catch {
        return false;
      }
    }),
    start: time,
    end: time,
    days: z.array(z.number().int().min(0).max(6)),
  }),
  contactPolicy: z.enum(['all', 'name-and-one']),
  limits: z.object({
    fileBytes: z
      .number()
      .int()
      .positive()
      .max(100 * 1024 * 1024),
    fileCount: z.number().int().positive().max(20),
    messageChars: z.number().int().positive().max(100000),
  }),
});
export const SiteSchema = z.object({
  id: identifier,
  name: z.string().min(1).max(100),
  origins: z.array(origin).min(1),
  widgetOrigins: z.array(origin).min(1),
  enabled: z.boolean().default(true),
  config: WidgetConfigSchema,
});
export type Site = z.infer<typeof SiteSchema>;
export type WidgetConfig = z.infer<typeof WidgetConfigSchema>;
export const ContactsSchema = z
  .object({
    name: z.string().trim().min(2).max(100),
    phone: z.string().trim().max(40),
    email: z.string().trim().max(254),
  })
  .strict();
export type Contacts = z.infer<typeof ContactsSchema>;
export const SourceSchema = z.object({
  pageUrl: safeUrl,
  title: z.string().max(200),
  referrerOrigin: z.union([origin, z.literal('')]),
});
export const SessionRequestSchema = z
  .object({
    siteId: identifier,
    source: SourceSchema,
    visitorToken: z.string().max(110).optional(),
  })
  .strict();
export const SendRequestSchema = z
  .object({
    operationId: identifier,
    html: z.string().max(200000),
    attachmentIds: z.array(z.uuid()).max(20),
    contacts: ContactsSchema.optional(),
  })
  .strict();
export type SendRequest = z.infer<typeof SendRequestSchema>;
export const AttachmentSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).max(255),
  size: z.number().int().nonnegative(),
  mime: z.string().max(255),
});
export type Attachment = z.infer<typeof AttachmentSchema>;
export const MessageSchema = z.object({
  id: z.uuid(),
  inquiryId: z.uuid(),
  direction: z.enum(['incoming', 'outgoing']),
  author: z.string().max(200),
  avatarUrl: safeUrl.optional(),
  html: z.string().max(200000),
  attachments: z.array(AttachmentSchema).max(20),
  createdAt: z.iso.datetime(),
  readAt: z.iso.datetime().optional(),
  operationId: identifier.optional(),
});
export type WidgetMessage = z.infer<typeof MessageSchema>;
export const ChatReceiptSchema = z.object({
  topicId: z.uuid(),
  messageId: z.uuid(),
  sequence: z.number().int().positive(),
});
export const ChatEventSchema = z.object({
  version: z.literal(1),
  sequence: z.number().int().positive(),
  type: z.enum(['message', 'read']),
  messageId: z.uuid(),
  senderId: z.uuid(),
  guestSessionId: z.uuid(),
  author: z.string().max(200),
  avatarUrl: safeUrl.optional(),
  direction: z.enum(['incoming', 'outgoing']),
  operationId: z.uuid().optional(),
  html: z.string().max(200000),
  attachments: z.array(AttachmentSchema).max(20),
  createdAt: z.iso.datetime(),
  readAt: z.iso.datetime().optional(),
});
export type ChatEvent = z.infer<typeof ChatEventSchema>;
