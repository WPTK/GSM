import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  buildPersistedSnapshot,
  buildTransientDiscoverySnapshot,
  type PersistedSnapshot,
} from './__fixtures__/persistedSnapshots';
import { useBulkRepositoryActions } from '../features/repositories/hooks/useBulkRepositoryActions';
import { useRepositoryAnalysisJob } from '../features/repositories/hooks/useRepositoryAnalysisJob';
import { useRepositoryCardActions } from '../features/repositories/hooks/useRepositoryCardActions';
import { useAIConfigActions } from '../features/settings/hooks/useAIConfigActions';
import { useBackendSettingsActions } from '../features/settings/hooks/useBackendSettingsActions';
import { useDiagnosticBackendActions } from '../features/settings/hooks/useDiagnosticBackendActions';
import { useMcpActions } from '../features/settings/hooks/useMcpActions';
import { useNetworkActions } from '../features/settings/hooks/useNetworkActions';
import { useVectorSearchActions } from '../features/settings/hooks/useVectorSearchActions';

type ActualStoreModule = typeof import('./useAppStore');
type AppStore = ActualStoreModule['useAppStore'];

let actualStore: ActualStoreModule;

beforeAll(async () => {
  actualStore = await vi.importActual<ActualStoreModule>('./useAppStore');
});

type PersistenceOptions = {
  version: number;
  partialize: (state: ReturnType<AppStore['getState']>) => PersistedSnapshot;
  migrate: (snapshot: PersistedSnapshot, version: number) => PersistedSnapshot | Promise<PersistedSnapshot>;
  merge: (
    snapshot: PersistedSnapshot,
    currentState: ReturnType<AppStore['getState']>,
  ) => ReturnType<AppStore['getState']>;
};

const persistenceOptions = (): PersistenceOptions => (
  actualStore.useAppStore.persist.getOptions() as unknown as PersistenceOptions
);

const partialize = (overrides: Partial<ReturnType<AppStore['getState']>> = {}): PersistedSnapshot => (
  persistenceOptions().partialize({ ...actualStore.useAppStore.getState(), ...overrides })
);

const currentPersistedKeys = [
  'user',
  'githubToken',
  'isAuthenticated',
  'accountWorkspaces',
  'repositories',
  'lastSync',
  'themeTokens',
  'aiConfigs',
  'activeAIConfig',
  'repositoryChatSettings',
  'embeddingConfigs',
  'activeEmbeddingConfig',
  'vectorSearchConfig',
  'vectorSearchStatus',
  'mcpConfig',
  'releaseSubscriptions',
  'releaseSourceSettings',
  'readReleases',
  'releases',
  'customCategories',
  'hiddenDefaultCategoryIds',
  'categoryOrder',
  'collapsedSidebarCategoryCount',
  'categoryMatchMode',
  'defaultCategoryOverrides',
  'assetFilters',
  'repositoryCardFields',
  'repositoryCardActions',
  'pluginCustomIcons',
  'themeMode',
  'themePresetLight',
  'themePresetDark',
  'currentView',
  'selectedCategory',
  'language',
  'translationEngine',
  'autoTranslateRepoDescription',
  'isSidebarCollapsed',
  'headerMenuConfig',
  'backendApiSecret',
  'searchFilters',
  'repositoryViewMode',
  'releaseViewMode',
  'releaseShowMode',
  'releaseLatestMode',
  'releaseSelectedFilters',
  'releaseSearchQuery',
  'releaseExpandedRepositories',
  'includePreRelease',
  'includeKeysInBackup',
  'discoveryChannels',
  'selectedDiscoveryChannel',
  'discoveryPlatform',
  'discoveryLanguage',
  'discoverySortBy',
  'discoverySortOrder',
  'discoverySearchMode',
  'discoverySelectedTopic',
  'weeklyOnlyCollected',
  'proxyConfig',
  'rpcDownloadConfig',
  'routeMode',
] as const;

const historicalSnapshots = (): PersistedSnapshot[] => [
  buildPersistedSnapshot(),
  buildPersistedSnapshot({
    repositories: [{
      id: 7,
      name: 'historical',
      full_name: 'owner/historical',
      description: 'legacy description',
      html_url: 'https://github.com/owner/historical',
      stargazers_count: 1,
      forks_count: 0,
      forks: 0,
      language: 'TypeScript',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      pushed_at: '2026-01-01T00:00:00.000Z',
      owner: { login: 'owner', avatar_url: '' },
      topics: [],
      custom_description: '__EMPTY__',
    }],
    subscriptionChannels: [{ id: 'daily-dev', name: 'Daily developers', enabled: true }],
  }),
  buildPersistedSnapshot({
    ...buildTransientDiscoverySnapshot(),
    mcpConfig: { enabled: true, token: 'historical-token' },
    vectorSearchConfig: {
      enabled: true,
      workerUrl: 'https://vector.example.com',
      authToken: 'vector-token',
      embeddingConfigId: 'missing-config',
      indexMode: 'readme',
      readmeMaxChars: 6000,
      searchThreshold: 0.35,
      searchTopK: 30,
      enableHyDE: true,
      enableReranking: true,
      embeddingFormatVersion: 1,
    },
  }),
];

describe('PR-07 Store modularization compatibility', () => {
  it('keeps exactly one persistence shell and the current persisted key set', () => {
    const options = persistenceOptions();
    const persisted = partialize({
      proxyConfig: { enabled: true, type: 'http', host: 'proxy.example.com', port: 7890, password: 'proxy-password' },
      rpcDownloadConfig: { enabled: true, host: 'rpc.example.com', port: 6800, secret: 'rpc-secret' },
    });

    expect(options.version).toBe(16);
    expect(Object.keys(persisted)).toEqual(currentPersistedKeys);
    expect(persisted.proxyConfig).toMatchObject({ password: 'proxy-password' });
    expect(persisted.rpcDownloadConfig).toMatchObject({ secret: 'rpc-secret' });

    for (const transientKey of [
      'discoveryRepos',
      'discoveryLastRefresh',
      'discoveryTotalCount',
      'discoveryHasMore',
      'discoveryNextPage',
      'discoveryIsLoading',
      'discoveryScrollPositions',
      'subscriptionChannels',
      'subscriptionRepos',
      'subscriptionLastRefresh',
      'subscriptionIsLoading',
    ]) {
      expect(persisted).not.toHaveProperty(transientKey);
    }
  });

  it('keeps migration presence checks idempotent and hydration-equivalent across historical fixtures', async () => {
    const options = persistenceOptions();

    for (const fixture of historicalSnapshots()) {
      const once = await options.migrate(structuredClone(fixture), 0);
      const twice = await options.migrate(structuredClone(once), 999);

      expect(twice).toEqual(once);
      expect(options.merge(once, actualStore.useAppStore.getInitialState())).toEqual(
        options.merge(twice, actualStore.useAppStore.getInitialState()),
      );
    }
  });

  it('normalizes theme tokens at the hydration boundary without a persistence version bump', () => {
    const merged = persistenceOptions().merge(
      buildPersistedSnapshot({ themeTokens: { accentColor: 'javascript:bad', fontScale: 9 } as never }),
      actualStore.useAppStore.getInitialState(),
    );

    expect(merged.themeTokens).toEqual({
      accentColor: null,
      fontScale: 1.5,
      radius: 'default',
      animation: 'normal',
    });
  });

  it('maps stale removed discovery channels and preset ids to defaults at hydration', () => {
    const store = actualStore.useAppStore;
    const staleChannels = [
      { id: 'trending', enabled: true },
      { id: 'x-tweet', enabled: true },
      { id: 'telegram', enabled: true },
      { id: 'external:example', enabled: true, sourceUrl: 'https://example.com/feed.json' },
      { id: 'hot-release', enabled: false },
    ];
    for (const stale of ['trending', 'x-tweet', 'telegram', 'external:example']) {
      const hydrated = actualStore.normalizePersistedState({
        discoveryChannels: staleChannels,
        selectedDiscoveryChannel: stale,
        themePresetLight: 'autoblog',
        themePresetDark: 'claude',
      } as never, store.getState());
      const ids = hydrated.discoveryChannels?.map(channel => channel.id) ?? [];
      expect(ids).toEqual(['hot-release', 'most-popular', 'topic', 'weekly', 'search', 'code-search']);
      expect(hydrated.selectedDiscoveryChannel).toBe('most-popular');
      expect(hydrated.themePresetLight).toBe('default');
      expect(hydrated.themePresetDark).toBe('default');
    }
  });

  it('drops removed-feature keys and falls back from removed views at hydration', () => {
    const hydrated = actualStore.normalizePersistedState({
      currentView: 'gists',
      gists: [{ id: 'g' }],
      forks: [{ id: 1 }],
      webdavConfigs: [{ id: 'w' }],
      xTweetAuth: { authToken: 'a', ct0: 'b' },
      trendingSnapshots: [{ period: 'daily' }],
    } as never, actualStore.useAppStore.getInitialState()) as unknown as Record<string, unknown>;

    expect(hydrated.currentView).toBe('repositories');
    for (const key of ['gists', 'forks', 'webdavConfigs', 'xTweetAuth', 'trendingSnapshots']) {
      expect(hydrated).not.toHaveProperty(key);
    }
  });

  it('retains the historical normalize-only resets and release backfill behavior', () => {
    const snapshot = buildPersistedSnapshot({
      ...buildTransientDiscoverySnapshot(),
      repositories: [{
        id: 11,
        name: 'release-repository',
        full_name: 'owner/release-repository',
        description: '',
        html_url: 'https://github.com/owner/release-repository',
        stargazers_count: 1,
        forks_count: 0,
        forks: 0,
        language: 'TypeScript',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
        pushed_at: '2026-01-01T00:00:00.000Z',
        owner: { login: 'owner', avatar_url: '' },
        topics: [],
      }],
      releases: [{
        id: 101,
        tag_name: 'v1.0.0',
        name: 'v1.0.0',
        body: null,
        published_at: '2026-02-01T00:00:00.000Z',
        html_url: 'https://github.com/owner/release-repository/releases/tag/v1.0.0',
        assets: [],
        repository: { id: 11, full_name: 'owner/release-repository', name: 'release-repository' },
      }],
    });

    const normalized = actualStore.normalizePersistedState(snapshot, actualStore.useAppStore.getInitialState());

    expect(normalized.discoveryRepos).toEqual({ 'hot-release': [], 'most-popular': [], topic: [], weekly: [], search: [], 'code-search': [] });
    expect(normalized.discoveryIsLoading).toEqual({ 'hot-release': false, 'most-popular': false, topic: false, weekly: false, search: false, 'code-search': false });
    expect(normalized.repositories?.[0]).toMatchObject({
      has_fetched_releases: true,
      last_release_fetch_time: '2026-02-01T00:00:00.000Z',
    });
  });

  it('preserves the root public API and all PR-04 to PR-06 Hook import paths', () => {
    expect(actualStore.useAppStore.getState).toBeTypeOf('function');
    expect(actualStore.sortCategoriesByOrder).toBeTypeOf('function');
    expect(actualStore.getAllCategories).toBeTypeOf('function');
    expect(actualStore.defaultCategories).toBeInstanceOf(Array);
    expect(actualStore.normalizePersistedState).toBeTypeOf('function');
    expect(actualStore.LEGACY_EMBEDDING_FORMAT_VERSION).toBe(1);
    expect(actualStore.isKnownEmbeddingFormatVersion(actualStore.LEGACY_EMBEDDING_FORMAT_VERSION)).toBe(true);

    for (const hook of [
      useRepositoryCardActions,
      useRepositoryAnalysisJob,
      useBulkRepositoryActions,
      useAIConfigActions,
      useBackendSettingsActions,
      useDiagnosticBackendActions,
      useMcpActions,
      useNetworkActions,
      useVectorSearchActions,
    ]) {
      expect(hook).toBeTypeOf('function');
    }
  });
});
