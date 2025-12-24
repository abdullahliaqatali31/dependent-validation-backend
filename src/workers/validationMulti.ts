import { Worker, Job } from 'bullmq'
import { defaultWorkerOptions } from './common'
import { config } from '../config'
import { query } from '../db'
import { redis, publish, CHANNELS } from '../redis'
import { QUEUE_NAMES, personalQueue, validationQueues } from '../queues'
import { releaseBatchAssignment, ensureBatchActivated, assignWorkerRoundRobin } from '../utils/validationAssignment'

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }

async function delayNextRequest(key: string, baseDelayMs: number) {
  const k = `ninja:last:${key}`
  const now = Date.now()
  const last = Number(await redis.get(k) || '0')
  const diff = now - last
  if (diff < baseDelayMs) await sleep(baseDelayMs - diff)
  await redis.set(k, String(Date.now()))
}

async function heartbeat(workerId: string, key: string, activeJob?: string) {
  const hash = `worker:${workerId}:status`
  const now = Date.now().toString()
  const boot = await redis.get(`worker:${workerId}:boot_ts`)
  const bootTs = boot ? Number(boot) : Date.now()
  if (!boot) await redis.set(`worker:${workerId}:boot_ts`, String(bootTs))
  const reqToday = await redis.get(`worker:${workerId}:req_today`) || '0'
  const uptime = Math.floor((Number(now) - bootTs) / 1000)
  await redis.hset(hash, { key, activeJob: activeJob || '', lastHeartbeat: now, requestsToday: reqToday, uptimeSeconds: String(uptime), workerId })
  await publish(CHANNELS.systemMonitor, { type: 'worker_update', workerId, key, activeJob, ts: Number(now) })
}

async function verify(email: string, key: string) {
  await delayNextRequest(key, config.ninjaDelayMs)
  const url = `https://happy.mailtester.ninja/ninja?email=${encodeURIComponent(email)}&key=${encodeURIComponent(key)}`
  const t0 = Date.now()
  const resp = await fetch(url, { method: 'GET' })
  const t1 = Date.now()
  const elapsed = t1 - t0
  await redis.incrby(`key:${key}:rt_sum`, elapsed)
  await redis.incr(`key:${key}:rt_count`)
  if (!resp.ok) throw new Error(`http_${resp.status}`)
  const data = await resp.json()
  return data
}

function mapOutcome(message: string, code?: string): 'accepted' | 'catch_all' | 'rejected' | 'timeout' {
  const msg = String(message || '').toLowerCase()
  const c = String(code || '').toLowerCase()
  if (msg.includes('accepted') || c === 'ok') return 'accepted'
  if (msg.includes('catch') || msg.includes('limited')) return 'catch_all'
  if (msg.includes('rejected') || msg.includes('spam') || msg.includes('no mx') || msg.includes('mx error') || c === 'invalid' || c === 'bad' || c === 'ko') return 'rejected'
  if (msg.includes('timeout')) return 'timeout'
  return 'rejected'
}

async function processJob(masterId: number, key: string, workerId: string, workerIdx: number) {
  const m = await query<{ email_normalized: string; batch_id: number; domain: string | null }>('SELECT email_normalized, batch_id, domain FROM master_emails WHERE id=$1', [masterId])
  if (m.rows.length === 0) return
  const email = m.rows[0].email_normalized
  const batchId = m.rows[0].batch_id

  // Safety check: if batch doesn't exist anymore (deleted), stop processing
  const b = await query<{ status: string; paused_stage: string | null }>('SELECT status, paused_stage FROM batches WHERE batch_id=$1', [batchId])
  if (b.rows.length === 0) {
    // Batch was deleted
    return
  }

  const paused = String(b.rows[0]?.status || '').toLowerCase() === 'paused'
  const pausedStage = String(b.rows[0]?.paused_stage || '').toLowerCase()
  if (paused && pausedStage === 'validation') {
    const q = validationQueues[workerIdx] || validationQueues[0]
    try { await q.add('validateEmail', { masterId }, { removeOnComplete: false, removeOnFail: false, delay: 15000 }) } catch {}
    await publish(CHANNELS.batchProgress, { batchId, stage: 'validation', status: 'paused', master_id: masterId })
    return
  }
  await heartbeat(workerId, key, `${batchId}:${email}`)
  try {
    const data = await verify(email, key)
    const code = String((data.code || '').toString()).toLowerCase()
    const message = String((data.message || '').toString())
    const domain = data.domain || m.rows[0].domain || null
    const mx = data.mx || null
    let status: 'valid' | 'invalid' | 'unknown' | 'catch_all' = 'unknown'
    if (code === 'ok') status = 'valid'
    else if (code === 'ko' || code === 'invalid' || code === 'bad') status = 'invalid'
    else if (code === 'mb') {
      const mm = message.toLowerCase()
      if (mm.includes('catch')) status = 'catch_all'
      else if (mm.includes('mx')) status = 'invalid'
    }
    const outcome = mapOutcome(message, code)
    const isPersonalQ = await query<{ count: string }>('SELECT COUNT(*) FROM public_provider_domains WHERE domain=$1', [domain || ''])
    const isPersonal = Number(isPersonalQ.rows[0]?.count || 0) > 0
    const category = isPersonal ? 'personal' : 'business'
    await query(
      `INSERT INTO validation_results(master_id, status_enum, details, ninja_key_used, domain, mx, message, metadata, category, outcome, is_personal, is_business)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (master_id) DO NOTHING`,
      [masterId, status, JSON.stringify(data), key, domain, mx, message, JSON.stringify({ domain, mx, code }), category, outcome, isPersonal, !isPersonal]
    )
    await query(
      `UPDATE ninja_keys
       SET total_requests = total_requests + 1,
           total_success = total_success + 1,
           consecutive_errors = 0,
           last_used_at = now()
       WHERE key=$1`,
      [key]
    )
    await redis.incr(`worker:${workerId}:req_today`)
    await redis.lpush('val_speed_points', Date.now().toString())
    await redis.ltrim('val_speed_points', 0, 6000)
    const totalQ = await query<{ count: string }>(
      `SELECT COUNT(*) 
       FROM filtered_emails fe 
       JOIN master_emails me ON fe.master_id = me.id 
       WHERE me.batch_id=$1 AND fe.status NOT LIKE 'removed:%'`, 
      [batchId]
    )
    const doneQ = await query<{ count: string }>('SELECT COUNT(*) FROM validation_results vr JOIN master_emails me ON vr.master_id=me.id WHERE me.batch_id=$1', [batchId])
    const total = Number(totalQ.rows[0]?.count || 0)
    const done = Number(doneQ.rows[0]?.count || 0)
    await publish(CHANNELS.batchProgress, { batchId, step: 'validation', stage: 'validation', processed: done, total })
    if (total > 0 && done >= total) {
      await query('UPDATE batches SET status=$2 WHERE batch_id=$1', [batchId, 'completed'])
      await publish(CHANNELS.batchProgress, { batchId, step: 'done', stage: 'completed', processed: done, total })
      await releaseBatchAssignment(batchId)
    }
    await personalQueue.add('personalCheck', { masterId }, { removeOnComplete: true, removeOnFail: true })
  } catch (e: any) {
    // If we fail here, we MUST record it so the job doesn't loop forever in QueueWatcher
    try {
        await query(
            `INSERT INTO validation_results(master_id, status_enum, details, ninja_key_used, outcome, category)
             VALUES ($1, 'unknown', $2, $3, 'rejected', 'business')
             ON CONFLICT (master_id) DO NOTHING`,
            [masterId, JSON.stringify({ error: (e as any)?.message || String(e), ts: Date.now() }), key]
        );
    } catch (dbErr) {
        console.error('Failed to record validation error', dbErr);
    }

    await redis.incr(`worker:${workerId}:req_today`)
    if (String(e?.message || '').includes('http_429') || String(e?.message || '').includes('429')) {
      await sleep(config.ninjaDelayMs * 2)
    } else {
      await sleep(500)
    }
    try {
      await query(
        `UPDATE ninja_keys
         SET total_requests = total_requests + 1,
             total_failed = total_failed + 1,
             consecutive_errors = consecutive_errors + 1,
             last_used_at = now()
         WHERE key=$1`,
        [key]
      )
    } catch {}
  } finally {
    await heartbeat(workerId, key)
  }
}

const workers: Worker[] = []
config.ninjaKeys.forEach((k, idx) => {
  const w = new Worker(`${QUEUE_NAMES.validation}_${idx}`, async (job: Job) => {
    try {
      const { masterId } = job.data as { masterId: number }
      await processJob(masterId, k, `val-${idx}`, idx)
    } catch (e) {
      try { await publish(CHANNELS.systemMonitor, { type: 'worker_error', worker: `validation_${idx}`, error: (e as any)?.message || String(e) }) } catch {}
      console.error(e)
      throw e
    }
  }, { ...defaultWorkerOptions(config.redisUrl), concurrency: 1 })
  workers.push(w)
  ;(async () => { while (true) { await heartbeat(`val-${idx}`, k); await sleep(5000) } })()
})

console.log('validationMulti workers started')
;(async () => {
  while (true) {
    try {
      const total = (config.ninjaKeys || []).length
      const now = Date.now()
      for (let idx = 0; idx < total; idx++) {
        const hb = await redis.hget(`worker:val-${idx}:status`, 'lastHeartbeat')
        const hbTs = hb ? Number(hb) : 0
        const batchIdStr = await redis.get(`val:worker:${idx}:batch_id`)
        const batchTsStr = await redis.get(`val:worker:${idx}:batch_ts`)
        const batchTs = batchTsStr ? Number(batchTsStr) : 0
        const stale = (hbTs && now - hbTs > 10 * 60 * 1000) || (batchTs && now - batchTs > 10 * 60 * 1000)
        if (batchIdStr && stale) {
          const batchId = Number(batchIdStr)
          if (Number.isNaN(batchId)) {
            console.warn(`[ValidationMulti] Found invalid batchIdStr="${batchIdStr}" for worker ${idx}. Cleaning up.`);
            await redis.del(`val:worker:${idx}:batch_id`);
            await redis.del(`val:worker:${idx}:batch_ts`);
            continue;
          }

          await releaseBatchAssignment(batchId)
          await ensureBatchActivated(batchId)
          const srcQ = validationQueues[idx]
          if (srcQ) {
            const jobs = await srcQ.getJobs(['waiting','delayed'], 0, -1)
            for (const j of jobs) {
              const mid = Number((j as any)?.data?.masterId || 0)
              if (!mid) continue
              const oldJobId = j.id
              try {
                await j.remove()
              } catch {}
              const toIdx = await assignWorkerRoundRobin(batchId)
              const destQ = validationQueues[toIdx] || validationQueues[0]
              if (destQ) {
                await destQ.add('validateEmail', { masterId: mid }, { 
                  jobId: oldJobId || `val-${mid}`,
                  removeOnComplete: false, 
                  removeOnFail: false 
                })
              }
            }
          }
        }
      }
    } catch (e) { console.error(e) }
    await sleep(30000)
  }
})()
