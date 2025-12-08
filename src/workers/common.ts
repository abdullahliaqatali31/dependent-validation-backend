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
