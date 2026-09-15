import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { SiteSchema } from './contracts';
import { securitySettingsSchema } from './security-config';
import { readChannels } from './channels/config';

const settingsSchema = z.object({
  ...securitySettingsSchema.shape,
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4314),
  DATABASE_URL: z
    .url()
    .refine((value) => ['postgres:', 'postgresql:'].includes(new URL(value).protocol)),
  MANAGER_INTERNAL_KEY: z
    .string()
    .min(32)
    .refine((value) => !value.startsWith('REPLACE_')),
  CHAT_MANAGER_KEY: z
    .string()
    .min(32)
    .refine((value) => !value.startsWith('REPLACE_')),
  CHAT_SERVICE_URL: z.url(),
  ERP_SERVICE_URL: z.url().optional(),
  ERP_MANAGER_KEY: z
    .string()
    .min(32)
    .refine((value) => !value.startsWith('REPLACE_'))
    .optional(),
  MANAGER_SITES_PATH: z.string().default('config/sites.example.json'),
  MANAGER_CHANNELS_PATH: z.string().optional(),
  MANAGER_QUEUE_LIMIT: z.coerce.number().int().positive().default(10000),
  MANAGER_SESSION_HOURS: z.coerce.number().int().min(1).max(720).default(24),
  MANAGER_WORKER_MS: z.coerce.number().int().min(100).max(60000).default(1000),
  VK_BUSINESS_URL: z.url().optional(),
});
export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = settingsSchema.safeParse(env);
  if (!parsed.success)
    throw new Error(
      `Проверьте настройки: ${[...new Set(parsed.error.issues.map((issue) => issue.path[0]))].join(', ')}`,
    );
  const settings = parsed.data;
  if (!!settings.ERP_SERVICE_URL !== !!settings.ERP_MANAGER_KEY)
    throw new Error('Укажите ERP_SERVICE_URL и ERP_MANAGER_KEY вместе');
  if (settings.ERP_SERVICE_URL) {
    const url = new URL(settings.ERP_SERVICE_URL);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !(
        url.protocol === 'https:' ||
        (url.protocol === 'http:' &&
          ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
      )
    )
      throw new Error('ERP_SERVICE_URL должен использовать HTTPS либо loopback');
  }
  const chatUrl = new URL(settings.CHAT_SERVICE_URL);
  if (
    chatUrl.username ||
    chatUrl.password ||
    chatUrl.search ||
    chatUrl.hash ||
    !(
      chatUrl.protocol === 'https:' ||
      (chatUrl.protocol === 'http:' &&
        ['127.0.0.1', 'localhost', '[::1]'].includes(chatUrl.hostname))
    )
  ) {
    throw new Error('CHAT_SERVICE_URL должен использовать HTTPS либо loopback');
  }
  const sites = z
    .array(SiteSchema)
    .min(1)
    .parse(JSON.parse(readFileSync(settings.MANAGER_SITES_PATH, 'utf8')));
  const localOnly =
    ['127.0.0.1', 'localhost', '::1'].includes(settings.HOST) &&
    sites.every((site) =>
      [...site.origins, ...site.widgetOrigins].every((origin) =>
        ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname),
      ),
    );
  if (
    !localOnly &&
    (settings.MANAGER_CAPTCHA_MODE === 'disabled' ||
      settings.MANAGER_SCAN_MODE === 'disabled')
  )
    throw new Error(
      'Отключение CAPTCHA и проверки файлов разрешено только на изолированном loopback-стенде',
    );
  if (
    settings.MANAGER_CAPTCHA_MODE !== 'disabled' &&
    (!settings.SMARTCAPTCHA_CLIENT_KEY || !settings.SMARTCAPTCHA_SERVER_KEY)
  )
    throw new Error('Укажите оба ключа Яндекс SmartCaptcha');
  if (settings.VK_BUSINESS_URL) {
    const url = new URL(settings.VK_BUSINESS_URL);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      !['vk.com', 'www.vk.com', 'vk.ru', 'www.vk.ru'].includes(url.hostname)
    )
      throw new Error('VK_BUSINESS_URL должен вести на HTTPS-страницу ВКонтакте');
  }
  for (const site of sites)
    site.config.socialLinks = [
      ...site.config.socialLinks.filter((link) => link.icon !== 'vk'),
      ...(settings.VK_BUSINESS_URL
        ? [
            {
              label: 'Написать ВКонтакте',
              url: settings.VK_BUSINESS_URL,
              icon: 'vk' as const,
            },
          ]
        : []),
    ];
  if (new Set(sites.map((site) => site.id)).size !== sites.length)
    throw new Error('Идентификаторы сайтов должны быть уникальными');
  return {
    ...settings,
    sites,
    channels: readChannels(settings.MANAGER_CHANNELS_PATH, env),
  };
}
export type Config = ReturnType<typeof readConfig>;
export const CONFIG = Symbol('manager.config');
