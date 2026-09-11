import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import type { Guest, InquiriesService } from './inquiries.service';
import { presentMessage } from './inquiries.service';

/** Подписка ограничена одной сессией; снимок и курсор читаются под общей блокировкой. */
export function attachWidgetEvents(server: Server, inquiries: InquiriesService) {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 8192 });
  const sessions = new Map<
    WebSocket,
    { guest: Guest; cursor: string; running: boolean; lastPingAt: number }
  >();
  const upgrade: Parameters<Server['on']>[1] = async (
    request: any,
    socket: any,
    head: any,
  ) => {
    if (
      new URL(request.url || '/', 'http://localhost').pathname !== '/v1/widget/events'
    ) {
      socket.destroy();
      return;
    }
    const origin = request.headers.origin || '';
    if (
      !inquiries.config.sites.some(
        (site) => site.enabled && site.widgetOrigins.includes(origin),
      )
    ) {
      socket.destroy();
      return;
    }
    try {
      await inquiries.rateLimit(`ws-ip:${request.socket.remoteAddress || 'unknown'}`, 60);
    } catch {
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, (ws) => {
      let authenticating = false;
      const timeout = setTimeout(() => ws.close(1008, 'Нужна авторизация'), 5000);
      ws.on('error', () => {
        sessions.delete(ws);
      });
      ws.on('close', () => {
        clearTimeout(timeout);
        sessions.delete(ws);
      });
      ws.on('message', (raw) => {
        void (async () => {
          try {
            const message = JSON.parse(String(raw));
            const state = sessions.get(ws);
            if (message.type === 'authenticate' && !state && !authenticating) {
              authenticating = true;
              const guest = await inquiries.guest(message.token, origin);
              if (
                [...sessions.values()].filter((state) => state.guest.id === guest.id)
                  .length >= 3
              )
                throw new Error('Лимит подписок');
              await inquiries.ready();
              const snapshot = await inquiries.database.transaction(async (client) => {
                await client.query(
                  'SELECT id FROM guest_sessions WHERE id=$1 FOR UPDATE',
                  [guest.id],
                );
                const inquiry = (
                  await client.query('SELECT id FROM inquiries WHERE session_id=$1', [
                    guest.id,
                  ])
                ).rows[0];
                const messages = inquiry
                  ? (
                      await client.query(
                        'SELECT * FROM (SELECT * FROM messages WHERE inquiry_id=$1 ORDER BY sequence DESC LIMIT 500) history ORDER BY sequence',
                        [inquiry.id],
                      )
                    ).rows.map(presentMessage)
                  : [];
                const cursor = (
                  await client.query(
                    'SELECT COALESCE(max(sequence),0)::text AS cursor FROM widget_events WHERE session_id=$1',
                    [guest.id],
                  )
                ).rows[0].cursor;
                return { inquiryId: inquiry?.id ?? null, messages, cursor };
              });
              if (ws.readyState !== WebSocket.OPEN) return;
              sessions.set(ws, {
                guest,
                cursor: snapshot.cursor,
                running: false,
                lastPingAt: 0,
              });
              clearTimeout(timeout);
              ws.send(
                JSON.stringify({
                  type: 'ready',
                  inquiryId: snapshot.inquiryId,
                  messages: snapshot.messages,
                }),
              );
            } else if (message.type === 'ping' && state) {
              if (Date.now() - state.lastPingAt < 1000)
                throw new Error('Слишком частые запросы');
              state.lastPingAt = Date.now();
              if (state.guest.expires_at.getTime() <= Date.now())
                throw new Error('Сессия истекла');
              inquiries.site(state.guest.site_id);
              await inquiries.ready();
              ws.send(
                JSON.stringify({
                  type: 'pong',
                  serverTime: new Date().toISOString(),
                }),
              );
            } else ws.close(1008, 'Недопустимое сообщение');
          } catch {
            ws.close(1011, 'Соединение недоступно');
          }
        })();
      });
    });
  };
  server.on('upgrade', upgrade);
  const timer = setInterval(() => {
    for (const [ws, state] of sessions) {
      if (state.running || ws.readyState !== WebSocket.OPEN) continue;
      if (
        state.guest.expires_at.getTime() <= Date.now() ||
        ws.bufferedAmount > 2 * 1024 * 1024
      ) {
        ws.close(1008);
        continue;
      }
      state.running = true;
      void inquiries.database
        .query(
          'SELECT e.sequence AS event_sequence,m.* FROM widget_events e JOIN messages m ON m.id=e.message_id WHERE e.session_id=$1 AND e.sequence>$2 ORDER BY e.sequence LIMIT 100',
          [state.guest.id, state.cursor],
        )
        .then((result) => {
          for (const row of result.rows) {
            if (ws.readyState !== WebSocket.OPEN) break;
            ws.send(
              JSON.stringify({
                type: 'message',
                message: presentMessage(row as any),
              }),
            );
            state.cursor = String(row.event_sequence);
          }
        })
        .catch(() => ws.close(1011, 'Связь с хранилищем потеряна'))
        .finally(() => {
          state.running = false;
        });
    }
  }, 250);
  timer.unref();
  return () => {
    clearInterval(timer);
    server.off('upgrade', upgrade);
    for (const ws of sockets.clients) ws.close(1001);
    sockets.close();
  };
}
