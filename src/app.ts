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

export async function createApplication(config: Config) {
  @Module({
    controllers: [HealthController, WidgetController, StaffController],
    providers: [
      { provide: CONFIG, useValue: config },
      Database,
      ChatAdapter,
      InquiriesService,
      DeliveryWorker,
      GuestGuard,
      StaffGuard,
    ],
  })
  class ManagerModule {}
  const app = await NestFactory.create<NestExpressApplication>(ManagerModule, {
    logger: ['error', 'warn'],
  });
  app.useBodyParser('json', { limit: '1mb' });
  const origins = new Set(
    config.sites.filter((site) => site.enabled).flatMap((site) => site.widgetOrigins),
  );
  app.enableCors({
    origin: (
      origin: string | undefined,
      callback: (error: Error | null, allowed: boolean) => void,
    ) => callback(null, typeof origin === 'string' && origins.has(origin)),
    allowedHeaders: ['Authorization', 'Content-Type'],
    methods: ['GET', 'POST', 'OPTIONS'],
    credentials: false,
  });
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
  const closeEvents = attachWidgetEvents(app.getHttpServer(), app.get(InquiriesService));
  return {
    app,
    close: async () => {
      closeEvents();
      await app.close();
    },
  };
}
