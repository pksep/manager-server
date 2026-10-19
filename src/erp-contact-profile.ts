import { z } from 'zod';
import { normalizeContacts } from './identity';

export const ErpContactSnapshotSchema = z.object({
  id: z.number().int().positive().max(2147483647),
  initial: z.string(),
  ban: z.boolean(),
  updatedAt: z.iso.datetime({ offset: true }),
  requisites: z.array(
    z.object({
      title: z.object({ type: z.string() }),
      value: z.unknown(),
    }),
  ),
});

export interface ErpContactProfile {
  phone: string;
  email: string;
  identities: Array<{ kind: 'phone' | 'email'; value: string }>;
}

/** Показывает сохранённые реквизиты; только корректные значения участвуют в поиске совпадений. */
export function erpContactProfile(
  contact: z.infer<typeof ErpContactSnapshotSchema>,
): ErpContactProfile {
  const result: ErpContactProfile = { phone: '', email: '', identities: [] };
  const seen = new Set<string>();

  for (const requisite of contact.requisites) {
    const kind = requisite.title.type;

    if ((kind !== 'phone' && kind !== 'email') || typeof requisite.value !== 'string')
      continue;

    const value = requisite.value.trim();

    if (!value) continue;
    if (!result[kind]) result[kind] = value;

    try {
      const normalized = normalizeContacts(
        { name: '', phone: '', email: '', [kind]: value },
        'name-and-one',
      )[kind];
      const key = `${kind}:${normalized}`;

      if (!seen.has(key)) result.identities.push({ kind, value: normalized });
      seen.add(key);
    } catch {
      // Старое свободное поле СЭП не является подтверждением совпадения клиентов.
    }
  }

  return result;
}
