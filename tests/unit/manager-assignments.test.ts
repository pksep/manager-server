import 'reflect-metadata';
import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import { ManagerAssignmentsWorker } from '../../src/manager-assignments.worker';
import { ChatAdapter } from '../../src/chat-adapter';
import type { Config } from '../../src/config';
import type { DatabaseResult } from '../../src/database';

const allowed = '00000000-0000-4000-8000-000000000001';

afterEach((): void => {
  mock.restore();
});

test('потеря связи не снимает назначения; следующий проход повторяет проверку', async (): Promise<void> => {
  const query = mock(
    async (_sql: string, _values?: unknown[]): Promise<DatabaseResult<never>> => ({
      rows: [],
      rowCount: 0,
    }),
  );
  const managerIds = mock(async (): Promise<string[]> => {
    throw new Error('Нет связи с Чатом');
  });
  const worker = new ManagerAssignmentsWorker({ query }, { managerIds });

  await expect(worker.reconcile()).rejects.toThrow('Нет связи с Чатом');
  expect(query).not.toHaveBeenCalled();

  managerIds.mockImplementation(async (): Promise<string[]> => [allowed]);
  await worker.reconcile();
  expect(query).toHaveBeenCalledTimes(1);
  expect(query.mock.calls[0]?.[1]).toEqual([[allowed]]);
  expect(query.mock.calls[0]?.[0]).toContain('metadata_version=metadata_version+1');
  expect(query.mock.calls[0]?.[0]).not.toContain('DELETE');
  expect(query.mock.calls[0]?.[0]).not.toContain('messages');
});

test('параллельные проверки используют один снимок, после остановки новые не начинаются', async (): Promise<void> => {
  let release!: (ids: string[]) => void;
  const snapshot = new Promise<string[]>((resolve): void => {
    release = resolve;
  });
  const query = mock(
    async (_sql: string, _values?: unknown[]): Promise<DatabaseResult<never>> => ({
      rows: [],
      rowCount: 0,
    }),
  );
  const managerIds = mock((): Promise<string[]> => snapshot);
  const worker = new ManagerAssignmentsWorker({ query }, { managerIds });
  const first = worker.reconcile();

  expect(worker.reconcile()).toBe(first);
  expect(managerIds).toHaveBeenCalledTimes(1);
  release([]);
  await first;
  expect(query.mock.calls[0]?.[1]).toEqual([[]]);

  await worker.onModuleDestroy();
  await worker.reconcile();
  expect(managerIds).toHaveBeenCalledTimes(1);
});

test('источник назначений отклоняет повреждённый ответ, а не считает его пустыми правами', async (): Promise<void> => {
  const fetch = spyOn(globalThis, 'fetch').mockResolvedValue(
    Response.json({ userIds: null }),
  );
  const chat = new ChatAdapter({
    CHAT_SERVICE_URL: 'http://127.0.0.1:65530/api',
    CHAT_MANAGER_KEY: 'synthetic-test-key',
  } as Config);

  await expect(chat.managerIds()).rejects.toThrow();

  fetch.mockResolvedValue(Response.json({ userIds: [allowed] }));
  expect(await chat.managerIds()).toEqual([allowed]);
  fetch.mockResolvedValue(new Response('unavailable', { status: 503 }));
  await expect(chat.managerIds()).rejects.toThrow('Нет связи с СЭП Чатом');
});
