import { Queue } from 'bullmq';
import { config } from './config';
import { defaultRedisOptions } from './workers/common';

export const QUEUE_NAMES = {
  dedupe: 'dedupeQueue',
  filter: 'filterQueue',
  personal: 'personalQueue',
  validation: 'validationQueue'
};

export const dedupeQueue = new Queue(QUEUE_NAMES.dedupe, defaultRedisOptions(config.redisUrl));
export const filterQueue = new Queue(QUEUE_NAMES.filter, defaultRedisOptions(config.redisUrl));
export const personalQueue = new Queue(QUEUE_NAMES.personal, defaultRedisOptions(config.redisUrl));
export const validationQueue = new Queue(QUEUE_NAMES.validation, defaultRedisOptions(config.redisUrl));
// Per-key validation queues to support one-batch-per-worker routing
export const validationQueues = (config.ninjaKeys || []).map((_, idx) => new Queue(`${QUEUE_NAMES.validation}_${idx}`, defaultRedisOptions(config.redisUrl)));
