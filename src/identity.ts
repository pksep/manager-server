import { BadRequestException } from '@nestjs/common';
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
