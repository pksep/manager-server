import {
  HttpException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import proxyaddr from 'proxy-addr';
import ipaddr from 'ipaddr.js';
import { createClient } from 'redis';
import { CONFIG, type Config } from './config';

interface Limit {
  key: string;
  capacity: number;
  window: number;
  cost?: number;
}
interface Lease {
  key: string;
  capacity: number;
}

export interface SecurityContext {
  ip: string;
  network: string;
  origin: string;
  visitor?: string;
  captchaToken?: string;
  challenge?: string;
}

export class SecurityError extends HttpException {
  constructor(
    readonly code:
      | 'rate_limited'
      | 'captcha_required'
      | 'captcha_failed'
      | 'file_rejected',
    message: string,
    readonly details: Record<string, string | number> = {},
  ) {
    super(message, code === 'rate_limited' ? 429 : code === 'file_rejected' ? 422 : 403);
  }
}

const bucketScript = `
local t=redis.call('TIME'); local now=t[1]*1000+math.floor(t[2]/1000)
local values={}; local retry=0
for i,key in ipairs(KEYS) do
 local at=(i-1)*3; local cap=tonumber(ARGV[at+1]); local window=tonumber(ARGV[at+2]); local cost=tonumber(ARGV[at+3])
 local old=redis.call('HMGET',key,'tokens','at'); local tokens=tonumber(old[1]) or cap
 tokens=math.min(cap,tokens+math.max(0,now-(tonumber(old[2]) or now))*cap/window)
 values[i]=tokens-cost
 if tokens<cost then retry=math.max(retry,math.ceil((cost-tokens)*window/cap)) end
end
if retry>0 then return retry end
for i,key in ipairs(KEYS) do
 redis.call('HSET',key,'tokens',values[i],'at',now); redis.call('PEXPIRE',key,tonumber(ARGV[(i-1)*3+2])*2)
end
return 0`;

const leaseScript = `
local t=redis.call('TIME'); local now=t[1]*1000+math.floor(t[2]/1000)
for i,key in ipairs(KEYS) do
 redis.call('ZREMRANGEBYSCORE',key,'-inf',now)
 if redis.call('ZCARD',key)>=tonumber(ARGV[i+2]) then return 0 end
end
for _,key in ipairs(KEYS) do redis.call('ZADD',key,now+tonumber(ARGV[2]),ARGV[1]); redis.call('PEXPIRE',key,tonumber(ARGV[2])*2) end
return 1`;

const repeatScript = `
local t=redis.call('TIME'); local now=t[1]*1000+math.floor(t[2]/1000)
redis.call('ZREMRANGEBYSCORE',KEYS[1],'-inf',now-tonumber(ARGV[2]))
redis.call('ZADD',KEYS[1],'NX',now,ARGV[1]); redis.call('PEXPIRE',KEYS[1],ARGV[2])
return redis.call('ZCARD',KEYS[1])`;

@Injectable()
export class SecurityService implements OnModuleInit, OnModuleDestroy {
  readonly redis: ReturnType<typeof createClient>;
  private readonly trust: (address: string, index: number) => boolean;
  private readonly logger = new Logger('ManagerSecurity');
  private readonly lastLogs = new Map<string, number>();
  private recovering?: Promise<void>;
  private stopped = false;

  constructor(@Inject(CONFIG) readonly config: Config) {
    const ranges = config.MANAGER_TRUSTED_PROXIES.split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    this.trust = ranges.length ? proxyaddr.compile(ranges) : (): boolean => false;
    this.redis = createClient({
      url: config.REDIS_URL,
      disableOfflineQueue: true,
      commandsQueueMaxLength: 1000,
      socket: {
        connectTimeout: 3000,
        reconnectStrategy: (attempt): number => Math.min(3000, 200 * (attempt + 1)),
      },
    });
    this.redis.on('error', () => this.audit('redis_unavailable'));
  }

  /** Общие счётчики обязательны для всех экземпляров публичного сервиса. */
  async onModuleInit(): Promise<void> {
    await Promise.race([
      this.redis.connect(),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error('Redis недоступен')), 5000);
        timer.unref();
      }),
    ]);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.redis.isOpen) await this.redis.disconnect();
  }

  /** Разрыв сети не удерживает публичные запросы и очередь команд без ограничения времени. */
  private async command<T>(action: () => Promise<T>): Promise<T> {
    this.assertReady();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        action(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new ServiceUnavailableException('Защита приёма временно недоступна'));
            if (!this.recovering && !this.stopped) {
              this.recovering = (async (): Promise<void> => {
                if (this.redis.isOpen) await this.redis.disconnect();
                if (!this.stopped) await this.redis.connect();
              })()
                .catch(() => {})
                .finally(() => {
                  this.recovering = undefined;
                });
            }
          }, 3000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async eval(
    script: string,
    options: { keys: string[]; arguments: string[] },
  ): Promise<unknown> {
    return this.command(() => this.redis.eval(script, options));
  }

  key(value: string): string {
    return `${this.config.MANAGER_REDIS_PREFIX}:${createHmac(
      'sha256',
      this.config.MANAGER_INTERNAL_KEY,
    )
      .update('security:' + value)
      .digest('hex')}`;
  }

  /** Подменённый X-Forwarded-For от прямого клиента не используется. */
  context(request: IncomingMessage): SecurityContext {
    let ip: string;
    try {
      ip = ipaddr.process(proxyaddr(request, this.trust)).toString();
    } catch {
      throw new HttpException('Некорректный адрес соединения', 400);
    }
    const address = ipaddr.parse(ip);
    const bytes = address.toByteArray();
    if (address.kind() === 'ipv6') bytes.fill(0, 8);
    const network = this.key(`network:${ipaddr.fromByteArray(bytes).toString()}`);
    const header = (name: string): string | undefined => {
      const value = request.headers[name];
      return typeof value === 'string' && value.length <= 8192 ? value : undefined;
    };
    return {
      ip,
      network,
      origin: header('origin') || '',
      captchaToken: header('x-captcha-token'),
      challenge: header('x-captcha-challenge'),
    };
  }

  /** Два независимых лимита не позволяют менять сессии ради обхода общего бюджета. */
  async consume(limits: Limit[]): Promise<void> {
    this.assertReady();
    const retry = Number(
      await this.eval(bucketScript, {
        keys: limits.map((limit) => this.key(limit.key)),
        arguments: limits.flatMap((limit) => [
          String(limit.capacity),
          String(limit.window),
          String(limit.cost ?? 1),
        ]),
      }),
    );
    if (retry > 0) {
      this.audit('rate_limited');
      throw new SecurityError(
        'rate_limited',
        'Слишком много запросов. Попробуйте позже.',
        { retryAfter: Math.max(5, Math.ceil(retry / 5000) * 5) },
      );
    }
  }

  async ingress(context: SecurityContext): Promise<void> {
    await this.consume([
      {
        key: `http:${context.network}`,
        capacity: this.config.MANAGER_HTTP_IP_MINUTE,
        window: 60000,
      },
      {
        key: 'http:global',
        capacity: this.config.MANAGER_HTTP_GLOBAL_MINUTE,
        window: 60000,
      },
    ]);
  }

  /** Идентификатор браузера подписан сервером и не открывает историю сессий. */
  visitor(token?: string): string {
    if (token && /^[a-f0-9-]{36}\.[a-f0-9]{64}$/.test(token)) {
      const [id, signature] = token.split('.');
      if (
        timingSafeEqual(
          Buffer.from(signature, 'hex'),
          Buffer.from(this.key(`visitor:${id}`).split(':').at(-1)!, 'hex'),
        )
      )
        return token;
    }
    const id = randomUUID();
    return `${id}.${this.key(`visitor:${id}`).split(':').at(-1)}`;
  }

  async newSession(
    context: SecurityContext,
    siteId: string,
    visitor: string,
  ): Promise<void> {
    await this.consume([
      {
        key: `sessions:${context.network}`,
        capacity: this.config.MANAGER_SESSIONS_IP_MINUTE,
        window: 60000,
      },
      {
        key: `sessions-hour:${context.network}`,
        capacity: this.config.MANAGER_SESSIONS_IP_HOUR,
        window: 3600000,
      },
      { key: `sessions-visitor:${visitor}`, capacity: 30, window: 3600000 },
      {
        key: `sessions-site:${siteId}`,
        capacity: this.config.MANAGER_SESSIONS_SITE_HOUR,
        window: 3600000,
      },
    ]);
  }

  /** Повтор одной операции не считается новым спам-сообщением. */
  async message(
    context: SecurityContext,
    siteId: string,
    guestId: string,
    operationId: string,
    normalizedText: string,
    attachmentIds: string[],
    first: boolean,
  ): Promise<void> {
    const operation = `${guestId}:${operationId}`;
    const fingerprint = normalizedText
      .normalize('NFKC')
      .toLocaleLowerCase('ru')
      .replace(/\s+/g, ' ')
      .trim();
    const signature = `${fingerprint}:${attachmentIds.join(',')}`;
    const count = Number(
      await this.eval(repeatScript, {
        keys: [this.key(`repeat:${siteId}:${context.network}:${signature}`)],
        arguments: [operation, '60000'],
      }),
    );
    if (count > 10) {
      this.audit('repeated_messages');
      throw new SecurityError(
        'rate_limited',
        'Слишком много повторяющихся сообщений. Попробуйте позже.',
        { retryAfter: 60 },
      );
    }
    const firstCount = first
      ? Number(
          await this.eval(repeatScript, {
            keys: [this.key(`new-inquiries:${siteId}:${context.network}`)],
            arguments: [operation, '600000'],
          }),
        )
      : 0;
    const distributedCount =
      /https?:\/\//.test(fingerprint) || fingerprint.length >= 80
        ? Number(
            await this.eval(repeatScript, {
              keys: [this.key(`distributed-repeat:${siteId}:${fingerprint}`)],
              arguments: [guestId, '300000'],
            }),
          )
        : 0;
    await this.captcha(
      context,
      siteId,
      `message:${operation}:${signature}`,
      count >= 3 ||
        distributedCount >= 10 ||
        firstCount > this.config.MANAGER_CAPTCHA_AFTER_INQUIRIES ||
        (first && this.config.MANAGER_CAPTCHA_MODE === 'required'),
    );
    await this.consume([
      {
        key: `messages:${guestId}`,
        capacity: this.config.MANAGER_MESSAGES_GUEST_MINUTE,
        window: 60000,
      },
      {
        key: `messages-visitor:${context.visitor || guestId}`,
        capacity: this.config.MANAGER_MESSAGES_GUEST_MINUTE,
        window: 60000,
      },
      {
        key: `messages-ip:${context.network}`,
        capacity: this.config.MANAGER_MESSAGES_IP_MINUTE,
        window: 60000,
      },
      {
        key: `messages-site:${siteId}`,
        capacity: this.config.MANAGER_MESSAGES_SITE_MINUTE,
        window: 60000,
      },
      ...(first
        ? [
            {
              key: `inquiries-ip:${context.network}`,
              capacity: this.config.MANAGER_INQUIRIES_IP_HOUR,
              window: 3600000,
            },
            {
              key: `inquiries-site:${siteId}`,
              capacity: this.config.MANAGER_INQUIRIES_SITE_HOUR,
              window: 3600000,
            },
          ]
        : []),
    ]);
  }

  /** Одноразовое подтверждение привязано к операции, сайту и источнику запроса. */
  async captcha(
    context: SecurityContext,
    siteId: string,
    operation: string,
    needed: boolean,
  ): Promise<void> {
    if (!needed || this.config.MANAGER_CAPTCHA_MODE === 'disabled') return;
    const binding = this.key(
      `${siteId}:${context.origin}:${context.network}:${operation}`,
    );
    if (
      context.challenge &&
      /^[a-f0-9-]{36}$/.test(context.challenge) &&
      context.captchaToken
    ) {
      const expected = await this.command(() =>
        this.redis.getDel(this.key(`challenge:${context.challenge}`)),
      );
      if (expected === binding) {
        let response: Response;
        try {
          response = await fetch('https://smartcaptcha.cloud.yandex.ru/validate', {
            method: 'POST',
            redirect: 'error',
            signal: AbortSignal.timeout(5000),
            body: new URLSearchParams({
              secret: this.config.SMARTCAPTCHA_SERVER_KEY || '',
              token: context.captchaToken,
              ip: context.ip,
            }),
          });
          if (!response.ok) throw new Error('captcha_unavailable');
        } catch {
          this.audit('captcha_unavailable');
          throw new ServiceUnavailableException('Проверка временно недоступна');
        }
        const result: unknown = await response.json();
        if (
          result &&
          typeof result === 'object' &&
          'status' in result &&
          result.status === 'ok' &&
          'host' in result &&
          result.host === new URL(context.origin).host
        )
          return;
        this.audit('captcha_failed');
      }
    }
    const challenge = randomUUID();
    await this.command(() =>
      this.redis.set(this.key(`challenge:${challenge}`), binding, { EX: 180 }),
    );
    throw new SecurityError('captcha_required', 'Подтвердите, что вы не робот.', {
      siteKey: this.config.SMARTCAPTCHA_CLIENT_KEY || '',
      challenge,
    });
  }

  /** Аренда ограничивает одновременные соединения и автоматически истекает после сбоя процесса. */
  async acquire(
    limits: Lease[],
    lifetime = 90000,
  ): Promise<{ renew(): Promise<boolean>; release(): Promise<void> }> {
    this.assertReady();
    const keys = limits.map((limit) => this.key(`lease:${limit.key}`));
    const token = randomUUID();
    const accepted = await this.eval(leaseScript, {
      keys,
      arguments: [
        token,
        String(lifetime),
        ...limits.map((limit) => String(limit.capacity)),
      ],
    });
    if (accepted !== 1)
      throw new SecurityError(
        'rate_limited',
        'Слишком много одновременных подключений.',
        { retryAfter: 30 },
      );
    return {
      renew: async (): Promise<boolean> => {
        const count = await this.eval(
          "local t=redis.call('TIME'); local now=t[1]*1000+math.floor(t[2]/1000); local untilAt=now+tonumber(ARGV[2]); for _,key in ipairs(KEYS) do local expiry=redis.call('ZSCORE',key,ARGV[1]); if not expiry or tonumber(expiry)<=now then return 0 end end; for _,key in ipairs(KEYS) do redis.call('ZADD',key,'XX',untilAt,ARGV[1]); redis.call('PEXPIRE',key,tonumber(ARGV[2])*2) end; return 1",
          { keys, arguments: [token, String(lifetime)] },
        );
        return count === 1;
      },
      release: async (): Promise<void> => {
        if (this.redis.isReady)
          await this.command(() =>
            Promise.all(keys.map((key) => this.redis.zRem(key, token))),
          );
      },
    };
  }

  assertReady(): void {
    if (!this.redis.isReady)
      throw new ServiceUnavailableException('Защита приёма временно недоступна');
  }

  audit(event: string): void {
    const now = Date.now();
    if (now - (this.lastLogs.get(event) || 0) > 60000) {
      this.lastLogs.set(event, now);
      this.logger.warn({ event });
    }
    if (this.redis?.isReady) {
      const key = `${this.config.MANAGER_REDIS_PREFIX}:metrics:${new Date().toISOString().slice(0, 10)}`;
      void this.redis
        .eval(
          "redis.call('HINCRBY',KEYS[1],ARGV[1],1); redis.call('EXPIRE',KEYS[1],604800); return 1",
          { keys: [key], arguments: [event] },
        )
        .catch(() => {});
    }
  }
}
