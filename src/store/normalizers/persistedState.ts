
import type {
  Category,
  DiscoveryChannelId,
  DiscoveryRepo,
  SubscriptionChannel,
} from '../../types';
import { defaultHeaderMenuConfig, defaultSubscriptionChannels } from '../../types';
import { DEFAULT_THEME_PRESET_ID, isThemePresetId } from '../../constants/themePresets';
import { isAppLanguage } from '../../i18n/languages';
import { normalizeReleaseSourceSettings } from '../../utils/releaseSources';
import { normalizeAssetFilters } from '../../utils/assetFilters';
import { normalizeThemeTokens } from '../../utils/themeTokens';
import { normalizeRepositoryCardFields } from '../../utils/repositoryCardFields';
import { normalizeRepositoryCardActions } from '../../utils/repositoryCardActions';
import type { AppStoreState } from '../types';
import { normalizeAccountWorkspaces } from '../helpers/accountWorkspace';
import { purgeLegacyAuthStorage } from '../persistence/legacyAuthStorage';
import { SERVER_HELD_TOKEN } from '../../services/githubApiFactory';
import {
  defaultDiscoveryChannels,
  defaultPresetFilters,
  initialSearchFilters,
  normalizeMcpConfig,
  normalizeNumberSet,
  normalizeRepositoryChatSettings,
  normalizeVectorSearchConfig,
  normalizeVectorSearchStatus,
  PersistedAppState,
  REQUIRED_HEADER_MENU_IDS,
} from '../schema';

/** Keys of features removed in the hardened fork; stale persisted values are dropped on hydration. */
const REMOVED_PERSISTED_KEYS = [
  'gists', 'starredGists', 'gistSearchFilters', 'gistSearchResults', 'selectedGistCategory', 'analyzingGistIds',
  'forks', 'readForks', 'forkViewMode', 'forkSelectedFilters', 'forkSearchQuery', 'forkExpandedRepositories', 'forkIsRefreshing',
  'webdavConfigs', 'activeWebDAVConfig', 'lastBackup',
  'xTweetFollows', 'xTweetAuth', 'xTweetAuthRevision', 'xTweetSyncStatus',
  'telegramFollows', 'telegramSyncStatus',
  'trendingSnapshots', 'trendingTimeRange', 'updateNotification',
  'syncMode', 'syncModeConfigured', 'listsPush', 'categoryListIdMap',
  // Credentials and egress prefs: the browser holds no secret (auth is the HttpOnly session cookie).
  'githubToken', 'backendApiSecret', 'proxyConfig', 'rpcDownloadConfig', 'routeMode', 'pluginCustomIcons',
] as const;

const omitRemovedSubscriptionKeys = (value: Record<string, unknown> | undefined): Record<string, unknown> => {
  if (!value || typeof value !== 'object') return {};
  const { trending: _removed, ...rest } = value;
  void _removed;
  return rest;
};

export const normalizePersistedState = (
  persisted: PersistedAppState | undefined,
  currentState: AppStoreState
): Partial<AppStoreState> => {
  const safePersisted = persisted ?? {};
  // 旧版持久化只有 theme/themePreset 单值；新契约是 themeMode +
  // 按深浅分开的 themePresetLight/themePresetDark。旧键在此消费，
  // 不再进入水合后的状态（避免残留僵尸字段）。
  const { theme: legacyTheme, themePreset: legacyThemePreset, ...persistedRest } = safePersisted as
    PersistedAppState & { theme?: unknown; themePreset?: unknown };
  for (const key of REMOVED_PERSISTED_KEYS) delete (persistedRest as Record<string, unknown>)[key];
  const resolvedLegacyTheme = legacyTheme === 'light' || legacyTheme === 'dark' ? legacyTheme : null;
  const themeMode: AppStoreState['themeMode'] =
    safePersisted.themeMode === 'light' || safePersisted.themeMode === 'dark' || safePersisted.themeMode === 'system'
      ? safePersisted.themeMode
      : (resolvedLegacyTheme ?? 'dark');
  const legacyPreset = isThemePresetId(legacyThemePreset) ? legacyThemePreset : DEFAULT_THEME_PRESET_ID;
  const themePresetLight = isThemePresetId(safePersisted.themePresetLight)
    ? safePersisted.themePresetLight
    : legacyPreset;
  const themePresetDark = isThemePresetId(safePersisted.themePresetDark)
    ? safePersisted.themePresetDark
    : legacyPreset;
  const persistedDiscoveryChannels = (safePersisted as Record<string, unknown>).discoveryChannels;
  const normalizedDiscoveryChannels = [...defaultDiscoveryChannels.map((defaultChannel) => {
    const persistedChannel = Array.isArray(persistedDiscoveryChannels)
      ? persistedDiscoveryChannels.find((channel: unknown) =>
          (channel as Record<string, unknown>)?.id === defaultChannel.id
        ) as Record<string, unknown> | undefined
      : undefined;
    return {
      ...defaultChannel,
      enabled: persistedChannel?.enabled !== false,
    };
  })];
  if (!normalizedDiscoveryChannels.some(channel => channel.enabled)) {
    normalizedDiscoveryChannels[0] = { ...normalizedDiscoveryChannels[0], enabled: true };
  }
  // Older builds mirrored the token and API secret in localStorage; erase them.
  purgeLegacyAuthStorage();


  const resolvedUser = safePersisted.user ?? null;
  // The browser never holds a token; a signed-in user is represented by the placeholder.
  const resolvedGithubToken = resolvedUser ? SERVER_HELD_TOKEN : null;

  const repositories = Array.isArray(safePersisted.repositories) ? safePersisted.repositories : [];
  const releases = Array.isArray(safePersisted.releases) ? safePersisted.releases : [];

  // Migration for old users: mark repos with existing releases as already synced.
  // 引用保留：无需回填时直接返回原数组——分片持久化按引用判脏，若 hydration
  // 总是产生新数组引用，会在每次启动后触发一次全量重写。
  // 用 String(id) 建索引：历史快照里 id 可能被持久化为字符串，与旧实现的
  // `===` 宽松匹配历史数据保持等价；单次遍历建 Map，回填整体 O(R+L)。
  const latestReleaseTimeByRepoId = new Map<string, number>();
  for (const release of releases) {
    const repoId = release.repository?.id;
    if (repoId === undefined || repoId === null) continue;
    const key = String(repoId);
    const publishedTime = new Date(release.published_at).getTime();
    const previous = latestReleaseTimeByRepoId.get(key);
    latestReleaseTimeByRepoId.set(key, previous === undefined ? publishedTime : Math.max(previous, publishedTime));
  }
  const needsReleaseBackfill = repositories.some(
    repo => latestReleaseTimeByRepoId.has(String(repo.id)) && !repo.has_fetched_releases,
  );
  const migratedRepositories = needsReleaseBackfill
    ? repositories.map(repo => {
      if (repo.has_fetched_releases) {
        return repo;
      }
      // Backfill last_release_fetch_time from the latest persisted release timestamp
      const latestReleaseTime = latestReleaseTimeByRepoId.get(String(repo.id));
      if (latestReleaseTime === undefined) {
        return repo;
      }
      return {
        ...repo,
        has_fetched_releases: true,
        last_release_fetch_time: repo.last_release_fetch_time || (latestReleaseTime ? new Date(latestReleaseTime).toISOString() : new Date().toISOString())
      };
    })
    : repositories;

  // Default includePreRelease to true if not set (backward compatibility)
  const includePreRelease = safePersisted.includePreRelease !== undefined
    ? safePersisted.includePreRelease
    : true;

  const normalizedAssetFilters = normalizeAssetFilters(safePersisted.assetFilters);

  return {
    ...currentState,
    ...persistedRest,
    user: resolvedUser,
    githubToken: resolvedGithubToken,
    accountWorkspaces: normalizeAccountWorkspaces(
      (safePersisted as Record<string, unknown>).accountWorkspaces,
    ),
    themeMode,
    themePresetLight,
    themePresetDark,
    themeTokens: normalizeThemeTokens((safePersisted as Record<string, unknown>).themeTokens),
    repositories: migratedRepositories,
    // 不恢复分析中状态：异步任务无法在页面重载后存活，恢复会导致卡片永久卡在“分析中”状态。
    analyzingRepositoryIds: new Set<number>(),
    releases,
    searchResults: migratedRepositories,
    releaseSubscriptions: normalizeNumberSet(safePersisted.releaseSubscriptions),
    repositoryViewMode: safePersisted.repositoryViewMode === 'list' ? 'list' : 'grid',
    releaseSourceSettings: normalizeReleaseSourceSettings(safePersisted.releaseSourceSettings),
    readReleases: normalizeNumberSet(safePersisted.readReleases),
    releaseExpandedRepositories: normalizeNumberSet(safePersisted.releaseExpandedRepositories),
    includePreRelease,
    searchFilters: {
      ...initialSearchFilters,
      ...safePersisted.searchFilters,
      sortBy: safePersisted.searchFilters?.sortBy || 'stars',
      sortOrder: safePersisted.searchFilters?.sortOrder || 'desc',
    },
    embeddingConfigs: Array.isArray(safePersisted.embeddingConfigs) ? safePersisted.embeddingConfigs : [],
    activeEmbeddingConfig: typeof safePersisted.activeEmbeddingConfig === 'string' ? safePersisted.activeEmbeddingConfig : null,
    vectorSearchConfig: normalizeVectorSearchConfig(
      safePersisted.vectorSearchConfig,
      safePersisted.embeddingConfigs
    ),
    vectorSearchStatus: normalizeVectorSearchStatus(
      safePersisted.vectorSearchStatus ?? currentState.vectorSearchStatus
    ),
// Persist full mcpConfig including token so Agent configs stay stable across restarts
    // unless the user explicitly resets the token.
    mcpConfig: normalizeMcpConfig((safePersisted as Record<string, unknown>).mcpConfig),
    repositoryChatSettings: normalizeRepositoryChatSettings((safePersisted as Record<string, unknown>).repositoryChatSettings),
    customCategories: Array.isArray(safePersisted.customCategories) ? safePersisted.customCategories : [],
    hiddenDefaultCategoryIds: (() => {
      const persistedIds = (safePersisted as Record<string, unknown>).hiddenDefaultCategoryIds;
      return Array.isArray(persistedIds)
        ? persistedIds.filter((id): id is string => typeof id === 'string')
        : [];
    })(),
    defaultCategoryOverrides: (() => {
      const persisted = (safePersisted as Record<string, unknown>).defaultCategoryOverrides;
      return persisted && typeof persisted === 'object' && !Array.isArray(persisted)
        ? persisted as Record<string, Partial<Category>>
        : {};
    })(),
    categoryOrder: Array.isArray(safePersisted.categoryOrder) ? safePersisted.categoryOrder.filter((id: unknown): id is string => typeof id === 'string') : [],
    collapsedSidebarCategoryCount: typeof safePersisted.collapsedSidebarCategoryCount === 'number' && safePersisted.collapsedSidebarCategoryCount > 0 ? safePersisted.collapsedSidebarCategoryCount : 20,
    categoryMatchMode: safePersisted.categoryMatchMode === 'legacy' ? 'legacy' : 'effective',
    assetFilters: normalizedAssetFilters.length > 0 ? normalizedAssetFilters : defaultPresetFilters,
    // 卡片可见字段（开发守则 §14）：逐项校验，非法值按默认（显示）处理
    repositoryCardFields: normalizeRepositoryCardFields((safePersisted as Record<string, unknown>).repositoryCardFields),
    repositoryCardActions: normalizeRepositoryCardActions((safePersisted as Record<string, unknown>).repositoryCardActions),
    language: isAppLanguage(safePersisted.language) ? safePersisted.language : currentState.language,
    translationEngine: safePersisted.translationEngine === 'google' || safePersisted.translationEngine === 'ai'
      ? safePersisted.translationEngine
      : 'microsoft',
    autoTranslateRepoDescription: typeof safePersisted.autoTranslateRepoDescription === 'boolean'
      ? safePersisted.autoTranslateRepoDescription
      : false,
    // Views removed in the hardened fork fall back to the repository list.
    currentView: ['repositories', 'releases', 'subscription', 'settings'].includes(String(safePersisted.currentView))
      ? safePersisted.currentView as AppStoreState['currentView']
      : 'repositories',
    isAuthenticated: !!(resolvedUser && resolvedGithubToken),
    releaseViewMode: safePersisted.releaseViewMode || 'timeline',
    releaseShowMode: safePersisted.releaseShowMode === 'unread' ? 'unread' : 'all',
    releaseLatestMode: safePersisted.releaseLatestMode === 'latest' ? 'latest' : 'all',
    releaseSelectedFilters: Array.isArray(safePersisted.releaseSelectedFilters) ? safePersisted.releaseSelectedFilters : [],
    releaseSearchQuery: typeof safePersisted.releaseSearchQuery === 'string' ? safePersisted.releaseSearchQuery : '',
    discoveryChannels: normalizedDiscoveryChannels,
    // discoveryRepos is session-only runtime data. Never revive a stale legacy
    // cache during hydration, even if a historical snapshot contains the field.
    discoveryRepos: { 'hot-release': [], 'most-popular': [], 'topic': [], 'weekly': [], 'search': [], 'code-search': [] } as Record<DiscoveryChannelId, DiscoveryRepo[]>,
    discoveryLastRefresh: { 'hot-release': null, 'most-popular': null, 'topic': null, 'weekly': null, 'search': null, 'code-search': null },
    discoveryTotalCount: { 'hot-release': 0, 'most-popular': 0, 'topic': 0, 'weekly': 0, 'search': 0, 'code-search': 0 },
    // 选中频道保留持久化值（存在且启用即可）；已移除的频道（trending 等）回落到默认频道
    selectedDiscoveryChannel: normalizedDiscoveryChannels.some(channel => channel.id === safePersisted.selectedDiscoveryChannel && channel.enabled)
      ? safePersisted.selectedDiscoveryChannel as DiscoveryChannelId
      : normalizedDiscoveryChannels.find(channel => channel.enabled)?.id ?? defaultDiscoveryChannels[0].id,
    // discoveryIsLoading 不持久化，始终重置为 false（防止旧数据格式异常）
    discoveryIsLoading: { 'hot-release': false, 'most-popular': false, 'topic': false, 'weekly': false, 'search': false, 'code-search': false },
    discoveryIsLoadingMore: { 'hot-release': false, 'most-popular': false, 'topic': false, 'weekly': false, 'search': false, 'code-search': false },
    discoveryLoadMoreError: { 'hot-release': null, 'most-popular': null, 'topic': null, 'weekly': null, 'search': null, 'code-search': null },
    discoveryHasMore: { 'hot-release': false, 'most-popular': false, 'topic': false, 'weekly': false, 'search': false, 'code-search': false },
    discoveryNextPage: { 'hot-release': 1, 'most-popular': 1, 'topic': 1, 'weekly': 1, 'search': 1, 'code-search': 1 },
    // discoveryScrollPositions 不持久化，始终重置为 0
    discoveryScrollPositions: { 'hot-release': 0, 'most-popular': 0, 'topic': 0, 'weekly': 0, 'search': 0, 'code-search': 0 },
    // 订阅频道状态：补全缺失的键；已移除的 trending 键在下方被清理
    subscriptionRepos: {
      'most-stars': [],
      'most-forks': [],
      'most-dev': [],
      ...omitRemovedSubscriptionKeys(safePersisted.subscriptionRepos as Record<string, unknown> | undefined),
    },
    subscriptionLastRefresh: {
      'most-stars': null,
      'most-forks': null,
      'most-dev': null,
      ...omitRemovedSubscriptionKeys((safePersisted as Record<string, unknown>).subscriptionLastRefresh as Record<string, unknown> | undefined),
    },
    subscriptionIsLoading: {
      'most-stars': false,
      'most-forks': false,
      'most-dev': false,
      ...omitRemovedSubscriptionKeys((safePersisted as Record<string, unknown>).subscriptionIsLoading as Record<string, unknown> | undefined),
    },
    // 所有频道都有 nameEn（兼容旧数据）；已移除的 trending 频道被过滤
    subscriptionChannels: (() => {
      const persisted = (safePersisted as Record<string, unknown>).subscriptionChannels;
      const defaultChannelsMap = new Map(defaultSubscriptionChannels.map(ch => [ch.id, ch]));
      if (!Array.isArray(persisted)) return defaultSubscriptionChannels;
      // 合并：使用 persisted 的频道，但补全缺失的字段（nameEn 等）
      return persisted.filter((ch: unknown) => defaultChannelsMap.has((ch as Record<string, unknown>)?.id as string)).map((ch: unknown) => {
        const chRecord = ch as Record<string, unknown>;
        const defaultCh = defaultChannelsMap.get(chRecord.id as string);
        if (defaultCh) {
          return {
            ...(chRecord as Partial<SubscriptionChannel>),
            name: defaultCh.name, // 始终使用中文名称（默认定义）
            nameEn: (chRecord.nameEn as string) || defaultCh.nameEn || (chRecord.name as string) || defaultCh.nameEn,
            icon: (chRecord.icon as string) || defaultCh.icon,
            description: (chRecord.description as string) || defaultCh.description,
          } as unknown as SubscriptionChannel;
        }
        return chRecord as unknown as SubscriptionChannel;
      }).concat(
        defaultSubscriptionChannels.filter(dch => !persisted.some((ch: unknown) => (ch as Record<string, unknown>).id === dch.id))
      );
    })(),
    headerMenuConfig: (() => {
      const persisted = (safePersisted as Record<string, unknown>).headerMenuConfig;
      if (!Array.isArray(persisted)) return defaultHeaderMenuConfig;
      // 合并：确保所有默认菜单都存在，保留用户自定义的 visible/order
      // 防御性过滤：跳过非对象或 null 的损坏数据
      const persistedMap = new Map(
        persisted
          .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
          .map((item) => [item.id, item])
      );
      return defaultHeaderMenuConfig.map((defaultItem) => {
        const persistedItem = persistedMap.get(defaultItem.id);
        if (!persistedItem) return defaultItem;
        const isRequired = REQUIRED_HEADER_MENU_IDS.has(defaultItem.id);
        return {
          ...defaultItem,
          visible: isRequired ? true : (typeof persistedItem.visible === 'boolean' ? persistedItem.visible : defaultItem.visible),
          order: typeof persistedItem.order === 'number' ? persistedItem.order : defaultItem.order,
        };
      });
    })(),
  };
};
