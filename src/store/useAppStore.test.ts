import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EmbeddingConfig, Release, Repository, VectorSearchConfig, VectorSearchStatus, defaultReleaseSourceSettings } from '../types';
import { EMBEDDING_FORMAT_VERSION, indexAllRepos } from '../services/vectorSearchService';
import { CUSTOM_RELEASE_SOURCE_ID, createCustomReleaseRepository } from '../utils/releaseSources';
import { findReleasesWithChangedAssets, shouldShowAssetsUpdatedIndicator } from '../utils/releaseAssets';
import {
  buildExpectedResetDiscoveryState,
  buildPersistedSnapshot,
  buildTransientDiscoverySnapshot,
  type PersistedSnapshot,
} from './__fixtures__/persistedSnapshots';

let useAppStore: typeof import('./useAppStore').useAppStore;
let normalizePersistedState: typeof import('./useAppStore').normalizePersistedState;

beforeAll(async () => {
  const { indexedDBStorage } = await vi.importActual<typeof import('../services/indexedDbStorage')>('../services/indexedDbStorage');
  window.localStorage?.removeItem?.('github-stars-manager');
  await indexedDBStorage.removeItem('github-stars-manager');
  ({ useAppStore, normalizePersistedState } = await vi.importActual<typeof import('./useAppStore')>('./useAppStore'));
});

const createRepository = (id: number, overrides: Partial<Repository> = {}): Repository => ({
  id,
  name: `repo-${id}`,
  full_name: `owner/repo-${id}`,
  description: 'A test repository',
  html_url: `https://github.com/owner/repo-${id}`,
  stargazers_count: 10,
  forks_count: 1,
  forks: 1,
  language: 'TypeScript',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-02T00:00:00.000Z',
  pushed_at: '2026-01-03T00:00:00.000Z',
  owner: {
    login: 'owner',
    avatar_url: 'https://github.com/avatar.png',
  },
  topics: ['test'],
  ...overrides,
});

describe('discovery channel visibility', () => {
  beforeEach(() => {
    useAppStore.setState({
      discoveryChannels: useAppStore.getInitialState().discoveryChannels.map(channel => ({ ...channel })),
      selectedDiscoveryChannel: 'topic',
    });
  });

  it('hides a channel and selects another visible channel', () => {
    useAppStore.getState().toggleDiscoveryChannel('topic');

    const state = useAppStore.getState();
    expect(state.discoveryChannels.find(channel => channel.id === 'topic')?.enabled).toBe(false);
    expect(state.selectedDiscoveryChannel).toBe('hot-release');
  });

  it('keeps the last visible channel available', () => {
    useAppStore.setState({
      discoveryChannels: useAppStore.getState().discoveryChannels.map(channel => ({
        ...channel,
        enabled: channel.id === 'hot-release',
      })),
      selectedDiscoveryChannel: 'hot-release',
    });

    useAppStore.getState().toggleDiscoveryChannel('hot-release');

    expect(useAppStore.getState().discoveryChannels.find(channel => channel.id === 'hot-release')?.enabled).toBe(true);
  });

  it('restores a visible selection from persisted channel settings', () => {
    const discoveryChannels = useAppStore.getInitialState().discoveryChannels.map(channel => ({
      ...channel,
      enabled: channel.id !== 'topic',
    }));
    const normalized = normalizePersistedState(
      { discoveryChannels, selectedDiscoveryChannel: 'topic' },
      useAppStore.getState()
    );

    expect(normalized.discoveryChannels?.find(channel => channel.id === 'topic')?.enabled).toBe(false);
    expect(normalized.selectedDiscoveryChannel).toBe('hot-release');
  });
});

describe('useAppStore release source settings', () => {
  beforeEach(() => {
    useAppStore.setState({
      releaseSourceSettings: defaultReleaseSourceSettings,
      releaseSubscriptions: new Set<number>(),
      releases: [],
      readReleases: new Set<number>(),
    });
  });

  it('keeps the starred release subscription source enabled by default', () => {
    expect(useAppStore.getState().releaseSourceSettings.enabledSourceIds).toEqual(['starred-release-subscription']);
  });

  it('dedupes custom release repositories by full name', () => {
    const first = createCustomReleaseRepository('owner/repo', CUSTOM_RELEASE_SOURCE_ID)!;
    const duplicate = createCustomReleaseRepository('https://github.com/OWNER/repo', CUSTOM_RELEASE_SOURCE_ID)!;

    useAppStore.getState().addReleaseSourceRepository(CUSTOM_RELEASE_SOURCE_ID, first);
    useAppStore.getState().addReleaseSourceRepository(CUSTOM_RELEASE_SOURCE_ID, duplicate);

    expect(useAppStore.getState().releaseSourceSettings.customReleaseRepos).toHaveLength(1);
  });

  it('removes custom release repositories by full name', () => {
    const repo = createCustomReleaseRepository('owner/repo', CUSTOM_RELEASE_SOURCE_ID)!;

    useAppStore.getState().addReleaseSourceRepository(CUSTOM_RELEASE_SOURCE_ID, repo);
    useAppStore.getState().removeReleaseSourceRepository(CUSTOM_RELEASE_SOURCE_ID, 'OWNER/repo');

    expect(useAppStore.getState().releaseSourceSettings.customReleaseRepos).toHaveLength(0);
  });
});

const makeRelease = (id: number, overrides: Partial<Release> = {}): Release => ({
  id,
  tag_name: `v${id}`,
  name: `Release ${id}`,
  body: null,
  published_at: '2026-01-01T00:00:00.000Z',
  html_url: `https://github.com/owner/repo/releases/tag/v${id}`,
  assets: [
    {
      id: 100 + id,
      name: 'app.dmg',
      size: 1000,
      download_count: 0,
      browser_download_url: 'https://example.com/app.dmg',
      content_type: 'application/octet-stream',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    },
  ],
  repository: { id: 1, full_name: 'owner/repo', name: 'repo' },
  ...overrides,
});

describe('useAppStore release add/upsert actions', () => {
  beforeEach(() => {
    useAppStore.setState({
      releaseSourceSettings: defaultReleaseSourceSettings,
      releaseSubscriptions: new Set<number>(),
      releases: [],
      readReleases: new Set<number>(),
    });
  });

  it('addReleases only appends new ids', () => {
    useAppStore.getState().addReleases([makeRelease(1), makeRelease(2)]);
    useAppStore.getState().addReleases([makeRelease(2), makeRelease(3)]);
    expect(useAppStore.getState().releases.map(r => r.id)).toEqual([1, 2, 3]);
  });

  it('upsertReleases updates assets/metadata and resets read state', () => {
    useAppStore.getState().addReleases([makeRelease(1, { is_read: true })]);
    useAppStore.getState().markReleaseAsRead(1);

    const updated = makeRelease(1, {
      name: 'Updated name',
      assets: [{ ...makeRelease(1).assets[0], size: 9999 }],
    });
    useAppStore.getState().upsertReleases([updated]);

    const result = useAppStore.getState().releases[0];
    expect(result.name).toBe('Updated name');
    expect(result.assets[0].size).toBe(9999);
    expect(result.is_read).toBe(false);
    expect(useAppStore.getState().readReleases.has(1)).toBe(false);
  });

  it('upsertReleases keeps read state of unaffected releases', () => {
    useAppStore.getState().addReleases([makeRelease(1), makeRelease(2)]);
    useAppStore.getState().markReleaseAsRead(2);

    useAppStore.getState().upsertReleases([makeRelease(1, {
      assets: [{ ...makeRelease(1).assets[0], size: 8888 }],
    })]);

    expect(useAppStore.getState().readReleases.has(1)).toBe(false);
    expect(useAppStore.getState().readReleases.has(2)).toBe(true);
  });

  it('upsertReleases ignores ids not present in store', () => {
    useAppStore.getState().addReleases([makeRelease(1)]);
    useAppStore.getState().upsertReleases([makeRelease(99)]);
    expect(useAppStore.getState().releases.map(r => r.id)).toEqual([1]);
  });

  it('regression: asset update resets read state and gates the "Assets updated" indicator until marked read', () => {
    const publishedAt = '2026-01-01T00:00:00.000Z';
    const assetAtPublish = { ...makeRelease(1).assets[0], updated_at: publishedAt };

    // 初始：已同步的 release，用户已标记为已读
    useAppStore.getState().addReleases([makeRelease(1, {
      published_at: publishedAt,
      assets: [assetAtPublish],
    })]);
    useAppStore.getState().markReleaseAsRead(1);
    const isUnread = () => !useAppStore.getState().readReleases.has(1);

    // 刷新：GitHub 返回同 id 但资产已被替换（updated_at 晚于 published_at）
    const latest = makeRelease(1, {
      published_at: publishedAt,
      assets: [
        { ...assetAtPublish, updated_at: '2026-01-05T00:00:00.000Z' },
        {
          ...assetAtPublish,
          id: 999,
          name: 'new-app.zip',
        },
      ],
    });

    // 复用 handleRefresh 的共享筛选逻辑（findReleasesWithChangedAssets），不依赖已读状态
    const updatedReleases = findReleasesWithChangedAssets([latest], useAppStore.getState().releases);
    expect(updatedReleases).toHaveLength(1);
    useAppStore.getState().upsertReleases(updatedReleases);

    // 资产更新后：无论之前是否已读，都重置为未读并展示"资产已更新"
    const merged = useAppStore.getState().releases.find(r => r.id === 1)!;
    expect(merged.is_read).toBe(false);
    expect(merged.updated_asset_ids).toEqual([101, 999]);
    expect(isUnread()).toBe(true);
    expect(shouldShowAssetsUpdatedIndicator(merged)).toBe(true);

    // 用户再次点击该条 release → 已读，"资产已更新"随 updated_asset_ids 清空而消失
    useAppStore.getState().markReleaseAsRead(1);
    expect(isUnread()).toBe(false);
    const afterRead = useAppStore.getState().releases.find(r => r.id === 1)!;
    expect(afterRead.updated_asset_ids).toEqual([]);
    expect(shouldShowAssetsUpdatedIndicator(afterRead)).toBe(false);
  });

  it('regression: asset updated_at newer than published_at alone does not show the indicator', () => {
    // GitHub 上资产几乎都在 Release 创建后上传（updated_at > published_at 常态），
    // 只有"相对上次拉取发生了变化"（updated_asset_ids 非空）才允许展示标识。
    const publishedAt = '2026-01-01T00:00:00.000Z';
    useAppStore.getState().addReleases([makeRelease(1, {
      published_at: publishedAt,
      assets: [{ ...makeRelease(1).assets[0], updated_at: '2026-01-02T00:00:00.000Z' }],
    })]);

    const fresh = useAppStore.getState().releases.find(r => r.id === 1)!;
    expect(fresh.updated_asset_ids).toBeUndefined();
    expect(shouldShowAssetsUpdatedIndicator(fresh)).toBe(false);
  });
});

describe('useAppStore release asset read actions', () => {
  beforeEach(() => {
    useAppStore.setState({
      releaseSourceSettings: defaultReleaseSourceSettings,
      releaseSubscriptions: new Set<number>(),
      releases: [],
      readReleases: new Set<number>(),
    });
  });

  it('markAssetAsRead removes only the clicked asset id from updated_asset_ids', () => {
    useAppStore.getState().addReleases([
      makeRelease(1, { updated_asset_ids: [101, 202, 303] }),
      makeRelease(2, { updated_asset_ids: [404] }),
    ]);

    useAppStore.getState().markAssetAsRead(202);

    const first = useAppStore.getState().releases.find(r => r.id === 1)!;
    const second = useAppStore.getState().releases.find(r => r.id === 2)!;
    expect(first.updated_asset_ids).toEqual([101, 303]);
    expect(second.updated_asset_ids).toEqual([404]);
  });

  it('markAssetAsRead does not touch the release read state', () => {
    useAppStore.getState().addReleases([makeRelease(1, { updated_asset_ids: [101] })]);
    useAppStore.getState().markAssetAsRead(101);

    expect(useAppStore.getState().readReleases.has(1)).toBe(false);
    expect(useAppStore.getState().releases[0].is_read).toBeUndefined();
  });

  it('markAssetAsRead is a no-op for unknown asset ids', () => {
    useAppStore.getState().addReleases([makeRelease(1, { updated_asset_ids: [101] })]);
    useAppStore.getState().markAssetAsRead(999);
    expect(useAppStore.getState().releases[0].updated_asset_ids).toEqual([101]);
  });

  it('markReleaseAsRead clears updated_asset_ids only on the clicked release', () => {
    useAppStore.getState().addReleases([
      makeRelease(1, { updated_asset_ids: [101] }),
      makeRelease(2, { updated_asset_ids: [202] }),
    ]);

    useAppStore.getState().markReleaseAsRead(1);

    expect(useAppStore.getState().releases[0].updated_asset_ids).toEqual([]);
    expect(useAppStore.getState().releases[1].updated_asset_ids).toEqual([202]);
  });

  it('markAllReleasesAsRead clears updated_asset_ids and sets is_read across releases', () => {
    useAppStore.getState().addReleases([
      makeRelease(1, { updated_asset_ids: [101, 202] }),
      makeRelease(2, { updated_asset_ids: [404] }),
    ]);

    useAppStore.getState().markAllReleasesAsRead();

    expect(useAppStore.getState().readReleases.has(1)).toBe(true);
    expect(useAppStore.getState().readReleases.has(2)).toBe(true);
    expect(useAppStore.getState().releases[0].updated_asset_ids).toEqual([]);
    expect(useAppStore.getState().releases[1].updated_asset_ids).toEqual([]);
    expect(useAppStore.getState().releases[0].is_read).toBe(true);
    expect(useAppStore.getState().releases[1].is_read).toBe(true);
  });

  it('markAllReleasesAsRead leaves releases without updated_asset_ids untouched', () => {
    useAppStore.getState().addReleases([makeRelease(1)]);
    useAppStore.getState().markAllReleasesAsRead();
    expect(useAppStore.getState().releases[0].updated_asset_ids).toBeUndefined();
    expect(useAppStore.getState().releases[0].is_read).toBe(true);
  });
});

describe('useAppStore vector search config normalization', () => {
  const embeddingConfig: EmbeddingConfig = {
    id: 'emb-1',
    name: 'Test Embedding',
    apiType: 'openai-compatible',
    baseUrl: 'https://example.com/v1',
    apiKey: 'test-key',
    model: 'test-model',
    dimensions: 1024,
    isActive: true,
  };

  it('preserves full vectorSearchConfig during persisted-state hydration', () => {
    const normalized = normalizePersistedState({
      embeddingConfigs: [embeddingConfig],
      activeEmbeddingConfig: embeddingConfig.id,
      vectorSearchConfig: {
        enabled: true,
        workerUrl: 'https://worker.example.com',
        authToken: 'worker-token',
        embeddingConfigId: embeddingConfig.id,
        indexMode: 'description',
        readmeMaxChars: 4096,
        searchThreshold: 0,
        searchTopK: 12,
        enableHyDE: false,
        enableReranking: false,
        embeddingFormatVersion: 2,
      },
    }, useAppStore.getState());

    expect(normalized.vectorSearchConfig).toEqual({
      enabled: true,
      workerUrl: 'https://worker.example.com',
      authToken: 'worker-token',
      embeddingConfigId: embeddingConfig.id,
      indexMode: 'description',
      readmeMaxChars: 4096,
      searchThreshold: 0,
      searchTopK: 12,
      enableHyDE: false,
      enableReranking: false,
      embeddingFormatVersion: 2,
    });
  });

  it('defaults missing vectorSearchConfig fields for old persisted state', () => {
    const normalized = normalizePersistedState({
      embeddingConfigs: [embeddingConfig],
      vectorSearchConfig: {
        enabled: true,
        workerUrl: 'https://worker.example.com',
        authToken: 'worker-token',
        embeddingConfigId: embeddingConfig.id,
        indexMode: 'readme',
        readmeMaxChars: 6000,
      },
    }, useAppStore.getState());

    expect(normalized.vectorSearchConfig).toMatchObject({
      enabled: true,
      workerUrl: 'https://worker.example.com',
      authToken: 'worker-token',
      embeddingConfigId: embeddingConfig.id,
      indexMode: 'readme',
      readmeMaxChars: 6000,
      searchThreshold: 0.35,
      searchTopK: 30,
      enableHyDE: true,
      enableReranking: true,
      embeddingFormatVersion: 1,
    });
  });

  it('uses the latest format version for a fresh/reset config so new users are not forced into a full reindex', () => {
    const normalized = normalizePersistedState(
      { embeddingConfigs: [embeddingConfig] },
      useAppStore.getState()
    );

    expect(normalized.vectorSearchConfig?.embeddingFormatVersion).toBe(EMBEDDING_FORMAT_VERSION);
  });

  const baseVectorSearchConfig: VectorSearchConfig = {
    enabled: true,
    workerUrl: 'https://worker.example.com',
    authToken: 'worker-token',
    embeddingConfigId: embeddingConfig.id,
    indexMode: 'readme',
    readmeMaxChars: 6000,
    searchThreshold: 0.35,
    searchTopK: 30,
    enableHyDE: true,
    enableReranking: true,
    embeddingFormatVersion: EMBEDDING_FORMAT_VERSION,
  };

  beforeEach(() => {
    useAppStore.setState({
      embeddingConfigs: [embeddingConfig],
      vectorSearchConfig: { ...baseVectorSearchConfig },
    });
  });

  it('does not downgrade embeddingFormatVersion from stale runtime config updates', () => {
    useAppStore.getState().setVectorSearchConfig({ embeddingFormatVersion: 1 });

    expect(useAppStore.getState().vectorSearchConfig.embeddingFormatVersion).toBe(EMBEDDING_FORMAT_VERSION);
  });

  it('merges ordinary stale backend fields while preserving current embeddingFormatVersion', () => {
    useAppStore.getState().setVectorSearchConfig({
      workerUrl: 'https://stale-backend.example.com',
      authToken: 'stale-token',
      embeddingFormatVersion: 1,
    });

    expect(useAppStore.getState().vectorSearchConfig).toMatchObject({
      workerUrl: 'https://stale-backend.example.com',
      authToken: 'stale-token',
      embeddingFormatVersion: EMBEDDING_FORMAT_VERSION,
    });
  });

  it('allows runtime upgrades from legacy to the latest embeddingFormatVersion', () => {
    useAppStore.setState({
      vectorSearchConfig: { ...baseVectorSearchConfig, embeddingFormatVersion: 1 },
    });

    useAppStore.getState().setVectorSearchConfig({ embeddingFormatVersion: EMBEDDING_FORMAT_VERSION });

    expect(useAppStore.getState().vectorSearchConfig.embeddingFormatVersion).toBe(EMBEDDING_FORMAT_VERSION);
  });

  it('ignores invalid runtime embeddingFormatVersion updates', () => {
    useAppStore.getState().setVectorSearchConfig({
      embeddingFormatVersion: EMBEDDING_FORMAT_VERSION + 1,
    });

    expect(useAppStore.getState().vectorSearchConfig.embeddingFormatVersion).toBe(EMBEDDING_FORMAT_VERSION);
  });

  it('keeps incremental indexing scoped to newly analyzed repos after a stale backend config sync', async () => {
    useAppStore.getState().setVectorSearchConfig({ embeddingFormatVersion: 1 });
    expect(useAppStore.getState().vectorSearchConfig.embeddingFormatVersion).toBe(EMBEDDING_FORMAT_VERSION);

    const indexedIds: number[] = [];
    const client = {
      embed: vi.fn(async (texts: string[]) => texts.map((_, i) => [i, i + 1, i + 2])),
    } as unknown as Parameters<typeof indexAllRepos>[1];
    const vectorService = {
      upsert: vi.fn(async (vectors: Array<{ id: string }>) => ({ upserted: vectors.length })),
    } as unknown as Parameters<typeof indexAllRepos>[2];

    const result = await indexAllRepos([
      createRepository(1, { analyzed_at: '2026-01-04T00:00:00.000Z', vector_indexed_at: '2026-01-05T00:00:00.000Z' }),
      createRepository(2, { analyzed_at: '2026-01-04T00:00:00.000Z', vector_indexed_at: '2026-01-05T00:00:00.000Z' }),
      createRepository(3, { analyzed_at: '2026-01-06T00:00:00.000Z', vector_indexed_at: undefined }),
      createRepository(4, { analyzed_at: undefined, vector_indexed_at: undefined }),
    ], client, vectorService, {
      incremental: true,
      formatVersion: useAppStore.getState().vectorSearchConfig.embeddingFormatVersion,
      currentFormatVersion: EMBEDDING_FORMAT_VERSION,
      indexMode: 'description',
      onRepoIndexed: (repoId) => indexedIds.push(repoId),
    });

    expect(indexedIds).toEqual([3]);
    expect(result.indexedRepoIds).toEqual([3]);
  });

  it('sanitizes corrupt persisted vector search status before hydration', () => {
    const normalized = normalizePersistedState({
      vectorSearchStatus: {
        connected: 'yes',
        vectorCount: -1,
        dimensions: Number.NaN,
        lastSyncAt: 123,
        error: { message: 'invalid' },
      } as unknown as VectorSearchStatus,
    }, useAppStore.getState());

    expect(normalized.vectorSearchStatus).toEqual({
      connected: false,
      vectorCount: 0,
      dimensions: 0,
    });
  });

  it('omits invalid persisted vector search status timestamps during hydration', () => {
    const normalized = normalizePersistedState({
      vectorSearchStatus: {
        connected: true,
        vectorCount: 42,
        dimensions: 1536,
        lastSyncAt: 'not-a-date',
      },
    }, useAppStore.getState());

    expect(normalized.vectorSearchStatus).toEqual({
      connected: true,
      vectorCount: 42,
      dimensions: 1536,
    });
  });

  it('preserves valid persisted vector search status during hydration', () => {
    const normalized = normalizePersistedState({
      vectorSearchStatus: {
        connected: true,
        vectorCount: 42,
        dimensions: 1536,
        lastSyncAt: '2026-08-15T00:00:00.000Z',
        error: 'stale error',
      },
    }, useAppStore.getState());

    expect(normalized.vectorSearchStatus).toEqual({
      connected: true,
      vectorCount: 42,
      dimensions: 1536,
      lastSyncAt: '2026-08-15T00:00:00.000Z',
      error: 'stale error',
    });
  });
});

describe('useAppStore repository performance guards', () => {
  beforeEach(() => {
    useAppStore.setState({
      repositories: [],
      searchResults: [],
      analyzingRepositoryIds: new Set(),
    });
  });

  it('does not notify subscribers when updateRepository receives an equivalent repository', () => {
    const repo = createRepository(1);
    useAppStore.setState({ repositories: [repo], searchResults: [repo] });

    const previousRepositories = useAppStore.getState().repositories;
    const previousSearchResults = useAppStore.getState().searchResults;
    let notifications = 0;
    const unsubscribe = useAppStore.subscribe(() => {
      notifications++;
    });

    useAppStore.getState().updateRepository({ ...repo });
    unsubscribe();

    expect(notifications).toBe(0);
    expect(useAppStore.getState().repositories).toBe(previousRepositories);
    expect(useAppStore.getState().searchResults).toBe(previousSearchResults);
  });

  it('updates only lists that contain the repository', () => {
    const repo = createRepository(1);
    useAppStore.setState({ repositories: [repo], searchResults: [] });

    const previousSearchResults = useAppStore.getState().searchResults;
    useAppStore.getState().updateRepository({ ...repo, ai_summary: 'Updated summary' });

    expect(useAppStore.getState().repositories[0].ai_summary).toBe('Updated summary');
    expect(useAppStore.getState().searchResults).toBe(previousSearchResults);
  });

  it('does not notify subscribers when analyzing state is unchanged', () => {
    useAppStore.setState({ analyzingRepositoryIds: new Set([1]) });

    const previousAnalyzingIds = useAppStore.getState().analyzingRepositoryIds;
    let notifications = 0;
    const unsubscribe = useAppStore.subscribe(() => {
      notifications++;
    });

    useAppStore.getState().setAnalyzingRepository(1, true);
    unsubscribe();

    expect(notifications).toBe(0);
    expect(useAppStore.getState().analyzingRepositoryIds).toBe(previousAnalyzingIds);
  });

  it('preserves an active search result set when setRepositories runs (Issue #304)', () => {
    const first = createRepository(1);
    const second = createRepository(2);
    useAppStore.setState({
      repositories: [first, second],
      searchResults: [second],
      searchFilters: { ...useAppStore.getState().searchFilters, query: 'repo-2' },
    });
    const previousSearchResults = useAppStore.getState().searchResults;

    const refreshed = [createRepository(1), createRepository(2), createRepository(3)];
    useAppStore.getState().setRepositories(refreshed);

    // The stale searchResults reference is kept so the filtered card (and its
    // open edit modal) stays mounted; SearchBar recomputes results afterwards.
    expect(useAppStore.getState().searchResults).toBe(previousSearchResults);
    expect(useAppStore.getState().repositories).toBe(refreshed);
  });

  it('preserves an active search result set when only a license filter is active', () => {
    const first = createRepository(1);
    const second = createRepository(2);
    useAppStore.setState({
      repositories: [first, second],
      searchResults: [second],
      searchFilters: { ...useAppStore.getState().searchFilters, licenses: ['MIT'] },
    });
    const previousSearchResults = useAppStore.getState().searchResults;

    const refreshed = [createRepository(1), createRepository(2), createRepository(3)];
    useAppStore.getState().setRepositories(refreshed);

    expect(useAppStore.getState().searchResults).toBe(previousSearchResults);
  });

  it('resets searchResults to the full list when no search filter is active', () => {
    // Reset searchFilters to defaults before the test; the license-only test above
    // may have left licenses set, which would keep hasActiveSearchFilters true.
    useAppStore.setState({ searchFilters: { ...useAppStore.getState().searchFilters, licenses: [] } });
    const repo = createRepository(1);
    useAppStore.setState({
      repositories: [repo],
      searchResults: [repo],
      searchFilters: { ...useAppStore.getState().searchFilters, query: '' },
    });

    const refreshed = [repo, createRepository(2)];
    useAppStore.getState().setRepositories(refreshed);

    expect(useAppStore.getState().searchResults).toBe(refreshed);
  });

  it('keeps the real GitHub id when adding a new repository so later syncs match', () => {
    // 回归：批量从链接 Star 的仓库自带 GitHub id。若换成合成 id，后续「同步」
    // 按 GitHub id 匹配不到本地记录，会用裸 GitHub 数据覆盖掉 AI 分析与分类标签。
    useAppStore.setState({ repositories: [createRepository(1)], searchResults: [] });
    const batchStarred = createRepository(765_432_1, { full_name: 'owner/from-links' });

    useAppStore.getState().addRepository(batchStarred);

    const added = useAppStore.getState().repositories.find(r => r.full_name === 'owner/from-links');
    expect(added?.id).toBe(765_432_1);
  });

  it('updates a renamed repository by its real GitHub id instead of adding a duplicate', () => {
    // 回归（CodeRabbit r4145581832）：id 是权威身份，改名只换 full_name。
    // 同一 id 却不同名时必须就地更新，否则同一仓库会出现两条记录。
    const existing = createRepository(1, {
      full_name: 'owner/old',
      ai_summary: '旧仓库分析',
      custom_category: '工具',
      category_locked: true,
    });
    useAppStore.setState({ repositories: [existing], searchResults: [] });

    useAppStore.getState().addRepository(createRepository(1, {
      full_name: 'owner/new',
      description: '改名后的描述',
    }));

    const repositories = useAppStore.getState().repositories;
    expect(repositories).toHaveLength(1);
    expect(repositories[0]).toMatchObject({
      id: 1,
      full_name: 'owner/new',
      description: '改名后的描述',
      // 本地 AI 分析与自定义字段保留
      ai_summary: '旧仓库分析',
      custom_category: '工具',
      category_locked: true,
    });
  });

  it('keeps AI analysis and custom category when re-adding an existing repository', () => {
    // 入参来自 GitHub 详情 / 发现页数据，不带 AI 字段，直接展开会清空已有分析结果。
    // 合成 id 的历史记录（批量 Star 遗留）缺失权威身份，应继续被认领。
    const analyzed = createRepository(1_700_000_000_005, {
      ai_summary: 'AI 摘要',
      ai_tags: ['ai-tag'],
      ai_platforms: ['cli'],
      analyzed_at: '2026-02-01T00:00:00.000Z',
      custom_category: '工具',
      category_locked: true,
    });
    useAppStore.setState({ repositories: [analyzed], searchResults: [] });

    // 同一 full_name，但 id 不同、且不带任何 AI 字段
    useAppStore.getState().addRepository(createRepository(999, {
      full_name: analyzed.full_name,
      description: '来自 GitHub 的新描述',
    }));

    expect(useAppStore.getState().repositories).toHaveLength(1);
    expect(useAppStore.getState().repositories[0]).toMatchObject({
      id: analyzed.id,
      description: '来自 GitHub 的新描述',
      ai_summary: 'AI 摘要',
      ai_tags: ['ai-tag'],
      ai_platforms: ['cli'],
      analyzed_at: '2026-02-01T00:00:00.000Z',
      custom_category: '工具',
      category_locked: true,
    });
  });

  it('keeps AI analysis when re-adding with the same GitHub id', () => {
    // 同一 GitHub 身份（id 相同）⇒ 无论是否合成 id，都应保留 AI 分析
    const analyzed = createRepository(555, { ai_summary: 'AI 摘要', ai_tags: ['ai-tag'] });
    useAppStore.setState({ repositories: [analyzed], searchResults: [] });

    useAppStore.getState().addRepository(createRepository(555, {
      full_name: analyzed.full_name,
      description: '来自 GitHub 的新描述',
    }));

    expect(useAppStore.getState().repositories[0]).toMatchObject({
      id: 555,
      description: '来自 GitHub 的新描述',
      ai_summary: 'AI 摘要',
      ai_tags: ['ai-tag'],
    });
  });

  it('adds a name-reusing repo as a separate record instead of overwriting the old id', () => {
    // 回归（CodeRabbit r4145277692）：本地记录带**真实 GitHub id**（id:5），
    // 原仓库已改名/删除，入参是复用旧名的新仓库（id:999）。
    // 绝不能把新仓库写到旧仓库的 id 下 —— 否则用户对新仓库做完 AI 分析后，
    // 下次同步按 GitHub id 匹配不到本地记录（名称兜底只认领合成 id 记录），
    // 分析结果会再次丢失，即本 PR 要修的原始问题。
    const old = createRepository(5, {
      ai_summary: '旧仓库分析',
      custom_category: '内部工具',
      category_locked: true,
    });
    useAppStore.setState({ repositories: [old], searchResults: [] });

    useAppStore.getState().addRepository(createRepository(999, {
      full_name: old.full_name,
      description: '一个完全不同的新项目',
    }));

    const repositories = useAppStore.getState().repositories;
    // 旧记录原样保留，新仓库作为独立记录加入
    expect(repositories).toHaveLength(2);
    expect(repositories[0]).toMatchObject({
      id: 5,
      ai_summary: '旧仓库分析',
      custom_category: '内部工具',
      category_locked: true,
    });
    const added = repositories.find(r => r.id === 999);
    expect(added).toBeDefined();
    expect(added).toMatchObject({
      id: 999,
      full_name: old.full_name,
      description: '一个完全不同的新项目',
    });
    // 新仓库不得继承旧仓库的 AI 分析
    expect(added?.ai_summary).toBeUndefined();
    expect(added?.custom_category).toBeUndefined();
  });

  it('updates the identity-matching record instead of appending a duplicate', () => {
    // 回归（CodeRabbit 5367214192）：列表里已存在「旧真实 id + 新真实 id」的同名
    // 记录时，再次添加新仓库必须更新 id 999 那条，而不是追加重复记录。
    const old = createRepository(5, { full_name: 'owner/old' });
    const current = createRepository(999, {
      full_name: 'owner/old',
      description: '旧描述',
      ai_summary: '新仓库的分析结果',
      ai_tags: ['新标签'],
    });
    useAppStore.setState({ repositories: [old, current], searchResults: [] });

    useAppStore.getState().addRepository(createRepository(999, {
      full_name: 'owner/old',
      description: '刷新后的描述',
    }));

    const repositories = useAppStore.getState().repositories;
    // 不得出现重复 id
    expect(repositories.map(r => r.id)).toEqual([5, 999]);
    // id 999 的记录被就地更新，且保留其 AI 分析
    const updated = repositories.find(r => r.id === 999)!;
    expect(updated.description).toBe('刷新后的描述');
    expect(updated.ai_summary).toBe('新仓库的分析结果');
    expect(updated.ai_tags).toEqual(['新标签']);
  });

  it('prefers the legacy synthetic record when no exact identity match exists', () => {
    // 同名 + 合成 id 的历史记录仍应被认领并就地更新（正向场景不被误伤）
    const legacy = createRepository(1_700_000_000_123, {
      full_name: 'owner/legacy',
      ai_summary: 'AI 摘要',
    });
    useAppStore.setState({ repositories: [legacy], searchResults: [] });

    useAppStore.getState().addRepository(createRepository(42, {
      full_name: 'owner/legacy',
      description: '来自 GitHub 的描述',
    }));

    const repositories = useAppStore.getState().repositories;
    expect(repositories).toHaveLength(1);
    expect(repositories[0]).toMatchObject({
      id: 1_700_000_000_123,
      description: '来自 GitHub 的描述',
      ai_summary: 'AI 摘要',
    });
  });

  it('keeps the new repo id after AI analysis so the next sync can still match it', () => {
    // 完整链路：复用旧名 → 独立记录 → AI 分析 → 同步仍能按 GitHub id 命中
    const old = createRepository(5, { full_name: 'owner/old' });
    useAppStore.setState({ repositories: [old], searchResults: [] });

    useAppStore.getState().addRepository(createRepository(999, {
      full_name: 'owner/old',
      description: '新项目',
    }));

    // 用户对新仓库做 AI 分析
    const analyzed = useAppStore.getState().repositories.find(r => r.id === 999)!;
    useAppStore.getState().updateRepository({
      ...analyzed,
      ai_summary: '新仓库的分析结果',
      ai_tags: ['新标签'],
    });

    // 同步时 GitHub 返回真实 id 999 ⇒ 必须按 id 命中，分析结果得以保留
    const storeRepos = useAppStore.getState().repositories;
    const matched = storeRepos.find(r => r.id === 999);
    expect(matched?.ai_summary).toBe('新仓库的分析结果');
    expect(matched?.ai_tags).toEqual(['新标签']);
    // 旧仓库的记录未被污染
    expect(storeRepos.find(r => r.id === 5)?.ai_summary).toBeUndefined();
  });

  it('preserves an active search result set when addRepository runs (Issue #304)', () => {
    const existing = createRepository(2);
    useAppStore.setState({
      repositories: [existing],
      searchResults: [existing],
      searchFilters: { ...useAppStore.getState().searchFilters, query: 'repo-2' },
    });
    const previousSearchResults = useAppStore.getState().searchResults;

    useAppStore.getState().addRepository(createRepository(3));

    // Same guard as setRepositories: swapping the full list into searchResults
    // while filters are active would unmount the filtered card being edited.
    expect(useAppStore.getState().searchResults).toBe(previousSearchResults);
    expect(useAppStore.getState().repositories).toHaveLength(2);

    // Without active filters, the full list is published to searchResults.
    useAppStore.setState({ searchFilters: { ...useAppStore.getState().searchFilters, query: '' } });
    useAppStore.getState().addRepository(createRepository(4));

    expect(useAppStore.getState().searchResults).toBe(useAppStore.getState().repositories);
  });
});

describe('useAppStore holds no browser-side credential', () => {
  const LEGACY_AUTH_KEY = 'github-stars-manager-auth';
  const LEGACY_SECRET_KEY = 'github-stars-manager-backend-secret';
  const user = { id: 1, login: 'test-user', name: 'Test', avatar_url: 'https://x/a.png', email: null };

  beforeEach(() => {
    window.localStorage.removeItem(LEGACY_AUTH_KEY);
    window.sessionStorage.removeItem(LEGACY_SECRET_KEY);
  });

  it('never writes the token or user to localStorage or sessionStorage on login', () => {
    useAppStore.getState().setGitHubToken('server');
    useAppStore.getState().setUser(user);
    expect(window.localStorage.getItem(LEGACY_AUTH_KEY)).toBeNull();
    expect(window.sessionStorage.getItem(LEGACY_SECRET_KEY)).toBeNull();
  });

  it('does not persist githubToken or any API secret', () => {
    useAppStore.getState().setGitHubToken('server');
    const persisted = persistenceOptions().partialize({ ...useAppStore.getState() }) as Record<string, unknown>;
    for (const key of ['githubToken', 'backendApiSecret', 'proxyConfig', 'rpcDownloadConfig', 'routeMode', 'pluginCustomIcons']) {
      expect(persisted).not.toHaveProperty(key);
    }
    expect(JSON.stringify(persisted)).not.toContain('server"');
  });

  it('erases credentials left in browser storage by older builds on hydration', () => {
    window.localStorage.setItem(LEGACY_AUTH_KEY, JSON.stringify({ user, githubToken: 'ghp_old', backendApiSecret: 'old-secret' }));
    window.sessionStorage.setItem(LEGACY_SECRET_KEY, 'old-secret');
    normalizePersistedState({}, useAppStore.getState());
    expect(window.localStorage.getItem(LEGACY_AUTH_KEY)).toBeNull();
    expect(window.sessionStorage.getItem(LEGACY_SECRET_KEY)).toBeNull();
  });

  it('githubToken is only ever the server placeholder, whatever an old snapshot holds', () => {
    const normalized = normalizePersistedState(
      { user, githubToken: 'ghp_persisted', backendApiSecret: 'old-secret' } as never,
      useAppStore.getState(),
    );
    expect(normalized.githubToken).toBe('server');
    expect(normalized).not.toHaveProperty('backendApiSecret');
    const signedOut = normalizePersistedState({ githubToken: 'ghp_persisted' } as never, useAppStore.getState());
    expect(signedOut.githubToken).toBeNull();
  });

  it('migration drops credentials and egress prefs from old snapshots', async () => {
    const migrated = await persistenceOptions().migrate!(
      { user, githubToken: 'ghp_old', backendApiSecret: 'old-secret', proxyConfig: { password: 'p' }, routeMode: 'browser' } as never,
      16,
    ) as Record<string, unknown>;
    for (const key of ['githubToken', 'backendApiSecret', 'proxyConfig', 'routeMode']) {
      expect(migrated).not.toHaveProperty(key);
    }
  });

  it('logout clears the in-memory token and any legacy storage', () => {
    window.localStorage.setItem(LEGACY_AUTH_KEY, '{}');
    useAppStore.getState().setGitHubToken('server');
    useAppStore.getState().logout();
    expect(useAppStore.getState().githubToken).toBeNull();
    expect(window.localStorage.getItem(LEGACY_AUTH_KEY)).toBeNull();
  });
});

describe('useAppStore logout and per-account workspaces', () => {
  const userA = { id: 1, login: 'alice', name: 'Alice', avatar_url: 'https://x/a.png', email: null };
  const userB = { id: 2, login: 'bob', name: 'Bob', avatar_url: 'https://x/b.png', email: null };

  beforeEach(() => {
    window.localStorage?.removeItem?.('github-stars-manager-auth');
    useAppStore.setState({
      user: null,
      githubToken: null,
      isAuthenticated: false,
      accountWorkspaces: {},
      repositories: [],
      searchResults: [],
      lastSync: null,
      customCategories: [],
    });
  });

  it('keeps repositories after logout so the same GitHub account can sign back in', () => {
    const repositories = [createRepository(1, { ai_summary: 'keep-me' })];
    useAppStore.setState({
      user: userA,
      githubToken: 'ghp_old',
      isAuthenticated: true,
      repositories,
      searchResults: repositories,
      lastSync: '2026-09-16T00:00:00.000Z',
    });

    useAppStore.getState().logout();

    const state = useAppStore.getState();
    expect(state.user).toBeNull();
    expect(state.githubToken).toBeNull();
    expect(state.isAuthenticated).toBe(false);
    expect(state.repositories).toEqual([]);
    expect(state.accountWorkspaces['1']?.repositories[0].ai_summary).toBe('keep-me');

    useAppStore.getState().setGitHubToken('ghp_new');
    useAppStore.getState().setUser(userA);

    expect(useAppStore.getState().repositories[0].ai_summary).toBe('keep-me');
    expect(useAppStore.getState().isAuthenticated).toBe(true);
  });

  it('restores each GitHub account workspace when switching users', () => {
    const aliceRepos = [createRepository(1, { ai_summary: 'alice-ai' })];
    const bobRepos = [createRepository(2, { ai_summary: 'bob-ai' })];
    useAppStore.setState({
      user: userA,
      githubToken: 'ghp_a',
      isAuthenticated: true,
      repositories: aliceRepos,
      searchResults: aliceRepos,
      lastSync: '2026-09-16T00:00:00.000Z',
    });

    useAppStore.getState().logout();
    useAppStore.getState().setGitHubToken('ghp_b');
    useAppStore.getState().setUser(userB);
    expect(useAppStore.getState().repositories).toEqual([]);

    useAppStore.setState({
      repositories: bobRepos,
      searchResults: bobRepos,
      lastSync: '2026-09-17T00:00:00.000Z',
    });
    useAppStore.getState().logout();
    useAppStore.getState().setGitHubToken('ghp_a2');
    useAppStore.getState().setUser(userA);

    expect(useAppStore.getState().repositories[0].ai_summary).toBe('alice-ai');
    expect(useAppStore.getState().user?.login).toBe('alice');
  });

  it('does not wipe live repositories when signing in after a backend restore', () => {
    const restored = [createRepository(9, { ai_summary: 'from-backend' })];
    useAppStore.setState({
      repositories: restored,
      searchResults: restored,
      lastSync: '2026-09-17T00:00:00.000Z',
    });

    useAppStore.getState().setGitHubToken('ghp_restored');
    useAppStore.getState().setUser(userA);

    expect(useAppStore.getState().repositories[0].ai_summary).toBe('from-backend');
  });

  it('refuses accidental empty repository overwrites unless allowEmpty is set', () => {
    const repositories = [createRepository(1, { ai_summary: 'keep-me' })];
    useAppStore.setState({ repositories, searchResults: repositories });

    useAppStore.getState().setRepositories([]);
    expect(useAppStore.getState().repositories).toEqual(repositories);

    useAppStore.getState().setRepositories([], { allowEmpty: true });
    expect(useAppStore.getState().repositories).toEqual([]);
  });
});

describe('useAppStore repository view mode', () => {
  beforeEach(() => {
    useAppStore.setState({ repositoryViewMode: 'grid' });
  });

  it('keeps grid as the backwards-compatible default for persisted states without a view preference', () => {
    const normalized = normalizePersistedState({}, useAppStore.getState());

    expect(normalized.repositoryViewMode).toBe('grid');
  });

  it('restores the persisted list preference', () => {
    const normalized = normalizePersistedState({ repositoryViewMode: 'list' }, useAppStore.getState());

    expect(normalized.repositoryViewMode).toBe('list');
  });

  it('updates the repository view preference without changing repository records', () => {
    const repositories = [createRepository(1)];
    useAppStore.setState({ repositories, repositoryViewMode: 'grid' });

    useAppStore.getState().setRepositoryViewMode('list');

    expect(useAppStore.getState().repositoryViewMode).toBe('list');
    expect(useAppStore.getState().repositories).toBe(repositories);
  });
});

describe('useAppStore theme preset', () => {
  it('defaults the theme mode and presets for legacy persisted state', () => {
    const normalized = normalizePersistedState({}, useAppStore.getState());

    expect(normalized.themeMode).toBe('dark');
    expect(normalized.themePresetLight).toBe('default');
    expect(normalized.themePresetDark).toBe('default');
  });

  it('falls back to the default presets for unknown persisted values', () => {
    const normalized = normalizePersistedState(
      { themePresetLight: 'does-not-exist' as never, themePresetDark: 'does-not-exist' as never },
      useAppStore.getState(),
    );

    expect(normalized.themePresetLight).toBe('default');
    expect(normalized.themePresetDark).toBe('default');
  });

  it('migrates legacy theme/themePreset into the new mode-aware fields', () => {
    const normalized = normalizePersistedState(
      { theme: 'light', themePreset: 'deep-purple' } as never,
      useAppStore.getState(),
    );
    expect(normalized.themeMode).toBe('light');
    expect(normalized.themePresetLight).toBe('deep-purple');
    expect(normalized.themePresetDark).toBe('deep-purple');
  });

  it('keeps light and dark presets independent at runtime', () => {
    useAppStore.setState({ themePresetLight: 'default', themePresetDark: 'default' });
    useAppStore.getState().setThemePresetLight('deep-purple');
    useAppStore.getState().setThemePresetDark('zen-inspired');
    expect(useAppStore.getState().themePresetLight).toBe('deep-purple');
    expect(useAppStore.getState().themePresetDark).toBe('zen-inspired');
  });
});

type PersistenceOptions = {
  partialize: (state: typeof useAppStore extends never ? never : ReturnType<typeof useAppStore.getState>) => PersistedSnapshot;
  migrate: (snapshot: PersistedSnapshot, version: number) => PersistedSnapshot | Promise<PersistedSnapshot>;
  merge: (
    snapshot: PersistedSnapshot,
    currentState: ReturnType<typeof useAppStore.getState>,
  ) => ReturnType<typeof useAppStore.getState>;
};

const persistenceOptions = (): PersistenceOptions => (
  useAppStore.persist.getOptions() as unknown as PersistenceOptions
);

const migrateSnapshot = async (snapshot: PersistedSnapshot): Promise<PersistedSnapshot> => (
  await persistenceOptions().migrate(snapshot, 0)
);

const partializeState = (overrides: Partial<ReturnType<typeof useAppStore.getState>> = {}): PersistedSnapshot => (
  persistenceOptions().partialize({ ...useAppStore.getState(), ...overrides })
);

describe('useAppStore persisted-state historical fixtures', () => {
  beforeEach(() => {
    window.localStorage.removeItem('github-stars-manager-auth');
    window.sessionStorage.removeItem('github-stars-manager-backend-secret');
  });

  it('migrates the historical __EMPTY__ description marker to an explicit empty description', async () => {
    const migrated = await migrateSnapshot(buildPersistedSnapshot({
      repositories: [createRepository(1, { custom_description: '__EMPTY__' })],
    }));

    expect((migrated.repositories as Repository[])[0].custom_description).toBe('');
  });

  it('backfills release-sync metadata from the latest persisted release for legacy repositories', () => {
    const normalized = normalizePersistedState(buildPersistedSnapshot({
      repositories: [createRepository(1)],
      releases: [
        makeRelease(11, { repository: { id: 1, full_name: 'owner/repo-1', name: 'repo-1' }, published_at: '2026-01-03T00:00:00.000Z' }),
        makeRelease(12, { repository: { id: 1, full_name: 'owner/repo-1', name: 'repo-1' }, published_at: '2026-02-04T00:00:00.000Z' }),
      ],
    }), useAppStore.getInitialState());

    expect(normalized.repositories?.[0]).toMatchObject({
      has_fetched_releases: true,
      last_release_fetch_time: '2026-02-04T00:00:00.000Z',
    });
  });

  it('keeps persisted heavy-field array references when no release backfill is needed', () => {
    // 分片持久化按引用判脏：hydration 规整化不得在无回填需求时重建重数据数组，
    // 否则每次启动后都会触发一次全量重写。
    const repositories = [createRepository(1, { has_fetched_releases: true }), createRepository(2)];
    const releases = [
      makeRelease(11, { repository: { id: 1, full_name: 'owner/repo-1', name: 'repo-1' } }),
    ];
    const normalized = normalizePersistedState(
      buildPersistedSnapshot({ repositories, releases }),
      useAppStore.getInitialState(),
    );

    expect(normalized.repositories).toBe(repositories);
    expect(normalized.releases).toBe(releases);

    // 存在需要回填的仓库时，回填行为保持不变
    const needsBackfill = normalizePersistedState(
      buildPersistedSnapshot({ repositories: [createRepository(1)], releases }),
      useAppStore.getInitialState(),
    );
    expect(needsBackfill.repositories?.[0]).toMatchObject({
      has_fetched_releases: true,
      last_release_fetch_time: '2026-01-01T00:00:00.000Z',
    });
  });

  it('preserves a historical MCP token while filling host and port defaults during migration and hydration', async () => {
    const migrated = await migrateSnapshot(buildPersistedSnapshot({
      mcpConfig: { enabled: true, token: 'mcp-historical-token' },
    }));
    const normalized = normalizePersistedState(migrated, useAppStore.getInitialState());

    expect(normalized.mcpConfig).toEqual({
      ...useAppStore.getInitialState().mcpConfig,
      enabled: true,
      token: 'mcp-historical-token',
    });
  });

  it('maps legacy daily-dev channels into the most-dev schema and drops the removed trending channel', async () => {
    const migrated = await migrateSnapshot(buildPersistedSnapshot({
      subscriptionChannels: [{ id: 'daily-dev', name: 'Daily developers', enabled: false }],
    }));
    const channels = migrated.subscriptionChannels as Array<Record<string, unknown>>;

    expect(channels).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'most-dev', nameEn: 'Top Developers', enabled: false }),
    ]));
    expect(channels.some(channel => channel.id === 'trending')).toBe(false);
  });

  it('fills the header menu contract for snapshots written before the header configuration existed', async () => {
    const migrated = await migrateSnapshot(buildPersistedSnapshot());

    expect(migrated.headerMenuConfig).toEqual(useAppStore.getInitialState().headerMenuConfig);
  });

  it('migrates a historical snapshot idempotently across repeated startups', async () => {
    const fixture = buildPersistedSnapshot({
      repositories: [createRepository(1, { custom_description: '__EMPTY__' })],
      subscriptionChannels: [{ id: 'daily-dev', name: 'Daily developers', enabled: true }],
    });

    const once = await migrateSnapshot(fixture);
    const twice = await migrateSnapshot(once);

    expect(twice).toEqual(once);
  });

  it('does not revive analyzing or discovery loading state from historical snapshots', () => {
    const snapshot = buildPersistedSnapshot({
      ...buildTransientDiscoverySnapshot(),
      analyzingRepositoryIds: [1],
    });
    const normalized = normalizePersistedState(snapshot, useAppStore.getInitialState());

    expect(normalized.analyzingRepositoryIds).toEqual(new Set());
    expect(normalized).toMatchObject(buildExpectedResetDiscoveryState());
  });

  it('serializes number Sets as arrays and reconstructs Sets during hydration', () => {
    const serialized = partializeState({
      releaseSubscriptions: new Set([1, 2]),
      readReleases: new Set([3]),
      releaseExpandedRepositories: new Set([5]),
    });
    const normalized = normalizePersistedState(serialized, useAppStore.getInitialState());

    expect(serialized).toMatchObject({
      releaseSubscriptions: [1, 2],
      readReleases: [3],
      releaseExpandedRepositories: [5],
    });
    expect(normalized.releaseSubscriptions).toEqual(new Set([1, 2]));
    expect(normalized.readReleases).toEqual(new Set([3]));
    expect(normalized.releaseExpandedRepositories).toEqual(new Set([5]));
  });
});

describe('useAppStore persistence contracts', () => {
  it('does not serialize discovery runtime repositories', () => {
    const persisted = partializeState({
      discoveryRepos: buildTransientDiscoverySnapshot().discoveryRepos as ReturnType<typeof useAppStore.getState>['discoveryRepos'],
    });
    expect(persisted).not.toHaveProperty('discoveryRepos');
  });
});
