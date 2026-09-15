import {
  BadRequestException,
  Inject,
  Injectable,
  ServiceUnavailableException,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { createReadStream } from 'node:fs';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { createConnection } from 'node:net';
import { once } from 'node:events';
import multer from 'multer';
import { finalize, type Observable } from 'rxjs';
import { CONFIG, type Config } from './config';
import { SecurityError, SecurityService } from './security';
import type { GuestRequest } from './http';
import type { Response } from 'express';

/** Временный файл не доступен через HTTP и удаляется после любого исхода обработки. */
@Injectable()
export class SecureUploadInterceptor implements NestInterceptor {
  constructor(@Inject(SecurityService) private readonly security: SecurityService) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const request = context.switchToHttp().getRequest<GuestRequest>();
    const response = context.switchToHttp().getResponse<Response>();
    const securityContext = this.security.context(request);
    const settings = this.security.config;
    const operationId = request.headers['x-operation-id'];
    if (typeof operationId !== 'string' || !/^[\w:-]{1,100}$/.test(operationId))
      throw new BadRequestException('Некорректный ключ загрузки');
    const site = settings.sites.find((value) => value.id === request.guest.site_id)!;
    const maxSize = Math.min(settings.MANAGER_UPLOAD_BYTES, site.config.limits.fileBytes);
    const length = Number(request.headers['content-length'] || maxSize);
    if (!Number.isSafeInteger(length) || length <= 0 || length > maxSize + 65536)
      throw new SecurityError('file_rejected', 'Файл превышает допустимый размер');
    await this.security.captcha(
      securityContext,
      site.id,
      `upload:${request.guest.id}:${operationId}`,
      settings.MANAGER_CAPTCHA_MODE !== 'disabled',
    );
    await this.security.consume([
      {
        key: `upload-bytes:${securityContext.network}`,
        capacity: settings.MANAGER_UPLOAD_HOURLY_BYTES,
        window: 3600000,
        cost: Math.min(length, maxSize),
      },
      {
        key: `upload-bytes-site:${site.id}`,
        capacity: settings.MANAGER_SITE_UPLOAD_HOURLY_BYTES,
        window: 3600000,
        cost: Math.min(length, maxSize),
      },
      { key: `uploads:${request.guest.id}`, capacity: 10, window: 60000 },
    ]);
    const lease = await this.security.acquire(
      [
        {
          key: `upload:${securityContext.network}`,
          capacity: settings.MANAGER_UPLOAD_CONCURRENCY,
        },
        { key: 'upload:global', capacity: settings.MANAGER_UPLOAD_GLOBAL_CONCURRENCY },
      ],
      90000,
    );
    let directory: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = async (): Promise<void> => {
      clearTimeout(timer);
      await lease.release().catch(() => {});
      if (directory) {
        const target = resolve(directory);
        if (
          dirname(target) !== resolve(tmpdir()) ||
          !basename(target).startsWith('sep-manager-upload-')
        )
          throw new Error('Недопустимый путь временного файла');
        await rm(target, { recursive: true, force: true }).catch(() =>
          this.security.audit('temporary_file_cleanup_failed'),
        );
      }
    };
    try {
      directory = await mkdtemp(join(tmpdir(), 'sep-manager-upload-'));
      const storage = multer.diskStorage({
        destination: directory,
        filename: (_request, _file, done): void => done(null, randomUUID()),
      });
      timer = setTimeout(() => request.destroy(), 60000);
      timer.unref();
      await new Promise<void>((resolve, reject) => {
        multer({
          storage,
          limits: {
            fileSize: maxSize,
            files: 1,
            fields: 1,
            fieldSize: 100,
            parts: 2,
            headerPairs: 50,
          },
        }).single('file')(request, response, (error: unknown): void => {
          if (error)
            reject(
              new SecurityError(
                'file_rejected',
                'Не удалось принять файл: проверьте размер и формат загрузки',
              ),
            );
          else resolve();
        });
      });
      if (request.body.operationId !== operationId || !request.file)
        throw new BadRequestException('Некорректная загрузка');
      return next.handle().pipe(
        finalize(() => {
          void cleanup();
        }),
      );
    } catch (error) {
      await cleanup();
      throw error;
    }
  }
}

@Injectable()
export class FileInspection {
  constructor(
    @Inject(CONFIG) private readonly config: Config,
    @Inject(SecurityService) private readonly security: SecurityService,
  ) {}

  /** Проверяем содержимое, а не присланный браузером MIME; архивы имеют отдельные бюджеты распаковки. */
  async inspect(
    path: string,
    name: string,
    size: number,
    originalMime = '',
  ): Promise<{
    mime: string;
    fingerprint: string;
    legacyFingerprint: string;
    digest: string;
  }> {
    if (size <= 0)
      throw new SecurityError('file_rejected', 'Пустой файл не поддерживается');
    const file = await open(path, 'r');
    let mime: string;
    try {
      const header = Buffer.alloc(Math.min(4096, size));
      await file.read(header, 0, header.length, 0);
      const extension = name.split('.').at(-1)?.toLowerCase();
      const starts = (hex: string): boolean =>
        header.subarray(0, hex.length / 2).equals(Buffer.from(hex, 'hex'));
      if (extension === 'pdf' && header.subarray(0, 5).toString() === '%PDF-')
        mime = 'application/pdf';
      else if (extension === 'png' && starts('89504e470d0a1a0a')) mime = 'image/png';
      else if (['jpg', 'jpeg'].includes(extension || '') && starts('ffd8ff'))
        mime = 'image/jpeg';
      else if (extension === 'gif' && /^GIF8[79]a/.test(header.subarray(0, 6).toString()))
        mime = 'image/gif';
      else if (
        extension === 'webp' &&
        header.subarray(0, 4).toString() === 'RIFF' &&
        header.subarray(8, 12).toString() === 'WEBP'
      )
        mime = 'image/webp';
      else if (['zip', 'docx', 'xlsx'].includes(extension || '') && starts('504b0304')) {
        const names = await this.checkZip(file, size);
        if (extension === 'docx' && !names.includes('word/document.xml'))
          throw new SecurityError('file_rejected', 'Содержимое не соответствует DOCX');
        if (extension === 'xlsx' && !names.includes('xl/workbook.xml'))
          throw new SecurityError('file_rejected', 'Содержимое не соответствует XLSX');
        mime =
          extension === 'docx'
            ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
            : extension === 'xlsx'
              ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
              : 'application/zip';
      } else if (['txt', 'csv'].includes(extension || '') && !header.includes(0))
        mime = extension === 'csv' ? 'text/csv' : 'text/plain';
      else
        throw new SecurityError('file_rejected', 'Этот формат файла не поддерживается');
    } finally {
      await file.close();
    }
    if (this.config.MANAGER_SCAN_MODE === 'required') await this.scan(path);
    const digest = createHash('sha256');
    const fingerprint = createHash('sha256').update(`${name}\0${mime}\0`);
    const legacyFingerprint = createHash('sha256').update(`${name}\0${originalMime}\0`);
    for await (const chunk of createReadStream(path)) {
      digest.update(chunk);
      fingerprint.update(chunk);
      legacyFingerprint.update(chunk);
    }
    return {
      mime,
      fingerprint: fingerprint.digest('hex'),
      legacyFingerprint: legacyFingerprint.digest('hex'),
      digest: digest.digest('hex'),
    };
  }

  private async checkZip(
    file: Awaited<ReturnType<typeof open>>,
    size: number,
  ): Promise<string[]> {
    const fail = (): never => {
      throw new SecurityError(
        'file_rejected',
        'Архив повреждён, защищён паролем или превышает ограничения распаковки',
      );
    };
    const tail = Buffer.alloc(Math.min(size, 65557));
    await file.read(tail, 0, tail.length, size - tail.length);
    const at = tail.lastIndexOf(Buffer.from('504b0506', 'hex'));
    if (at < 0 || at + 22 > tail.length) return fail();
    const count = tail.readUInt16LE(at + 10),
      bytes = tail.readUInt32LE(at + 12),
      offset = tail.readUInt32LE(at + 16);
    if (
      tail.readUInt16LE(at + 4) ||
      tail.readUInt16LE(at + 6) ||
      count > 1000 ||
      bytes > 1024 * 1024 ||
      offset + bytes > size ||
      count === 65535
    )
      return fail();
    const directory = Buffer.alloc(bytes);
    await file.read(directory, 0, bytes, offset);
    const names: string[] = [];
    let cursor = 0,
      expanded = 0;
    for (let index = 0; index < count; index++) {
      if (cursor + 46 > bytes || directory.readUInt32LE(cursor) !== 0x02014b50)
        return fail();
      const flags = directory.readUInt16LE(cursor + 8),
        method = directory.readUInt16LE(cursor + 10);
      const compressed = directory.readUInt32LE(cursor + 20),
        unpacked = directory.readUInt32LE(cursor + 24);
      const nameSize = directory.readUInt16LE(cursor + 28),
        extra = directory.readUInt16LE(cursor + 30),
        comment = directory.readUInt16LE(cursor + 32);
      if (
        flags & 1 ||
        ![0, 8].includes(method) ||
        unpacked > 100 * 1024 * 1024 ||
        unpacked > Math.max(1024 * 1024, compressed * 200) ||
        cursor + 46 + nameSize + extra + comment > bytes
      )
        return fail();
      const name = directory
        .subarray(cursor + 46, cursor + 46 + nameSize)
        .toString('utf8');
      if (
        name.includes('\0') ||
        name.startsWith('/') ||
        name.includes('\\') ||
        name.split('/').includes('..') ||
        name.includes(':')
      )
        return fail();
      expanded += unpacked;
      if (expanded > 100 * 1024 * 1024) return fail();
      names.push(name);
      cursor += 46 + nameSize + extra + comment;
    }
    if (cursor !== bytes) return fail();
    return names;
  }

  /** INSTREAM передаёт антивирусу ограниченные блоки без загрузки файла в память процесса. */
  private async scan(path: string): Promise<void> {
    const socket = createConnection({
      host: this.config.MANAGER_CLAMAV_HOST,
      port: this.config.MANAGER_CLAMAV_PORT,
    });
    const source = createReadStream(path, { highWaterMark: 65536 });
    let result = '';
    const response = new Promise<string>((resolve, reject) => {
      socket.setTimeout(30000, () => socket.destroy(new Error('scan_timeout')));
      socket.on('error', reject);
      socket.on('data', (chunk: Buffer): void => {
        result += chunk.toString();
        if (result.length > 4096) socket.destroy(new Error('scan_response_limit'));
        if (result.includes('\0')) resolve(result.slice(0, result.indexOf('\0')));
      });
      socket.on('close', (): void => {
        if (!result.includes('\0')) reject(new Error('scan_incomplete'));
      });
    });
    // Ошибка соединения может прийти раньше начала ожидания ответа.
    void response.catch(() => {});
    try {
      await once(socket, 'connect');
      socket.write('zINSTREAM\0');
      for await (const chunk of source) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const length = Buffer.alloc(4);
        length.writeUInt32BE(buffer.length);
        socket.write(length);
        if (!socket.write(buffer)) await once(socket, 'drain');
      }
      socket.write(Buffer.alloc(4));
      const answer = await response;
      if (answer !== 'stream: OK') {
        this.security.audit('file_rejected');
        throw new SecurityError('file_rejected', 'Файл не прошёл проверку безопасности');
      }
    } catch (error) {
      if (error instanceof SecurityError) throw error;
      this.security.audit('scanner_unavailable');
      throw new ServiceUnavailableException('Проверка файла временно недоступна');
    } finally {
      source.destroy();
      socket.destroy();
    }
  }
}
