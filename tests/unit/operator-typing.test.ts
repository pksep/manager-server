import 'reflect-metadata';
import { afterAll, afterEach, expect, spyOn, test } from 'bun:test';
import { ServiceUnavailableException } from '@nestjs/common';
import { ChatAdapter } from '../../src/chat-adapter';
import { readConfig } from '../../src/config';

const config = readConfig({
  DATABASE_URL: 'postgresql://localhost/unused',
  CHAT_SERVICE_URL: 'http://127.0.0.1:4501/api',
  CHAT_MANAGER_KEY: 'c'.repeat(32),
  MANAGER_INTERNAL_KEY: 'm'.repeat(32),
});
const inquiryId = '160f378c-2608-4141-95a4-37872f8f0051';
const guestSessionId = 'f8a0a1ad-a558-4487-96e3-a6a091f75214';
const signal = {
  id: 'b6dd9a85-0b0d-4286-bfc1-e47c4b5bc3b5',
  inquiryId,
  guestSessionId,
  startedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 8000).toISOString(),
};
const fetchMock = spyOn(globalThis, 'fetch');

afterAll((): void => {
  fetchMock.mockRestore();
});

afterEach((): void => {
  fetchMock.mockReset();
});

test('набор читается по защищённому адресу и не раскрывает данные оператора', async (): Promise<void> => {
  fetchMock.mockResolvedValue(
    Response.json({ typing: { ...signal, userId: 'private', active: true } }),
  );
  const adapter = new ChatAdapter(config);

  expect(await adapter.typing(inquiryId, guestSessionId)).toEqual(signal);
  expect(fetchMock.mock.calls[0][0]).toBe(
    `${config.CHAT_SERVICE_URL}/internal/manager/inquiries/${inquiryId}/typing/${guestSessionId}`,
  );
  const options = fetchMock.mock.calls[0][1];
  expect(new Headers(options?.headers).get('x-manager-key')).toBe(
    config.CHAT_MANAGER_KEY,
  );
});

test('чужой адресат не превращается в событие для посетителя', async (): Promise<void> => {
  fetchMock.mockResolvedValue(
    Response.json({ typing: { ...signal, guestSessionId: crypto.randomUUID() } }),
  );

  await expect(
    new ChatAdapter(config).typing(inquiryId, guestSessionId),
  ).rejects.toBeInstanceOf(ServiceUnavailableException);
});

test('завершённый набор возвращает отсутствие сигнала', async (): Promise<void> => {
  fetchMock.mockResolvedValue(Response.json({ typing: null }));

  expect(await new ChatAdapter(config).typing(inquiryId, guestSessionId)).toBeNull();
});

test('старый сервер без поддержки набора возвращает контролируемую ошибку', async (): Promise<void> => {
  fetchMock.mockResolvedValue(new Response('', { status: 404 }));

  await expect(
    new ChatAdapter(config).typing(inquiryId, guestSessionId),
  ).rejects.toBeInstanceOf(ServiceUnavailableException);
});
