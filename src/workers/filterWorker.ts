import { Worker, Job } from 'bullmq';
import { defaultWorkerOptions } from './common';
import { config } from '../config';
import { query } from '../db';
import { matchRules } from '../utils/rules';
import { cleanEmail } from '../utils/emailCleaner';
import { isUnsubscribed } from '../utils/unsubscribeFilter';
import { validationQueues } from '../queues';
import { assignWorkerForBatch } from '../utils/validationAssignment';
import { publish, CHANNELS } from '../redis';

async function loadRulesFor(masterId: number) {
  const m = await query<{ submitter_id: number | null; submitter_team_id: number | null }>(
    'SELECT submitter_id, submitter_team_id FROM master_emails WHERE id=$1',
    [masterId]
  );
  const { submitter_id, submitter_team_id } = m.rows[0] || { submitter_id: null, submitter_team_id: null };
  const cacheKey = `${submitter_team_id || 'null'}:${submitter_id || 'null'}`;
  const now = Date.now();
  const cached = (rulesCache.get(cacheKey) || null);
  if (cached && cached.expires > now) return cached.rules;
  const res = await query(
    `SELECT contains, endswith, domains, excludes
     FROM rules
     WHERE (scope='global')
        OR (scope='team' AND team_id = $1)
        OR (scope='employee' AND employee_id = $2)
     ORDER BY priority DESC`,
    [submitter_team_id, submitter_id]
  );
  // Merge all rule arrays into a single combined set
  const combined = { contains: [] as string[], endswith: [] as string[], domains: [] as string[], excludes: [] as string[] };
  for (const row of res.rows as any[]) {
    if (row.contains) combined.contains.push(...row.contains);
    if (row.endswith) combined.endswith.push(...row.endswith);
    if (row.domains) combined.domains.push(...row.domains);
    if (row.excludes) combined.excludes.push(...row.excludes);
  }
  rulesCache.set(cacheKey, { rules: combined, expires: now + 60_000 });
  return combined;
}

const rulesCache: Map<string, { rules: { contains: string[]; endswith: string[]; domains: string[]; excludes: string[] }; expires: number }> = new Map();

async function processMaster(masterId: number) {
  const m = await query<{ email_normalized: string; email_raw: string | null; domain: string; batch_id: number }>('SELECT email_normalized, email_raw, domain, batch_id FROM master_emails WHERE id=$1', [masterId]);
  if (m.rows.length === 0) return;
  const email = m.rows[0].email_normalized;
  const original = m.rows[0].email_raw || email;
  const domain = m.rows[0].domain;
  const batchId = m.rows[0].batch_id;
  const b = await query<{ status: string; paused_stage: string | null }>('SELECT status, paused_stage FROM batches WHERE batch_id=$1', [batchId]);
  const paused = String(b.rows[0]?.status || '').toLowerCase() === 'paused';
  const pausedStage = String(b.rows[0]?.paused_stage || '').toLowerCase();
  if (paused && pausedStage === 'filter') {
    await publish(CHANNELS.batchProgress, { stage: 'filter', status: 'paused', master_id: masterId });
    return;
  }
  const rules = await loadRulesFor(masterId);
  const res = matchRules(email, rules);
  const unsub = await isUnsubscribed(email, domain);
  const cleaned = cleanEmail(original, {
    contains: rules.contains || [],
    endswith: rules.endswith || [],
    domains: rules.domains || [],
    excludes: rules.excludes || []
  });
  const finalStatus = unsub && cleaned.cleaned ? 'removed:unsubscribed' : cleaned.status;
  const finalReason = unsub && cleaned.cleaned ? 'unsubscribed' : cleaned.reason;
  await query(
    `INSERT INTO filtered_emails(batch_id, master_id, original_email, cleaned_email, status, reason, domain, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [batchId, masterId, original, cleaned.cleaned, finalStatus, finalReason, cleaned.domain, JSON.stringify({ flags: res.flags, matched_keyword: res.matchedKeyword, matched_domain: res.matchedDomain, unsubscribed: unsub })]
  );
  const removed = String(finalStatus).startsWith('removed:');
  try {
    const doneQ = await query<{ c: string }>('SELECT COUNT(*) AS c FROM filtered_emails WHERE batch_id=$1', [batchId]);
    const totalQ = await query<{ c: string }>('SELECT COUNT(*) AS c FROM master_emails WHERE batch_id=$1', [batchId]);
    const processed = Number(doneQ.rows[0]?.c || 0);
    const total = Number(totalQ.rows[0]?.c || 0);
    await publish(CHANNELS.batchProgress, { batchId, step: 'filter', stage: 'filter', processed, total });
  } catch {}
  await publish(CHANNELS.batchProgress, { stage: 'filter', status: removed ? 'excluded' : 'passed', master_id: masterId });
  if (removed) return;
  try {
    const idx = await assignWorkerForBatch(batchId);
    const q = validationQueues[idx] || validationQueues[0];
    await q.add('validateEmail', { masterId }, { removeOnComplete: true, removeOnFail: true });
  } catch {
    const q = validationQueues[0] || undefined;
    if (q) await q.add('validateEmail', { masterId }, { removeOnComplete: true, removeOnFail: true });
  }
}

export const filterWorker = new Worker(
  'filterQueue',
  async (job: Job) => {
    const { masterId } = job.data as { masterId: number };
    await processMaster(masterId);
  },
  defaultWorkerOptions(config.redisUrl)
);

console.log('filterWorker started');
