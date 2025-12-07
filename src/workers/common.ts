import { QueueOptions, WorkerOptions } from 'bullmq';

export function defaultRedisOptions(redisUrl: string): QueueOptions {
  return {
    connection: {
      url: redisUrl
    }
  };
}

export function defaultWorkerOptions(redisUrl: string): WorkerOptions {
  return {
    connection: {
      url: redisUrl
    }
    , lockDuration: 300000
    , stalledInterval: 30000
    , maxStalledCount: 10
  };
}
