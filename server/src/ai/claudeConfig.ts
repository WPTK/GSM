import { readSecret } from '../secrets.js';

/**
 * Claude settings come from the environment only:
 *   ANTHROPIC_API_KEY, or ANTHROPIC_API_KEY_FILE (a path, for Docker secrets; the file wins when both are set)
 *   CLAUDE_MODEL_BULK  (default claude-haiku-5-5)   summaries, tags, search, translate
 *   CLAUDE_MODEL_CHAT  (default claude-sonnet-5-5)  chat and tools
 *   AI_SPEND_CONFIRM_USD (default 2.00)
 * The key is never stored in the database, logged, or sent to the browser.
 */

export const DEFAULT_MODEL_BULK = 'claude-haiku-5-5';
export const DEFAULT_MODEL_CHAT = 'claude-sonnet-5-5';
export const DEFAULT_SPEND_CONFIRM_USD = 2.0;

let cachedKey: string | null | undefined;
let modelsVerified = false;

function readKey(): string | null {
  return readSecret('ANTHROPIC_API_KEY');
}

/** The configured Anthropic key, or null. Read once, then cached. */
export function getAnthropicKey(): string | null {
  if (cachedKey === undefined) cachedKey = readKey();
  return cachedKey;
}

/** Last 4 characters of the key and nothing more; null when no key is set. */
export function keySuffix(): string | null {
  const key = getAnthropicKey();
  // A short key would show most of itself; real keys are far longer than 12 characters.
  if (!key || key.length < 12) return null;
  return key.slice(-4);
}

export function getModels(): { bulk: string; chat: string } {
  return {
    bulk: process.env.CLAUDE_MODEL_BULK?.trim() || DEFAULT_MODEL_BULK,
    chat: process.env.CLAUDE_MODEL_CHAT?.trim() || DEFAULT_MODEL_CHAT,
  };
}

export function getSpendConfirmUsd(): number {
  const raw = process.env.AI_SPEND_CONFIRM_USD?.trim();
  if (!raw) return DEFAULT_SPEND_CONFIRM_USD;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_SPEND_CONFIRM_USD;
}

/** True once startup has confirmed both model IDs with the Models API. */
export function isConnected(): boolean {
  return modelsVerified && getAnthropicKey() !== null;
}

export function markModelsVerified(value = true): void {
  modelsVerified = value;
}

/** Test hook: forget the cached key and the verified flag. */
export function resetClaudeConfigForTests(): void {
  cachedKey = undefined;
  modelsVerified = false;
}
