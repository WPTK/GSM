import pricingFile from './pricing.json' with { type: 'json' };

export interface PriceTier {
  /** Highest prompt size (tokens) this tier applies to; null means no upper limit. */
  maxPromptTokens: number | null;
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
}

export interface ModelPricing {
  minCacheTokens: number;
  tiers: PriceTier[];
}

interface PricingFile {
  checkedAt: string;
  source: string;
  unit: string;
  batchDiscount: number;
  models: Record<string, ModelPricing>;
}

const pricing = pricingFile as PricingFile;

export const PRICING_CHECKED_AT = pricing.checkedAt;
export const BATCH_DISCOUNT = pricing.batchDiscount;

export function hasPricing(model: string): boolean {
  return Object.prototype.hasOwnProperty.call(pricing.models, model);
}

export function getModelPricing(model: string): ModelPricing {
  if (!hasPricing(model)) throw new Error(`No pricing entry for model ${model}; add it to ai/pricing.json`);
  return pricing.models[model];
}

/** The price tier for a request whose prompt has the given size. */
export function tierFor(model: string, promptTokens: number): PriceTier {
  const tiers = getModelPricing(model).tiers;
  return tiers.find((t) => t.maxPromptTokens === null || promptTokens <= t.maxPromptTokens) ?? tiers[tiers.length - 1];
}
