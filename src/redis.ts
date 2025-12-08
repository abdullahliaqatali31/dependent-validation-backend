import Redis from 'ioredis';
import { config } from './config';

export const redis = new Redis(config.redisUrl, {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
  retryStrategy: (times: number) => Math.min(times * 500, 10000),
  autoResubscribe: true
});

redis.on('error', (e: any) => {
  try { console.error('redis_error', { url: config.redisUrl, message: e?.message || String(e) }); } catch {}
});
redis.on('reconnecting', () => {
  try { console.log('redis_reconnecting', { url: config.redisUrl }); } catch {}
});
redis.on('ready', () => {
  try { console.log('redis_ready', { url: config.redisUrl }); } catch {}
});

 export async function bloomExists(key: string, item: string): Promise<boolean> {
  try {
    const res = await redis.call('BF.EXISTS', key, item) as number;
    return res === 1;
  } catch {
    return false;
  }
}

export async function bloomAdd(key: string, item: string): Promise<void> {
  try {
    await redis.call('BF.ADD', key, item);
  } catch {}
}

export async function publish(channel: string, message: any) {
  await redis.publish(channel, JSON.stringify(message));
}

export const CHANNELS = {
  batchProgress: 'batch_progress',
  systemMonitor: 'system_monitor'
};
