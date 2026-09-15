import { BadRequestException, ConflictException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { DatabaseTransaction } from './database';
import { domainToASCII } from 'node:url';
import type { Contacts, WidgetConfig } from './contracts';

/** Нормализует реквизиты для поиска кандидатов, не подтверждая личность посетителя. */
export function normalizeContacts(
  contacts: Contacts,
  policy: WidgetConfig['contactPolicy'],
) {
  const phone = contacts.phone.replace(/\D/g, '');
  if (
    (contacts.phone || policy === 'all') &&
    (!/^[+\d\s().-]+$/.test(contacts.phone) || phone.length < 10 || phone.length > 15)
  )
    throw new BadRequestException('Проверьте номер телефона');
  if (
    (contacts.email || policy === 'all') &&
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contacts.email)
  )
    throw new BadRequestException('Проверьте email');
  if (!contacts.phone && !contacts.email)
    throw new BadRequestException('Укажите телефон или email');
  const [local, domain] = contacts.email.split('@');
  if (domain && !domainToASCII(domain)) throw new BadRequestException('Проверьте email');
  const email = domain
    ? `${local.toLocaleLowerCase('en-US')}@${domainToASCII(domain.toLocaleLowerCase('en-US'))}`
    : '';
  return { phone: phone ? `+${phone}` : '', email };
}

/** Совпадение обоих реквизитов связывает карточку, но не даёт доступ к истории сессий. */
export async function resolveCustomer(
  client: DatabaseTransaction,
  contacts: Contacts,
  normalized: { phone: string; email: string },
): Promise<string> {
  if (normalized.phone && normalized.email) {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `manager:customer:${normalized.phone}:${normalized.email}`,
    ]);
    const matches = (
      await client.query<{ id: string; erp_contact_id: string | null }>(
        `SELECT c.id,c.erp_contact_id FROM customers c WHERE c.merged_into IS NULL
       AND EXISTS(SELECT 1 FROM customer_identities p WHERE p.customer_id=c.id AND p.kind='phone' AND p.value=$1)
       AND EXISTS(SELECT 1 FROM customer_identities e WHERE e.customer_id=c.id AND e.kind='email' AND e.value=$2)
       ORDER BY c.erp_contact_id IS NULL,c.created_at,c.id`,
        [normalized.phone, normalized.email],
      )
    ).rows;
    if (new Set(matches.map((row) => row.erp_contact_id).filter(Boolean)).size > 1)
      throw new ConflictException('Телефон и email связаны с разными контактами СЭП');
    if (matches.length) return matches[0].id;
  }
  const id = randomUUID();
  await client.models.Customer.create(
    { id, name: contacts.name, contacts },
    { transaction: client.transaction },
  );
  return id;
}
