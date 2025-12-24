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
  'gmail.com',
  'yahoo.com',
  'outlook.com',
  'hotmail.com',
  'aol.com',
  'icloud.com',
  'proton.me',
  'live.com',
  'msn.com',
  'yandex.com',
  'zoho.com',
  'mail.com'
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
