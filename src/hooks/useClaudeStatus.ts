import { useCallback, useSyncExternalStore } from 'react';
import {
  getClaudeStatusSnapshot,
  refreshClaudeStatus,
  subscribeClaudeStatus,
} from '../services/claudeStatusStore';
import type { AiStatusResponse } from '../services/claudeContract';

export interface ClaudeStatus {
  /** The server has a key and both models verified. Gate AI features on this. */
  connected: boolean;
  /** 'credit_low' while the account balance is too low and jobs are paused. */
  state: 'ok' | 'credit_low';
  status: AiStatusResponse | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

/** Live Claude status from the server (GET /api/ai/status), shared by every caller. */
export function useClaudeStatus(): ClaudeStatus {
  const snapshot = useSyncExternalStore(subscribeClaudeStatus, getClaudeStatusSnapshot, getClaudeStatusSnapshot);
  const refresh = useCallback(() => refreshClaudeStatus(), []);
  return {
    connected: snapshot.status?.connected === true,
    state: snapshot.status?.state ?? 'ok',
    status: snapshot.status,
    loading: snapshot.loading,
    error: snapshot.error,
    refresh,
  };
}
