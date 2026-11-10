import { fetchAiStatus } from './claudeClient';
import type { AiStatusResponse } from './claudeContract';

/**
 * Shared, polled copy of GET /api/ai/status. Components subscribe through
 * useClaudeStatus; the poll runs only while at least one subscriber exists.
 * The status holds no secret: the server sends at most the last 4 key characters.
 */

export interface ClaudeStatusSnapshot {
  status: AiStatusResponse | null;
  /** True until the first response (or failure) arrives. */
  loading: boolean;
  error: string | null;
}

const REFRESH_MS = 60_000;

let snapshot: ClaudeStatusSnapshot = { status: null, loading: true, error: null };
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let inflight: Promise<void> | null = null;

const emit = (next: ClaudeStatusSnapshot) => {
  snapshot = next;
  listeners.forEach((listener) => listener());
};

export const getClaudeStatusSnapshot = (): ClaudeStatusSnapshot => snapshot;

export function refreshClaudeStatus(): Promise<void> {
  if (inflight) return inflight;
  inflight = fetchAiStatus()
    .then((status) => emit({ status, loading: false, error: null }))
    .catch((error: unknown) => emit({
      // Keep the last good status: one failed poll must not flip every AI feature to "not connected".
      status: snapshot.status,
      loading: false,
      error: error instanceof Error ? error.message : String(error),
    }))
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export function subscribeClaudeStatus(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    void refreshClaudeStatus();
    timer = setInterval(() => { void refreshClaudeStatus(); }, REFRESH_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** Test hook: forget the cached status. */
export function resetClaudeStatusForTests(): void {
  snapshot = { status: null, loading: true, error: null };
  inflight = null;
}
