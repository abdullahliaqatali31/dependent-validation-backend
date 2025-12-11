import { redis } from '../redis'
import { config } from '../config'

const BATCH_WORKER_KEY = (batchId: number) => `val:batch:${batchId}:worker_idx`
const WORKER_BATCH_KEY = (idx: number) => `val:worker:${idx}:batch_id`
const WORKER_BATCH_TS = (idx: number) => `val:worker:${idx}:batch_ts`
const ACTIVE_BATCH_KEY = 'val:active_batch_id'
const BATCH_ACTIVATED_KEY = (batchId: number) => `val:batch:${batchId}:activated`
const BATCH_RR_KEY = (batchId: number) => `val:batch:${batchId}:rr`

export async function waitForBatchTurn(batchId: number): Promise<void> {
  while (true) {
    const active = await redis.get(ACTIVE_BATCH_KEY)
    if (!active) {
      await redis.set(ACTIVE_BATCH_KEY, String(batchId))
      return
    }
    if (Number(active) === batchId) return
    await new Promise(r => setTimeout(r, 1000))
  }
}

export async function ensureBatchActivated(batchId: number): Promise<void> {
  const activated = await redis.get(BATCH_ACTIVATED_KEY(batchId))
  if (activated) return
  await waitForBatchTurn(batchId)
  await redis.set(BATCH_ACTIVATED_KEY(batchId), '1')
}

export async function assignWorkerRoundRobin(batchId: number): Promise<number> {
  const total = Math.max(1, (config.ninjaKeys || []).length)
  const curStr = await redis.get(BATCH_RR_KEY(batchId))
  const cur = curStr ? Number(curStr) : 0
  const idx = cur % total
  await redis.set(BATCH_RR_KEY(batchId), String(cur + 1))
  await redis.set(BATCH_WORKER_KEY(batchId), 'all')
  await redis.set(WORKER_BATCH_KEY(idx), String(batchId))
  await redis.set(WORKER_BATCH_TS(idx), String(Date.now()))
  return idx
}

export async function releaseBatchAssignment(batchId: number): Promise<void> {
  const total = Math.max(1, (config.ninjaKeys || []).length)
  await redis.del(BATCH_WORKER_KEY(batchId))
  await redis.del(BATCH_ACTIVATED_KEY(batchId))
  await redis.del(BATCH_RR_KEY(batchId))
  for (let idx = 0; idx < total; idx++) {
    const cur = await redis.get(WORKER_BATCH_KEY(idx))
    if (cur && Number(cur) === batchId) {
      await redis.del(WORKER_BATCH_KEY(idx))
      await redis.del(WORKER_BATCH_TS(idx))
    }
  }
  const active = await redis.get(ACTIVE_BATCH_KEY)
  if (active && Number(active) === batchId) await redis.del(ACTIVE_BATCH_KEY)
}
