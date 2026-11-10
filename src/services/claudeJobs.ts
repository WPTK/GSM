import {
  AIRequestError,
  cancelAnalysisJob,
  createAnalysisJob,
  estimateAnalysis,
  fetchAnalysisJob,
} from './claudeClient';
import type {
  AiLanguage,
  AnalysisEstimateResponse,
  AnalysisJob,
  AnalysisJobItem,
  AnalysisRepoInput,
} from './claudeContract';
import { AI_LANGUAGES, TERMINAL_JOB_STATUSES } from './claudeContract';
import type { Category, DiscoveryRepo, Repository } from '../types';
import { resolveCategoryAssignment } from '../utils/categoryUtils';

/**
 * Client side of a Claude analysis job: estimate, ask the owner when the server says the
 * run is expensive, create the job, poll until it ends and hand every finished repository
 * to the caller. The server fetches READMEs, calls Claude and (for stored repositories)
 * writes the result; the client only applies categories and updates the store.
 */

export interface ClaudeAnalysisRequest {
  /** Stored repositories to analyse; the server writes the results. */
  repoIds?: number[];
  /** Repositories that are not stored stars (discovery); results are returned only. */
  repos?: AnalysisRepoInput[];
  language: string;
}

export interface ClaudeAnalysisOptions {
  /** Called when the estimate is over the spend threshold. Resolve false to stop before any spend. */
  confirmSpend: (estimate: AnalysisEstimateResponse) => Promise<boolean>;
  /** Called after every poll. */
  onProgress?: (job: AnalysisJob) => void;
  /** Called once for each repository the first time it is done or failed. */
  onItem?: (item: AnalysisJobItem, job: AnalysisJob) => void;
  /** Aborting cancels the server job (best effort) and ends the wait. */
  signal?: AbortSignal;
  /** Poll interval in ms for direct jobs. Default 2000. */
  pollIntervalMs?: number;
  /** Poll interval in ms for batch jobs, which take minutes to hours. Default 30000. */
  batchPollIntervalMs?: number;
  /** Poll interval in ms while the job is paused (credit low). Default 10000. */
  pausedPollIntervalMs?: number;
  /** Consecutive transient poll failures tolerated before giving up. Default 3. */
  pollRetryLimit?: number;
}

export interface ClaudeAnalysisOutcome {
  /** The estimate the run was based on. */
  estimate: AnalysisEstimateResponse;
  /** Final job state, or null when the owner declined the spend. */
  job: AnalysisJob | null;
  /** True when the owner declined the spend dialog. */
  declined: boolean;
  /** True when the run was stopped through the signal. */
  cancelled: boolean;
}

/** UI languages the server has prompt variants for; anything else is sent as English. */
export const toAiLanguage = (language: string): AiLanguage =>
  (AI_LANGUAGES as readonly string[]).includes(language) ? language as AiLanguage : 'en';

const isTerminal = (job: AnalysisJob): boolean => TERMINAL_JOB_STATUSES.includes(job.status);

const sleep = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve) => {
  if (signal?.aborted) {
    resolve();
    return;
  }
  const timer = setTimeout(() => {
    signal?.removeEventListener('abort', onAbort);
    resolve();
  }, ms);
  const onAbort = () => {
    clearTimeout(timer);
    resolve();
  };
  signal?.addEventListener('abort', onAbort, { once: true });
});

const isCode = (error: unknown, code: string): boolean =>
  error instanceof AIRequestError && error.code === code;

const isAbort = (error: unknown): boolean => error instanceof Error && error.name === 'AbortError';

/** Network failures and 5xx/429 are worth another poll; a 404 or 4xx is not. */
const isTransientPollError = (error: unknown): boolean => {
  if (error instanceof AIRequestError) return error.status >= 500 || error.status === 429;
  return error instanceof TypeError;
};

export async function runClaudeAnalysis(
  request: ClaudeAnalysisRequest,
  options: ClaudeAnalysisOptions,
): Promise<ClaudeAnalysisOutcome> {
  const { signal } = options;
  const body = {
    ...(request.repoIds ? { repoIds: request.repoIds } : {}),
    ...(request.repos ? { repos: request.repos } : {}),
    language: toAiLanguage(request.language),
  };

  let estimate = await estimateAnalysis(body, signal);
  let confirmed = false;
  if (estimate.needsConfirm) {
    if (!(await options.confirmSpend(estimate))) {
      return { estimate, job: null, declined: true, cancelled: false };
    }
    confirmed = true;
  }

  let job: AnalysisJob;
  try {
    job = await createAnalysisJob(estimate.estimateId, confirmed);
  } catch (error) {
    if (isCode(error, 'AI_ESTIMATE_NOT_FOUND')) {
      // Estimates live 30 minutes in server memory: ask again and use the fresh id.
      estimate = await estimateAnalysis(body, signal);
      if (estimate.needsConfirm && !confirmed) {
        if (!(await options.confirmSpend(estimate))) {
          return { estimate, job: null, declined: true, cancelled: false };
        }
        confirmed = true;
      }
      job = await createAnalysisJob(estimate.estimateId, confirmed);
    } else if (isCode(error, 'AI_SPEND_CONFIRM_REQUIRED') && !confirmed) {
      // The server guard disagreed with the estimate flag: ask now instead of failing.
      if (!(await options.confirmSpend(estimate))) {
        return { estimate, job: null, declined: true, cancelled: false };
      }
      confirmed = true;
      job = await createAnalysisJob(estimate.estimateId, true);
    } else {
      throw error;
    }
  }

  const reported = new Set<number>();
  const report = (current: AnalysisJob) => {
    options.onProgress?.(current);
    for (const item of current.items) {
      if (item.status === 'pending' || reported.has(item.repoId)) continue;
      reported.add(item.repoId);
      options.onItem?.(item, current);
    }
  };
  report(job);

  // Created without the abort signal on purpose: if the request were aborted mid-flight the
  // client would never learn the job id and the server job would run (and bill) unseen.
  let cancelled = false;
  const cancelJob = async () => {
    cancelled = true;
    try {
      job = await cancelAnalysisJob(job.id);
    } catch {
      // The job may already be finished or the server unreachable; the last known state stands.
    }
    report(job);
  };

  const retryLimit = options.pollRetryLimit ?? 3;
  let failures = 0;
  while (!isTerminal(job) && !signal?.aborted) {
    const base = job.mode === 'batch' ? options.batchPollIntervalMs ?? 30_000 : options.pollIntervalMs ?? 2_000;
    // A paused job waits for the owner to top up credit: poll slowly instead of hammering the server.
    const interval = job.status === 'paused' ? Math.max(base, options.pausedPollIntervalMs ?? 10_000) : base;
    await sleep(interval, signal);
    if (signal?.aborted) break;
    try {
      job = await fetchAnalysisJob(job.id, signal);
      failures = 0;
    } catch (error) {
      if (signal?.aborted || isAbort(error)) break;
      failures += 1;
      if (!isTransientPollError(error) || failures > retryLimit) throw error;
      continue;
    }
    report(job);
  }
  if (signal?.aborted && !isTerminal(job)) await cancelJob();

  return { estimate, job, declined: false, cancelled: cancelled || job.status === 'cancelled' };
}

// ---------------------------------------------------------------------------
// One repository (card button, discovery card)
// ---------------------------------------------------------------------------

export interface AIAnalysisResult {
  summary: string;
  tags: string[];
  platforms: string[];
  custom_category?: string;
  category_locked?: boolean;
  analyzed_at: string;
  analysis_failed: boolean;
  analysis_error?: string;
}

export interface AnalyzeRepositoryOptions {
  repository: Repository | DiscoveryRepo;
  /** True for a stored star: the server writes the result. False for a discovery repo: result returned only. */
  stored: boolean;
  language: string;
  categories: Category[];
  confirmSpend: ClaudeAnalysisOptions['confirmSpend'];
  onProgress?: (status: string) => void;
  signal?: AbortSignal;
}

export const analyzeRepository = async (options: AnalyzeRepositoryOptions): Promise<AIAnalysisResult> => {
  const { repository, stored, language, categories, confirmSpend, onProgress, signal } = options;
  onProgress?.('Analyzing with Claude...');

  const request: ClaudeAnalysisRequest = stored
    ? { repoIds: [repository.id], language }
    : {
        repos: [{
          id: repository.id,
          fullName: repository.full_name,
          description: repository.description ?? null,
          language: repository.language ?? null,
          topics: repository.topics ?? [],
          stars: repository.stargazers_count,
        }],
        language,
      };
  const outcome = await runClaudeAnalysis(request, { confirmSpend, signal });
  if (outcome.declined || !outcome.job) throw new DOMException('Analysis declined', 'AbortError');
  if (outcome.cancelled) throw new DOMException('Analysis cancelled', 'AbortError');
  const item = outcome.job.items.find((candidate) => candidate.repoId === repository.id) ?? outcome.job.items[0];
  if (!item || item.status !== 'done' || !item.result) {
    throw new Error(item?.error || `Analysis ${outcome.job.status}`);
  }

  const analysis = item.result;
  const resolvedCategory = resolveCategoryAssignment({ ...repository, ai_summary: analysis.summary } as Repository, analysis.tags, categories);
  return {
    summary: analysis.summary,
    tags: analysis.tags,
    platforms: analysis.platforms,
    custom_category: resolvedCategory,
    category_locked: !!(repository as Repository).category_locked,
    analyzed_at: new Date().toISOString(),
    analysis_failed: false,
  };
};

export const createFailedAnalysisResult = (error?: string): AIAnalysisResult => ({
  summary: '',
  tags: [],
  platforms: [],
  analyzed_at: new Date().toISOString(),
  analysis_failed: true,
  analysis_error: error || undefined,
});
