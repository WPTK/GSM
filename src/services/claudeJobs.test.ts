import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnalysisEstimateResponse, AnalysisJob, AnalysisJobItem } from './claudeContract';
import type { Repository } from '../types';
import { analyzeRepository, runClaudeAnalysis, toAiLanguage } from './claudeJobs';

const cache = { cache: 'used', prefixTokens: 5000, minTokens: 4096 } as const;

const estimate = (overrides: Partial<AnalysisEstimateResponse> = {}): AnalysisEstimateResponse => ({
  estimateId: 'est-1',
  repos: 2,
  inputTokens: 1000,
  outputTokens: 200,
  usd: 0.05,
  batch: false,
  needsConfirm: false,
  confirmThresholdUsd: 1,
  model: 'claude-test',
  pricingCheckedAt: '2026-11-01',
  cache,
  ...overrides,
});

const item = (repoId: number, status: AnalysisJobItem['status'], extra: Partial<AnalysisJobItem> = {}): AnalysisJobItem => ({
  repoId,
  fullName: `owner/repo-${repoId}`,
  status,
  ...extra,
});

const job = (status: AnalysisJob['status'], items: AnalysisJobItem[], mode: AnalysisJob['mode'] = 'direct'): AnalysisJob => ({
  id: 'job-1',
  status,
  mode,
  persisted: true,
  total: items.length,
  done: items.filter((i) => i.status === 'done').length,
  failed: items.filter((i) => i.status === 'failed').length,
  usd: 0.01,
  cache,
  createdAt: '2026-11-09T00:00:00.000Z',
  updatedAt: '2026-11-09T00:00:00.000Z',
  items,
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

type Route = (url: string, init: RequestInit) => Response | Promise<Response>;
let calls: Array<{ url: string; method: string; body: unknown }>;

const installFetch = (route: Route) => {
  calls = [];
  (window.fetch as ReturnType<typeof vi.fn>).mockReset();
  (window.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined });
    return route(url, init);
  });
};

const done1 = item(1, 'done', { result: { summary: 'S1', tags: ['t'], platforms: ['web'] } });
const done2 = item(2, 'done', { result: { summary: 'S2', tags: [], platforms: [] } });

describe('toAiLanguage', () => {
  it('keeps supported UI languages and falls back to en', () => {
    expect(toAiLanguage('zh-TW')).toBe('zh-TW');
    expect(toAiLanguage('pt-BR')).toBe('pt-BR');
    expect(toAiLanguage('xx')).toBe('en');
  });
});

describe('runClaudeAnalysis', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('estimates, creates a job without confirmation under the threshold, and reports each item once', async () => {
    let polls = 0;
    installFetch((url) => {
      if (url.endsWith('/analysis/estimate')) return json(estimate());
      if (url.endsWith('/analysis/jobs')) return json({ job: job('running', [item(1, 'pending'), item(2, 'pending')]) });
      polls += 1;
      return polls === 1
        ? json({ job: job('running', [done1, item(2, 'pending')]) })
        : json({ job: job('completed', [done1, done2]) });
    });
    const confirmSpend = vi.fn();
    const onItem = vi.fn();

    const outcome = await runClaudeAnalysis({ repoIds: [1, 2], language: 'de' }, { confirmSpend, onItem, pollIntervalMs: 1 });

    expect(confirmSpend).not.toHaveBeenCalled();
    expect(calls[0]).toMatchObject({ url: '/api/ai/analysis/estimate', method: 'POST', body: { repoIds: [1, 2], language: 'de' } });
    expect(calls[1]).toMatchObject({ url: '/api/ai/analysis/jobs', body: { estimateId: 'est-1' } });
    expect(onItem.mock.calls.map(([i]) => (i as AnalysisJobItem).repoId)).toEqual([1, 2]);
    expect(outcome).toMatchObject({ declined: false, cancelled: false });
    expect(outcome.job?.status).toBe('completed');
  });

  it('asks the owner when the estimate needs confirmation and sends confirmed:true', async () => {
    installFetch((url) => {
      if (url.endsWith('/analysis/estimate')) return json(estimate({ needsConfirm: true, usd: 4.2, batch: true }));
      return json({ job: job('completed', [done1]) });
    });
    const confirmSpend = vi.fn().mockResolvedValue(true);

    await runClaudeAnalysis({ repoIds: [1], language: 'en' }, { confirmSpend });

    expect(confirmSpend).toHaveBeenCalledWith(expect.objectContaining({ usd: 4.2 }));
    expect(calls[1].body).toEqual({ estimateId: 'est-1', confirmed: true });
  });

  it('stops before creating a job when the owner declines', async () => {
    installFetch(() => json(estimate({ needsConfirm: true })));
    const outcome = await runClaudeAnalysis({ repoIds: [1], language: 'en' }, { confirmSpend: vi.fn().mockResolvedValue(false) });

    expect(outcome).toMatchObject({ declined: true, job: null });
    expect(calls).toHaveLength(1);
  });

  it('re-estimates once when the server no longer knows the estimate (AI_ESTIMATE_NOT_FOUND)', async () => {
    let estimates = 0;
    let creates = 0;
    installFetch((url) => {
      if (url.endsWith('/analysis/estimate')) {
        estimates += 1;
        return json(estimate({ estimateId: `est-${estimates}` }));
      }
      creates += 1;
      return creates === 1
        ? json({ error: 'gone', code: 'AI_ESTIMATE_NOT_FOUND' }, 404)
        : json({ job: job('completed', [done1]) });
    });

    const outcome = await runClaudeAnalysis({ repoIds: [1], language: 'en' }, { confirmSpend: vi.fn() });

    expect(estimates).toBe(2);
    expect(calls.filter((c) => c.url.endsWith('/analysis/jobs')).map((c) => (c.body as { estimateId: string }).estimateId)).toEqual(['est-1', 'est-2']);
    expect(outcome.job?.status).toBe('completed');
  });

  it('asks and retries when the server demands confirmation the estimate did not flag', async () => {
    let creates = 0;
    installFetch((url) => {
      if (url.endsWith('/analysis/estimate')) return json(estimate());
      creates += 1;
      return creates === 1
        ? json({ error: 'confirm', code: 'AI_SPEND_CONFIRM_REQUIRED' }, 409)
        : json({ job: job('completed', [done1]) });
    });
    const confirmSpend = vi.fn().mockResolvedValue(true);

    await runClaudeAnalysis({ repoIds: [1], language: 'en' }, { confirmSpend });

    expect(confirmSpend).toHaveBeenCalledTimes(1);
    expect(calls[calls.length - 1].body).toEqual({ estimateId: 'est-1', confirmed: true });
  });

  it('cancels the server job when the signal aborts and reports cancelled', async () => {
    installFetch((url) => {
      if (url.endsWith('/analysis/estimate')) return json(estimate());
      if (url.endsWith('/cancel')) return json({ job: job('cancelled', [done1, item(2, 'pending')]) });
      if (url.endsWith('/analysis/jobs')) return json({ job: job('running', [done1, item(2, 'pending')]) });
      return json({ job: job('running', [done1, item(2, 'pending')]) });
    });
    const controller = new AbortController();
    const onItem = vi.fn(() => controller.abort());

    const outcome = await runClaudeAnalysis(
      { repoIds: [1, 2], language: 'en' },
      { confirmSpend: vi.fn(), signal: controller.signal, onItem, pollIntervalMs: 5 },
    );

    expect(calls.some((c) => c.url === '/api/ai/analysis/jobs/job-1/cancel' && c.method === 'POST')).toBe(true);
    expect(outcome).toMatchObject({ cancelled: true });
    expect(outcome.job?.status).toBe('cancelled');
  });

  it('still cancels the server job when the abort lands during an in-flight poll fetch', async () => {
    const controller = new AbortController();
    installFetch((url, init) => {
      if (url.endsWith('/analysis/estimate')) return json(estimate());
      if (url.endsWith('/cancel')) return json({ job: job('cancelled', [item(1, 'pending')]) });
      if (url.endsWith('/analysis/jobs')) return json({ job: job('running', [item(1, 'pending')]) });
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
        queueMicrotask(() => controller.abort());
      });
    });

    const outcome = await runClaudeAnalysis(
      { repoIds: [1], language: 'en' },
      { confirmSpend: vi.fn(), signal: controller.signal, pollIntervalMs: 1 },
    );

    expect(calls.some((c) => c.url === '/api/ai/analysis/jobs/job-1/cancel')).toBe(true);
    expect(outcome).toMatchObject({ cancelled: true });
  });

  it('cancels the job it learned about when the abort lands during the create request', async () => {
    const controller = new AbortController();
    installFetch((url) => {
      if (url.endsWith('/analysis/estimate')) return json(estimate());
      if (url.endsWith('/cancel')) return json({ job: job('cancelled', [item(1, 'pending')]) });
      controller.abort();
      return json({ job: job('running', [item(1, 'pending')]) });
    });

    const outcome = await runClaudeAnalysis({ repoIds: [1], language: 'en' }, { confirmSpend: vi.fn(), signal: controller.signal });

    expect(calls.filter((c) => c.url.endsWith('/cancel'))).toHaveLength(1);
    expect(calls.filter((c) => c.url.endsWith('/analysis/jobs/job-1'))).toHaveLength(0);
    expect(outcome.cancelled).toBe(true);
  });

  it('retries transient poll failures and finishes the job', async () => {
    let polls = 0;
    installFetch((url) => {
      if (url.endsWith('/analysis/estimate')) return json(estimate());
      if (url.endsWith('/analysis/jobs')) return json({ job: job('running', [item(1, 'pending')]) });
      polls += 1;
      if (polls === 1) return json({ error: 'busy', code: 'AI_UPSTREAM_ERROR' }, 503);
      if (polls === 2) return Promise.reject(new TypeError('network down'));
      return json({ job: job('completed', [done1]) });
    });

    const outcome = await runClaudeAnalysis({ repoIds: [1], language: 'en' }, { confirmSpend: vi.fn(), pollIntervalMs: 1 });

    expect(polls).toBe(3);
    expect(outcome.job?.status).toBe('completed');
  });

  it('gives up after more than the retry limit of consecutive poll failures', async () => {
    let polls = 0;
    installFetch((url) => {
      if (url.endsWith('/analysis/estimate')) return json(estimate());
      if (url.endsWith('/analysis/jobs')) return json({ job: job('running', [item(1, 'pending')]) });
      polls += 1;
      return json({ error: 'down', code: 'AI_UPSTREAM_ERROR' }, 502);
    });

    await expect(runClaudeAnalysis({ repoIds: [1], language: 'en' }, { confirmSpend: vi.fn(), pollIntervalMs: 1, pollRetryLimit: 3 }))
      .rejects.toMatchObject({ status: 502 });
    expect(polls).toBe(4);
  });

  it('does not retry a permanent poll failure such as a missing job', async () => {
    let polls = 0;
    installFetch((url) => {
      if (url.endsWith('/analysis/estimate')) return json(estimate());
      if (url.endsWith('/analysis/jobs')) return json({ job: job('running', [item(1, 'pending')]) });
      polls += 1;
      return json({ error: 'nope', code: 'AI_JOB_NOT_FOUND' }, 404);
    });

    await expect(runClaudeAnalysis({ repoIds: [1], language: 'en' }, { confirmSpend: vi.fn(), pollIntervalMs: 1 }))
      .rejects.toMatchObject({ status: 404 });
    expect(polls).toBe(1);
  });

  it('backs off while the job is paused', async () => {
    vi.useFakeTimers();
    try {
      let polls = 0;
      installFetch((url) => {
        if (url.endsWith('/analysis/estimate')) return json(estimate());
        if (url.endsWith('/analysis/jobs')) return json({ job: job('paused', [item(1, 'pending')]) });
        polls += 1;
        return json({ job: job('completed', [done1]) });
      });
      const run = runClaudeAnalysis({ repoIds: [1], language: 'en' }, { confirmSpend: vi.fn(), pollIntervalMs: 10, pausedPollIntervalMs: 10_000 });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(polls).toBe(0);
      await vi.advanceTimersByTimeAsync(5_000);
      await run;
      expect(polls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses the batch poll interval for batch jobs', async () => {
    vi.useFakeTimers();
    try {
      let polls = 0;
      installFetch((url) => {
        if (url.endsWith('/analysis/estimate')) return json(estimate({ batch: true }));
        if (url.endsWith('/analysis/jobs')) return json({ job: job('submitted', [item(1, 'pending')], 'batch') });
        polls += 1;
        return json({ job: job('completed', [done1], 'batch') });
      });
      const run = runClaudeAnalysis({ repoIds: [1], language: 'en' }, { confirmSpend: vi.fn(), pollIntervalMs: 10, batchPollIntervalMs: 60_000 });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(polls).toBe(0);
      await vi.advanceTimersByTimeAsync(60_000);
      const outcome = await run;
      expect(polls).toBe(1);
      expect(outcome.job?.status).toBe('completed');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('analyzeRepository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const repository: Repository = {
    id: 1,
    forks: 0,
    name: 'repo-1',
    full_name: 'owner/repo-1',
    description: 'd',
    html_url: 'https://github.com/owner/repo-1',
    stargazers_count: 3,
    forks_count: 0,
    language: 'TypeScript',
    created_at: '',
    updated_at: '',
    pushed_at: '',
    owner: { login: 'owner', avatar_url: '' },
    topics: ['x'],
  };

  it('sends repoIds for a stored repository and returns the parsed result', async () => {
    installFetch((url) => {
      if (url.endsWith('/analysis/estimate')) return json(estimate({ repos: 1 }));
      return json({ job: job('completed', [done1]) });
    });

    const result = await analyzeRepository({ repository, stored: true, language: 'en', categories: [], confirmSpend: vi.fn() });

    expect(calls[0].body).toEqual({ repoIds: [1], language: 'en' });
    expect(result).toMatchObject({ summary: 'S1', tags: ['t'], platforms: ['web'], analysis_failed: false });
  });

  it('sends the repository fields for a discovery repository', async () => {
    installFetch((url) => {
      if (url.endsWith('/analysis/estimate')) return json(estimate({ repos: 1 }));
      return json({ job: job('completed', [done1]) });
    });

    await analyzeRepository({ repository, stored: false, language: 'fr', categories: [], confirmSpend: vi.fn() });

    expect(calls[0].body).toEqual({
      repos: [{ id: 1, fullName: 'owner/repo-1', description: 'd', language: 'TypeScript', topics: ['x'], stars: 3 }],
      language: 'fr',
    });
  });

  it('throws the item error when the job item failed', async () => {
    installFetch((url) => {
      if (url.endsWith('/analysis/estimate')) return json(estimate({ repos: 1 }));
      return json({ job: job('completed', [item(1, 'failed', { error: 'bad output' })]) });
    });

    await expect(analyzeRepository({ repository, stored: true, language: 'en', categories: [], confirmSpend: vi.fn() }))
      .rejects.toThrow('bad output');
  });

  it('rejects with an AbortError when the owner declines the spend', async () => {
    installFetch(() => json(estimate({ needsConfirm: true })));

    await expect(analyzeRepository({ repository, stored: true, language: 'en', categories: [], confirmSpend: vi.fn().mockResolvedValue(false) }))
      .rejects.toMatchObject({ name: 'AbortError' });
  });
});
