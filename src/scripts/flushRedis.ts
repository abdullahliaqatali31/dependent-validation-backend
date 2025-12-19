import { redis } from '../redis';

(async () => {
  console.log('Flushing all Redis data...');
  try {
    const result = await redis.flushall();
    console.log('Redis flushed:', result);
  } catch (e) {
    console.error('Failed to flush Redis:', e);
  } finally {
    process.exit(0);
  }
})();
