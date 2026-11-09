import { randomUUID } from 'node:crypto';
import { getDb } from '../db/connection.js';
import { CUSTOM_ANALYSIS_PROMPT_KEY } from '../db/settingsKeys.js';
import { getAnthropicClient } from './client.js';
import { getModels, getSpendConfirmUsd } from './claudeConfig.js';
import { buildAnalysisPrefix, README_CAP_CHARS, type PromptCategory } from './prompts.js';
import { decideCache } from './cache.js';
import { ANALYSIS_MAX_TOKENS } from './analyze.js';
import { BATCH_DISCOUNT, PRICING_CHECKED_AT, tierFor } from './pricing.js';
import {
  DIRECT_REPO_LIMIT,
  type AiCacheInfo,
  type AiLanguage,
  type AnalysisEstimateRequest,
  type AnalysisEstimateResponse,
  type AnalysisRepoInput,
} from './contract.js';

export const ESTIMATE_TTL_MS = 30 * 60 * 1000;
/** Conservative characters-per-token ratio for the per-repository heuristic. */
const CHARS_PER_TOKEN = 3;
const PER_REPO_OVERHEAD_TOKENS = 80;

export interface RepoRecord {
  id: number;
  fullName: string;
  description: string | null;
  language: string | null;
  topics: string[];
  stars: number;
}

export interface StoredEstimate {
  id: string;
  expiresAt: number;
  language: AiLanguage;
  /** True for stored repositories (results are written); false for inline discovery repos. */
  persisted: boolean;
  repos: RepoRecord[];
  model: string;
  response: AnalysisEstimateResponse;
}

const estimates = new Map<string, StoredEstimate>();
let lastCache: AiCacheInfo | null = null;

export function getLastCacheDecision(): AiCacheInfo | null {
  return lastCache;
}

export function setLastCacheDecision(info: AiCacheInfo): void {
  lastCache = info;
}

export function getCustomAnalysisPrompt(): string {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(CUSTOM_ANALYSIS_PROMPT_KEY) as
    | { value: string | null }
    | undefined;
  return row?.value ?? '';
}

function parseKeywords(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((k): k is string => typeof k === 'string');
  } catch {
    // fall through to comma separated
  }
  return raw.split(',').map((k) => k.trim()).filter(Boolean);
}

export function loadCategories(): PromptCategory[] {
  const rows = getDb().prepare('SELECT name, keywords FROM categories ORDER BY sort_order, name').all() as Array<{
    name: string;
    keywords: string | null;
  }>;
  return rows.filter((r) => r.name).map((r) => ({ name: r.name, keywords: parseKeywords(r.keywords) }));
}

/** The cacheable prefix for a language: instructions, category list and the owner's custom prompt. */
export function loadAnalysisPrefix(language: AiLanguage): string {
  return buildAnalysisPrefix(language, loadCategories(), getCustomAnalysisPrompt());
}

function parseTopics(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

export function loadStoredRepos(ids: number[]): RepoRecord[] {
  const db = getDb();
  const stmt = db.prepare('SELECT id, full_name, description, language, topics, stargazers_count FROM repositories WHERE id = ?');
  const out: RepoRecord[] = [];
  for (const id of new Set(ids)) {
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    if (!row) continue;
    out.push({
      id: row.id as number,
      fullName: row.full_name as string,
      description: (row.description as string | null) ?? null,
      language: (row.language as string | null) ?? null,
      topics: parseTopics(row.topics),
      stars: (row.stargazers_count as number) ?? 0,
    });
  }
  return out;
}

function fromInline(r: AnalysisRepoInput): RepoRecord {
  return {
    id: r.id,
    fullName: r.fullName,
    description: r.description ?? null,
    language: r.language ?? null,
    topics: r.topics ?? [],
    stars: r.stars ?? 0,
  };
}

/** Heuristic input tokens for one repository: metadata plus a README at the truncation cap. */
export function perRepoInputTokens(repo: RepoRecord): number {
  const metaChars =
    repo.fullName.length + (repo.description?.length ?? 0) + (repo.language?.length ?? 0) + repo.topics.join(', ').length + 160;
  return Math.ceil((metaChars + README_CAP_CHARS) / CHARS_PER_TOKEN) + PER_REPO_OVERHEAD_TOKENS;
}

/**
 * Upper-bound cost in USD for a run. Pure: no I/O.
 *
 * Worst case assumed: every repository hits max_tokens (1024) on every call and returns invalid
 * output once, so it is called twice. A batch is one discounted pass plus one undiscounted
 * direct retry call per repository (batch caching is best-effort, so every batch request is
 * charged as a cache write).
 */
export function computeCost(opts: {
  model: string;
  repoCount: number;
  prefixTokens: number;
  perRepoInputTokensTotal: number;
  outputPerRepo: number;
  batch: boolean;
  cache: AiCacheInfo;
}): { inputTokens: number; outputTokens: number; usd: number } {
  const { repoCount: n, prefixTokens: p, cache } = opts;
  const maxPerRepo = n > 0 ? Math.ceil(opts.perRepoInputTokensTotal / n) : 0;
  const tier = tierFor(opts.model, p + maxPerRepo * 2);
  const M = 1_000_000;
  const R = opts.perRepoInputTokensTotal;
  const used = cache.cache === 'used';

  // Direct requests: the first writes the cache, the rest read it.
  const directCost = (requests: number, repoInput: number, output: number): number => {
    const prefix = used
      ? (p * tier.cacheWrite5m + Math.max(0, requests - 1) * p * tier.cacheRead) / M
      : (requests * p * tier.input) / M;
    return prefix + (repoInput * tier.input) / M + (output * tier.output) / M;
  };

  if (!opts.batch) {
    const requests = 2 * n;
    const output = requests * opts.outputPerRepo;
    return {
      inputTokens: requests * p + 2 * R,
      outputTokens: output,
      usd: Math.ceil(directCost(requests, 2 * R, output) * 10000) / 10000,
    };
  }

  const passPrefix = (n * p * (used ? tier.cacheWrite5m : tier.input)) / M;
  const batchPass = (passPrefix + (R * tier.input) / M + (n * opts.outputPerRepo * tier.output) / M) * (1 - BATCH_DISCOUNT);
  const retryPass = directCost(n, R, n * opts.outputPerRepo);
  return {
    inputTokens: 2 * n * p + 2 * R,
    outputTokens: 2 * n * opts.outputPerRepo,
    usd: Math.ceil((batchPass + retryPass) * 10000) / 10000,
  };
}
export class EstimateInputError extends Error {}

function prune(now: number): void {
  for (const [id, e] of estimates) if (e.expiresAt <= now) estimates.delete(id);
}

export async function createEstimate(req: AnalysisEstimateRequest): Promise<StoredEstimate> {
  const persisted = req.repoIds !== undefined;
  const repos = persisted ? loadStoredRepos(req.repoIds ?? []) : (req.repos ?? []).map(fromInline);
  if (repos.length === 0) throw new EstimateInputError('None of the requested repositories were found');

  const model = getModels().bulk;
  const prefix = loadAnalysisPrefix(req.language);
  const cache = await decideCache(getAnthropicClient(), model, prefix);
  setLastCacheDecision(cache);

  const batch = repos.length > DIRECT_REPO_LIMIT;
  const total = repos.reduce((sum, r) => sum + perRepoInputTokens(r), 0);
  const cost = computeCost({
    model,
    repoCount: repos.length,
    prefixTokens: cache.prefixTokens,
    perRepoInputTokensTotal: total,
    outputPerRepo: ANALYSIS_MAX_TOKENS,
    batch,
    cache,
  });
  const threshold = getSpendConfirmUsd();
  const now = Date.now();
  prune(now);
  const stored: StoredEstimate = {
    id: randomUUID(),
    expiresAt: now + ESTIMATE_TTL_MS,
    language: req.language,
    persisted,
    repos,
    model,
    response: {
      estimateId: '',
      repos: repos.length,
      inputTokens: cost.inputTokens,
      outputTokens: cost.outputTokens,
      usd: cost.usd,
      batch,
      needsConfirm: cost.usd > threshold,
      confirmThresholdUsd: threshold,
      model,
      pricingCheckedAt: PRICING_CHECKED_AT,
      cache,
    },
  };
  stored.response.estimateId = stored.id;
  estimates.set(stored.id, stored);
  return stored;
}

export function getEstimate(id: string): StoredEstimate | null {
  const e = estimates.get(id);
  if (!e) return null;
  if (e.expiresAt <= Date.now()) {
    estimates.delete(id);
    return null;
  }
  return e;
}

export function consumeEstimate(id: string): void {
  estimates.delete(id);
}

export function clearEstimatesForTests(): void {
  estimates.clear();
  lastCache = null;
}
