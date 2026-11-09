import { getDb } from '../db/connection.js';
import { AI_STATE_SETTING_KEY } from '../db/settingsKeys.js';
import { logger } from '../services/logger.js';
import { getAnthropicClient } from './client.js';
import { getModels } from './claudeConfig.js';
import type { AiState } from './contract.js';

/** How long to wait between recovery probes. */
export const CREDIT_PROBE_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface StoredAiState {
  state: AiState;
  since?: string;
  nextCheckAt?: string;
}

const CREDIT_MESSAGE = /credit balance is too low/i;

/**
 * Anthropic reports an exhausted balance either as 402 (billing_error) or as 400
 * (invalid_request_error) with "Your credit balance is too low". Batch result items
 * carry the same text, so a plain message can be checked too.
 */
export function isCreditLowError(err: unknown): boolean {
  if (typeof err === 'string') return CREDIT_MESSAGE.test(err);
  if (!err || typeof err !== 'object') return false;
  const e = err as { status?: unknown; message?: unknown; error?: { message?: unknown; error?: { message?: unknown } } };
  if (e.status === 402) return true;
  const messages = [e.message, e.error?.message, e.error?.error?.message].filter((m): m is string => typeof m === 'string');
  if (e.status === 400 || e.status === undefined) return messages.some((m) => CREDIT_MESSAGE.test(m));
  return false;
}

export function getAiState(): StoredAiState {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(AI_STATE_SETTING_KEY) as
    | { value: string | null }
    | undefined;
  if (!row?.value) return { state: 'ok' };
  try {
    const parsed = JSON.parse(row.value) as StoredAiState;
    return parsed.state === 'credit_low' ? parsed : { state: 'ok' };
  } catch {
    return { state: 'ok' };
  }
}

function writeState(value: StoredAiState): void {
  getDb().prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(AI_STATE_SETTING_KEY, JSON.stringify(value));
}

type ResumeListener = () => void;
const resumeListeners = new Set<ResumeListener>();
let probeTimer: ReturnType<typeof setTimeout> | null = null;

/** Jobs register here to be restarted when credit comes back. */
export function onCreditResumed(listener: ResumeListener): () => void {
  resumeListeners.add(listener);
  return () => resumeListeners.delete(listener);
}

function scheduleProbe(delayMs: number): void {
  if (probeTimer) clearTimeout(probeTimer);
  probeTimer = setTimeout(() => {
    probeTimer = null;
    void runCreditProbe();
  }, Math.max(0, delayMs));
  probeTimer.unref?.();
}

/** Marks credit as low, schedules the daily probe and returns the stored state. */
export function setCreditLow(): StoredAiState {
  const existing = getAiState();
  if (existing.state === 'credit_low') return existing;
  const now = Date.now();
  const next: StoredAiState = {
    state: 'credit_low',
    since: new Date(now).toISOString(),
    nextCheckAt: new Date(now + CREDIT_PROBE_INTERVAL_MS).toISOString(),
  };
  writeState(next);
  logger.warn('ai.credit', 'Anthropic credit balance is too low; AI jobs are paused');
  scheduleProbe(CREDIT_PROBE_INTERVAL_MS);
  return next;
}

function clearCreditLow(): void {
  writeState({ state: 'ok' });
  logger.info('ai.credit', 'Anthropic credit is available again; resuming AI jobs');
  for (const listener of [...resumeListeners]) {
    try {
      listener();
    } catch (err) {
      logger.errorFromError('ai.credit', 'resume listener failed', err);
    }
  }
}

/** One-token call on the bulk model. Success clears credit_low; failure keeps it and waits another day. */
export async function runCreditProbe(): Promise<boolean> {
  if (getAiState().state !== 'credit_low') return true;
  try {
    await getAnthropicClient().messages.create({
      model: getModels().bulk,
      max_tokens: 1,
      messages: [{ role: 'user', content: '.' }],
    });
    clearCreditLow();
    return true;
  } catch (err) {
    if (!isCreditLowError(err)) {
      logger.warn('ai.credit', 'credit probe failed for a reason other than credit; will retry tomorrow');
    }
    const next: StoredAiState = {
      state: 'credit_low',
      since: getAiState().since,
      nextCheckAt: new Date(Date.now() + CREDIT_PROBE_INTERVAL_MS).toISOString(),
    };
    writeState(next);
    scheduleProbe(CREDIT_PROBE_INTERVAL_MS);
    return false;
  }
}

/** On boot: when the stored state is credit_low, probe at its nextCheckAt (or now if that has passed). */
export function resumeCreditProbeSchedule(): void {
  const state = getAiState();
  if (state.state !== 'credit_low') return;
  const due = state.nextCheckAt ? Date.parse(state.nextCheckAt) - Date.now() : 0;
  scheduleProbe(Number.isFinite(due) ? due : 0);
}

export function stopCreditProbeForTests(): void {
  if (probeTimer) clearTimeout(probeTimer);
  probeTimer = null;
}
