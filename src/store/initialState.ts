
import type { AppState } from '../types';
import { defaultHeaderMenuConfig, defaultReleaseSourceSettings, defaultSubscriptionChannels } from '../types';
import { defaultRepositoryChatSettings } from '../types/repositoryChat';
import { DEFAULT_THEME_PRESET_ID } from '../constants/themePresets';
import { DEFAULT_THEME_TOKENS } from '../utils/themeTokens';
import { DEFAULT_REPOSITORY_CARD_FIELDS } from '../types/repositoryCardFields';
import { DEFAULT_REPOSITORY_CARD_ACTIONS } from '../types/repositoryCardActions';
import { detectInitialLanguage } from '../i18n/languages';
import {
  defaultDiscoveryChannels,
  defaultMcpConfig,
  defaultPresetFilters,
  defaultVectorSearchConfig,
  defaultVectorSearchStatus,
  initialSearchFilters,
} from './schema';

export const createInitialState = (): AppState => ({
      user: null,
      githubToken: null,
      isAuthenticated: false,
      accountWorkspaces: {},
      repositories: [],
      // Theme token 默认全部"跟随预设"（开发守则 §14）
      themeTokens: { ...DEFAULT_THEME_TOKENS },
      isLoading: false,
      isSyncingStars: false,
      lastSync: null,
      analyzingRepositoryIds: new Set<number>(),
      aiConfigs: [],
      activeAIConfig: null,
      repositoryChatSettings: { ...defaultRepositoryChatSettings },
      embeddingConfigs: [],
      activeEmbeddingConfig: null,
      vectorSearchConfig: { ...defaultVectorSearchConfig },
      vectorSearchStatus: { ...defaultVectorSearchStatus },
      vectorIndexingState: { isIndexing: false, phase: null, phaseDone: 0, phaseTotal: 0, result: null },
      mcpConfig: { ...defaultMcpConfig },
      similarView: null,
      searchFilters: initialSearchFilters,
      searchResults: [],
      releases: [],
      releaseSubscriptions: new Set<number>(),
      releaseSourceSettings: defaultReleaseSourceSettings,
      readReleases: new Set<number>(),
      customCategories: [],
      hiddenDefaultCategoryIds: [],
      defaultCategoryOverrides: {},
      categoryOrder: [],
      collapsedSidebarCategoryCount: 20,
      categoryMatchMode: 'effective',
      assetFilters: defaultPresetFilters,
      themeMode: 'dark',
      systemTheme:
        typeof window !== 'undefined' && typeof window.matchMedia === 'function'
          && window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light',
      themePresetLight: DEFAULT_THEME_PRESET_ID,
      themePresetDark: DEFAULT_THEME_PRESET_ID,
      hasHydrated: false,
      currentView: 'repositories',
      selectedCategory: 'all',
      language: detectInitialLanguage(),
      translationEngine: 'microsoft',
      autoTranslateRepoDescription: false,
      analysisProgress: { current: 0, total: 0 },
      isSidebarCollapsed: false,
      readmeModalOpen: false,
      repositoryViewMode: 'grid',
      // 卡片可见字段默认全开（开发守则 §14）
      repositoryCardFields: { ...DEFAULT_REPOSITORY_CARD_FIELDS },
      repositoryCardActions: DEFAULT_REPOSITORY_CARD_ACTIONS.map((item) => ({ ...item })),
      releaseViewMode: 'timeline',
      releaseShowMode: 'all',
      releaseLatestMode: 'all',
      releaseSelectedFilters: [],
      releaseSearchQuery: '',
      releaseExpandedRepositories: new Set<number>(),
      releaseIsRefreshing: false,
      includePreRelease: true,
      includeKeysInBackup: false,


      discoveryChannels: defaultDiscoveryChannels,
      discoveryRepos: { 'hot-release': [], 'most-popular': [], 'topic': [], 'weekly': [], 'search': [], 'code-search': [] },
      discoveryLastRefresh: { 'hot-release': null, 'most-popular': null, 'topic': null, 'weekly': null, 'search': null, 'code-search': null },
      discoveryIsLoading: { 'hot-release': false, 'most-popular': false, 'topic': false, 'weekly': false, 'search': false, 'code-search': false },
      discoveryIsLoadingMore: { 'hot-release': false, 'most-popular': false, 'topic': false, 'weekly': false, 'search': false, 'code-search': false },
      discoveryLoadMoreError: { 'hot-release': null, 'most-popular': null, 'topic': null, 'weekly': null, 'search': null, 'code-search': null },
      selectedDiscoveryChannel: 'hot-release',
      discoveryPlatform: 'All',
      discoveryLanguage: 'All',
      discoverySortBy: 'BestMatch',
      discoverySortOrder: 'Descending',
      discoverySearchQuery: '',
      // 仓库搜索模式：默认关键词（行为与历史版本一致）；phase/detail/emptyReason 为会话级状态
      discoverySearchMode: 'keyword',
      discoverySearchPhase: null,
      discoverySearchPhaseDetail: null,
      discoverySearchEmptyReason: null,
      discoverySelectedTopic: null,
      discoveryHasMore: { 'hot-release': false, 'most-popular': false, 'topic': false, 'weekly': false, 'search': false, 'code-search': false },
      discoveryNextPage: { 'hot-release': 1, 'most-popular': 1, 'topic': 1, 'weekly': 1, 'search': 1, 'code-search': 1 },
      discoveryTotalCount: { 'hot-release': 0, 'most-popular': 0, 'topic': 0, 'weekly': 0, 'search': 0, 'code-search': 0 },
      discoveryScrollPositions: { 'hot-release': 0, 'most-popular': 0, 'topic': 0, 'weekly': 0, 'search': 0, 'code-search': 0 },
      weeklyOnlyCollected: false,
      weeklySyncStatus: null,

      // Subscription
      subscriptionRepos: { 'most-stars': [], 'most-forks': [], 'most-dev': [] },
      subscriptionLastRefresh: { 'most-stars': null, 'most-forks': null, 'most-dev': null },
      subscriptionIsLoading: { 'most-stars': false, 'most-forks': false, 'most-dev': false },
      subscriptionChannels: defaultSubscriptionChannels,
      headerMenuConfig: defaultHeaderMenuConfig,
});
