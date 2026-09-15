import { Inject, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ChannelHttp, assertPlatformUrl, readableBody } from './http-client';
import { ChannelError, type IncomingFile, type Platform } from './contracts';

const maximum = 20 * 1024 * 1024;

@Injectable()
export class ChannelFiles {
  constructor(@Inject(ChannelHttp) private readonly http: ChannelHttp) {}

  /** Переносит внешний файл с проверкой каждого redirect и ограничения потока. */
  async receive<T>(
    platform: Platform,
    file: IncomingFile,
    use: (upload: Express.Multer.File) => Promise<T>,
  ): Promise<T> {
    if (file.size !== undefined && (file.size < 1 || file.size > maximum))
      throw new ChannelError('CHANNEL_FILE_TOO_LARGE');
    let address = file.url;
    for (let redirects = 0; redirects <= 3; redirects++) {
      const response = await this.http.request(platform, address, {}, false);
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        const location = response.headers.get('location');
        if (!location || redirects === 3) throw new ChannelError('CHANNEL_FILE_REDIRECT');
        address = assertPlatformUrl(platform, new URL(location, address).href).href;
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new ChannelError(
          'CHANNEL_FILE_UNAVAILABLE',
          response.status >= 500 || response.status === 429,
        );
      }
      return this.fromResponse(response, file.name, file.mime, use, file.size);
    }
    throw new ChannelError('CHANNEL_FILE_REDIRECT');
  }

  /** Временный файл ограничен размером и удаляется при любом исходе обработки. */
  async fromResponse<T>(
    response: Response,
    name: string,
    mime: string,
    use: (upload: Express.Multer.File) => Promise<T>,
    expectedSize?: number,
  ): Promise<T> {
    const declared = Number(response.headers.get('content-length'));
    if (!response.body || declared > maximum) {
      await response.body?.cancel();
      throw new ChannelError('CHANNEL_FILE_TOO_LARGE');
    }
    const directory = await mkdtemp(join(tmpdir(), 'sep-manager-upload-channel-'));
    const path = join(directory, 'content');
    let size = 0;
    try {
      const limit = new Transform({
        transform(chunk: Buffer, _encoding, callback): void {
          size += chunk.length;
          callback(
            size > maximum ? new ChannelError('CHANNEL_FILE_TOO_LARGE') : null,
            chunk,
          );
        },
      });
      await pipeline(
        readableBody(response.body),
        limit,
        createWriteStream(path, { flags: 'wx' }),
        { signal: AbortSignal.timeout(30000) },
      );
      if (!size || (expectedSize !== undefined && size !== expectedSize))
        throw new ChannelError('CHANNEL_FILE_SIZE_MISMATCH');
      const filename = name.replace(/[\x00-\x1f/\\]/g, '_').slice(0, 255) || 'Вложение';
      const stream = createReadStream(path);
      try {
        return await use({
          fieldname: 'file',
          originalname: filename,
          encoding: '7bit',
          mimetype: mime,
          size,
          destination: directory,
          filename: 'content',
          path,
          stream,
          buffer: Buffer.alloc(0),
        });
      } finally {
        stream.destroy();
      }
    } finally {
      const target = resolve(directory);
      if (
        dirname(target) !== resolve(tmpdir()) ||
        !basename(target).startsWith('sep-manager-upload-channel-')
      )
        throw new Error('Некорректный путь очистки');
      await rm(target, { recursive: true, force: true });
    }
  }

  /** Multipart передаёт один проверенный файл потоком без полного буфера в памяти. */
  async upload(
    platform: Platform,
    address: string,
    field: string,
    file: Express.Multer.File,
    headers: Record<string, string> = {},
  ): Promise<unknown> {
    const boundary = `manager-${randomBytes(18).toString('hex')}`;
    const filename = file.originalname.replace(/["\r\n\\]/g, '_');
    const prefix = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: ${file.mimetype}\r\n\r\n`,
    );
    const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
    const source = createReadStream(file.path);
    const chunks = async function* (): AsyncGenerator<Buffer> {
      yield prefix;
      for await (const chunk of source)
        yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      yield suffix;
    };
    const stream = Readable.from(chunks());
    try {
      return await this.http.json(
        platform,
        address,
        {
          method: 'POST',
          body: Readable.toWeb(stream) as ReadableStream<Uint8Array>,
          headers: {
            ...headers,
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': String(prefix.length + file.size + suffix.length),
          },
        },
        false,
      );
    } finally {
      source.destroy();
      stream.destroy();
    }
  }
}
