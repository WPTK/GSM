import { StrictMode, type ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Repository } from '../../../types';
import type { AnalysisJob, AnalysisJobItem } from '../../../services/claudeContract';
import { useRepositoryAnalysisJob } from './useRepositoryAnalysisJob';
import { useAppStore } from '../../../store/useAppStore';

const mocks = vi.hoisted(() => ({
  useAppStore: vi.fn(),
  toast: vi.fn(),
  confirm: vi.fn(),
  runClaudeAnalysis: vi.fn(),
  confirmSpend: vi.fn(),
  claude: { connected: true },
  forceSyncToBackend: vi.fn(),
}));

vi.mock('../../../store/useAppStore', () => ({
  useAppStore: mocks.useAppStore,
}));

vi.mock('../../../hooks/useDialog', () => ({
  useDialog: () => ({ toast: mocks.toast, confirm: mocks.confirm }),
}));

vi.mock('../../../hooks/useClaudeStatus', () => ({
  useClaudeStatus: () => ({ connected: mocks.claude.connected, state: 'ok', status: null, loading: false, error: null, refresh: async () => {} }),
}));

vi.mock('../../../hooks/useClaudeSpendConfirm', () => ({
  useClaudeSpendConfirm: () => mocks.confirmSpend,
}));

vi.mock('../../../services/claudeJobs', () => ({
  runClaudeAnalysis: mocks.runClaudeAnalysis,
}));

vi.mock('../../../services/autoSync', () => ({
  forceSyncToBackend: mocks.forceSyncToBackend,
}));

const repository = (id: number, overrides: Partial<Repository> = {}): Repository => ({
  id,
  name: `repository-${id}`,
  full_name: `owner/repository-${id}`,
  description: 'Repository description',
  html_url: `https://github.com/owner/repository-${id}`,
  stargazers_count: 10,
  forks_count: 1,
  forks: 1,
  language: 'TypeScript',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-02T00:00:00.000Z',
  pushed_at: '2026-01-03T00:00:00.000Z',
  owner: { login: 'owner', avatar_url: 'https://example.com/avatar.png' },
  topics: [],
  ...overrides,
});

const createStoreState = () => ({
  language: 'zh' as const,
  updateRepository: vi.fn(),
  setLoading: vi.fn(),
  setAnalysisProgress: vi.fn(),
});

const doneItem = (repoId: number, summary: string, tags: string[] = []): AnalysisJobItem => ({
  repoId,
  status: 'done',
  result: { summary, tags, platforms: [] },
} as unknown as AnalysisJobItem);
const failedItem = (repoId: number, error: string): AnalysisJobItem => ({ repoId, status: 'failed', error } as unknown as AnalysisJobItem);
const jobOf = (items: AnalysisJobItem[]): AnalysisJob => ({
  id: 'job-1',
  status: 'done',
  mode: 'direct',
  total: items.length,
  done: items.filter((item) => item.status === 'done').length,
  failed: items.filter((item) => item.status === 'failed').length,
  items,
} as unknown as AnalysisJob);

type RunOptions = {
  signal: AbortSignal;
  onProgress?: (job: AnalysisJob) => void;
  onItem?: (item: AnalysisJobItem, job: AnalysisJob) => void;
};

/** Makes runClaudeAnalysis report every item through onItem, then finish. */
const finishWith = (items: AnalysisJobItem[]) => async (_request: unknown, options: RunOptions) => {
  const job = jobOf(items);
  options.onProgress?.(job);
  for (const item of items) options.onItem?.(item, job);
  return { estimate: {}, job, declined: false, cancelled: false };
};

let storeState = createStoreState();
const mockUseAppStore = vi.mocked(useAppStore);
const runOptions = (repositories: Repository[], syncOnComplete = false) => ({
  repositories,
  scope: 'all' as const,
  syncOnComplete,
});

const renderJob = () => renderHook(() => useRepositoryAnalysisJob({ allCategories: [] }));

describe('useRepositoryAnalysisJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.claude.connected = true;
    storeState = createStoreState();
    mockUseAppStore.mockImplementation(((selector?: (state: typeof storeState) => unknown) => (
      selector ? selector(storeState) : storeState
    )) as typeof useAppStore);
    mocks.confirm.mockResolvedValue(true);
    mocks.forceSyncToBackend.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends the repository ids and UI language to the server job and stores successful results without syncing', async () => {
    const target = repository(1, { custom_description: 'Keep me' });
    mocks.runClaudeAnalysis.mockImplementation(finishWith([doneItem(1, 'AI summary', ['ai'])]));
    const { result } = renderJob();

    await act(async () => {
      await result.current.run(runOptions([target]));
    });

    expect(mocks.runClaudeAnalysis).toHaveBeenCalledWith(
      { repoIds: [1], language: 'zh' },
      expect.objectContaining({ confirmSpend: mocks.confirmSpend, signal: expect.any(AbortSignal) }),
    );
    expect(storeState.updateRepository).toHaveBeenCalledWith(expect.objectContaining({
      id: target.id,
      ai_summary: 'AI summary',
      ai_tags: ['ai'],
      custom_description: 'Keep me',
      analysis_failed: false,
    }));
    expect(mocks.forceSyncToBackend).not.toHaveBeenCalled();
    expect(result.current).toMatchObject({ isRunning: false, progress: { current: 0, total: 0 } });
  });

  it('stores both successful and failed items from a partially failing job and syncs once when requested', async () => {
    const successful = repository(1);
    const failed = repository(2, { custom_tags: ['user-tag'] });
    mocks.runClaudeAnalysis.mockImplementation(finishWith([doneItem(1, 'done'), failedItem(2, 'model unavailable')]));
    const { result } = renderJob();

    await act(async () => {
      await result.current.run(runOptions([successful, failed], true));
    });

    expect(storeState.updateRepository).toHaveBeenCalledTimes(2);
    expect(storeState.updateRepository).toHaveBeenCalledWith(expect.objectContaining({ id: failed.id, analysis_failed: true, analysis_error: 'model unavailable', custom_tags: ['user-tag'] }));
    expect(mocks.forceSyncToBackend).toHaveBeenCalledTimes(1);
  });

  it('does nothing and says Claude is not connected when the server has no verified key', async () => {
    mocks.claude.connected = false;
    const { result } = renderJob();

    let started = true;
    await act(async () => {
      started = await result.current.run(runOptions([repository(1)]));
    });

    expect(started).toBe(false);
    expect(mocks.runClaudeAnalysis).not.toHaveBeenCalled();
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith(expect.any(String), 'error');
  });

  it('writes nothing and does not sync when the owner declines the spend dialog', async () => {
    mocks.runClaudeAnalysis.mockResolvedValue({ estimate: {}, job: null, declined: true, cancelled: false });
    const { result } = renderJob();

    let ok = true;
    await act(async () => {
      ok = await result.current.run(runOptions([repository(1)], true));
    });

    expect(ok).toBe(false);
    expect(storeState.updateRepository).not.toHaveBeenCalled();
    expect(mocks.forceSyncToBackend).not.toHaveBeenCalled();
    expect(result.current.isRunning).toBe(false);
  });

  it('leaves results written before a confirmed stop intact and resets task state', async () => {
    const target = repository(1, { custom_description: 'User value' });
    mocks.runClaudeAnalysis.mockImplementation(async (_request: unknown, options: RunOptions) => {
      options.onItem?.(doneItem(1, 'Completed before stop'), jobOf([doneItem(1, 'Completed before stop')]));
      await new Promise<void>((resolve) => options.signal.addEventListener('abort', () => resolve(), { once: true }));
      return { estimate: {}, job: jobOf([doneItem(1, 'Completed before stop')]), declined: false, cancelled: true };
    });
    const { result } = renderJob();
    let runningJob!: Promise<boolean>;

    act(() => {
      runningJob = result.current.run(runOptions([target]));
    });
    await waitFor(() => expect(storeState.updateRepository).toHaveBeenCalledTimes(1));

    await act(async () => {
      await result.current.requestStop();
      await runningJob;
    });

    expect(storeState.updateRepository).toHaveBeenCalledWith(expect.objectContaining({ id: target.id, ai_summary: 'Completed before stop', custom_description: 'User value' }));
    expect(result.current.isRunning).toBe(false);
  });

  it('does not abort or change task state when stop confirmation is cancelled', async () => {
    const target = repository(1);
    let signal!: AbortSignal;
    let finish!: () => void;
    mocks.runClaudeAnalysis.mockImplementation((_request: unknown, options: RunOptions) => {
      signal = options.signal;
      return new Promise((resolve) => {
        finish = () => resolve({ estimate: {}, job: jobOf([]), declined: false, cancelled: false });
      });
    });
    const { result } = renderJob();
    let runningJob!: Promise<boolean>;

    act(() => {
      runningJob = result.current.run(runOptions([target]));
    });
    await waitFor(() => expect(result.current.isRunning).toBe(true));
    mocks.confirm.mockResolvedValueOnce(false);

    await act(async () => {
      await result.current.requestStop();
    });
    expect(signal.aborted).toBe(false);
    expect(result.current.isRunning).toBe(true);

    await act(async () => {
      finish();
      await runningJob;
    });
  });

  it('reports job exceptions and resets state', async () => {
    mocks.runClaudeAnalysis.mockRejectedValue(new Error('network unavailable'));
    const { result } = renderJob();

    await act(async () => {
      await result.current.run(runOptions([repository(1)]));
    });

    expect(mocks.toast).toHaveBeenCalledWith('AI分析失败，请检查AI配置和网络连接。', 'error');
    expect(result.current).toMatchObject({ isRunning: false, progress: { current: 0, total: 0 } });
  });

  it('re-enables result writes after StrictMode rehearses the lifecycle cleanup', async () => {
    const target = repository(1);
    mocks.runClaudeAnalysis.mockImplementation(finishWith([doneItem(1, 'StrictMode result')]));

    const { result } = renderHook(
      () => useRepositoryAnalysisJob({ allCategories: [] }),
      { wrapper: ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode> },
    );

    await act(async () => {
      await result.current.run(runOptions([target]));
    });

    expect(storeState.updateRepository).toHaveBeenCalledWith(expect.objectContaining({
      id: target.id,
      ai_summary: 'StrictMode result',
    }));
  });

  it('aborts an active job on unmount and prevents further result writes', async () => {
    const target = repository(1);
    let signal!: AbortSignal;
    let onItem: RunOptions['onItem'];
    mocks.runClaudeAnalysis.mockImplementation((_request: unknown, options: RunOptions) => {
      signal = options.signal;
      onItem = options.onItem;
      return new Promise(() => undefined);
    });
    const { result, unmount } = renderJob();

    act(() => {
      void result.current.run(runOptions([target]));
    });
    await waitFor(() => expect(mocks.runClaudeAnalysis).toHaveBeenCalledTimes(1));
    unmount();
    onItem?.(doneItem(1, 'late result'), jobOf([doneItem(1, 'late result')]));

    expect(signal.aborted).toBe(true);
    expect(storeState.updateRepository).not.toHaveBeenCalled();
  });
});
