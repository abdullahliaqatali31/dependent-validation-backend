import Redis from 'ioredis';
import { config } from './config';

export const redis = new Redis(config.redisUrl);

export async function bloomExists(key: string, item: string): Promise<boolean> {
  // RedisBloom BF.EXISTS
  const res = await redis.call('BF.EXISTS', key, item) as number;
  return res === 1;
}

export async function bloomAdd(key: string, item: string): Promise<void> {
  await redis.call('BF.ADD', key, item);
}

export async function publish(channel: string, message: any) {
  await redis.publish(channel, JSON.stringify(message));
}

export const CHANNELS = {
  batchProgress: 'batch_progress',
  systemMonitor: 'system_monitor'
};
