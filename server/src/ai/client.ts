import Anthropic from '@anthropic-ai/sdk';
import { guardedFetch } from '../services/proxyService.js';
import { getAnthropicKey } from './claudeConfig.js';

/** Fixed base URL. The key is only ever sent here (and guardedFetch re-checks the host). */
export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';

/** The SDK retries 408/409/429/5xx (including 529) with backoff and honours retry-after. */
export const SDK_MAX_RETRIES = 5;

/** Request parameters and options are passed through to the SDK untouched. */
export type ClientParams = Record<string, unknown>;

/** A content block of a reply; only the fields this server reads. */
export interface ContentBlockLike {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

/** A finished message (reply or batch item): only the fields this server reads. */
export interface MessageLike {
  content?: ContentBlockLike[];
  usage?: Record<string, unknown>;
  stop_reason?: string | null;
}

/** A message stream: text deltas, abort, and the accumulated final message. */
export interface MessageStreamLike {
  on(event: 'text', listener: (text: string) => void): unknown;
  abort?(): void;
  finalMessage(): Promise<MessageLike>;
}

/** A batch record from create/retrieve/cancel. */
export interface BatchLike {
  id?: string;
  processing_status?: string;
  [key: string]: unknown;
}

/** One line of batch results. */
export interface BatchResultEntryLike {
  custom_id: string;
  result: { type: string; message?: MessageLike; error?: BatchErrorLike };
}

export interface BatchErrorLike {
  message?: string;
  error?: { message?: string };
  [key: string]: unknown;
}

/**
 * The slice of the SDK this server uses. The real client satisfies it, and tests
 * inject a fake through setAnthropicClientForTests.
 */
export interface AnthropicLike {
  messages: {
    create(params: ClientParams, options?: ClientParams): Promise<MessageLike>;
    stream(params: ClientParams, options?: ClientParams): MessageStreamLike;
    countTokens(params: ClientParams, options?: ClientParams): Promise<{ input_tokens: number }>;
    batches: {
      create(params: ClientParams, options?: ClientParams): Promise<BatchLike>;
      retrieve(id: string, options?: ClientParams): Promise<BatchLike>;
      results(id: string, options?: ClientParams): Promise<AsyncIterable<BatchResultEntryLike>> | AsyncIterable<BatchResultEntryLike>;
      cancel(id: string, options?: ClientParams): Promise<BatchLike>;
    };
  };
  models: {
    retrieve(id: string, options?: ClientParams): Promise<{ id?: string; [key: string]: unknown }>;
  };
}

export function buildAnthropicClient(opts: { apiKey: string; fetch?: typeof fetch }): AnthropicLike {
  return new Anthropic({
    apiKey: opts.apiKey,
    baseURL: ANTHROPIC_BASE_URL,
    maxRetries: SDK_MAX_RETRIES,
    fetch: opts.fetch ?? guardedFetch,
  }) as unknown as AnthropicLike;
}

let override: AnthropicLike | null = null;
let real: AnthropicLike | null = null;

/** The shared client. Throws when no key is configured. */
export function getAnthropicClient(): AnthropicLike {
  if (override) return override;
  if (!real) {
    const key = getAnthropicKey();
    if (!key) throw new Error('ANTHROPIC_API_KEY is not configured');
    real = buildAnthropicClient({ apiKey: key });
  }
  return real;
}

/** Test hook: inject a fake client (or null to go back to the real one). */
export function setAnthropicClientForTests(client: AnthropicLike | null): void {
  override = client;
  real = null;
}
