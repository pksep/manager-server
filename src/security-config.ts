import { z } from 'zod';

const positive = (value: number): z.ZodDefault<z.ZodCoercedNumber<unknown>> =>
  z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(value);

export const securitySettingsSchema = z.object({
  REDIS_URL: z
    .url()
    .refine((value) => ['redis:', 'rediss:'].includes(new URL(value).protocol))
    .default('redis://127.0.0.1:56394/14'),
  MANAGER_RABBITMQ_URL: z
    .url()
    .refine((value) => ['amqp:', 'amqps:'].includes(new URL(value).protocol))
    .optional(),
  MANAGER_QUEUE_PREFIX: z
    .string()
    .regex(/^[a-zA-Z0-9_-]{1,50}$/)
    .default('manager'),
  MANAGER_REDIS_PREFIX: z
    .string()
    .regex(/^[a-zA-Z0-9:_-]{1,60}$/)
    .default('manager:security'),
  MANAGER_TRUSTED_PROXIES: z.string().default(''),
  MANAGER_CAPTCHA_MODE: z.enum(['disabled', 'adaptive', 'required']).default('disabled'),
  SMARTCAPTCHA_CLIENT_KEY: z.string().min(1).max(300).optional(),
  SMARTCAPTCHA_SERVER_KEY: z.string().min(20).max(500).optional(),
  MANAGER_SCAN_MODE: z.enum(['required', 'disabled']).default('required'),
  MANAGER_CLAMAV_HOST: z.string().default('127.0.0.1'),
  MANAGER_CLAMAV_PORT: z.coerce.number().int().min(1).max(65535).default(53310),
  MANAGER_UPLOAD_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .max(20 * 1024 * 1024)
    .default(20 * 1024 * 1024),
  MANAGER_UPLOAD_HOURLY_BYTES: positive(100 * 1024 * 1024),
  MANAGER_SITE_UPLOAD_HOURLY_BYTES: positive(1024 * 1024 * 1024),
  MANAGER_UPLOAD_CONCURRENCY: positive(2),
  MANAGER_UPLOAD_GLOBAL_CONCURRENCY: positive(8),
  MANAGER_HTTP_IP_MINUTE: positive(600),
  MANAGER_HTTP_GLOBAL_MINUTE: positive(10000),
  MANAGER_SESSIONS_IP_MINUTE: positive(30),
  MANAGER_SESSIONS_IP_HOUR: positive(120),
  MANAGER_SESSIONS_SITE_HOUR: positive(3000),
  MANAGER_MESSAGES_GUEST_MINUTE: positive(20),
  MANAGER_MESSAGES_IP_MINUTE: positive(120),
  MANAGER_MESSAGES_SITE_MINUTE: positive(1000),
  MANAGER_INQUIRIES_IP_HOUR: positive(30),
  MANAGER_INQUIRIES_SITE_HOUR: positive(1000),
  MANAGER_CAPTCHA_AFTER_INQUIRIES: positive(3),
  MANAGER_WS_IP_CONCURRENCY: positive(30),
  MANAGER_WS_GLOBAL_CONCURRENCY: positive(1000),
});

export type SecuritySettings = z.infer<typeof securitySettingsSchema>;
