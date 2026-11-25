import { createHmac, timingSafeEqual } from 'node:crypto';

/** Проверяет подпись Meta по исходным байтам запроса до обработки сообщения. */
export function verifyWhatsAppSignature(
  body: Uint8Array,
  header: string | undefined,
  appSecret: string,
): boolean {
  if (!appSecret || !header || !/^sha256=[0-9a-f]{64}$/i.test(header)) return false;

  const expected = createHmac('sha256', appSecret).update(body).digest();
  const received = Buffer.from(header.slice(7), 'hex');

  return received.length === expected.length && timingSafeEqual(received, expected);
}
