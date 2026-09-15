import { readFileSync } from 'node:fs';
import { z } from 'zod';

const environmentKey = z.string().regex(/^[A-Z][A-Z0-9_]{1,100}$/);
const base = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  name: z.string().trim().min(1).max(100),
  accountId: z.string().regex(/^[1-9][0-9]{0,15}$/),
  enabled: z.boolean().default(true),
  webhookSecretEnv: environmentKey,
});

const schema = z.discriminatedUnion('platform', [
  base.extend({
    platform: z.literal('vk'),
    tokenEnv: environmentKey,
    confirmationEnv: environmentKey,
  }),
  base.extend({
    platform: z.literal('avito'),
    clientIdEnv: environmentKey,
    clientSecretEnv: environmentKey,
  }),
]);

export type ChannelConnection = z.infer<typeof schema> & {
  webhookSecret: string;
  token?: string;
  confirmation?: string;
  clientId?: string;
  clientSecret?: string;
};

/** Конфигурация содержит ссылки на переменные окружения; реальные ключи остаются на сервере. */
export function readChannels(
  path: string | undefined,
  env: NodeJS.ProcessEnv,
): ChannelConnection[] {
  if (!path) return [];
  const parsed = z
    .array(schema)
    .max(50)
    .safeParse(JSON.parse(readFileSync(path, 'utf8')));
  if (!parsed.success)
    throw new Error('Проверьте MANAGER_CHANNELS_PATH: конфигурация каналов некорректна');
  const ids = new Set<string>();
  const accounts = new Set<string>();
  const secrets = new Set<string>();
  return parsed.data.map((connection): ChannelConnection => {
    const account = `${connection.platform}:${connection.accountId}`;
    if (ids.has(connection.id) || accounts.has(account))
      throw new Error('Подключения каналов должны быть уникальными');
    ids.add(connection.id);
    accounts.add(account);
    const credential = (key: string, minLength = 1): string => {
      const value = env[key]?.trim() || '';
      if (
        connection.enabled &&
        (value.length < minLength || value.startsWith('REPLACE_'))
      )
        throw new Error(`Укажите переменную окружения ${key}`);
      return value;
    };
    const webhookSecret = credential(connection.webhookSecretEnv, 32);
    if (
      connection.enabled &&
      (!/^[a-zA-Z0-9_-]{32,128}$/.test(webhookSecret) || secrets.has(webhookSecret))
    )
      throw new Error('Секреты уведомлений должны быть уникальными случайными строками');
    secrets.add(webhookSecret);
    return {
      ...connection,
      webhookSecret,
      ...(connection.platform === 'vk'
        ? {
            token: credential(connection.tokenEnv),
            confirmation: credential(connection.confirmationEnv),
          }
        : {
            clientId: credential(connection.clientIdEnv),
            clientSecret: credential(connection.clientSecretEnv),
          }),
    };
  });
}
