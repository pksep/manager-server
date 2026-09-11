import {
  Body,
  CanActivate,
  Controller,
  ExecutionContext,
  Get,
  Inject,
  Injectable,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { InquiriesService } from './inquiries.service';
import type { Request } from 'express';
import { ErpSyncService } from './erp-sync.service';

type StaffRequest = Request & { actorId: string };
@Injectable()
export class StaffGuard implements CanActivate {
  constructor(@Inject(InquiriesService) private readonly inquiries: InquiriesService) {}
  /** Действия доступны только серверу чата, передающему проверенного сотрудника. */
  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<StaffRequest>();
    const key = request.headers['x-manager-key'],
      expected = this.inquiries.config.MANAGER_INTERNAL_KEY;
    if (
      typeof key !== 'string' ||
      Buffer.byteLength(key) !== Buffer.byteLength(expected) ||
      !timingSafeEqual(Buffer.from(key), Buffer.from(expected))
    )
      throw new UnauthorizedException('Интеграция не авторизована');
    request.actorId = z.uuid().parse(request.headers['x-actor-id']);
    await this.inquiries.chat.assertManager(request.actorId);
    return true;
  }
}

@Controller('internal/staff')
@UseGuards(StaffGuard)
export class StaffController {
  constructor(
    @Inject(InquiriesService) private readonly inquiries: InquiriesService,
    @Inject(ErpSyncService) private readonly erp: ErpSyncService,
  ) {}

  /** Показывает совпадения с ЕРП для явного выбора менеджером. */
  @Get('inquiries/:id/erp/candidates')
  candidates(@Param('id', ParseUUIDPipe) id: string, @Req() request: StaffRequest) {
    return this.erp.candidates(id, request.actorId);
  }
  /** Принимает команду создания или связи контакта с обращением. */
  @Post('inquiries/:id/erp/sync')
  sync(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() request: StaffRequest,
  ) {
    return this.erp.enqueue(id, request.actorId, body);
  }
  /** Повторяет недоставленную операцию ЕРП с прежним ключом. */
  @Post('inquiries/:id/erp/retry')
  retryErp(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { operationId } = z.object({ operationId: z.uuid() }).strict().parse(body);
    return this.erp.retry(id, operationId);
  }

  /** Все сотрудники с правом раздела видят общий список обращений и источник каждого. */
  @Get('inquiries')
  async list() {
    return (
      await this.inquiries.database.query(`SELECT i.*,c.name,c.contacts,c.erp_contact_id,
      (SELECT count(*)::int FROM delivery_operations d WHERE d.inquiry_id=i.id AND d.state='failed') AS failed_deliveries
      FROM inquiries i JOIN customers c ON c.id=i.customer_id ORDER BY i.created_at DESC LIMIT 100`)
    ).rows;
  }

  /** Показывает менеджеру обращение, переписку и состояние доставки. */
  @Get('inquiries/:id')
  async detail(@Param('id', ParseUUIDPipe) id: string) {
    const inquiry = (
      await this.inquiries.database.query(
        'SELECT i.*,c.name,c.contacts,c.erp_contact_id FROM inquiries i JOIN customers c ON c.id=i.customer_id WHERE i.id=$1',
        [id],
      )
    ).rows[0];
    if (!inquiry) throw new NotFoundException('Обращение не найдено');
    const messages = (
      await this.inquiries.database.query(
        'SELECT m.*,d.state AS delivery_state FROM messages m LEFT JOIN delivery_operations d ON d.id=m.id WHERE m.inquiry_id=$1 ORDER BY m.sequence LIMIT 500',
        [id],
      )
    ).rows;
    const candidates = (
      await this.inquiries.database.query(
        `SELECT DISTINCT c.id,c.name,c.contacts,c.erp_contact_id FROM customer_identities mine JOIN customer_identities other ON other.kind=mine.kind AND other.value=mine.value JOIN customers c ON c.id=other.customer_id WHERE mine.customer_id=$1 AND mine.kind IN ('email','phone') AND other.customer_id<>mine.customer_id LIMIT 20`,
        [inquiry.customer_id],
      )
    ).rows;
    const erpOperations = (
      await this.inquiries.database.query(
        'SELECT id,actor_id,state,erp_contact_id,last_error,created_at,updated_at FROM erp_sync_operations WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 20',
        [inquiry.customer_id],
      )
    ).rows;
    return { inquiry, messages, contactCandidates: candidates, erpOperations };
  }

  /** Предыдущие обращения доступны менеджерам после явной связи с одним контактом ЕРП. */
  @Get('inquiries/:id/history')
  async history(@Param('id', ParseUUIDPipe) id: string, @Query('after') after = '0') {
    const cursor = z
      .string()
      .regex(/^(0|[1-9]\d{0,18})$/)
      .refine((value) => BigInt(value) <= 9223372036854775807n)
      .parse(after);
    const customer = (
      await this.inquiries.database.query(
        'SELECT c.id,c.erp_contact_id FROM customers c JOIN inquiries i ON i.customer_id=c.id WHERE i.id=$1',
        [id],
      )
    ).rows[0];
    if (!customer) throw new NotFoundException('Обращение не найдено');
    const rows = (
      await this.inquiries.database.query(
        `SELECT m.*,i.source,i.topic_id FROM messages m JOIN inquiries i ON i.id=m.inquiry_id JOIN customers c ON c.id=i.customer_id
       WHERE (c.id=$1 OR ($2::text IS NOT NULL AND c.erp_contact_id=$2)) AND m.sequence>$3::bigint
       ORDER BY m.sequence LIMIT 101`,
        [customer.id, customer.erp_contact_id, cursor],
      )
    ).rows;
    const messages = rows.slice(0, 100);
    return {
      messages,
      nextCursor: rows.length > 100 ? String(messages.at(-1)?.sequence) : null,
    };
  }

  /** Ручной выбор имеет приоритет над автоматическим назначением первого ответившего. */
  @Post('inquiries/:id/assignee')
  async assign(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() request: StaffRequest,
  ) {
    const { userId } = z.object({ userId: z.uuid() }).strict().parse(body);
    if (userId) await this.inquiries.chat.assertManager(userId);
    return this.inquiries.database.transaction(async (client) => {
      const inquiry = (
        await client.query('SELECT * FROM inquiries WHERE id=$1 FOR UPDATE', [id])
      ).rows[0];
      if (!inquiry) throw new NotFoundException('Обращение не найдено');
      if (inquiry.assignee_id !== userId || !inquiry.manually_assigned) {
        await client.query(
          'UPDATE inquiries SET assignee_id=$2,manually_assigned=true WHERE id=$1',
          [id, userId],
        );
        await client.query(
          'INSERT INTO assignment_events(id,inquiry_id,previous_user_id,user_id,actor_id,reason) VALUES($1,$2,$3,$4,$5,$6)',
          [randomUUID(), id, inquiry.assignee_id, userId, request.actorId, 'manual'],
        );
      }
      return { inquiryId: id, assigneeId: userId, manuallyAssigned: true };
    });
  }

  /** Возобновляет неудачную доставку, сохраняя исходные идентификаторы сообщений. */
  @Post('inquiries/:id/retry')
  async retry(@Param('id', ParseUUIDPipe) id: string) {
    if (
      !(await this.inquiries.database.query('SELECT id FROM inquiries WHERE id=$1', [id]))
        .rowCount
    )
      throw new NotFoundException('Обращение не найдено');
    const jobs = await this.inquiries.database.query(
      "UPDATE delivery_operations SET state='pending',attempts=0,next_attempt_at=now(),last_error=NULL WHERE inquiry_id=$1 AND state='failed' RETURNING id",
      [id],
    );
    return { inquiryId: id, resumed: jobs.rowCount };
  }
}
