import { expect, mock, test } from 'bun:test';
import type { LookupOptions } from 'node:dns';
import { connect, createServer, type Socket } from 'node:net';
import { pinnedLookup } from '../../src/channels/pinned-lookup';

for (const address of [
  { address: '93.184.215.14', family: 4 },
  { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
]) {
  test(`lookup IPv${address.family}: all=true возвращает массив только закреплённого адреса`, (): void => {
    const callback = mock<Parameters<ReturnType<typeof pinnedLookup>>[2]>();

    pinnedLookup(address)('ignored.invalid', { all: true }, callback);

    expect(callback.mock.calls).toEqual([[null, [address]]]);
  });

  for (const options of [{ all: false }, {}]) {
    test(`lookup IPv${address.family}: all=${String(options.all)} сохраняет одиночный формат`, (): void => {
      const callback = mock<Parameters<ReturnType<typeof pinnedLookup>>[2]>();

      pinnedLookup(address)('ignored.invalid', options, callback);

      expect(callback.mock.calls).toEqual([[null, address.address, address.family]]);
    });
  }
}

for (const autoSelectFamily of [true, false]) {
  test(`закреплённый lookup соединяется с локальным TCP-сервером, autoSelectFamily=${autoSelectFamily}`, async (): Promise<void> => {
    const server = createServer((socket): void => {
      socket.end('lookup-ok');
    });
    let socket: Socket | undefined;

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });

    try {
      const address = server.address();

      if (!address || typeof address === 'string') {
        throw new Error('Тестовый TCP-сервер не получил порт');
      }

      const lookup = pinnedLookup({ address: '127.0.0.1', family: 4 });
      const calls: LookupOptions[] = [];

      socket = connect({
        host: 'pinned-lookup.invalid',
        port: address.port,
        autoSelectFamily,
        lookup: (hostname, options, callback): void => {
          calls.push(options);
          lookup(hostname, options, callback);
        },
      });
      const connected = socket;
      const received = await new Promise<string>((resolve, reject) => {
        let data = '';

        connected.setTimeout(2000, (): void => {
          connected.destroy(new Error('Тестовое TCP-соединение не завершилось'));
        });
        connected.once('error', reject);
        connected.on('data', (chunk: Buffer): void => {
          data += chunk.toString();
        });
        connected.once('end', (): void => resolve(data));
      });

      expect(received).toBe('lookup-ok');
      expect(calls).toHaveLength(1);
      expect(Boolean(calls[0].all)).toBe(autoSelectFamily);
    } finally {
      socket?.destroy();

      await new Promise<void>((resolve, reject) => {
        server.close((error): void => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  });
}
