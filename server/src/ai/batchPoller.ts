import { logger } from '../services/logger.js';
import { getAnthropicClient } from './client.js';
import { collectBatchResults, listJobsByStatus, markBatchFailed } from './jobs.js';

export const BATCH_POLL_INTERVAL_MS = 60_000;

let timer: ReturnType<typeof setInterval> | null = null;
let polling = false;

/**
 * One pass over every submitted batch job: retrieve the batch (never create), and when it
 * has ended collect the results. A job whose batch id is missing is left alone.
 */
export async function pollBatchesOnce(): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    for (const { id, batchId } of listJobsByStatus('submitted')) {
      if (!batchId) continue;
      try {
        const batch = await getAnthropicClient().messages.batches.retrieve(batchId);
        if (batch.processing_status === 'ended') {
          await collectBatchResults(id);
        }
      } catch (err) {
        const status = (err as { status?: number }).status;
        if (status === 404) {
          markBatchFailed(id, 'The batch is no longer available at Anthropic');
        } else {
          logger.warn('ai.batch', `poll failed for a job; will retry (status ${status ?? 'unknown'})`);
        }
      }
    }
  } finally {
    polling = false;
  }
}

/** Polls every 60 seconds. Starting twice is a no-op. */
export function startBatchPoller(intervalMs = BATCH_POLL_INTERVAL_MS): void {
  if (timer) return;
  timer = setInterval(() => void pollBatchesOnce(), intervalMs);
  timer.unref?.();
  void pollBatchesOnce();
}

export function stopBatchPoller(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
