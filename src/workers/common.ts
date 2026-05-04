import { QueueOptions, WorkerOptions } from 'bullmq';

export function defaultRedisOptions(redisUrl: string): QueueOptions {
  const u = new URL(redisUrl);
  const password = (u.password || '') || undefined;
  return {
    connection: {
      host: u.hostname || '127.0.0.1',
      port: Number(u.port || 6379),
      password,
      family: 4,
      lazyConnect: true,
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      retryStrategy: (times: number) => Math.min(times * 500, 10000),
      autoResubscribe: true
    }
  };
}

export const DEFAULT_PUBLIC_DOMAINS = new Set([
  'gmail.com', 'googlemail.com',
  'yahoo.com', 'yahoo.co.uk', 'yahoo.ca', 'yahoo.fr', 'yahoo.de', 'ymail.com',
  'outlook.com', 'outlook.fr', 'outlook.de',
  'hotmail.com', 'hotmail.co.uk', 'hotmail.fr', 'hotmail.it', 'hotmail.de',
  'aol.com', 'aim.com',
  'icloud.com', 'me.com', 'mac.com',
  'proton.me', 'protonmail.com', 'protonmail.ch',
  'live.com', 'live.co.uk', 'live.fr',
  'msn.com', 'windowslive.com',
  'yandex.com', 'yandex.ru',
  'zoho.com', 'zohomail.com',
  'mail.com', 'gmx.com', 'gmx.de', 'gmx.net',
  'tutanota.com', 'tuta.io',
  'rediffmail.com', 'indiatimes.com',
  'free.fr', 'orange.fr', 'wanadoo.fr',
  'libero.it', 'virgilio.it',
  'web.de', 'laposte.net'
]);

export function defaultWorkerOptions(redisUrl: string): WorkerOptions {
  const u = new URL(redisUrl);
  const password = (u.password || '') || undefined;
  return {
    connection: {
      host: u.hostname || '127.0.0.1',
      port: Number(u.port || 6379),
      password,
      family: 4,
      lazyConnect: true,
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      retryStrategy: (times: number) => Math.min(times * 500, 10000),
      autoResubscribe: true
    }
    , lockDuration: 300000
    , stalledInterval: 30000
    , maxStalledCount: 10
  };
}
