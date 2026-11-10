import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshDb, insertRepos, makeFakeClient, resetAiEnv, textMessage, VALID_ANALYSIS, waitFor, type FakeClient } from './helpers.js';

vi.mock('../../src/db/connection.js', () => ({ getDb: () => (globalThis as unknown as { __testDb: unknown }).__testDb, closeDb: () => undefined }));
vi.mock('../../src/ai/readme.js', () => ({ fetchReadme: vi.fn(async (name: string) => `README for ${name}`) }));

const { setAnthropicClientForTests } = await import('../../src/ai/client.js');
const { resetClaudeConfigForTests, markModelsVerified } = await import('../../src/ai/claudeConfig.js');
const { clearEstimatesForTests, createEstimate } = await import('../../src/ai/estimate.js');
const { createJob, getJob, resumeJobsOnBoot, cancelJob, SpendConfirmRequiredError } = await import('../../src/ai/jobs.js');
const { pollBatchesOnce } = await import('../../src/ai/batchPoller.js');
const { getAiState, stopCreditProbeForTests, runCreditProbe, CREDIT_PROBE_INTERVAL_MS, PROBE_RETRY_BASE_MS, resumeCreditProbeSchedule, setCreditLow } = await import('../../src/ai/creditState.js');
const { analyzeRepo, AnalysisInvalidError } = await import('../../src/ai/analyze.js');
const { buildSystem, decideCache } = await import('../../src/ai/cache.js');
const { fetchReadme } = await import('../../src/ai/readme.js');

let fake: FakeClient;
let db: ReturnType<typeof freshDb>;

beforeEach(() => {
  resetAiEnv();
  resetClaudeConfigForTests();
  process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-zzzz-1234';
  db = freshDb();
  markModelsVerified();
  clearEstimatesForTests();
  fake = makeFakeClient();
  setAnthropicClientForTests(fake);
  vi.mocked(fetchReadme).mockImplementation(async (name: string) => `README for ${name}`);
});
afterEach(() => {
  vi.useRealTimers();
  setAnthropicClientForTests(null);
  stopCreditProbeForTests();
  resetAiEnv();
  resetClaudeConfigForTests();
});

const lang = 'en' as const;

async function estimateFor(ids: number[]) {
  return createEstimate({ repoIds: ids, language: lang });
}

describe('analysis output', () => {
  it('retries once on invalid output, then fails the item', async () => {
    fake.impl.create = () => textMessage('{"summary":"x","tags":[],"platforms":["toaster"]}');
    await expect(
      analyzeRepo({ client: fake, model: 'claude-haiku-5-5', system: buildSystem('p', { cache: 'skipped', prefixTokens: 1, minTokens: 512 }), userText: 'u' }),
    ).rejects.toBeInstanceOf(AnalysisInvalidError);
    expect(fake.calls.create).toHaveLength(2);
  });

  it('succeeds when the retry is valid and sends output_config.format', async () => {
    let n = 0;
    fake.impl.create = () => (++n === 1 ? textMessage('not json') : textMessage(JSON.stringify(VALID_ANALYSIS)));
    const out = await analyzeRepo({ client: fake, model: 'claude-haiku-5-5', system: [{ type: 'text', text: 'p' }], userText: 'u' });
    expect(out.result.tags).toEqual(['Dev Tools', 'CLI']);
    expect(fake.calls.create).toHaveLength(2);
    const p = fake.calls.create[0];
    expect(p.output_config.format.type).toBe('json_schema');
    expect(p.output_config.format.schema.additionalProperties).toBe(false);
    expect(p.tool_choice).toBeUndefined();
    expect(p.thinking).toBeUndefined();
  });

  it('a job item that stays invalid fails after exactly two calls', async () => {
    fake.impl.create = () => textMessage('nope');
    const ids = insertRepos(db, 1);
    const est = await estimateFor(ids);
    const job = createJob(est.id, false);
    await waitFor(() => getJob(job.id).status === 'failed');
    expect(fake.calls.create).toHaveLength(2);
    expect(getJob(job.id).items[0].status).toBe('failed');
    expect(db.prepare('SELECT analysis_failed FROM repositories WHERE id = 1').get()).toEqual({ analysis_failed: 1 });
  });
});

describe('prompt cache decision', () => {
  it('skips caching below the model minimum and does not add cache_control', async () => {
    fake.impl.countTokens = () => ({ input_tokens: 300 });
    const info = await decideCache(fake, 'claude-haiku-5-5', 'prefix');
    expect(info).toEqual({ cache: 'skipped', prefixTokens: 300, minTokens: 512 });
    expect(buildSystem('prefix', info)[0].cache_control).toBeUndefined();
  });

  it('uses caching at or above the minimum', async () => {
    fake.impl.countTokens = () => ({ input_tokens: 512 });
    const info = await decideCache(fake, 'claude-haiku-5-5', 'prefix');
    expect(info.cache).toBe('used');
    expect(buildSystem('prefix', info)[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('a direct job sends the system block with cache_control only when used', async () => {
    fake.impl.countTokens = () => ({ input_tokens: 2000 });
    const ids = insertRepos(db, 2);
    const est = await estimateFor(ids);
    expect(est.response.cache.cache).toBe('used');
    const job = createJob(est.id, false);
    await waitFor(() => getJob(job.id).status === 'completed');
    expect(fake.calls.create[0].system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(fake.calls.create[0].system[0].text).not.toContain('Additional analysis instructions');
  });

  it('puts the owner custom prompt into the cached prefix', async () => {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('ai.customAnalysisPrompt', 'Always mention the licence. {LANGUAGE}');
    const ids = insertRepos(db, 1);
    const est = await estimateFor(ids);
    createJob(est.id, false);
    await waitFor(() => fake.calls.create.length > 0);
    const text = fake.calls.create[0].system[0].text as string;
    expect(text).toContain('Always mention the licence. en');
    expect(fake.calls.countTokens[0].system).toContain('Always mention the licence.');
  });
});

describe('estimate and spend guard', () => {
  it('keeps at most 50 estimates and evicts the oldest first', async () => {
    const { getEstimate } = await import('../../src/ai/estimate.js');
    const ids = insertRepos(db, 1);
    const made = [];
    for (let i = 0; i < 52; i++) made.push(await estimateFor(ids));
    expect(getEstimate(made[0].id)).toBeNull();
    expect(getEstimate(made[1].id)).toBeNull();
    expect(getEstimate(made[2].id)).not.toBeNull();
    expect(getEstimate(made[51].id)).not.toBeNull();
  });

  it('reports an upper bound and labels batch use above 20 repos', async () => {
    const ids = insertRepos(db, 21);
    const est = await estimateFor(ids);
    expect(est.response.repos).toBe(21);
    expect(est.response.batch).toBe(true);
    expect(est.response.usd).toBeGreaterThan(0);
    expect(est.response.pricingCheckedAt).toBe('2026-11-09');
    const direct = await estimateFor(ids.slice(0, 20));
    expect(direct.response.batch).toBe(false);
  });

  it('returns 409-equivalent without confirmation and runs with it', async () => {
    process.env.AI_SPEND_CONFIRM_USD = '0';
    const ids = insertRepos(db, 1);
    const est = await estimateFor(ids);
    expect(est.response.needsConfirm).toBe(true);
    expect(() => createJob(est.id, false)).toThrow(SpendConfirmRequiredError);
    expect(fake.calls.create).toHaveLength(0);
    const job = createJob(est.id, true);
    await waitFor(() => getJob(job.id).status === 'completed');
  });

  it('does not need confirmation under the threshold', async () => {
    const ids = insertRepos(db, 3);
    const est = await estimateFor(ids);
    expect(est.response.needsConfirm).toBe(false);
  });

  it('inline repos are analysed but not written to the repositories table', async () => {
    const est = await createEstimate({ repos: [{ id: 999, fullName: 'x/y' }], language: lang });
    const job = createJob(est.id, false);
    await waitFor(() => getJob(job.id).status === 'completed');
    expect(getJob(job.id).persisted).toBe(false);
    expect(getJob(job.id).items[0].result?.summary).toBeTruthy();
    expect(db.prepare('SELECT COUNT(*) c FROM repositories').get()).toEqual({ c: 0 });
  });
});

describe('direct and batch routing', () => {
  it('20 repos run directly (no batch) and write results', async () => {
    const ids = insertRepos(db, 20);
    const est = await estimateFor(ids);
    const job = createJob(est.id, false);
    await waitFor(() => getJob(job.id).status === 'completed');
    expect(getJob(job.id).mode).toBe('direct');
    expect(fake.calls.batchCreate).toHaveLength(0);
    expect(fake.calls.create).toHaveLength(20);
    const row = db.prepare('SELECT ai_summary, ai_tags, ai_platforms, analyzed_at FROM repositories WHERE id = 1').get() as { ai_summary: string; ai_tags: string; ai_platforms: string; analyzed_at: string };
    expect(row.ai_summary).toBe(VALID_ANALYSIS.summary);
    expect(JSON.parse(row.ai_tags)).toEqual(VALID_ANALYSIS.tags);
    expect(row.analyzed_at).toBeTruthy();
  });

  it('direct runs use at most 4 concurrent calls', async () => {
    let live = 0;
    let peak = 0;
    fake.impl.create = async () => {
      live++;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 15));
      live--;
      return textMessage(JSON.stringify(VALID_ANALYSIS));
    };
    const ids = insertRepos(db, 12);
    const est = await estimateFor(ids);
    const job = createJob(est.id, false);
    await waitFor(() => getJob(job.id).status === 'completed');
    expect(peak).toBe(4);
  });

  it('21 repos go through one batch with repo-<id> custom ids and output_config', async () => {
    const ids = insertRepos(db, 21);
    const est = await estimateFor(ids);
    const job = createJob(est.id, false);
    await waitFor(() => getJob(job.id).status === 'submitted');
    expect(fake.calls.create).toHaveLength(0);
    expect(fake.calls.batchCreate).toHaveLength(1);
    const reqs = fake.calls.batchCreate[0].requests;
    expect(reqs).toHaveLength(21);
    expect(reqs.map((r: { custom_id: string }) => r.custom_id)).toContain('repo-21');
    expect(reqs[0].params.output_config.format.type).toBe('json_schema');
    expect(db.prepare('SELECT batch_id FROM ai_jobs WHERE id = ?').get(job.id)).toEqual({ batch_id: 'batch_1' });
  });

  it('a restart resumes polling with retrieve and never creates a second batch', async () => {
    const ids = insertRepos(db, 21);
    const est = await estimateFor(ids);
    const job = createJob(est.id, false);
    await waitFor(() => getJob(job.id).status === 'submitted');
    // "restart": new fake client, same database
    const second = makeFakeClient();
    second.impl.batchRetrieve = (id: string) => ({ id, processing_status: 'ended' });
    second.impl.batchResults = async function* () {
      for (const id of ids) {
        yield { custom_id: `repo-${id}`, result: { type: 'succeeded', message: textMessage(JSON.stringify(VALID_ANALYSIS)) } };
      }
    };
    setAnthropicClientForTests(second);
    resumeJobsOnBoot();
    await pollBatchesOnce();
    expect(second.calls.batchCreate).toHaveLength(0);
    expect(second.calls.batchRetrieve).toEqual(['batch_1']);
    expect(second.calls.create).toHaveLength(0);
    const done = getJob(job.id);
    expect(done.status).toBe('completed');
    expect(done.done).toBe(21);
  });

  it('batch items with invalid output are retried once directly; errored items fail', async () => {
    const ids = insertRepos(db, 21);
    const est = await estimateFor(ids);
    const job = createJob(est.id, false);
    await waitFor(() => getJob(job.id).status === 'submitted');
    fake.impl.batchRetrieve = (id: string) => ({ id, processing_status: 'ended' });
    fake.impl.batchResults = async function* () {
      yield { custom_id: 'repo-1', result: { type: 'succeeded', message: textMessage('garbage') } };
      yield { custom_id: 'repo-2', result: { type: 'errored', error: { type: 'error', error: { type: 'api_error', message: 'boom' } } } };
      for (const id of ids.slice(2)) {
        yield { custom_id: `repo-${id}`, result: { type: 'succeeded', message: textMessage(JSON.stringify(VALID_ANALYSIS)) } };
      }
    };
    await pollBatchesOnce();
    const j = getJob(job.id);
    expect(j.status).toBe('completed');
    expect(j.items.find((i) => i.repoId === 1)?.status).toBe('done'); // direct retry succeeded
    expect(j.items.find((i) => i.repoId === 2)?.status).toBe('failed');
    expect(fake.calls.create).toHaveLength(1);
  });

  it('cancel stops a submitted batch', async () => {
    const ids = insertRepos(db, 21);
    const est = await estimateFor(ids);
    const job = createJob(est.id, false);
    await waitFor(() => getJob(job.id).status === 'submitted');
    expect(cancelJob(job.id).status).toBe('cancelled');
    await waitFor(() => fake.calls.batchCancel.length === 1);
  });
});

describe('credit-low state', () => {
  it('a 400 credit error pauses the job; the daily probe resumes it (fake timers)', async () => {
    const ids = insertRepos(db, 3);
    const est = await estimateFor(ids);
    let broke = true;
    fake.impl.create = () => {
      if (broke) throw Object.assign(new Error('Your credit balance is too low to access the Anthropic API'), { status: 400 });
      return textMessage(JSON.stringify(VALID_ANALYSIS));
    };
    const job = createJob(est.id, false);
    await waitFor(() => getJob(job.id).status === 'paused');
    expect(getAiState().state).toBe('credit_low');
    expect(getJob(job.id).items.every((i) => i.status === 'pending')).toBe(true);

    vi.useFakeTimers();
    resumeCreditProbeSchedule(); // re-arm on a fake clock
    // first probe: still broke -> stays low and reschedules
    await vi.advanceTimersByTimeAsync(CREDIT_PROBE_INTERVAL_MS);
    expect(getAiState().state).toBe('credit_low');
    broke = false;
    vi.useRealTimers();
    expect(await runCreditProbe()).toBe(true);
    expect(getAiState().state).toBe('ok');
    await waitFor(() => getJob(job.id).status === 'completed');
    expect(getJob(job.id).done).toBe(3);
  });

  it('the scheduled probe fires after 24 hours and a success clears the state', async () => {
    vi.useFakeTimers();
    const { setCreditLow } = await import('../../src/ai/creditState.js');
    setCreditLow();
    let probes = 0;
    fake.impl.create = () => { probes++; return textMessage('.'); };
    await vi.advanceTimersByTimeAsync(CREDIT_PROBE_INTERVAL_MS - 1000);
    expect(probes).toBe(0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(probes).toBe(1);
    expect(fake.calls.create[0].max_tokens).toBe(1);
    expect(getAiState().state).toBe('ok');
  });

  it('a credit error inside a batch result pauses the job; resume resubmits only the pending items', async () => {
    const ids = insertRepos(db, 21);
    const est = await estimateFor(ids);
    const job = createJob(est.id, false);
    await waitFor(() => getJob(job.id).status === 'submitted');
    fake.impl.batchRetrieve = (id: string) => ({ id, processing_status: 'ended' });
    fake.impl.batchResults = async function* () {
      yield { custom_id: 'repo-1', result: { type: 'succeeded', message: textMessage(JSON.stringify(VALID_ANALYSIS)) } };
      for (const id of ids.slice(1)) {
        yield { custom_id: `repo-${id}`, result: { type: 'errored', error: { type: 'invalid_request_error', message: 'Your credit balance is too low' } } };
      }
    };
    await pollBatchesOnce();
    expect(getJob(job.id).status).toBe('paused');
    expect(getAiState().state).toBe('credit_low');
    fake.impl.batchCreate = (p) => ({ id: 'batch_2', processing_status: 'in_progress', n: (p.requests as unknown[]).length });
    expect(await runCreditProbe()).toBe(true);
    await waitFor(() => getJob(job.id).status === 'submitted');
    expect(fake.calls.batchCreate[1].requests).toHaveLength(20);
  });
});

describe('submit races and crash window', () => {
  it('a cancel that lands during batches.create wins and the new batch is cancelled', async () => {
    const ids = insertRepos(db, 21);
    const est = await estimateFor(ids);
    let jobId = '';
    fake.impl.batchCreate = () => {
      cancelJob(jobId); // the user cancels while create() is in flight
      return { id: 'batch_race', processing_status: 'in_progress' };
    };
    jobId = createJob(est.id, false).id;
    await waitFor(() => fake.calls.batchCancel.includes('batch_race'));
    expect(getJob(jobId).status).toBe('cancelled');
  });

  it('a restart after the intent marker but before the id was stored fails the job without resubmitting', async () => {
    const ids = insertRepos(db, 21);
    const est = await estimateFor(ids);
    fake.impl.batchCreate = () => new Promise(() => undefined); // process "dies" inside create()
    const job = createJob(est.id, false);
    await waitFor(() => (db.prepare('SELECT batch_id FROM ai_jobs WHERE id = ?').get(job.id) as { batch_id?: string }).batch_id?.startsWith('pending:'));
    const second = makeFakeClient();
    setAnthropicClientForTests(second);
    resumeJobsOnBoot();
    const j = getJob(job.id);
    expect(j.status).toBe('failed');
    expect(j.items.every((i) => i.status === 'failed' && /start the run again/.test(i.error ?? ''))).toBe(true);
    expect(second.calls.batchCreate).toHaveLength(0);
  });
});

describe('estimate is an upper bound', () => {
  it('covers 1024 output tokens and one retry for every repo (direct)', async () => {
    const ids = insertRepos(db, 20);
    const est = await estimateFor(ids);
    const p = est.response.cache.prefixTokens; // 900, cached
    expect(est.response.cache.cache).toBe('used');
    // worst case by hand: every repo called twice, both hitting max_tokens, README at the cap
    const perRepoIn = Math.ceil((('own/r1'.length + 'desc'.length + 160 + 2000) / 3)) + 80 + 4; // slack for id length
    const requests = 40;
    const worst =
      (p * 0.125 + (requests - 1) * p * 0.01 + 2 * 20 * perRepoIn * 0.1 + requests * 1024 * 0.5) / 1_000_000;
    expect(est.response.usd).toBeGreaterThanOrEqual(worst);
    expect(est.response.outputTokens).toBe(40 * 1024);
  });

  it('for a batch adds one undiscounted direct retry pass', async () => {
    const ids = insertRepos(db, 21);
    const est = await estimateFor(ids);
    expect(est.response.batch).toBe(true);
    expect(est.response.outputTokens).toBe(2 * 21 * 1024);
    const oneBatchPass = (21 * 900 * 0.125 + 21 * 1024 * 0.5) / 1_000_000 * 0.5;
    expect(est.response.usd).toBeGreaterThan(oneBatchPass);
  });
});

describe('credit probe failures that are not credit errors', () => {
  it('retry in 5 minutes with backoff instead of waiting 24 hours', async () => {
    vi.useFakeTimers();
    setCreditLow();
    let probes = 0;
    fake.impl.create = () => { probes++; throw Object.assign(new Error('overloaded'), { status: 529 }); };
    await vi.advanceTimersByTimeAsync(CREDIT_PROBE_INTERVAL_MS + 1000); // first (daily) probe fails
    expect(probes).toBe(1);
    expect(getAiState().state).toBe('credit_low');
    await vi.advanceTimersByTimeAsync(PROBE_RETRY_BASE_MS + 1000);
    expect(probes).toBe(2);
    await vi.advanceTimersByTimeAsync(PROBE_RETRY_BASE_MS * 2 + 1000);
    expect(probes).toBe(3); // doubled gap
    const next = Date.parse(getAiState().nextCheckAt as string) - Date.now();
    expect(next).toBeLessThanOrEqual(PROBE_RETRY_BASE_MS * 4);
  });

  it('a real credit error keeps the 24 hour hold', async () => {
    vi.useFakeTimers();
    setCreditLow();
    fake.impl.create = () => { throw Object.assign(new Error('Your credit balance is too low'), { status: 400 }); };
    await vi.advanceTimersByTimeAsync(CREDIT_PROBE_INTERVAL_MS + 1000);
    const next = Date.parse(getAiState().nextCheckAt as string) - Date.now();
    expect(next).toBeGreaterThan(CREDIT_PROBE_INTERVAL_MS - 5000);
  });
});