import 'reflect-metadata';
import { expect, mock, test } from 'bun:test';
import { ForbiddenException } from '@nestjs/common';
import type { QueryResultRow } from 'pg';
import type { DatabaseResult, DatabaseTransaction } from '../../src/database';
import { InquiriesService } from '../../src/inquiries.service';
import type { ChatEvent } from '../../src/contracts';

for (const allowed of [true, false]) {
  test(`запоздалый ответ сохраняется, автоматическое назначение требует текущий доступ: ${allowed}`, async (): Promise<void> => {
    const statements: string[] = [];
    const sessionId = crypto.randomUUID();
    const senderId = crypto.randomUUID();
    const inquiryId = crypto.randomUUID();
    const query = async <T extends QueryResultRow = QueryResultRow>(
      sql: string,
    ): Promise<DatabaseResult<T>> => {
      statements.push(sql);
      const rows: QueryResultRow[] = sql.startsWith('SELECT session_id')
        ? [{ session_id: sessionId }]
        : sql.startsWith('SELECT * FROM inquiries')
          ? [{ chat_cursor: '0' }]
          : [{ id: inquiryId }];

      return { rows: rows as T[], rowCount: rows.length };
    };
    const actor = mock(async (): Promise<void> => {
      if (!allowed) throw new ForbiddenException('Доступ отозван');
    });
    const service = Object.assign(
      Object.create(InquiriesService.prototype) as InquiriesService,
      {
        database: {
          transaction: async <T>(
            work: (db: Pick<DatabaseTransaction, 'query'>) => Promise<T>,
          ): Promise<T> => work({ query }),
        },
        chat: { assertManager: actor },
        queue: { enqueue: async (): Promise<void> => {} },
      },
    );
    const event: ChatEvent = {
      version: 1,
      sequence: 1,
      type: 'message',
      messageId: crypto.randomUUID(),
      senderId,
      guestSessionId: sessionId,
      author: 'Оператор',
      direction: 'incoming',
      html: '<p>Ответ посетителю</p>',
      attachments: [],
      createdAt: new Date().toISOString(),
    };

    await service.acceptEvents(inquiryId, [event]);

    expect(actor).toHaveBeenCalledWith(senderId);
    expect(statements.some((sql) => sql.startsWith('INSERT INTO messages'))).toBe(true);
    expect(
      statements.some((sql) => sql.startsWith('UPDATE inquiries SET assignee_id')),
    ).toBe(allowed);
    expect(
      statements.some((sql) => sql.startsWith('UPDATE inquiries SET chat_cursor')),
    ).toBe(true);
  });
}
