import { redis } from '../redis'
import { config } from '../config'

const BATCH_WORKER_KEY = (batchId: number) => `val:batch:${batchId}:worker_idx`
const WORKER_BATCH_KEY = (idx: number) => `val:worker:${idx}:batch_id`
const WORKER_BATCH_TS = (idx: number) => `val:worker:${idx}:batch_ts`

export async function assignWorkerForBatch(batchId: number): Promise<number> {
  const existing = await redis.get(BATCH_WORKER_KEY(batchId))
  if (existing) return Number(existing)
  const total = (config.ninjaKeys || []).length
  for (let idx = 0; idx < total; idx++) {
    const cur = await redis.get(WORKER_BATCH_KEY(idx))
    if (!cur) {
      await redis.set(BATCH_WORKER_KEY(batchId), String(idx))
      await redis.set(WORKER_BATCH_KEY(idx), String(batchId))
      await redis.set(WORKER_BATCH_TS(idx), String(Date.now()))
      return idx
    }
  }
  // if none free, pin to modulo for stability
  const idx = batchId % Math.max(1, total)
  await redis.set(BATCH_WORKER_KEY(batchId), String(idx))
  return idx
}

export async function releaseBatchAssignment(batchId: number): Promise<void> {
  const existing = await redis.get(BATCH_WORKER_KEY(batchId))
  if (existing) {
    await redis.del(BATCH_WORKER_KEY(batchId))
    await redis.del(WORKER_BATCH_KEY(Number(existing)))
    await redis.del(WORKER_BATCH_TS(Number(existing)))
  }
}
