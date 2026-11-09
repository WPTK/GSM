import type { AnthropicLike } from './client.js';
import type { AiCacheInfo } from './contract.js';
import { getModelPricing } from './pricing.js';

export interface SystemBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

/**
 * Decides whether the shared prefix is long enough to cache. Below the model's minimum
 * the prefix is sent plain and the decision is reported as skipped; the prompt is never padded.
 */
export async function decideCache(client: AnthropicLike, model: string, prefix: string): Promise<AiCacheInfo> {
  const minTokens = getModelPricing(model).minCacheTokens;
  const counted = await client.messages.countTokens({
    model,
    system: prefix,
    messages: [{ role: 'user', content: '.' }],
  });
  const prefixTokens = counted.input_tokens;
  return { cache: prefixTokens >= minTokens ? 'used' : 'skipped', prefixTokens, minTokens };
}

/** The system parameter: one text block, with cache_control only when the decision was `used`. */
export function buildSystem(prefix: string, info: AiCacheInfo): SystemBlock[] {
  const block: SystemBlock = { type: 'text', text: prefix };
  if (info.cache === 'used') block.cache_control = { type: 'ephemeral' };
  return [block];
}
