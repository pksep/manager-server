import 'reflect-metadata';
import { afterEach, expect, spyOn, test } from 'bun:test';
import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { ChatAdapter, ChatRequestFailed } from '../../src/chat-adapter';
import { readConfig } from '../../src/config';
import { deliveryFailure } from '../../src/delivery-policy';

const config = readConfig({
  DATABASE_URL: 'postgresql://localhost/unused',
  CHAT_SERVICE_URL: 'http://127.0.0.1:4501/api',
  CHAT_MANAGER_KEY: 'c'.repeat(32),
  MANAGER_INTERNAL_KEY: 'm'.repeat(32),
});

let restoreFetch: (() => void) | undefined;

afterEach((): void => {
  restoreFetch?.();
  restoreFetch = undefined;
});

for (const status of [400, 422]) {
  test(`HTTP ${status}: отклонённые данные сохраняются отдельно без автоповтора`, (): void => {
    expect(deliveryFailure(new ChatRequestFailed(status), 1)).toEqual({
      state: 'failed',
      delaySeconds: 2,
      code: 'CHAT_MESSAGE_REJECTED',
    });
  });
}

for (const status of [401, 404, 408, 409, 429, 500, 502, 503, 504]) {
  test(`HTTP ${status}: восстановимый сбой не исчерпывает доставку после 10 попыток`, (): void => {
    expect(deliveryFailure(new ChatRequestFailed(status), 100)).toEqual({
      state: 'pending',
      delaySeconds: 60,
      code: 'CHAT_DELIVERY_FAILED',
    });
  });
}

for (const error of [
  new ChatRequestFailed(),
  new ForbiddenException(),
  new Error('Потерян ответ после сохранения'),
]) {
  test(`${error.constructor.name}: неизвестный результат не удаляется и не пропускается`, (): void => {
    expect(deliveryFailure(error, 10).state).toBe('pending');
  });
}

test('пауза растёт до минуты и не переполняется на больших счётчиках', (): void => {
  expect(
    [1, 2, 3, 4, 5, 6, 10, 10000].map(
      (attempts) => deliveryFailure(new ChatRequestFailed(), attempts).delaySeconds,
    ),
  ).toEqual([2, 4, 8, 16, 32, 60, 60, 60]);
});

test('адаптер сохраняет HTTP-статус без тела ответа и секретов', async (): Promise<void> => {
  const fetchMock = spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response('private-upstream-response', { status: 422 }),
  );
  restoreFetch = (): void => fetchMock.mockRestore();

  try {
    await new ChatAdapter(config).request('/inquiries/test/messages');
    throw new Error('Ожидалась ошибка');
  } catch (error) {
    expect(error).toBeInstanceOf(ChatRequestFailed);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(error instanceof ChatRequestFailed && error.remoteStatus).toBe(422);
    expect(String(error)).not.toContain('private-upstream-response');
    expect(String(error)).not.toContain(config.CHAT_MANAGER_KEY);
  }
});

test('ошибка сети остаётся восстановимой без HTTP-статуса', async (): Promise<void> => {
  const fetchMock = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNRESET'));
  restoreFetch = (): void => fetchMock.mockRestore();

  await expect(new ChatAdapter(config).request('/ready')).rejects.toMatchObject({
    remoteStatus: undefined,
  });
});

test('проверка доступа сохраняет прежний запрет HTTP 403', async (): Promise<void> => {
  const fetchMock = spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response('', { status: 403 }),
  );
  restoreFetch = (): void => fetchMock.mockRestore();

  await expect(new ChatAdapter(config).assertManager('test')).rejects.toBeInstanceOf(
    ForbiddenException,
  );
});
