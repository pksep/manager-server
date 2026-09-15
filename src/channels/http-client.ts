import { Inject, Injectable } from '@nestjs/common';
import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import ipaddr from 'ipaddr.js';
import { ChannelError, type Platform } from './contracts';

export type ChannelTransport = (url: URL, init: RequestInit) => Promise<Response>;

export const CHANNEL_TRANSPORT = Symbol('manager.channelTransport');

/** DNS-адрес закрепляется на время запроса: внешние вложения не могут обратиться во внутреннюю сеть. */
export const nativeChannelTransport: ChannelTransport = async (
  url,
  init,
): Promise<Response> => {
  const records = await lookup(url.hostname, { all: true });
  if (
    !records.length ||
    records.some(({ address }) => ipaddr.process(address).range() !== 'unicast')
  )
    throw new ChannelError('CHANNEL_ADDRESS_DENIED');
  const address = records.find((record) => record.family === 4) || records[0];
  return new Promise<Response>((resolve, reject) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const request = httpsRequest(
      url,
      {
        method: init.method || 'GET',
        headers,
        signal: init.signal || undefined,
        family: address.family,
        lookup: (_host, _options, callback): void =>
          callback(null, address.address, address.family),
      },
      (response) => {
        const resultHeaders = new Headers();
        for (const [key, value] of Object.entries(response.headers)) {
          if (Array.isArray(value))
            value.forEach((item) => resultHeaders.append(key, item));
          else if (value !== undefined) resultHeaders.set(key, value);
        }
        resolve(
          new Response(Readable.toWeb(response) as ReadableStream<Uint8Array>, {
            status: response.statusCode || 502,
            headers: resultHeaders,
          }),
        );
      },
    );
    request.on('error', reject);
    if (typeof init.body === 'string' || init.body instanceof Uint8Array)
      request.end(init.body);
    else if (init.body instanceof URLSearchParams) request.end(init.body.toString());
    else if (init.body instanceof ReadableStream) {
      const body = readableBody(init.body);
      body.on('error', (error) => request.destroy(error));
      request.on('close', () => body.destroy());
      body.pipe(request);
    } else if (init.body)
      request.destroy(new Error('Неподдерживаемый формат тела запроса'));
    else request.end();
  });
};

/** Совместимый поток для fetch в Node и Bun без зависимости от несовпадающих DOM-типов. */
export function readableBody(stream: ReadableStream<Uint8Array>): Readable {
  const chunks = async function* (): AsyncGenerator<Uint8Array> {
    const reader = stream.getReader();
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) return;
        yield next.value;
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  };
  return Readable.from(chunks());
}

/** Принимает только адреса API и файлов официальных платформ; перенаправления проверяются заново. */
export function assertPlatformUrl(
  platform: Platform,
  value: string,
  apiOnly = false,
): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ChannelError('CHANNEL_ADDRESS_DENIED');
  }
  const domains =
    platform === 'vk'
      ? [
          'vk.com',
          'vk.ru',
          'userapi.com',
          'vkuserphoto.ru',
          'vkuseraudio.net',
          'vk-cdn.net',
          'vkuser.net',
        ]
      : ['avito.ru', 'avito.st', 'avito.com'];
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== '443') ||
    (apiOnly
      ? url.hostname !== (platform === 'vk' ? 'api.vk.com' : 'api.avito.ru')
      : !domains.some(
          (domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`),
        ))
  )
    throw new ChannelError('CHANNEL_ADDRESS_DENIED');
  return url;
}

@Injectable()
export class ChannelHttp {
  constructor(@Inject(CHANNEL_TRANSPORT) private readonly transport: ChannelTransport) {}

  /** Выполняет ограниченный запрос без вывода ответа провайдера или токена в ошибку. */
  async request(
    platform: Platform,
    address: string,
    init: RequestInit = {},
    apiOnly = true,
  ): Promise<Response> {
    const url = assertPlatformUrl(platform, address, apiOnly);
    try {
      return await this.transport(url, {
        ...init,
        redirect: 'manual',
        signal: AbortSignal.timeout(20000),
      });
    } catch (error) {
      if (error instanceof ChannelError) throw error;
      throw new ChannelError('CHANNEL_NETWORK_ERROR', true, init.method === 'POST');
    }
  }

  /** JSON читается с лимитом, включая ответы с неверным Content-Length. */
  async json(
    platform: Platform,
    address: string,
    init: RequestInit = {},
    apiOnly = true,
  ): Promise<unknown> {
    const response = await this.request(platform, address, init, apiOnly);
    if (!response.ok) {
      await response.body?.cancel();
      const seconds = Math.min(
        3600,
        Math.max(1, Number(response.headers.get('retry-after')) || 30),
      );
      throw new ChannelError(
        response.status === 401 || response.status === 403
          ? 'CHANNEL_ACCESS_DENIED'
          : `CHANNEL_HTTP_${response.status}`,
        response.status === 429 || response.status >= 500,
        response.status >= 500 && init.method === 'POST',
        seconds,
      );
    }
    if (!response.body)
      throw new ChannelError('CHANNEL_INVALID_RESPONSE', true, init.method === 'POST');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > 2 * 1024 * 1024) throw new Error();
        chunks.push(value);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } catch {
      await reader.cancel().catch(() => {});
      throw new ChannelError('CHANNEL_INVALID_RESPONSE', true, init.method === 'POST');
    }
  }
}
