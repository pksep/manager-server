import {
  Body,
  Get,
  Query,
  Req,
  Controller,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { RawBodyRequest } from '@nestjs/common';
import { z } from 'zod';
import { ChannelService } from './service';

@Controller('v1/channels')
export class ChannelController {
  constructor(@Inject(ChannelService) private readonly channels: ChannelService) {}

  @Get('whatsapp/:id')
  verifyWhatsApp(
    @Param('id') id: string,
    @Query() query: unknown,
    @Res() response: Response,
  ): void {
    const values = z
      .object({
        'hub.mode': z.literal('subscribe'),
        'hub.verify_token': z.string().max(128),
        'hub.challenge': z.string().regex(/^[0-9]{1,100}$/),
      })
      .parse(query);
    this.channels.connection('whatsapp', id, values['hub.verify_token']);
    response.type('text/plain').send(values['hub.challenge']);
  }

  @Post('whatsapp/:id')
  @HttpCode(200)
  async whatsapp(
    @Param('id') id: string,
    @Req() request: RawBodyRequest<Request>,
    @Headers('x-hub-signature-256') signature: string | undefined,
    @Body() body: unknown,
  ): Promise<{ ok: true }> {
    const connection = this.channels.whatsappConnection(id, request.rawBody, signature);
    await this.channels.receive(connection, body);

    return { ok: true };
  }

  /** ВК требует текст confirmation при подключении и ровно ok для остальных событий. */
  @Post('vk/:id')
  @HttpCode(200)
  async vk(
    @Param('id') id: string,
    @Body() body: unknown,
    @Res() response: Response,
  ): Promise<void> {
    const credentials = z.object({ secret: z.string().max(128) }).parse(body);
    const connection = this.channels.connection('vk', id, credentials.secret);
    response.type('text/plain').send(await this.channels.receive(connection, body));
  }

  /** Авито не подписывает callback: случайный секрет URL дополняется сверкой сообщения через API. */
  @Post('avito/:id/:secret')
  @HttpCode(200)
  async avito(
    @Param('id') id: string,
    @Param('secret') secret: string,
    @Body() body: unknown,
  ): Promise<{ ok: true }> {
    const connection = this.channels.connection('avito', id, secret);
    await this.channels.receive(connection, body);
    return { ok: true };
  }

  @Post('telegram/:id')
  @HttpCode(200)
  async telegram(
    @Param('id') id: string,
    @Headers('x-telegram-bot-api-secret-token') secret: string | undefined,
    @Body() body: unknown,
  ): Promise<{ ok: true }> {
    const connection = this.channels.connection(
      'telegram',
      id,
      typeof secret === 'string' ? secret : '',
    );
    await this.channels.receive(connection, body);

    return { ok: true };
  }

  @Post('max/:id')
  @HttpCode(200)
  async max(
    @Param('id') id: string,
    @Headers('x-max-bot-api-secret') secret: string | undefined,
    @Body() body: unknown,
  ): Promise<{ ok: true }> {
    const connection = this.channels.connection(
      'max',
      id,
      typeof secret === 'string' ? secret : '',
    );
    await this.channels.receive(connection, body);

    return { ok: true };
  }
}
