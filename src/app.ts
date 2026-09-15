import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { CONFIG, type Config } from './config';
import { Database } from './database';
import { ChatAdapter } from './chat-adapter';
import { InquiriesService } from './inquiries.service';
import { DeliveryWorker } from './delivery.worker';
import { GuestGuard, HealthController, SafeErrorFilter, WidgetController } from './http';
import { attachWidgetEvents } from './widget-events';
import { StaffController, StaffGuard } from './staff';
import { ErpSyncService } from './erp-sync.service';
import { SecurityService, SecurityError } from './security';
import type { Request, Response, NextFunction } from 'express';
import { FileInspection, SecureUploadInterceptor } from './secure-upload';
import { OperationQueue } from './operation-queue';
import { WidgetSettings } from './widget-settings';
import { RetentionWorker } from './retention';

export async function createApplication(config: Config) {
  @Module({
    controllers: [HealthController, WidgetController, StaffController],
    providers: [
      { provide: CONFIG, useValue: config },
      Database,
      OperationQueue,
      WidgetSettings,
      RetentionWorker,
      ChatAdapter,
      InquiriesService,
      DeliveryWorker,
      GuestGuard,
      StaffGuard,
      ErpSyncService,
      SecurityService,
      FileInspection,
      SecureUploadInterceptor,
    ],
  })
  class ManagerModule {}
  const app = await NestFactory.create<NestExpressApplication>(ManagerModule, {
    logger: ['error', 'warn'],
    bodyParser: false,
  });
  const origins = new Set(
    config.sites.filter((site) => site.enabled).flatMap((site) => site.widgetOrigins),
  );
  app.enableCors({
    origin: (
      origin: string | undefined,
      callback: (error: Error | null, allowed: boolean) => void,
    ): void => callback(null, typeof origin === 'string' && origins.has(origin)),
    allowedHeaders: [
      'Authorization',
      'Content-Type',
      'X-Captcha-Token',
      'X-Captcha-Challenge',
      'X-Operation-Id',
    ],
    exposedHeaders: ['Retry-After'],
    methods: ['GET', 'POST', 'OPTIONS'],
    credentials: false,
  });
  const security = app.get(SecurityService);
  app.use((request: Request, response: Response, next: NextFunction): void => {
    if (!request.path.startsWith('/v1/widget')) return next();
    void Promise.resolve()
      .then(() => security.ingress(security.context(request)))
      .then(() => next())
      .catch((error: unknown) => {
        const status = error instanceof SecurityError ? 429 : 503;
        response.setHeader('Cache-Control', 'no-store');
        if (error instanceof SecurityError)
          response.setHeader('Retry-After', String(error.details.retryAfter || 30));
        response.status(status).json({
          error:
            status === 429
              ? 'Слишком много запросов. Попробуйте позже.'
              : 'Сервис временно недоступен',
          code: status === 429 ? 'rate_limited' : 'unavailable',
        });
      });
  });
  app.useBodyParser('json', { limit: '256kb' });
  app.use(
    (
      request: unknown,
      response: { setHeader(name: string, value: string): void },
      next: () => void,
    ) => {
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      next();
    },
  );
  app.useGlobalFilters(new SafeErrorFilter());
  await app.init();
  const server = app.getHttpServer();
  server.headersTimeout = 10000;
  server.requestTimeout = 60000;
  server.keepAliveTimeout = 5000;
  const closeEvents = attachWidgetEvents(app.getHttpServer(), app.get(InquiriesService));
  return {
    app,
    close: async () => {
      closeEvents();
      // Обработчики завершают сохранение результата, пока база ещё открыта.
      await app.get(OperationQueue).onModuleDestroy();
      await app.get(DeliveryWorker).onModuleDestroy();
      await app.get(RetentionWorker).onModuleDestroy();
      await app.close();
    },
  };
}
