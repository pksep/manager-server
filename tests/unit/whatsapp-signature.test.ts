import { createHmac } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { verifyWhatsAppSignature } from '../../src/channels/whatsapp-signature';

describe('подпись уведомлений WhatsApp', (): void => {
  const secret = 'local-test-app-secret';
  const body = Buffer.from('{"object":"whatsapp_business_account"}');
  const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

  test('принимает подпись для точных байтов тела', (): void => {
    expect(verifyWhatsAppSignature(body, signature, secret)).toBe(true);
  });

  test('отклоняет изменённое тело и другой секрет', (): void => {
    expect(verifyWhatsAppSignature(Buffer.from(`${body} `), signature, secret)).toBe(
      false,
    );
    expect(verifyWhatsAppSignature(body, signature, 'other-secret')).toBe(false);
  });

  test('отклоняет отсутствующую и некорректную подпись', (): void => {
    expect(verifyWhatsAppSignature(body, undefined, secret)).toBe(false);
    expect(verifyWhatsAppSignature(body, 'sha1=bad', secret)).toBe(false);
    expect(verifyWhatsAppSignature(body, 'sha256=abc', secret)).toBe(false);
    expect(verifyWhatsAppSignature(body, signature, '')).toBe(false);
  });
});
