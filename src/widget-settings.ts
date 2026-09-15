import {
  Inject,
  Injectable,
  Logger,
  type OnModuleInit,
  type OnModuleDestroy,
} from '@nestjs/common';
import { z } from 'zod';
import { CONFIG, type Config } from './config';
import type { WidgetConfig } from './contracts';

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

  constructor(@Inject(CONFIG) private readonly config: Config) {
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
