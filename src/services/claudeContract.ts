/**
 * Client copy of the /api/ai wire contract (server/src/ai/contract.ts). Types and
 * constants only: the server validates, the client just speaks the shapes.
 * The Anthropic key and model IDs never appear here: the purpose picks the model.
 */

export const AI_LANGUAGES = ['de', 'en', 'es', 'fr', 'ja', 'ko', 'pt-BR', 'ru', 'zh', 'zh-TW'] as const;
export type AiLanguage = (typeof AI_LANGUAGES)[number];

export type AiErrorCode =
  | 'VALIDATION_ERROR'
  | 'AI_CREDIT_LOW'
  | 'AI_NOT_CONFIGURED'
  | 'AI_UPSTREAM_ERROR'
  | 'AI_RATE_LIMITED'
  | 'AI_SPEND_CONFIRM_REQUIRED'
  | 'AI_ESTIMATE_NOT_FOUND'
  | 'AI_JOB_NOT_FOUND'
  | 'AI_JOB_NOT_CANCELLABLE';

export type AiState = 'ok' | 'credit_low';

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export type AiStopReason = 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | 'refusal' | 'pause_turn';

export type AiCacheInfo =
  | { cache: 'used'; prefixTokens: number; minTokens: number }
  | { cache: 'skipped'; prefixTokens: number; minTokens: number };

export interface AiStatusResponse {
  connected: boolean;
  keySuffix: string | null;
  models: { bulk: string; chat: string };
  state: AiState;
  since?: string;
  nextCheckAt?: string;
  cache?: AiCacheInfo;
}

export const MAX_CUSTOM_ANALYSIS_PROMPT_CHARS = 4000;

export interface AiSettingsResponse {
  customAnalysisPrompt: string;
}

export type AiPurpose = 'chat' | 'tools' | 'search' | 'translate' | 'release-summary';

/** Hard cap on maxTokens per purpose; the server answers 400 above it. */
export const MAX_TOKENS_BY_PURPOSE: Record<AiPurpose, number> = {
  chat: 8192,
  tools: 8192,
  search: 4096,
  translate: 8192,
  'release-summary': 4096,
};

export type AiContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

export interface AiMessage {
  role: 'user' | 'assistant';
  content: string | AiContentBlock[];
}

export interface AiToolDefinitionWire {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

export interface AiMessagesRequest {
  purpose: AiPurpose;
  system?: string;
  messages: AiMessage[];
  tools?: AiToolDefinitionWire[];
  maxTokens: number;
  temperature?: number;
  stream?: boolean;
}

export interface AiToolCallWire {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AiMessagesResponse {
  text: string;
  toolCalls?: AiToolCallWire[];
  usage: AiUsage;
  stopReason: AiStopReason;
}

export type AiSseFrame =
  | { type: 'delta'; text: string }
  | { type: 'done'; usage: AiUsage; stopReason: AiStopReason; toolCalls?: AiToolCallWire[] }
  | { type: 'error'; code: AiErrorCode; message: string };

export interface AnalysisResult {
  summary: string;
  tags: string[];
  platforms: string[];
}

export interface AnalysisRepoInput {
  id: number;
  fullName: string;
  description?: string | null;
  language?: string | null;
  topics?: string[];
  stars?: number;
}

export interface AnalysisEstimateRequest {
  repoIds?: number[];
  repos?: AnalysisRepoInput[];
  language: AiLanguage;
}

export interface AnalysisEstimateResponse {
  estimateId: string;
  repos: number;
  inputTokens: number;
  outputTokens: number;
  usd: number;
  batch: boolean;
  needsConfirm: boolean;
  confirmThresholdUsd: number;
  model: string;
  pricingCheckedAt: string;
  cache: AiCacheInfo;
}

export type AnalysisJobStatus = 'queued' | 'running' | 'submitted' | 'paused' | 'completed' | 'failed' | 'cancelled';
export type AnalysisItemStatus = 'pending' | 'done' | 'failed';

export interface AnalysisJobItem {
  repoId: number;
  fullName: string;
  status: AnalysisItemStatus;
  result?: AnalysisResult;
  error?: string;
}

export interface AnalysisJob {
  id: string;
  status: AnalysisJobStatus;
  mode: 'direct' | 'batch';
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

export const TERMINAL_JOB_STATUSES: readonly AnalysisJobStatus[] = ['completed', 'failed', 'cancelled'];
