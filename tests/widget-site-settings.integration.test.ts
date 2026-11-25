import 'reflect-metadata';
import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readConfig } from '../dist/config';
import { Database } from '../dist/database';
import { WidgetSettings } from '../dist/widget-settings';
import type { EditableWidgetSettings } from '../src/widget-settings';

test('сохраняет настройки только выбранного сайта и не перезаписывает чужую редакцию', async (): Promise<void> => {
  const url = process.env.MANAGER_WIDGET_SETTINGS_TEST_DB;
  if (url !== 'postgres://postgres@127.0.0.1:56443/manager_widget_settings_qa')
    throw new Error('Требуется отдельная тестовая база настроек виджета');

  const config = readConfig({
    DATABASE_URL: url,
    CHAT_SERVICE_URL: 'http://127.0.0.1:5001/api',
    CHAT_MANAGER_KEY: randomUUID(),
    MANAGER_INTERNAL_KEY: randomUUID(),
  });
  const database = new Database(config);
  try {
    await database.migrate();
    const site = { ...config.sites[0], id: randomUUID() };
    const second = { ...site, id: randomUUID() };
    for (const profile of [site, second]) {
      await database.models.Site.create({
        id: profile.id,
        name: profile.name,
        origins: profile.origins,
        widget_origins: profile.widgetOrigins,
        config: profile.config,
        enabled: true,
      });
    }
    const actorId = randomUUID();
    const service = new WidgetSettings({ ...config, sites: [site, second] }, database);
    const defaults = await service.edit(site.id);
    const settings: EditableWidgetSettings = {
      ...defaults.settings,
      initialMessage: 'Здравствуйте! Это новое приветствие.',
      welcomeMessages: ['Узнать цену'],
      autoOpenDelayMs: null,
      schedule: {
        ...defaults.settings.schedule,
        start: '10:00',
        end: '17:00',
        days: [1, 2],
      },
      socialLinks: {
        vk: '',
        avito: 'https://www.avito.ru/test',
        telegram: 'https://t.me/test',
        max: '',
      },
    };

    expect(defaults.version).toBe(0);
    const concurrent = await Promise.allSettled([
      service.save(site.id, { version: 0, settings }, actorId),
      service.save(site.id, { version: 0, settings }, actorId),
    ]);
    expect(concurrent.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(concurrent).toContainEqual(
      expect.objectContaining({
        status: 'rejected',
        reason: expect.objectContaining({ status: 409 }),
      }),
    );
    await expect(
      service.save(
        site.id,
        {
          version: 1,
          settings: {
            ...settings,
            socialLinks: { ...settings.socialLinks, vk: 'https://vk.ru.example.test' },
          },
        },
        actorId,
      ),
    ).rejects.toThrow();

    const restarted = new WidgetSettings({ ...config, sites: [site, second] }, database);
    expect(await restarted.edit(site.id)).toEqual({ version: 1, settings });
    expect(await restarted.forSite(site)).toMatchObject({
      managedByChat: true,
      initialMessage: settings.initialMessage,
      autoOpenDelayMs: null,
      schedule: settings.schedule,
      welcomeMessages: settings.welcomeMessages,
      socialLinks: [
        { icon: 'avito', url: settings.socialLinks.avito },
        { icon: 'telegram', url: settings.socialLinks.telegram },
      ],
    });
    expect((await restarted.forSite(second)).managedByChat).toBeUndefined();
    expect(
      await restarted.save(
        site.id,
        { version: 1, settings: { ...settings, initialMessage: '' } },
        actorId,
      ),
    ).toMatchObject({ version: 2, settings: { initialMessage: '' } });
  } finally {
    await database.onModuleDestroy();
  }
});
