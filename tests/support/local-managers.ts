import { readFileSync } from 'node:fs';
import type { Pool } from 'pg';

export const localActors = JSON.parse(
  readFileSync('../.worktrees/manager-erp-server/.local/erp-actors.json', 'utf8'),
) as Array<{ userId: number; roleId: number; tabel: string }>;

/** Сценарии работают с ролями настоящей тестовой ERP, а не подменяют снимок прав Чата. */
export async function clientPermission(
  db: Pool,
  roleId: number,
  enabled?: boolean,
): Promise<boolean> {
  const permission = (
    await db.query(
      "SELECT p.id FROM authorization_permissions p JOIN authorization_resources r ON r.id=p.resource_id WHERE r.code='chat.clients' AND p.action='view'",
    )
  ).rows[0]?.id;
  if (!permission) throw new Error('Сначала настройте тестовые роли ERP');
  const current = !!(
    await db.query(
      'SELECT 1 FROM role_permissions WHERE role_id=$1 AND permission_id=$2',
      [roleId, permission],
    )
  ).rowCount;
  if (enabled === undefined || current === enabled) return current;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    if (enabled)
      await client.query(
        'INSERT INTO role_permissions(role_id,permission_id,"createdAt","updatedAt") VALUES($1,$2,now(),now()) ON CONFLICT DO NOTHING',
        [roleId, permission],
      );
    else
      await client.query(
        'DELETE FROM role_permissions WHERE role_id=$1 AND permission_id=$2',
        [roleId, permission],
      );
    await client.query(
      'UPDATE roles SET permissions_version=permissions_version+1 WHERE id=$1',
      [roleId],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return current;
}

export async function awaitManagerAccess(
  base: string,
  token: string,
  allowed: boolean,
): Promise<void> {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const response = await fetch(base + '/manager/access', {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    if (response.ok && (await response.json()).allowed === allowed) return;
    await Bun.sleep(500);
  }
  throw new Error('Роль ERP не обновилась в Чате');
}
