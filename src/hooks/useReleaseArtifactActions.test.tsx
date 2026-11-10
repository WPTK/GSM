import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Release } from '../types';
import { computeDownloadKey, useReleaseArtifactActions } from './useReleaseArtifactActions';

const mocks = vi.hoisted(() => ({
  useAppStore: vi.fn(),
  toast: vi.fn(),
  analyzeReleaseSummary: vi.fn(),
  claude: { connected: true },
}));

vi.mock('./useClaudeStatus', () => ({
  useClaudeStatus: () => ({ connected: mocks.claude.connected }),
}));

vi.mock('../store/useAppStore', () => ({
  useAppStore: mocks.useAppStore,
}));

vi.mock('../hooks/useDialog', () => ({
  useDialog: () => ({ toast: mocks.toast, confirm: vi.fn() }),
}));

vi.mock('../services/aiService', () => ({
  AIService: class {
    analyzeReleaseSummary = mocks.analyzeReleaseSummary;
  },
}));

const createStoreState = () => ({
  language: 'zh' as const,
});

let storeState = createStoreState();
const mockUseAppStore = vi.mocked(mocks.useAppStore);
mockUseAppStore.mockImplementation((selector?: (state: typeof storeState) => unknown) =>
  selector ? selector(storeState) : storeState);
(mockUseAppStore as unknown as { getState: () => typeof storeState }).getState = () => storeState;

const release: Release = {
  id: 100,
  tag_name: 'v1.0.0',
  name: 'Version 1.0.0',
  body: 'Notes body',
  published_at: '2026-01-02T00:00:00.000Z',
  html_url: 'https://github.com/owner/repo/releases/tag/v1.0.0',
  assets: [],
  prerelease: false,
  repository: { id: 9, full_name: 'owner/repo', name: 'repo' },
};

describe('computeDownloadKey', () => {
  it('versions the key with updatedAt', () => {
    expect(computeDownloadKey({ url: 'https://x/a.zip', updatedAt: '2026-01-01T00:00:00.000Z' }))
      .toBe('https://x/a.zip@2026-01-01T00:00:00.000Z');
    expect(computeDownloadKey({ url: 'https://x/a.zip' })).toBe('https://x/a.zip@');
    expect(computeDownloadKey({ url: 'https://x/a.zip', updatedAt: undefined })).toBe('https://x/a.zip@');
  });
});

describe('useReleaseArtifactActions.generateSummary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeState = createStoreState();
    mocks.claude.connected = true;
  });

  it('toasts without writing state when Claude is not connected', async () => {
    mocks.claude.connected = false;
    const { result } = renderHook(() => useReleaseArtifactActions());
    await act(async () => { await result.current.generateSummary(release); });
    expect(mocks.toast).toHaveBeenCalledWith('Claude 未连接。请让服务器所有者添加 Anthropic API 密钥。', 'error');
    expect(result.current.summaries[100]).toBeUndefined();
    expect(mocks.analyzeReleaseSummary).not.toHaveBeenCalled();
  });

  it('stores loading → done with the generated content', async () => {
    mocks.analyzeReleaseSummary.mockResolvedValue('# Summary');
    const { result } = renderHook(() => useReleaseArtifactActions());
    await act(async () => { await result.current.generateSummary(release); });
    expect(mocks.analyzeReleaseSummary).toHaveBeenCalledWith(
      'Notes body',
      { repoName: 'owner/repo', tagName: 'v1.0.0', releaseName: 'Version 1.0.0' },
      expect.any(AbortSignal),
    );
    expect(result.current.summaries[100]).toEqual({ status: 'done', content: '# Summary' });
  });

  it('skips regeneration while loading or when a done summary exists', async () => {
    mocks.analyzeReleaseSummary.mockResolvedValue('# Summary');
    const { result } = renderHook(() => useReleaseArtifactActions());
    await act(async () => { await result.current.generateSummary(release); });

    await act(async () => { await result.current.generateSummary(release); });
    expect(mocks.analyzeReleaseSummary).toHaveBeenCalledTimes(1);

    // loading 态同样短路
    let resolveSummary!: (value: string) => void;
    mocks.analyzeReleaseSummary.mockImplementation(() => new Promise<string>((resolve) => {
      resolveSummary = resolve;
    }));
    const second: Release = { ...release, id: 101 };
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.generateSummary(second);
    });
    await act(async () => { await result.current.generateSummary(second); });
    expect(result.current.summaries[101]?.status).toBe('loading');
    resolveSummary('# late');
    await act(async () => { await pending; });
  });

  it('collapses same-tick consecutive generateSummary calls into a single request', async () => {
    // loading 守卫读渲染快照：同一事件循环内（同步双调用）第二次仍看到旧快照，
    // 依赖 summaryAbortRefs 的同步门卫去重。
    mocks.analyzeReleaseSummary.mockImplementation(() => new Promise<string>(() => undefined));
    const { result } = renderHook(() => useReleaseArtifactActions());
    act(() => {
      void result.current.generateSummary(release);
      void result.current.generateSummary(release);
    });
    expect(mocks.analyzeReleaseSummary).toHaveBeenCalledTimes(1);
    expect(result.current.summaries[100]?.status).toBe('loading');
  });

  it('stores the error state and toasts on failure', async () => {
    mocks.analyzeReleaseSummary.mockRejectedValue(new Error('model offline'));
    const { result } = renderHook(() => useReleaseArtifactActions());
    await act(async () => { await result.current.generateSummary(release); });
    expect(result.current.summaries[100]).toEqual({ status: 'error', error: 'model offline' });
    expect(mocks.toast).toHaveBeenCalledWith('总结生成失败：model offline', 'error');
  });

  it('stays silent on AbortError', async () => {
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    mocks.analyzeReleaseSummary.mockRejectedValue(abortError);
    const { result } = renderHook(() => useReleaseArtifactActions());
    await act(async () => { await result.current.generateSummary(release); });
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(result.current.summaries[100]).toEqual({ status: 'loading' });
  });

  it('aborts all in-flight summary requests on unmount', async () => {
    const signals: AbortSignal[] = [];
    mocks.analyzeReleaseSummary.mockImplementation((_body: string, _meta: unknown, signal: AbortSignal) => {
      signals.push(signal);
      return new Promise<string>(() => undefined);
    });
    const { result, unmount } = renderHook(() => useReleaseArtifactActions());
    act(() => {
      void result.current.generateSummary(release);
    });
    expect(signals[0].aborted).toBe(false);
    unmount();
    expect(signals[0].aborted).toBe(true);
  });

  it('cancelSummaryRequests aborts in-flight requests without unmounting', async () => {
    const signals: AbortSignal[] = [];
    mocks.analyzeReleaseSummary.mockImplementation((_body: string, _meta: unknown, signal: AbortSignal) => {
      signals.push(signal);
      return new Promise<string>(() => undefined);
    });
    const { result } = renderHook(() => useReleaseArtifactActions());
    act(() => {
      void result.current.generateSummary(release);
    });
    act(() => {
      result.current.cancelSummaryRequests();
    });
    expect(signals[0].aborted).toBe(true);
  });

  it('reset cancels in-flight summaries so they cannot write back after clearing', async () => {
    // abort 感知 mock：真实 fetch 在 signal 中止时会以 AbortError 拒绝
    const resolvers: Array<(value: string) => void> = [];
    mocks.analyzeReleaseSummary.mockImplementation((_b: string, _m: unknown, signal: AbortSignal) =>
      new Promise<string>((resolve, reject) => {
        resolvers.push((value: string) => {
          if (signal.aborted) {
            const abortError = new Error('Aborted');
            abortError.name = 'AbortError';
            reject(abortError);
          } else {
            resolve(value);
          }
        });
      }));
    const { result } = renderHook(() => useReleaseArtifactActions());

    act(() => {
      void result.current.generateSummary(release);
    });
    expect(result.current.summaries[100]?.status).toBe('loading');

    act(() => {
      result.current.reset();
    });
    expect(result.current.summaries).toEqual({});

    // 模拟迟到的完成：请求已被 reset 取消，结果不得回写
    resolvers[0]('# stale');
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(result.current.summaries).toEqual({});
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it('reset discards late results even when the service ignores the abort signal', async () => {
    // H1 回归：resolve 型 mock（忽略 signal，不抛 AbortError）——修复前会把迟到
    // 的 done 回写进刚清空的状态；修复后由 post-await aborted 守卫丢弃。
    let resolveSummary!: (value: string) => void;
    mocks.analyzeReleaseSummary.mockImplementation(() => new Promise<string>((resolve) => {
      resolveSummary = resolve;
    }));
    const { result } = renderHook(() => useReleaseArtifactActions());

    act(() => {
      void result.current.generateSummary(release);
    });
    expect(result.current.summaries[100]?.status).toBe('loading');

    act(() => {
      result.current.reset();
    });
    expect(result.current.summaries).toEqual({});

    resolveSummary('# stale');
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(result.current.summaries).toEqual({});
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it('reset clears summaries', async () => {
    mocks.analyzeReleaseSummary.mockResolvedValue('# Summary');
    const { result } = renderHook(() => useReleaseArtifactActions());
    await act(async () => {
      await result.current.generateSummary(release);
    });
    expect(result.current.summaries[100]).toEqual({ status: 'done', content: '# Summary' });
    act(() => {
      result.current.reset();
    });
    expect(result.current.summaries).toEqual({});
  });
});
