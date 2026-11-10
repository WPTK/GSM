import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Release, Repository } from '../../../types';
import { useRepositoryReleaseSheet } from './useRepositoryReleaseSheet';

const mocks = vi.hoisted(() => ({
  backend: {
    isAvailable: false,
    getRepositoryReleases: vi.fn(),
    downloadGitHubResource: vi.fn(),
  },
  toast: vi.fn(),
  analyzeReleaseSummary: vi.fn(),
  store: {
    language: 'zh' as const,
  },
  claude: { connected: true },
}));

vi.mock('../../../hooks/useClaudeStatus', () => ({
  useClaudeStatus: () => ({ connected: mocks.claude.connected }),
}));

vi.mock('../../../services/backendAdapter', () => ({ backend: mocks.backend }));
vi.mock('../../../hooks/useDialog', () => ({
  useDialog: () => ({ toast: mocks.toast, confirm: vi.fn() }),
}));
vi.mock('../../../services/aiService', () => ({
  AIService: class {
    analyzeReleaseSummary = mocks.analyzeReleaseSummary;
  },
}));
vi.mock('../../../store/useAppStore', () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof mocks.store) => unknown) => selector(mocks.store),
    { getState: () => mocks.store },
  ),
}));

const repository: Repository = {
  id: 9,
  name: 'repo',
  full_name: 'owner/repo',
  description: null,
  html_url: 'https://github.com/owner/repo',
  stargazers_count: 0,
  forks_count: 0,
  forks: 0,
  language: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  pushed_at: '2026-01-01T00:00:00.000Z',
  owner: { login: 'owner', avatar_url: 'https://example.com/avatar.png' },
  topics: [],
};

const rawRelease = {
  id: 100,
  tag_name: 'v1.0.0',
  name: 'Version 1.0.0',
  body: 'Notes',
  published_at: '2026-01-02T00:00:00.000Z',
  html_url: 'https://github.com/owner/repo/releases/tag/v1.0.0',
  assets: [],
  prerelease: false,
};

describe('useRepositoryReleaseSheet', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.backend.isAvailable = false;
  });

  it('uses the live backend GitHub proxy when available and maps repository identity locally', async () => {
    mocks.backend.isAvailable = true;
    mocks.backend.getRepositoryReleases.mockResolvedValue([rawRelease]);
    const { result } = renderHook(() => useRepositoryReleaseSheet(repository));

    await act(async () => {
      await result.current.loadReleases();
    });

    expect(mocks.backend.getRepositoryReleases).toHaveBeenCalledWith('owner', 'repo', 1, 100, expect.any(AbortSignal));
    expect(result.current.releases).toEqual([expect.objectContaining({
      id: rawRelease.id,
      repository: { id: repository.id, name: repository.name, full_name: repository.full_name },
    })]);
  });

  it('filters backend draft releases with null publication times before mapping', async () => {
    mocks.backend.isAvailable = true;
    mocks.backend.getRepositoryReleases.mockResolvedValue([
      { ...rawRelease, id: 99, draft: true, published_at: null },
      rawRelease,
    ]);
    const { result } = renderHook(() => useRepositoryReleaseSheet(repository));

    await act(async () => {
      await result.current.loadReleases();
    });

    expect(result.current.releases).toEqual([expect.objectContaining({ id: rawRelease.id })]);
  });

  it('uses the authenticated backend proxy for private downloads', async () => {
    mocks.backend.isAvailable = true;
    const blob = new Blob(['backend release asset']);
    mocks.backend.downloadGitHubResource.mockResolvedValue(blob);
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:backend-release') });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const { result } = renderHook(() => useRepositoryReleaseSheet(repository));

    await act(async () => {
      await result.current.downloadAsset({
        id: 'asset-2',
        name: 'backend-private.zip',
        url: 'https://github.com/owner/repo/releases/download/v1/backend-private.zip',
        authenticatedPath: '/repos/owner/repo/releases/assets/2',
        size: 10,
        isSourceCode: false,
        assetId: 2,
      });
    });

    expect(mocks.backend.downloadGitHubResource).toHaveBeenCalledWith('/repos/owner/repo/releases/assets/2');
    expect(clickSpy).toHaveBeenCalledOnce();
  });

  it('opens a new window for public assets that have no authenticated path', async () => {
    mocks.backend.isAvailable = true;
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    const { result } = renderHook(() => useRepositoryReleaseSheet(repository));

    await act(async () => {
      await result.current.downloadAsset({
        id: 'asset-3',
        name: 'browser-fallback.zip',
        url: 'https://github.com/owner/repo/releases/download/v1/browser-fallback.zip',
        size: 10,
        isSourceCode: false,
        assetId: 3,
      });
    });

    expect(mocks.backend.downloadGitHubResource).not.toHaveBeenCalled();
    expect(openSpy).toHaveBeenCalledWith('https://github.com/owner/repo/releases/download/v1/browser-fallback.zip', '_blank', 'noopener,noreferrer');
    openSpy.mockRestore();
  });

  it('keeps an in-flight AI summary alive across unrelated state updates', async () => {
    mocks.claude.connected = true;
    // abort 感知 mock：真实 fetch 在 signal 中止时会以 AbortError 拒绝
    let resolveSummary!: (value: string) => void;
    mocks.analyzeReleaseSummary.mockImplementation((_b: string, _m: unknown, signal: AbortSignal) =>
      new Promise<string>((resolve, reject) => {
        resolveSummary = (value: string) => {
          if (signal.aborted) {
            const abortError = new Error('Aborted');
            abortError.name = 'AbortError';
            reject(abortError);
          } else {
            resolve(value);
          }
        };
      }));
    const { result } = renderHook(() => useRepositoryReleaseSheet(repository));

    const sheetRelease: Release = {
      id: rawRelease.id,
      tag_name: rawRelease.tag_name,
      name: rawRelease.name,
      body: rawRelease.body,
      published_at: rawRelease.published_at,
      html_url: rawRelease.html_url,
      assets: [],
      prerelease: false,
      repository: { id: repository.id, full_name: repository.full_name, name: repository.name },
    };

    let pending!: Promise<void>;
    act(() => {
      pending = result.current.generateSummary(sheetRelease);
    });
    // An unrelated download state update must not abort the summary request.
    await act(async () => {
      await result.current.downloadAsset({
        id: 'asset-4',
        name: 'a.zip',
        url: 'https://github.com/owner/repo/releases/download/v1/a.zip',
        size: 1,
        isSourceCode: false,
      });
    });
    resolveSummary('# Summary');
    await act(async () => { await pending; });

    expect(result.current.summaries[sheetRelease.id]).toEqual({ status: 'done', content: '# Summary' });
  });
});
