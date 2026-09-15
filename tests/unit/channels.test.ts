import 'reflect-metadata';
import { expect, test } from 'bun:test';
import { mkdtemp, writeFile, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertPlatformUrl, ChannelHttp } from '../../src/channels/http-client';
import { ChannelFiles } from '../../src/channels/files';
import { readChannels } from '../../src/channels/config';
import { channelText, textParts } from '../../src/channels/service';
import { ChannelError } from '../../src/channels/contracts';

test('каналы не включаются без конфигурации; отключённые записи не требуют ключей', async () => {
  expect(readChannels(undefined, {})).toEqual([]);
  const directory = await mkdtemp(join(tmpdir(), 'manager-channel-test-'));
  try {
    const path = join(directory, 'channels.json');
    const entry = {
      id: 'vk-main',
      platform: 'vk',
      name: 'Компания',
      accountId: '123',
      enabled: false,
      tokenEnv: 'VK_TOKEN',
      confirmationEnv: 'VK_CONFIRMATION',
      webhookSecretEnv: 'VK_WEBHOOK_SECRET',
    };
    await writeFile(path, JSON.stringify([entry]));
    expect(readChannels(path, {})[0].enabled).toBe(false);
    await writeFile(path, JSON.stringify([{ ...entry, enabled: true }]));
    expect(() => readChannels(path, {})).toThrow();
    await writeFile(path, JSON.stringify([entry, entry]));
    expect(() => readChannels(path, {})).toThrow();
  } finally {
    await rm(join(directory, 'channels.json'), { force: true });
    await rmdir(directory);
  }
});

test('адреса API и файлов проверяются до обращения в сеть', () => {
  for (const address of [
    'http://api.vk.com',
    'https://api.vk.com.attacker.test',
    'https://secret@api.vk.com',
    'https://127.0.0.1',
    'https://api.vk.com:444',
    'https://api.avito.ru',
  ])
    expect(() => assertPlatformUrl('vk', address, true)).toThrow();
  expect(assertPlatformUrl('avito', 'https://api.avito.ru/token/', true).hostname).toBe(
    'api.avito.ru',
  );
  expect(assertPlatformUrl('vk', 'https://sun9.userapi.com/image.jpg').hostname).toBe(
    'sun9.userapi.com',
  );
});

test('redirect вложения во внутреннюю сеть блокируется без второго запроса', async () => {
  let calls = 0;
  const files = new ChannelFiles(
    new ChannelHttp(async () => {
      calls++;
      return new Response(null, {
        status: 302,
        headers: { Location: 'http://127.0.0.1:4503/api' },
      });
    }),
  );
  await expect(
    files.receive(
      'vk',
      { id: '1', name: 'x.txt', mime: 'text/plain', url: 'https://userapi.com/x.txt' },
      async () => true,
    ),
  ).rejects.toMatchObject({ code: 'CHANNEL_ADDRESS_DENIED' });
  expect(calls).toBe(1);
});

test('поток без Content-Length ограничен размером, временный файл удаляется', async () => {
  const files = new ChannelFiles(
    new ChannelHttp(async () => {
      throw new Error();
    }),
  );
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(21 * 1024 * 1024));
        controller.close();
      },
    }),
  );
  let used = false;
  await expect(
    files.fromResponse(response, 'x.txt', 'text/plain', async () => {
      used = true;
    }),
  ).rejects.toBeInstanceOf(ChannelError);
  expect(used).toBe(false);
});

test('сбой POST обозначает неопределённую отправку, 429 безопасно повторяется', async () => {
  const lost = new ChannelHttp(async () => {
    throw new Error('secret must not escape');
  });
  await expect(
    lost.json('avito', 'https://api.avito.ru/test', { method: 'POST' }),
  ).rejects.toMatchObject({ code: 'CHANNEL_NETWORK_ERROR', uncertain: true });
  const limited = new ChannelHttp(
    async () => new Response('secret', { status: 429, headers: { 'Retry-After': '7' } }),
  );
  await expect(
    limited.json('avito', 'https://api.avito.ru/test', { method: 'POST' }),
  ).rejects.toMatchObject({ retryable: true, uncertain: false, retryAfter: 7 });
});

test('длинные сообщения сохраняют переносы и Unicode без разрыва эмодзи', () => {
  const text = channelText(
    '<p>Привет &amp; спасибо</p><p>😊<br>вторая строка</p><script>secret</script>',
  );
  expect(text).toBe('Привет & спасибо\n😊\nвторая строка');
  const parts = textParts('я'.repeat(999) + '😊' + 'z', 1000);
  expect(parts.join('')).toBe('я'.repeat(999) + '😊' + 'z');
  expect(parts.every((part) => part.length <= 1000)).toBe(true);
});
