import 'reflect-metadata';
import { expect, mock, spyOn, test } from 'bun:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { QueryResultRow } from 'pg';
import type { Transaction } from 'sequelize';
import { WebSocket } from 'ws';
import { ChatAdapter } from '../../src/chat-adapter';
import { readConfig } from '../../src/config';
import {
  Database,
  type DatabaseResult,
  type DatabaseTransaction,
} from '../../src/database';
import {
  InquiriesService,
  type Guest,
  type MessageRow,
} from '../../src/inquiries.service';
import { SecurityService } from '../../src/security';
import { attachWidgetEvents } from '../../src/widget-events';
import type { OperatorTyping } from '../../src/contracts';

test('сигнал адресован только сессии, не повторяется и не блокирует сообщения при сбое', async (): Promise<void> => {
  const config = readConfig({
    DATABASE_URL: 'postgresql://localhost/unused',
    CHAT_SERVICE_URL: 'http://127.0.0.1:4501/api',
    CHAT_MANAGER_KEY: 'c'.repeat(32),
    MANAGER_INTERNAL_KEY: 'm'.repeat(32),
  });
  const origin = config.sites[0].widgetOrigins[0];
  const guest: Guest = {
    id: crypto.randomUUID(),
    site_id: config.sites[0].id,
    source: {},
    origin,
    expires_at: new Date(Date.now() + 60000),
  };
  const inquiryId = crypto.randomUUID();
  const signal: OperatorTyping = {
    id: crypto.randomUUID(),
    inquiryId,
    guestSessionId: guest.id,
    startedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 8000).toISOString(),
  };
  let rows: Array<MessageRow & { event_sequence: string }> = [];
  const database = Object.create(Database.prototype) as Database;
  database.query = async <T extends QueryResultRow = QueryResultRow>(
    sql: string,
    values: unknown[] = [],
  ): Promise<DatabaseResult<T>> => {
    let result: QueryResultRow[] = [];
    if (sql.includes('AS cursor')) result = [{ cursor: '0' }];
    else if (sql.includes('inquiry_id AS id')) result = [{ id: inquiryId }];
    else if (sql.includes('event_sequence'))
      result = rows.filter((row) => Number(row.event_sequence) > Number(values[1]));

    return { rows: result as T[], rowCount: result.length };
  };
  database.transaction = async <T>(
    action: (client: DatabaseTransaction) => Promise<T>,
  ): Promise<T> =>
    action({
      query: database.query,
      transaction: {} as Transaction,
      models: {} as DatabaseTransaction['models'],
    });
  const security = Object.create(SecurityService.prototype) as SecurityService;
  spyOn(security, 'context').mockReturnValue({
    ip: '127.0.0.1',
    network: 'local',
    origin,
  });
  spyOn(security, 'ingress').mockResolvedValue(undefined);
  const renewLease = mock(async (): Promise<boolean> => true);
  spyOn(security, 'acquire').mockResolvedValue({
    renew: renewLease,
    release: async (): Promise<void> => {},
  });
  const chat = new ChatAdapter(config);
  const typing = spyOn(chat, 'typing').mockResolvedValue(signal);
  const inquiries = Object.assign(
    Object.create(InquiriesService.prototype) as InquiriesService,
    { config, database, security, chat },
  );
  spyOn(inquiries, 'guest').mockResolvedValue(guest);
  spyOn(inquiries, 'ready').mockResolvedValue(undefined);
  spyOn(inquiries, 'rateLimit').mockResolvedValue(undefined);
  const server = createServer();
  const detach = attachWidgetEvents(server, inquiries);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/widget/events`, {
    headers: { Origin: origin },
  });
  const received: Array<{ type: string; id?: string; message?: { id: string } }> = [];
  ws.on('error', (): void => {});
  ws.on('message', (raw) => received.push(JSON.parse(String(raw))));

  async function waitFor(predicate: () => boolean, timeout = 3500): Promise<void> {
    const deadline = Date.now() + timeout;
    while (!predicate() && Date.now() < deadline) await Bun.sleep(25);
    expect(predicate()).toBe(true);
  }

  try {
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
      setTimeout(
        () => reject(new Error('Подключение тестового клиента не завершилось')),
        2000,
      ).unref();
    });
    ws.send(JSON.stringify({ type: 'authenticate', token: 'test' }));
    await waitFor(() => received.some((event) => event.type === 'typing'));
    expect(typing.mock.calls[0]).toEqual([inquiryId, guest.id]);
    await Bun.sleep(1100);
    expect(received.filter((event) => event.type === 'typing')).toHaveLength(1);

    let finishTyping: ((value: null) => void) | undefined;
    typing.mockImplementation(
      (): Promise<null> =>
        new Promise((resolve) => {
          finishTyping = resolve;
        }),
    );
    await waitFor(() => !!finishTyping);
    const messageId = crypto.randomUUID();
    rows = [
      {
        id: messageId,
        inquiry_id: inquiryId,
        session_id: guest.id,
        direction: 'incoming',
        author: 'Оператор',
        html: '<p>Ответ</p>',
        attachments: [],
        created_at: new Date(),
        event_sequence: '1',
      },
    ];
    await waitFor(() => received.some((event) => event.message?.id === messageId));
    expect(ws.readyState).toBe(WebSocket.OPEN);
    finishTyping?.(null);
    typing.mockRejectedValue(new Error('Нет связи с сигналом набора'));
    await Bun.sleep(1100);
    expect(ws.readyState).toBe(WebSocket.OPEN);

    // Клиент не отправляет ни одного прикладного ping — как фоновая вкладка.
    await waitFor(() => renewLease.mock.calls.length >= 2, 21000);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    expect(renewLease.mock.calls.length).toBe(2);

    // Автоматическое поддержание связи не продлевает отозванную аренду.
    renewLease.mockResolvedValue(false);
    await waitFor(() => ws.readyState === WebSocket.CLOSED, 22000);
  } finally {
    ws.terminate();
    detach();
    await Promise.race([
      new Promise<void>((resolve) => server.close(() => resolve())),
      Bun.sleep(1000),
    ]);
  }
}, 50000);
