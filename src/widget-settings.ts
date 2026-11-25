import {
  Inject,
  Injectable,
  ConflictException,
  NotFoundException,
  Logger,
  type OnModuleInit,
  type OnModuleDestroy,
} from '@nestjs/common';
import { z } from 'zod';
import { CONFIG, type Config } from './config';
import { WidgetConfigSchema, type Site, type WidgetConfig } from './contracts';
import { Database } from './database';

const platforms = {
  vk: {
    label: 'ВКонтакте',
    hosts: ['vk.ru', 'www.vk.ru', 'vk.com', 'www.vk.com', 'vk.me'],
  },
  avito: { label: 'Авито', hosts: ['avito.ru', 'www.avito.ru', 'm.avito.ru'] },
  telegram: { label: 'Telegram', hosts: ['t.me', 'telegram.me'] },
  max: { label: 'MAX', hosts: ['max.ru', 'www.max.ru'] },
};

type Platform = keyof typeof platforms;

const socialLink = (platform: Platform): z.ZodType<string> =>
  z
    .string()
    .trim()
    .max(2048)
    .refine((value): boolean => {
      if (!value) return true;

      const url = URL.parse(value);

      return (
        !!url &&
        url.protocol === 'https:' &&
        !url.username &&
        !url.password &&
        !url.port &&
        platforms[platform].hosts.includes(url.hostname)
      );
    });

const editableSchema = z
  .object({
    initialMessage: z.string().trim().max(2000),
    welcomeMessages: z.array(z.string().trim().min(1).max(2000)).max(10),
    socialLinks: z
      .object({
        vk: socialLink('vk'),
        avito: socialLink('avito'),
        telegram: socialLink('telegram'),
        max: socialLink('max'),
      })
      .strict(),
    schedule: WidgetConfigSchema.shape.schedule
      .extend({
        days: WidgetConfigSchema.shape.schedule.shape.days
          .max(7)
          .refine((days): boolean => new Set(days).size === days.length),
      })
      .strict(),
    autoOpenDelayMs: WidgetConfigSchema.shape.autoOpenDelayMs.unwrap(),
  })
  .strict();

export type EditableWidgetSettings = z.infer<typeof editableSchema>;

type SettingsRecord = { version: number; settings: EditableWidgetSettings };

const saveSchema = z
  .object({
    version: z.number().int().nonnegative().max(2147483646),
    settings: editableSchema,
  })
  .strict();

const platformKeys = Object.keys(platforms) as Platform[];

export function applyWidgetSiteSettings(
  base: WidgetConfig,
  settings: EditableWidgetSettings,
): WidgetConfig {
  const extraLinks: WidgetConfig['socialLinks'] = base.socialLinks.filter(
    (link) =>
      link.icon === 'chat' &&
      !platformKeys.some((platform) => socialLink(platform).safeParse(link.url).success),
  );
  const links: WidgetConfig['socialLinks'] = [];
  for (const icon of platformKeys) {
    const url = settings.socialLinks[icon];
    if (url) links.push({ icon, url, label: platforms[icon].label });
  }

  return {
    ...base,
    managedByChat: true,
    initialMessage: settings.initialMessage,
    welcomeMessages: settings.welcomeMessages,
    schedule: settings.schedule,
    autoOpenDelayMs: settings.autoOpenDelayMs,
    socialLinks: [...links, ...extraLinks.slice(0, 6 - links.length)],
  };
}

const settingsSchema = z
  .object({
    vkBusinessUrl: z
      .url()
      .max(2048)
      .refine((value) => {
        const url = new URL(value);
        return (
          url.protocol === 'https:' &&
          !url.username &&
          !url.password &&
          ['vk.com', 'www.vk.com', 'vk.ru', 'www.vk.ru'].includes(url.hostname)
        );
      })
      .nullable(),
  })
  .strict();

/** ERP остаётся источником ссылки компании; кеш не блокирует приём сообщений при кратком сбое ERP. */
@Injectable()
export class WidgetSettings implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private pending?: Promise<void>;
  private vk: string | null | undefined;
  private readonly logger = new Logger('WidgetSettings');

  constructor(
    @Inject(CONFIG) private readonly config: Config,
    @Inject(Database) private readonly database: Database,
  ) {
    this.vk = config.ERP_SERVICE_URL ? null : undefined;
  }

  async onModuleInit(): Promise<void> {
    if (!this.config.ERP_SERVICE_URL) return;
    await this.refresh();
    this.timer = setInterval(() => {
      void this.refresh();
    }, 30000);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.timer);
    await this.pending;
  }

  publicConfig(config: WidgetConfig): WidgetConfig {
    return {
      ...config,
      ...(this.vk !== undefined
        ? {
            socialLinks: [
              ...config.socialLinks.filter((link) => link.icon !== 'vk'),
              ...(this.vk
                ? [{ icon: 'vk' as const, label: 'Написать ВКонтакте', url: this.vk }]
                : []),
            ],
          }
        : {}),
      limits: {
        ...config.limits,
        fileBytes: Math.min(config.limits.fileBytes, this.config.MANAGER_UPLOAD_BYTES),
      },
    };
  }

  sites(): Array<{ id: string; name: string }> {
    return this.config.sites
      .filter((site) => site.enabled && !site.support)
      .map(({ id, name }) => ({ id, name }));
  }

  private async stored(siteId: string): Promise<SettingsRecord | undefined> {
    const { rows } = await this.database.query<{ version: number; settings: unknown }>(
      'SELECT version, settings FROM widget_site_settings WHERE site_id=$1',
      [siteId],
    );
    const row = rows[0];

    return row && { version: row.version, settings: editableSchema.parse(row.settings) };
  }

  async forSite(site: Site): Promise<WidgetConfig> {
    const base = this.publicConfig(site.config);
    const stored = site.support ? undefined : await this.stored(site.id);

    return stored ? applyWidgetSiteSettings(base, stored.settings) : base;
  }

  async edit(siteId: string): Promise<SettingsRecord> {
    const site = this.config.sites.find(
      (item) => item.id === siteId && item.enabled && !item.support,
    );
    if (!site) throw new NotFoundException('Сайт не подключён');

    const stored = await this.stored(siteId);
    if (stored) return stored;

    const base = this.publicConfig(site.config);
    const knownLink = (platform: Platform): string => {
      const url =
        base.socialLinks.find(
          (link) =>
            link.icon === platform ||
            (link.icon === 'chat' && socialLink(platform).safeParse(link.url).success),
        )?.url ?? '';

      return socialLink(platform).safeParse(url).success ? url : '';
    };

    return {
      version: 0,
      settings: {
        initialMessage: base.initialMessage ?? '',
        welcomeMessages: base.welcomeMessages.filter((message) => message.trim()),
        autoOpenDelayMs: base.autoOpenDelayMs ?? null,
        schedule: base.schedule,
        socialLinks: {
          vk: knownLink('vk'),
          avito: knownLink('avito'),
          telegram: knownLink('telegram'),
          max: knownLink('max'),
        },
      },
    };
  }

  async save(siteId: string, body: unknown, actorId: string): Promise<SettingsRecord> {
    const site = this.config.sites.find(
      (item) => item.id === siteId && item.enabled && !item.support,
    );
    if (!site) throw new NotFoundException('Сайт не подключён');

    const { version, settings } = saveSchema.parse(body);
    const values = [siteId, JSON.stringify(settings), actorId];
    const { rows } =
      version === 0
        ? await this.database.query<{ version: number }>(
            'INSERT INTO widget_site_settings (site_id, settings, updated_by) VALUES ($1,$2::jsonb,$3) ON CONFLICT (site_id) DO NOTHING RETURNING version',
            values,
          )
        : await this.database.query<{ version: number }>(
            'UPDATE widget_site_settings SET settings=$2::jsonb, updated_by=$3, updated_at=now(), version=version+1 WHERE site_id=$1 AND version=$4 RETURNING version',
            [...values, version],
          );
    if (!rows[0])
      throw new ConflictException('Настройки уже изменены другим сотрудником');

    return { version: rows[0].version, settings };
  }

  private async refresh(): Promise<void> {
    if (this.pending) return this.pending;
    this.pending = this.load()
      .catch(() => {
        this.logger.warn({ event: 'erp_widget_settings_unavailable' });
      })
      .finally(() => {
        this.pending = undefined;
      });
    await this.pending;
  }

  private async load(): Promise<void> {
    const response = await fetch(
      `${this.config.ERP_SERVICE_URL!.replace(/\/$/, '')}/internal/manager/access/widget`,
      {
        headers: {
          'x-manager-key': this.config.ERP_MANAGER_KEY!,
          compress: 'no-compress',
        },
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!response.ok) throw new Error('ERP settings unavailable');
    this.vk = settingsSchema.parse(await response.json()).vkBusinessUrl;
  }
}
