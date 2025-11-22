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
  };
}