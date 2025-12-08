import { QueueOptions, WorkerOptions } from 'bullmq';

export function defaultRedisOptions(redisUrl: string): QueueOptions {
  return {
    connection: {
      url: redisUrl,
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      retryStrategy: (times: number) => Math.min(times * 500, 10000),
      autoResubscribe: true
    }
  };
}

export function defaultWorkerOptions(redisUrl: string): WorkerOptions {
  return {
    connection: {
      url: redisUrl,
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
