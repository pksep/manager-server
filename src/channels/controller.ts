import { Body, Controller, HttpCode, Inject, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { ChannelService } from './service';

@Controller('v1/channels')
export class ChannelController {
  constructor(@Inject(ChannelService) private readonly channels: ChannelService) {}

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
}
