import {
  ArgumentsHost,
  Body,
  CanActivate,
  Catch,
  Controller,
  ExceptionFilter,
  ExecutionContext,
  Get,
  HttpException,
  Inject,
  Injectable,
  Logger,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ZodError } from 'zod';
import { type Guest, InquiriesService } from './inquiries.service';
import { SecurityError } from './security';
import { SecureUploadInterceptor } from './secure-upload';

export type GuestRequest = Request & { guest: Guest };
export function bearer(request: Request) {
  const value = request.headers.authorization;
  return typeof value === 'string' && value.startsWith('Bearer ') ? value.slice(7) : '';
}
@Injectable()
export class GuestGuard implements CanActivate {
  constructor(@Inject(InquiriesService) private readonly inquiries: InquiriesService) {}
  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<GuestRequest>();
    request.guest = await this.inquiries.guest(
      bearer(request),
      request.headers.origin || '',
    );
    await this.inquiries.rateLimit(`guest:${request.guest.id}`, 180);
    return true;
  }
}
@Catch()
export class SafeErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger('ManagerHttp');
  catch(error: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    if (response.headersSent) {
      response.end();
      return;
    }
    const status =
      error instanceof ZodError
        ? 400
        : error instanceof HttpException
          ? error.getStatus()
          : 503;
    if (!(error instanceof ZodError) && !(error instanceof HttpException)) {
      // Не пишем текст ошибки БД, параметры запроса, контакты и ключи в журнал.
      this.logger.error(
        error instanceof Error ? error.name : 'UnknownError',
        error instanceof Error ? error.stack?.split('\n').slice(1).join('\n') : undefined,
      );
    }
    if (error instanceof SecurityError && error.code === 'rate_limited')
      response.setHeader('Retry-After', String(error.details.retryAfter || 30));
    response.status(status).json({
      ...(error instanceof SecurityError ? { code: error.code, ...error.details } : {}),
      error:
        status >= 500
          ? 'Сервис временно недоступен'
          : error instanceof ZodError
            ? 'Проверьте данные запроса'
            : (error as Error).message,
    });
  }
}
@Controller()
export class HealthController {
  constructor(@Inject(InquiriesService) private readonly inquiries: InquiriesService) {}
  @Get('health/live') live() {
    return { live: true };
  }
  @Get('health/ready') async ready() {
    await this.inquiries.ready();
    return { ready: true, version: 1 };
  }
}
@Controller('v1/widget')
export class WidgetController {
  constructor(@Inject(InquiriesService) private readonly inquiries: InquiriesService) {}
  /** Открывает ограниченный диалог посетителя без доступа к предыдущим обращениям. */
  @Post('session') async session(@Body() body: unknown, @Req() request: Request) {
    return this.inquiries.session(
      body,
      request.headers.origin || '',
      bearer(request),
      this.inquiries.security.context(request),
    );
  }
  @Post('inquiries') @UseGuards(GuestGuard) sendFirst(
    @Req() request: GuestRequest,
    @Body() body: unknown,
  ) {
    return this.inquiries.send(
      request.guest,
      body,
      undefined,
      this.inquiries.security.context(request),
    );
  }
  @Post('inquiries/:id/messages') @UseGuards(GuestGuard) sendNext(
    @Req() request: GuestRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    return this.inquiries.send(
      request.guest,
      body,
      id,
      this.inquiries.security.context(request),
    );
  }
  @Get('inquiries/:id/messages') @UseGuards(GuestGuard) history(
    @Req() request: GuestRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('after') after = '0',
  ) {
    return this.inquiries.history(request.guest, id, after);
  }
  @Post('attachments')
  @UseGuards(GuestGuard)
  @UseInterceptors(SecureUploadInterceptor)
  upload(
    @Req() request: GuestRequest,
    @Body('operationId') operationId: string,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    return this.inquiries.upload(request.guest, operationId, file);
  }
  @Get('attachments/:id')
  @UseGuards(GuestGuard)
  async download(
    @Req() request: GuestRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Res() response: Response,
  ) {
    const { response: upstream, file } = await this.inquiries.download(request.guest, id);
    if (!upstream.body) throw new HttpException('Файл не получен', 503);
    response.setHeader('Content-Type', 'application/octet-stream');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    );
    response.setHeader('Content-Length', String(file.size));
    await pipeline(Readable.fromWeb(upstream.body as any), response);
  }
}
