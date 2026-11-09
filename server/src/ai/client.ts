import Anthropic from '@anthropic-ai/sdk';
import { guardedFetch } from '../services/proxyService.js';
import { getAnthropicKey } from './claudeConfig.js';

/** Fixed base URL. The key is only ever sent here (and guardedFetch re-checks the host). */
export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';

/** The SDK retries 408/409/429/5xx (including 529) with backoff and honours retry-after. */
export const SDK_MAX_RETRIES = 5;

/**
 * The slice of the SDK this server uses. The real client satisfies it, and tests
 * inject a fake through setAnthropicClientForTests.
 */
export interface AnthropicLike {
  messages: {
    create(params: any, options?: any): Promise<any>;
    stream(params: any, options?: any): any;
    countTokens(params: any, options?: any): Promise<{ input_tokens: number }>;
    batches: {
      create(params: any, options?: any): Promise<any>;
      retrieve(id: string, options?: any): Promise<any>;
      results(id: string, options?: any): Promise<AsyncIterable<any>> | AsyncIterable<any>;
      cancel(id: string, options?: any): Promise<any>;
    };
  };
  models: {
    retrieve(id: string, options?: any): Promise<any>;
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
