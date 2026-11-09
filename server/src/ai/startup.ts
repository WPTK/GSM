import { logger } from '../services/logger.js';
import { getAnthropicClient, type AnthropicLike } from './client.js';
import { getAnthropicKey, getModels, markModelsVerified } from './claudeConfig.js';
import { hasPricing } from './pricing.js';

export class ClaudeStartupError extends Error {}

/**
 * Fails closed: the server does not listen without ANTHROPIC_API_KEY and without both
 * model IDs known to the Models API (and priced in pricing.json, so the spend guard works).
 * Messages never contain the key.
 */
export async function validateModels(client?: AnthropicLike): Promise<void> {
  if (!getAnthropicKey()) {
    throw new ClaudeStartupError('ANTHROPIC_API_KEY (or ANTHROPIC_API_KEY_FILE) is not set; refusing to start');
  }
  const { bulk, chat } = getModels();
  const api = client ?? getAnthropicClient();
  for (const [role, id] of [['CLAUDE_MODEL_BULK', bulk], ['CLAUDE_MODEL_CHAT', chat]] as const) {
    if (!hasPricing(id)) {
      throw new ClaudeStartupError(`${role}=${id} has no entry in ai/pricing.json, so the spend guard cannot price it; refusing to start`);
    }
    try {
      await api.models.retrieve(id);
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 404) {
        throw new ClaudeStartupError(`${role}=${id} is not a model the Anthropic API knows; refusing to start`);
      }
      throw new ClaudeStartupError(`Could not verify ${role}=${id} with the Anthropic API (${status ? `HTTP ${status}` : 'network error'}); refusing to start`);
    }
  }
  markModelsVerified();
}

/** Runs validateModels and exits 1 with one clear log line on failure. */
export async function validateModelsOrExit(exit: (code: number) => never = process.exit): Promise<void> {
  try {
    await validateModels();
  } catch (err) {
    logger.error('ai.startup', err instanceof ClaudeStartupError ? err.message : 'Claude startup check failed');
    exit(1);
  }
}
