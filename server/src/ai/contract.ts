/**
 * Wire contract for the Claude routes (/api/ai/*). The client codes against
 * this file; keep it exact. Schemas are strict: unknown keys are rejected.
 *
 * All routes use cookie auth. Error bodies are `{ error: string, code: string }`
 * (see AiErrorCode). The Anthropic key and model IDs never appear in a request:
 * the purpose picks the model on the server.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

/** UI languages the analysis prompt has variants for. Other values fall back to English. */
export const AI_LANGUAGES = ['de', 'en', 'es', 'fr', 'ja', 'ko', 'pt-BR', 'ru', 'zh', 'zh-TW'] as const;
export const AiLanguageSchema = z.enum(AI_LANGUAGES);
export type AiLanguage = z.infer<typeof AiLanguageSchema>;

export const AI_PLATFORMS = ['mac', 'windows', 'linux', 'ios', 'android', 'docker', 'web', 'cli'] as const;
export type AiPlatform = (typeof AI_PLATFORMS)[number];

/** Error codes the /api/ai routes can return in `{ error, code }`. */
export const AI_ERROR_CODES = [
  'VALIDATION_ERROR', // 400 body failed the schema (includes model/baseUrl in the body)
  'AI_CREDIT_LOW', // 503 credit balance too low; jobs are paused
  'AI_NOT_CONFIGURED', // 503 key or models missing (cannot normally happen: startup fails closed)
  'AI_UPSTREAM_ERROR', // 502 Anthropic returned an error the server could not recover from
  'AI_RATE_LIMITED', // 429 Anthropic rate limit after the SDK's retries
  'AI_SPEND_CONFIRM_REQUIRED', // 409 estimate is over the threshold and `confirmed` was not true
  'AI_ESTIMATE_NOT_FOUND', // 404 unknown or expired estimateId
  'AI_JOB_NOT_FOUND', // 404 unknown job id
  'AI_JOB_NOT_CANCELLABLE', // 409 job already finished

] as const;
export type AiErrorCode = (typeof AI_ERROR_CODES)[number];

export interface AiErrorBody {
  error: string;
  code: AiErrorCode;
}

export type AiState = 'ok' | 'credit_low';

/** Token usage in the shape Anthropic reports it, camelCased. */
export const AiUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheCreationInputTokens: z.number().int().nonnegative(),
  cacheReadInputTokens: z.number().int().nonnegative(),
});
export type AiUsage = z.infer<typeof AiUsageSchema>;

export type AiStopReason = 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | 'refusal' | 'pause_turn';

/** Result of the prompt-cache decision for the shared prefix. */
export type AiCacheInfo =
  | { cache: 'used'; prefixTokens: number; minTokens: number }
  | { cache: 'skipped'; prefixTokens: number; minTokens: number };

// ---------------------------------------------------------------------------
// GET /api/ai/status
// ---------------------------------------------------------------------------

export interface AiStatusResponse {
  /** True when a key is configured and both models were verified at startup. */
  connected: boolean;
  /** Last 4 characters of the key, or null when not connected. Never more. */
  keySuffix: string | null;
  models: { bulk: string; chat: string };
  state: AiState;
  /** ISO time the credit_low state began (only when state is credit_low). */
  since?: string;
  /** ISO time of the next daily probe (only when state is credit_low). */
  nextCheckAt?: string;
  /** Latest cache decision for the analysis prefix, if an analysis has been estimated or run. */
  cache?: AiCacheInfo;
}

// ---------------------------------------------------------------------------
// GET/PUT /api/ai/settings
// ---------------------------------------------------------------------------

/** Longest custom analysis prompt the server stores. */
export const MAX_CUSTOM_ANALYSIS_PROMPT_CHARS = 4000;

/**
 * Owner-editable extra instructions for repository analysis. The text is appended to
 * the shared prompt prefix (so it is part of the cached prefix) and may use `{LANGUAGE}`;
 * the old `{REPO_INFO}`, `{CATEGORIES_INFO}` and `{CATEGORIES_HINT}` placeholders are dropped.
 * An empty string clears it.
 */
export const AiSettingsUpdateSchema = z
  .object({ customAnalysisPrompt: z.string().max(MAX_CUSTOM_ANALYSIS_PROMPT_CHARS) })
  .strict();
export type AiSettingsUpdate = z.infer<typeof AiSettingsUpdateSchema>;

/** Reply of GET /api/ai/settings and PUT /api/ai/settings (the stored values after the call). */
export interface AiSettingsResponse {
  customAnalysisPrompt: string;
}

// ---------------------------------------------------------------------------
// POST /api/ai/messages
// ---------------------------------------------------------------------------

export const AI_PURPOSES = ['chat', 'tools', 'search', 'translate', 'release-summary'] as const;
export const AiPurposeSchema = z.enum(AI_PURPOSES);
export type AiPurpose = z.infer<typeof AiPurposeSchema>;

/** Which model class serves each purpose: chat and tools use CLAUDE_MODEL_CHAT, the rest CLAUDE_MODEL_BULK. */
export const PURPOSE_MODEL_CLASS: Record<AiPurpose, 'bulk' | 'chat'> = {
  chat: 'chat',
  tools: 'chat',
  search: 'bulk',
  translate: 'bulk',
  'release-summary': 'bulk',
};

/** Hard cap on maxTokens per purpose. A larger value is a 400. */
export const MAX_TOKENS_BY_PURPOSE: Record<AiPurpose, number> = {
  chat: 8192,
  tools: 8192,
  search: 4096,
  translate: 8192,
  'release-summary': 4096,
};

export const AiTextBlockSchema = z.object({ type: z.literal('text'), text: z.string() }).strict();
export const AiToolUseBlockSchema = z
  .object({ type: z.literal('tool_use'), id: z.string().min(1), name: z.string().min(1), input: z.record(z.string(), z.unknown()) })
  .strict();
export const AiToolResultBlockSchema = z
  .object({
    type: z.literal('tool_result'),
    tool_use_id: z.string().min(1),
    content: z.string(),
    is_error: z.boolean().optional(),
  })
  .strict();
export const AiContentBlockSchema = z.discriminatedUnion('type', [
  AiTextBlockSchema,
  AiToolUseBlockSchema,
  AiToolResultBlockSchema,
]);
export type AiContentBlock = z.infer<typeof AiContentBlockSchema>;

export const AiMessageSchema = z
  .object({
    role: z.enum(['user', 'assistant']),
    content: z.union([z.string(), z.array(AiContentBlockSchema).min(1)]),
  })
  .strict();
export type AiMessage = z.infer<typeof AiMessageSchema>;

export const AiToolDefinitionSchema = z
  .object({
    name: z.string().min(1).max(64),
    description: z.string().optional(),
    input_schema: z.record(z.string(), z.unknown()),
  })
  .strict();
export type AiToolDefinition = z.infer<typeof AiToolDefinitionSchema>;

export const AiMessagesRequestSchema = z
  .object({
    purpose: AiPurposeSchema,
    system: z.string().optional(),
    messages: z.array(AiMessageSchema).min(1),
    tools: z.array(AiToolDefinitionSchema).optional(),
    maxTokens: z.number().int().positive(),
    temperature: z.number().min(0).max(1).optional(),
    stream: z.boolean().optional(),
  })
  .strict(); // `model` and `baseUrl` are not keys, so strict() answers 400 for them
export type AiMessagesRequest = z.infer<typeof AiMessagesRequestSchema>;

export interface AiToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** JSON reply when `stream` is not true. */
export interface AiMessagesResponse {
  text: string;
  toolCalls?: AiToolCall[];
  usage: AiUsage;
  stopReason: AiStopReason;
}

/**
 * SSE frames when `stream: true` (Content-Type text/event-stream). Each frame is
 * `event: <type>\ndata: <json>\n\n`. Order: zero or more `delta`, then exactly one
 * `done` or one `error`. Tool calls are not streamed incrementally: a `done` frame
 * carries them in `toolCalls`.
 */
export interface AiSseDeltaFrame {
  type: 'delta';
  text: string;
}
export interface AiSseDoneFrame {
  type: 'done';
  usage: AiUsage;
  stopReason: AiStopReason;
  toolCalls?: AiToolCall[];
}
export interface AiSseErrorFrame {
  type: 'error';
  code: AiErrorCode;
  message: string;
}
export type AiSseFrame = AiSseDeltaFrame | AiSseDoneFrame | AiSseErrorFrame;

// ---------------------------------------------------------------------------
// Analysis (summary, tags, platforms)
// ---------------------------------------------------------------------------

export const AnalysisResultSchema = z
  .object({
    summary: z.string().min(3),
    tags: z.array(z.string().min(1)).min(1).max(8),
    platforms: z.array(z.enum(AI_PLATFORMS)),
  })
  .strict();
export type AnalysisResult = z.infer<typeof AnalysisResultSchema>;

/** A repository the caller wants analysed without it being a stored star (discovery). */
export const AnalysisRepoInputSchema = z
  .object({
    id: z.number().int(),
    fullName: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
    description: z.string().nullable().optional(),
    language: z.string().nullable().optional(),
    topics: z.array(z.string()).optional(),
    stars: z.number().int().nonnegative().optional(),
  })
  .strict();
export type AnalysisRepoInput = z.infer<typeof AnalysisRepoInputSchema>;

/** Maximum repos in one estimate. */
export const MAX_ANALYSIS_REPOS = 5000;

/**
 * POST /api/ai/analysis/estimate. Exactly one of `repoIds` (stored repositories)
 * or `repos` (inline, results returned but not written) must be present.
 */
export const AnalysisEstimateRequestSchema = z
  .object({
    repoIds: z.array(z.number().int()).min(1).max(MAX_ANALYSIS_REPOS).optional(),
    repos: z.array(AnalysisRepoInputSchema).min(1).max(MAX_ANALYSIS_REPOS).optional(),
    language: AiLanguageSchema,
  })
  .strict()
  .refine((v) => (v.repoIds === undefined) !== (v.repos === undefined), {
    message: 'Provide exactly one of repoIds or repos',
  });
export type AnalysisEstimateRequest = z.infer<typeof AnalysisEstimateRequestSchema>;

/** Repos of a request run directly up to this count, as a Message Batch above it. */
export const DIRECT_REPO_LIMIT = 20;

export interface AnalysisEstimateResponse {
  /** Pass to POST /analysis/jobs. Valid for 30 minutes. */
  estimateId: string;
  repos: number;
  /** Upper bound, whole run (prefix once + per-repo input). */
  inputTokens: number;
  /** Upper bound, whole run (fixed per-repo output budget). */
  outputTokens: number;
  /** Upper-bound cost in USD, batch discount applied when `batch` is true. */
  usd: number;
  /** True when more than DIRECT_REPO_LIMIT repos will go through the Message Batches API. */
  batch: boolean;
  /** True when usd is over AI_SPEND_CONFIRM_USD; creating the job then needs `confirmed: true`. */
  needsConfirm: boolean;
  /** The threshold in USD, so the dialog can show it. */
  confirmThresholdUsd: number;
  model: string;
  /** Date the prices were checked (YYYY-MM-DD), from pricing.json. */
  pricingCheckedAt: string;
  cache: AiCacheInfo;
}

export const AnalysisJobCreateRequestSchema = z
  .object({
    estimateId: z.string().min(1),
    confirmed: z.boolean().optional(),
  })
  .strict();
export type AnalysisJobCreateRequest = z.infer<typeof AnalysisJobCreateRequestSchema>;

export type AnalysisJobStatus =
  | 'queued' // accepted, not started
  | 'running' // direct calls in flight
  | 'submitted' // batch submitted to Anthropic, polling
  | 'paused' // credit_low; resumes when the daily probe succeeds
  | 'completed'
  | 'failed' // every item failed or the batch itself failed/expired
  | 'cancelled';

export type AnalysisItemStatus = 'pending' | 'done' | 'failed';

export interface AnalysisJobItem {
  repoId: number;
  fullName: string;
  status: AnalysisItemStatus;
  /** Present when status is done. For `repos` input this is the only place the result lives. */
  result?: AnalysisResult;
  /** Present when status is failed. A short message, never a secret. */
  error?: string;
}

export interface AnalysisJob {
  id: string;
  status: AnalysisJobStatus;
  mode: 'direct' | 'batch';
  /** True when results were written to `repositories` (repoIds input); false for inline `repos`. */
  persisted: boolean;
  total: number;
  done: number;
  failed: number;
  usd: number;
  cache: AiCacheInfo;
  createdAt: string;
  updatedAt: string;
  items: AnalysisJobItem[];
}

/** POST /api/ai/analysis/jobs -> 202. GET /jobs/:id and POST /jobs/:id/cancel -> 200. */
export interface AnalysisJobResponse {
  job: AnalysisJob;
}
