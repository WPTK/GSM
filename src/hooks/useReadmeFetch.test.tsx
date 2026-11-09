import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_README_VARIANT, type ReadmeVariant } from '../utils/readmeVariants';
import { pickReadmeCandidate, useReadmeFetch } from './useReadmeFetch';

const mocks = vi.hoisted(() => ({
  useAppStore: vi.fn(),
  backend: {
    isAvailable: true,
    getRepositoryReadme: vi.fn(),
    getRepositoryReadmeByPath: vi.fn(),
    listRepositoryReadmeCandidates: vi.fn(),
  },
}));

vi.mock('../store/useAppStore', () => ({
  useAppStore: mocks.useAppStore,
}));

vi.mock('../services/backendAdapter', () => ({ backend: mocks.backend }));

const createStoreState = () => ({
  githubToken: 'github-token' as string | null,
  language: 'zh' as const,
});

let storeState = createStoreState();
const mockUseAppStore = vi.mocked(mocks.useAppStore);
mockUseAppStore.mockImplementation((selector?: (state: typeof storeState) => unknown) =>
  selector ? selector(storeState) : storeState);
(mockUseAppStore as unknown as { getState: () => typeof storeState }).getState = () => storeState;

const defaultVariant: ReadmeVariant = { ...DEFAULT_README_VARIANT };

describe('useReadmeFetch.fetchReadmeContent', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    storeState = createStoreState();
    mocks.backend.isAvailable = true;
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('goes through the backend', async () => {
    mocks.backend.getRepositoryReadme.mockResolvedValue('# Backend readme');
    const { result } = renderHook(() => useReadmeFetch({ owner: 'owner', name: 'repo' }));
    await act(async () => {
      await expect(result.current.fetchReadmeContent(defaultVariant)).resolves.toBe('# Backend readme');
    });
    expect(mocks.backend.getRepositoryReadme).toHaveBeenCalledWith('owner', 'repo', expect.any(AbortSignal));
  });

  it('rethrows the backend error (there is no direct-GitHub fallback) (content path)', async () => {
    mocks.backend.getRepositoryReadme.mockRejectedValue(new Error('backend down'));
    const { result } = renderHook(() => useReadmeFetch({ owner: 'owner', name: 'repo' }));
    await act(async () => {
      await expect(result.current.fetchReadmeContent(defaultVariant)).rejects.toThrow('backend down');
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('uses the path variant against the backend', async () => {
    const pathVariant: ReadmeVariant = { ...DEFAULT_README_VARIANT, key: 'readme-zh', path: 'README.zh.md', isDefault: false };
    mocks.backend.getRepositoryReadmeByPath.mockResolvedValueOnce('# backend path');

    const { result } = renderHook(() => useReadmeFetch({ owner: 'owner', name: 'repo' }));
    await act(async () => {
      await expect(result.current.fetchReadmeContent(pathVariant)).resolves.toBe('# backend path');
    });
    expect(mocks.backend.getRepositoryReadmeByPath).toHaveBeenCalledWith('owner', 'repo', 'README.zh.md', expect.any(AbortSignal));

  });

  it('rejects with an AbortError-named error when cancelled after the backend resolves', async () => {
    let resolveBackend!: (value: string) => void;
    mocks.backend.getRepositoryReadme.mockImplementation(() => new Promise<string>((resolve) => {
      resolveBackend = resolve;
    }));
    const { result } = renderHook(() => useReadmeFetch({ owner: 'owner', name: 'repo' }));

    let pending!: Promise<string>;
    act(() => {
      pending = result.current.fetchReadmeContent(defaultVariant);
    });
    act(() => {
      result.current.cancel();
    });
    resolveBackend('# stale');
    await act(async () => {
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    });
  });

  it('aborts the previous content request when a new one starts', async () => {
    const signals: AbortSignal[] = [];
    mocks.backend.getRepositoryReadme.mockImplementation((_owner: string, _name: string, signal: AbortSignal) => {
      signals.push(signal);
      return new Promise<string>(() => undefined);
    });
    const { result } = renderHook(() => useReadmeFetch({ owner: 'owner', name: 'repo' }));

    act(() => {
      void result.current.fetchReadmeContent(defaultVariant);
    });
    act(() => {
      void result.current.fetchReadmeContent(defaultVariant);
    });

    expect(signals).toHaveLength(2);
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
  });
});

describe('useReadmeFetch.fetchReadmeCandidates', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    storeState = createStoreState();
    mocks.backend.isAvailable = true;
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('returns candidates from the backend when available', async () => {
    const candidates = [{ name: 'README.zh-CN.md', path: 'README.zh-CN.md' }];
    mocks.backend.listRepositoryReadmeCandidates.mockResolvedValue(candidates);
    const { result } = renderHook(() => useReadmeFetch({ owner: 'owner', name: 'repo' }));
    await act(async () => {
      await expect(result.current.fetchReadmeCandidates('main')).resolves.toBe(candidates);
    });
    expect(mocks.backend.listRepositoryReadmeCandidates).toHaveBeenCalledWith('owner', 'repo', 'main', expect.any(AbortSignal));
  });

  it('rethrows the backend error (there is no direct-GitHub fallback) (candidates path)', async () => {
    mocks.backend.listRepositoryReadmeCandidates.mockRejectedValue(new Error('backend down'));
    const { result } = renderHook(() => useReadmeFetch({ owner: 'owner', name: 'repo' }));
    await act(async () => {
      await expect(result.current.fetchReadmeCandidates('main')).rejects.toThrow('backend down');
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('cancel aborts the in-flight candidates request', async () => {
    const signals: AbortSignal[] = [];
    mocks.backend.listRepositoryReadmeCandidates.mockImplementation((_o: string, _n: string, _b: string | undefined, signal: AbortSignal) => {
      signals.push(signal);
      return new Promise(() => undefined);
    });
    const { result } = renderHook(() => useReadmeFetch({ owner: 'owner', name: 'repo' }));

    act(() => {
      void result.current.fetchReadmeCandidates('main');
    });
    expect(signals[0].aborted).toBe(false);
    act(() => {
      result.current.cancel();
    });
    expect(signals[0].aborted).toBe(true);
  });
});

describe('pickReadmeCandidate', () => {
  const variantA: ReadmeVariant = { ...DEFAULT_README_VARIANT, key: 'a' };
  const variantB: ReadmeVariant = { ...DEFAULT_README_VARIANT, key: 'b' };

  it('returns the variant matching the selected key', () => {
    expect(pickReadmeCandidate([variantA, variantB], 'b', variantA)).toBe(variantB);
  });

  it('falls back to the default variant for unknown or missing keys', () => {
    expect(pickReadmeCandidate([variantA, variantB], 'missing', variantA)).toBe(variantA);
    expect(pickReadmeCandidate([variantA, variantB], undefined, variantB)).toBe(variantB);
  });
});
