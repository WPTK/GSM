import { randomUUID } from 'node:crypto';
import { getDb } from '../db/connection.js';
import { logger } from '../services/logger.js';
import { getAnthropicClient } from './client.js';
import { analyzeRepo, buildAnalysisParams, parseMessageResult, AnalysisInvalidError } from './analyze.js';
import { buildSystem } from './cache.js';
import { getAiState, isCreditLowError, setCreditLow, onCreditResumed } from './creditState.js';
import { consumeEstimate, getEstimate, loadAnalysisPrefix, type RepoRecord } from './estimate.js';
import { buildRepoMessage } from './prompts.js';
import { fetchReadme } from './readme.js';
import type {
  AiCacheInfo,
  AiLanguage,
  AnalysisItemStatus,
  AnalysisJob,
  AnalysisJobItem,
  AnalysisJobStatus,
  AnalysisResult,
} from './contract.js';

/** Direct (non-batch) runs analyse this many repositories at once. */
export const DIRECT_CONCURRENCY = 4;

export class SpendConfirmRequiredError extends Error {}
export class EstimateNotFoundError extends Error {}
export class JobNotFoundError extends Error {}
export class JobNotCancellableError extends Error {}

interface JobRow {
  id: string;
  status: AnalysisJobStatus;
  mode: 'direct' | 'batch';
  persisted: number;
  language: AiLanguage;
  model: string;
  usd: number;
  cache_json: string;
  batch_id: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

interface ItemRow {
  job_id: string;
  repo_id: number;
  full_name: string;
  repo_json: string | null;
  status: AnalysisItemStatus;
  result_json: string | null;
  error: string | null;
}

const FINAL_STATUSES: AnalysisJobStatus[] = ['completed', 'failed', 'cancelled'];
const controllers = new Map<string, AbortController>();
const running = new Set<string>();

function now(): string {
  return new Date().toISOString();
}

function shortError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/\s+/g, ' ').slice(0, 200);
}

function jobRow(id: string): JobRow | undefined {
  return getDb().prepare('SELECT * FROM ai_jobs WHERE id = ?').get(id) as JobRow | undefined;
}

function itemRows(jobId: string): ItemRow[] {
  return getDb().prepare('SELECT * FROM ai_job_items WHERE job_id = ? ORDER BY rowid').all(jobId) as ItemRow[];
}

function setStatus(id: string, status: AnalysisJobStatus, extra: { batchId?: string | null; error?: string | null } = {}): void {
  const db = getDb();
  if (extra.batchId !== undefined) {
    db.prepare('UPDATE ai_jobs SET status = ?, batch_id = ?, error = COALESCE(?, error), updated_at = ? WHERE id = ?').run(
      status, extra.batchId, extra.error ?? null, now(), id,
    );
  } else {
    db.prepare('UPDATE ai_jobs SET status = ?, error = COALESCE(?, error), updated_at = ? WHERE id = ?').run(status, extra.error ?? null, now(), id);
  }
}

function toJob(row: JobRow): AnalysisJob {
  const items: AnalysisJobItem[] = itemRows(row.id).map((i) => {
    const item: AnalysisJobItem = { repoId: i.repo_id, fullName: i.full_name, status: i.status };
    if (i.result_json) item.result = JSON.parse(i.result_json) as AnalysisResult;
    if (i.error) item.error = i.error;
    return item;
  });
  return {
    id: row.id,
    status: row.status,
    mode: row.mode,
    persisted: row.persisted === 1,
    total: items.length,
    done: items.filter((i) => i.status === 'done').length,
    failed: items.filter((i) => i.status === 'failed').length,
    usd: row.usd,
    cache: JSON.parse(row.cache_json) as AiCacheInfo,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    items,
  };
}

export function getJob(id: string): AnalysisJob {
  const row = jobRow(id);
  if (!row) throw new JobNotFoundError(id);
  return toJob(row);
}

function markItemDone(job: JobRow, item: ItemRow | { repo_id: number }, result: AnalysisResult): void {
  const db = getDb();
  db.prepare("UPDATE ai_job_items SET status = 'done', result_json = ?, error = NULL WHERE job_id = ? AND repo_id = ?").run(
    JSON.stringify(result), job.id, item.repo_id,
  );
  if (job.persisted === 1) {
    db.prepare(
      'UPDATE repositories SET ai_summary = ?, ai_tags = ?, ai_platforms = ?, analyzed_at = ?, analysis_failed = 0 WHERE id = ?',
    ).run(result.summary, JSON.stringify(result.tags), JSON.stringify(result.platforms), now(), item.repo_id);
  }
}

function markItemFailed(job: JobRow, repoId: number, message: string): void {
  const db = getDb();
  db.prepare("UPDATE ai_job_items SET status = 'failed', error = ? WHERE job_id = ? AND repo_id = ?").run(message, job.id, repoId);
  if (job.persisted === 1) {
    db.prepare("UPDATE repositories SET analysis_failed = 1 WHERE id = ? AND (analyzed_at IS NULL OR analyzed_at = '')").run(repoId);
  }
}

function finalizeIfDone(id: string): void {
  const row = jobRow(id);
  if (!row || FINAL_STATUSES.includes(row.status)) return;
  const items = itemRows(id);
  if (items.some((i) => i.status === 'pending')) return;
  const done = items.filter((i) => i.status === 'done').length;
  setStatus(id, done === 0 && items.length > 0 ? 'failed' : 'completed');
}

function pauseForCredit(id: string): void {
  setCreditLow();
  const row = jobRow(id);
  if (row && !FINAL_STATUSES.includes(row.status)) setStatus(id, 'paused');
}

function repoFromItem(item: ItemRow): RepoRecord {
  if (item.repo_json) return JSON.parse(item.repo_json) as RepoRecord;
  return { id: item.repo_id, fullName: item.full_name, description: null, language: null, topics: [], stars: 0 };
}

export function createJob(estimateId: string, confirmed: boolean): AnalysisJob {
  const est = getEstimate(estimateId);
  if (!est) throw new EstimateNotFoundError(estimateId);
  if (est.response.needsConfirm && confirmed !== true) throw new SpendConfirmRequiredError(estimateId);

  const id = randomUUID();
  const db = getDb();
  const stamp = now();
  db.transaction(() => {
    db.prepare(
      'INSERT INTO ai_jobs (id, status, mode, persisted, language, model, usd, cache_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(id, 'queued', est.response.batch ? 'batch' : 'direct', est.persisted ? 1 : 0, est.language, est.model, est.response.usd, JSON.stringify(est.response.cache), stamp, stamp);
    const ins = db.prepare('INSERT OR IGNORE INTO ai_job_items (job_id, repo_id, full_name, repo_json) VALUES (?, ?, ?, ?)');
    for (const r of est.repos) ins.run(id, r.id, r.fullName, JSON.stringify(r));
  })();
  consumeEstimate(estimateId);
  startJob(id);
  return getJob(id);
}

export function cancelJob(id: string): AnalysisJob {
  const row = jobRow(id);
  if (!row) throw new JobNotFoundError(id);
  if (FINAL_STATUSES.includes(row.status)) throw new JobNotCancellableError(id);
  controllers.get(id)?.abort();
  setStatus(id, 'cancelled');
  if (row.batch_id) {
    void Promise.resolve()
      .then(() => getAnthropicClient().messages.batches.cancel(row.batch_id as string))
      .catch((err) => logger.warn('ai.jobs', `batch cancel failed: ${shortError(err)}`));
  }
  return getJob(id);
}

/** Starts (or restarts) the work for a job in the background. Safe to call twice. */
export function startJob(id: string): void {
  if (running.has(id)) return;
  running.add(id);
  void runJob(id)
    .catch((err) => {
      logger.errorFromError('ai.jobs', 'job run failed', err);
      const row = jobRow(id);
      if (row && !FINAL_STATUSES.includes(row.status)) setStatus(id, 'failed', { error: shortError(err) });
    })
    .finally(() => running.delete(id));
}

async function runJob(id: string): Promise<void> {
  const row = jobRow(id);
  if (!row || FINAL_STATUSES.includes(row.status)) return;
  if (getAiState().state === 'credit_low') {
    setStatus(id, 'paused');
    return;
  }
  if (row.mode === 'batch') {
    await submitBatch(row);
  } else {
    await runDirect(row);
  }
}

function systemFor(row: JobRow) {
  const cache = JSON.parse(row.cache_json) as AiCacheInfo;
  return buildSystem(loadAnalysisPrefix(row.language), cache);
}

/** Analyses one item with README fetch; used by direct runs and for retrying invalid batch items. */
async function analyzeItem(row: JobRow, item: ItemRow, attempts: number, signal?: AbortSignal): Promise<void> {
  const repo = repoFromItem(item);
  try {
    const readme = await fetchReadme(repo.fullName);
    const { result } = await analyzeRepo({
      client: getAnthropicClient(),
      model: row.model,
      system: systemFor(row),
      userText: buildRepoMessage(row.language, repo, readme),
      attempts,
      signal,
    });
    markItemDone(row, item, result);
  } catch (err) {
    if (isCreditLowError(err)) throw err;
    if (signal?.aborted) throw err;
    markItemFailed(row, item.repo_id, err instanceof AnalysisInvalidError ? err.message : shortError(err));
  }
}

async function runDirect(row: JobRow): Promise<void> {
  const controller = new AbortController();
  controllers.set(row.id, controller);
  setStatus(row.id, 'running');
  const queue = itemRows(row.id).filter((i) => i.status === 'pending');
  let stop = false;

  const worker = async () => {
    for (;;) {
      if (stop || controller.signal.aborted) return;
      const current = jobRow(row.id);
      if (!current || current.status !== 'running') return;
      const item = queue.shift();
      if (!item) return;
      try {
        await analyzeItem(row, item, 2, controller.signal);
      } catch (err) {
        stop = true;
        if (isCreditLowError(err)) pauseForCredit(row.id);
        return;
      }
    }
  };

  try {
    await Promise.all(Array.from({ length: DIRECT_CONCURRENCY }, worker));
  } finally {
    controllers.delete(row.id);
  }
  finalizeIfDone(row.id);
}

async function submitBatch(row: JobRow): Promise<void> {
  setStatus(row.id, 'running');
  const pending = itemRows(row.id).filter((i) => i.status === 'pending');
  const system = systemFor(row);
  const requests: Array<{ custom_id: string; params: Record<string, unknown> }> = [];

  const queue = [...pending];
  const worker = async () => {
    for (;;) {
      const item = queue.shift();
      if (!item) return;
      const repo = repoFromItem(item);
      try {
        const readme = await fetchReadme(repo.fullName);
        requests.push({
          custom_id: `repo-${item.repo_id}`,
          params: buildAnalysisParams(row.model, system, buildRepoMessage(row.language, repo, readme)),
        });
      } catch (err) {
        markItemFailed(row, item.repo_id, shortError(err));
      }
    }
  };
  await Promise.all(Array.from({ length: DIRECT_CONCURRENCY }, worker));

  const current = jobRow(row.id);
  if (!current || current.status !== 'running') return; // cancelled while preparing
  if (requests.length === 0) {
    finalizeIfDone(row.id);
    return;
  }
  try {
    const batch = await getAnthropicClient().messages.batches.create({ requests });
    setStatus(row.id, 'submitted', { batchId: batch.id as string });
  } catch (err) {
    if (isCreditLowError(err)) {
      pauseForCredit(row.id);
      return;
    }
    throw err;
  }
}

/** Reads a finished batch and records every item. Called by the poller. */
export async function collectBatchResults(id: string): Promise<void> {
  const row = jobRow(id);
  if (!row || !row.batch_id || row.status !== 'submitted') return;
  const client = getAnthropicClient();
  const stream = await client.messages.batches.results(row.batch_id);
  const retries: ItemRow[] = [];
  let creditLow = false;

  for await (const entry of stream as AsyncIterable<{ custom_id: string; result: { type: string; message?: any; error?: any } }>) {
    const repoId = Number(/^repo-(\d+)$/.exec(entry.custom_id)?.[1]);
    const item = Number.isFinite(repoId) ? itemRows(id).find((i) => i.repo_id === repoId) : undefined;
    if (!item || item.status !== 'pending') continue;
    const res = entry.result;
    if (res.type === 'succeeded') {
      const parsed = parseMessageResult(res.message ?? {});
      if (parsed) markItemDone(row, item, parsed);
      else retries.push(item); // invalid output: one direct retry below
    } else if (res.type === 'errored' && isCreditLowError(res.error)) {
      creditLow = true;
    } else {
      markItemFailed(row, repoId, res.type === 'errored' ? shortError(res.error?.error?.message ?? res.error?.message ?? 'batch item failed') : `batch item ${res.type}`);
    }
  }

  if (creditLow) {
    // Items that hit the credit wall stay pending; the job resubmits only them after recovery.
    getDb().prepare('UPDATE ai_jobs SET batch_id = NULL WHERE id = ?').run(id);
    pauseForCredit(id);
    return;
  }
  for (const item of retries) {
    try {
      await analyzeItem(row, item, 1);
    } catch (err) {
      if (isCreditLowError(err)) {
        pauseForCredit(id);
        return;
      }
      markItemFailed(row, item.repo_id, shortError(err));
    }
  }
  finalizeIfDone(id);
}

export function listJobsByStatus(status: AnalysisJobStatus): Array<{ id: string; batchId: string | null }> {
  return (getDb().prepare('SELECT id, batch_id FROM ai_jobs WHERE status = ?').all(status) as Array<{ id: string; batch_id: string | null }>).map(
    (r) => ({ id: r.id, batchId: r.batch_id }),
  );
}

export function markBatchFailed(id: string, message: string): void {
  const row = jobRow(id);
  if (!row) return;
  for (const item of itemRows(id).filter((i) => i.status === 'pending')) markItemFailed(row, item.repo_id, message);
  finalizeIfDone(id);
}

/**
 * On boot: direct jobs that were mid-run restart on their pending items; batch jobs that
 * were already submitted are left to the poller (they are retrieved, never created again).
 */
export function resumeJobsOnBoot(): void {
  for (const status of ['queued', 'running'] as const) {
    for (const { id } of listJobsByStatus(status)) startJob(id);
  }
  if (getAiState().state !== 'credit_low') resumePausedJobs();
}

export function resumePausedJobs(): void {
  for (const { id } of listJobsByStatus('paused')) startJob(id);
}

onCreditResumed(resumePausedJobs);
