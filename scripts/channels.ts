import 'reflect-metadata';
import { readConfig } from '../src/config';
import { ChannelHttp, nativeChannelTransport } from '../src/channels/http-client';
import { ChannelFiles } from '../src/channels/files';
import { VkAdapter } from '../src/channels/vk';
import { AvitoAdapter } from '../src/channels/avito';
import { ChannelError } from '../src/channels/contracts';
import { Database } from '../src/database';
import { z } from 'zod';

const config = readConfig();
const http = new ChannelHttp(nativeChannelTransport);
const files = new ChannelFiles(http);
const vk = new VkAdapter(http, files);
const avito = new AvitoAdapter(http, files);
const [command, connectionId, operationId] = process.argv.slice(2);
const selected = config.channels.filter(
  (item) => item.enabled && (!connectionId || item.id === connectionId),
);

try {
  if (!['check', 'subscribe', 'status', 'retry-inbox'].includes(command))
    throw new Error('Команда: check, subscribe, status или retry-inbox');
  if (command === 'status' || command === 'retry-inbox') {
    const db = new Database(config);
    try {
      if (command === 'status') {
        const rows = await db.query(
          `SELECT c.id,c.platform,c.name,c.enabled,c.last_event_at,c.last_error,
          (SELECT count(*)::int FROM channel_inbox i WHERE i.connection_id=c.id AND i.state='failed') AS failed_incoming,
          (SELECT count(*)::int FROM channel_outbox o JOIN reply_routes r ON r.id=o.route_id WHERE r.connection_id=c.id AND o.state IN ('failed','uncertain')) AS failed_outgoing
          FROM channel_connections c WHERE ($1::text IS NULL OR c.id=$1) ORDER BY c.id`,
          [connectionId || null],
        );
        console.info(JSON.stringify(rows.rows, null, 2));
      } else {
        if (!connectionId || !selected.length)
          throw new Error('Укажите активное подключение');
        const id = z.uuid().parse(operationId);
        const result = await db.query(
          "UPDATE channel_inbox SET state='pending',attempts=0,queued_until=NULL,locked_until=NULL,lease_token=NULL,next_attempt_at=now() WHERE id=$1 AND connection_id=$2 AND state='failed' RETURNING id",
          [id, connectionId],
        );
        console.info(
          result.rowCount
            ? 'Уведомление поставлено на повторную обработку'
            : 'Ошибка обработки не найдена',
        );
      }
    } finally {
      await db.onModuleDestroy();
    }
  } else {
    if (!selected.length)
      throw new Error('Нет активных подключений в MANAGER_CHANNELS_PATH');
    for (const connection of selected) {
      if (command === 'check') {
        if (connection.platform === 'vk')
          await vk.call(connection, 'groups.getById', {
            group_ids: connection.accountId,
          });
        else {
          const account = z
            .object({ id: z.number().int().positive() })
            .parse(await avito.call(connection, '/core/v1/accounts/self'));
          if (String(account.id) !== connection.accountId)
            throw new Error('Ключ Авито принадлежит другому аккаунту');
          await avito.call(
            connection,
            `/messenger/v2/accounts/${connection.accountId}/chats?limit=1`,
          );
        }
        console.info(`${connection.id}: API доступен`);
      } else {
        const origin = new URL(process.env.MANAGER_PUBLIC_URL || '');
        if (
          origin.protocol !== 'https:' ||
          origin.username ||
          origin.password ||
          origin.pathname !== '/' ||
          origin.search ||
          origin.hash
        )
          throw new Error('MANAGER_PUBLIC_URL должен быть HTTPS origin без пути');
        if (connection.platform === 'avito') {
          await avito.call(connection, '/messenger/v3/webhook', {
            url: `${origin.origin}/v1/channels/avito/${connection.id}/${connection.webhookSecret}`,
          });
          console.info(`${connection.id}: подписка Авито зарегистрирована`);
        } else {
          // Настройка ВК выполняется в управлении сообществом: токен сообщений может не иметь права администрирования Callback API.
          console.info(
            `${connection.id}: в Callback API сообщества укажите ${origin.origin}/v1/channels/vk/${connection.id}, версию 5.199, событие message_new и секрет из серверного окружения`,
          );
        }
      }
    }
  }
} catch (error) {
  console.error(
    error instanceof ChannelError
      ? error.code
      : 'Действие не выполнено: проверьте команду, конфигурацию, доступ к API и журнал состояния подключения',
  );
  process.exitCode = 1;
}
