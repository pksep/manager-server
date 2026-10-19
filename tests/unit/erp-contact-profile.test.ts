import { expect, test } from 'bun:test';
import {
  erpContactProfile,
  ErpContactSnapshotSchema,
} from '../../src/erp-contact-profile';

test('реквизиты СЭП отображаются и нормализуются для поиска без дублей', (): void => {
  const result = erpContactProfile({
    id: 15,
    initial: 'Клиент',
    ban: false,
    updatedAt: new Date().toISOString(),
    requisites: [
      { title: { type: 'phone' }, value: '+7 (999) 123-45-67' },
      { title: { type: 'phone' }, value: '+79991234567' },
      { title: { type: 'email' }, value: ' Client@EXAMPLE.test ' },
      { title: { type: 'address' }, value: 'Не телефон' },
    ],
  });

  expect(result).toEqual({
    phone: '+7 (999) 123-45-67',
    email: 'Client@EXAMPLE.test',
    identities: [
      { kind: 'phone', value: '+79991234567' },
      { kind: 'email', value: 'client@example.test' },
    ],
  });
});

test('свободный текст и пустые поля не подтверждают совпадение людей', (): void => {
  expect(
    erpContactProfile({
      id: 15,
      initial: 'Клиент',
      ban: false,
      updatedAt: new Date().toISOString(),
      requisites: [
        { title: { type: 'phone' }, value: 'уточнить' },
        { title: { type: 'email' }, value: null },
      ],
    }),
  ).toEqual({ phone: 'уточнить', email: '', identities: [] });
});

test('снимок без версии не выдаётся за обновление контакта', (): void => {
  expect(
    ErpContactSnapshotSchema.safeParse({
      id: 15,
      initial: 'Клиент',
      ban: false,
      requisites: [],
    }).success,
  ).toBe(false);
});
