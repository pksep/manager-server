import 'reflect-metadata';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Database } from '../src/database';
import type { Config } from '../src/config';
import { ManagerAssignmentsWorker } from '../src/manager-assignments.worker';

const address = process.env.MANAGER_ASSIGNMENT_TEST_DATABASE_URL;
if (!address)
  throw new Error('Укажите отдельную локальную MANAGER_ASSIGNMENT_TEST_DATABASE_URL');

const url = new URL(address);
if (
  !['127.0.0.1', 'localhost'].includes(url.hostname) ||
  !/^\/manager_assignment_test_[a-z0-9_]+$/.test(url.pathname)
) {
  throw new Error('Нужна отдельная локальная база manager_assignment_test_*');
}

const database = new Database({ DATABASE_URL: address } as Config);
const allowed = '00000000-0000-4000-8000-000000000001';
const revoked = '00000000-0000-4000-8000-000000000002';
const archived = '00000000-0000-4000-8000-000000000003';

interface AssignmentRow {
  id: number;
  manager_ids: string[];
  assignee_id: string | null;
  manually_assigned: boolean;
  metadata_version: number;
  note: string;
}

async function rows(): Promise<AssignmentRow[]> {
  return (await database.query<AssignmentRow>('SELECT * FROM inquiries ORDER BY id'))
    .rows;
}

beforeAll(async (): Promise<void> => {
  await database.query(`CREATE TABLE inquiries(
    id integer PRIMARY KEY, manager_ids uuid[] NOT NULL, assignee_id uuid,
    manually_assigned boolean NOT NULL, metadata_version integer NOT NULL DEFAULT 0,
    note text NOT NULL DEFAULT 'Сохранить примечание'
  )`);
});

afterAll(async (): Promise<void> => {
  await database.onModuleDestroy();
});

test('отзыв права и архив снимают все назначения, сохраняя других менеджеров и примечания', async (): Promise<void> => {
  await database.query(
    `INSERT INTO inquiries(id,manager_ids,assignee_id,manually_assigned) VALUES
    (1,ARRAY[$2::uuid],$2,true),
    (2,ARRAY[$1::uuid,$2::uuid],$2,true),
    (3,ARRAY[$3::uuid],$3,true),
    (4,ARRAY[$1::uuid],$1,true),
    (5,'{}',$2,true),
    (6,'{}',NULL,true)`,
    [allowed, revoked, archived],
  );
  const worker = new ManagerAssignmentsWorker(database, {
    managerIds: async (): Promise<string[]> => [allowed],
  });

  await worker.reconcile();
  const result = await rows();

  expect(result.map((row) => row.manager_ids)).toEqual([
    [],
    [allowed],
    [],
    [allowed],
    [],
    [],
  ]);
  expect(result.map((row) => row.assignee_id)).toEqual([
    null,
    null,
    null,
    allowed,
    null,
    null,
  ]);
  expect(result.map((row) => row.metadata_version)).toEqual([1, 1, 1, 0, 1, 0]);
  expect(result.map((row) => row.manually_assigned)).toEqual([
    false,
    true,
    false,
    true,
    false,
    true,
  ]);
  expect(result.every((row) => row.note === 'Сохранить примечание')).toBe(true);

  await worker.reconcile();
  expect(await rows()).toEqual(result);
  const restored = new ManagerAssignmentsWorker(database, {
    managerIds: async (): Promise<string[]> => [allowed, revoked, archived],
  });
  await restored.reconcile();
  expect(await rows()).toEqual(result);
});

test('временный отказ источника прав не изменяет назначения', async (): Promise<void> => {
  const before = await rows();
  const worker = new ManagerAssignmentsWorker(database, {
    managerIds: async (): Promise<string[]> => {
      throw new Error('Временный отказ');
    },
  });

  await expect(worker.reconcile()).rejects.toThrow('Временный отказ');
  expect(await rows()).toEqual(before);
});

test('запоздалый снимок не перезаписывает сохранённого доступного менеджера и новое примечание', async (): Promise<void> => {
  let release!: (ids: string[]) => void;
  const snapshot = new Promise<string[]>((resolve): void => {
    release = resolve;
  });
  const worker = new ManagerAssignmentsWorker(database, {
    managerIds: (): Promise<string[]> => snapshot,
  });
  const pending = worker.reconcile();
  await database.query(
    'UPDATE inquiries SET manager_ids=ARRAY[$1::uuid],assignee_id=$1,note=$2,metadata_version=7 WHERE id=1',
    [allowed, 'Новая правка'],
  );

  release([allowed]);
  await pending;
  expect((await rows())[0]).toMatchObject({
    manager_ids: [allowed],
    assignee_id: allowed,
    note: 'Новая правка',
    metadata_version: 7,
  });
});
