import type { StoreApi } from 'zustand';
import type { AppLanguage } from '../i18n/languages';
import type {
  AppState,
  ThemeMode,
  Repository,
  Release,
  AIConfig,
  EmbeddingConfig,
  VectorSearchConfig,
  VectorSearchStatus,
  McpServiceConfig,
  VectorIndexingState,
  SearchFilters,
  GitHubUser,
  Category,
  AssetFilter,
  AnalysisProgress,
  DiscoveryChannelId,
  DiscoveryRepo,
  DiscoveryPlatform,
  ProgrammingLanguage,
  SortBy,
  SortOrder,
  WeeklySyncStatus,
  TopicCategory,
  CustomReleaseRepository,
  ReleaseSourceId,
  ReleaseSourceSettings,
  HeaderMenuItem,
  TranslationEngine,
  RepositoryCardFieldId,
  RepositoryCardActionPreference,
  RepositoryChatSettings,
  ThemeTokens,
} from '../types';
import type { ThemePresetId } from '../constants/themePresets';

export interface AppActions {
  // Auth actions
  setUser: (user: GitHubUser | null) => void;
  setGitHubToken: (token: string | null) => void;
  logout: () => void;

  // Repository actions
  setRepositories: (repos: Repository[], options?: { allowEmpty?: boolean }) => void;
  updateRepository: (repo: Repository) => void;
  /** 批量更新多个仓库的指定字段，保留当前过滤的 searchResults 不被重置 */
  updateRepositoriesMetadata: (updates: { id: number; patch: Partial<Repository> }[]) => void;
  addRepository: (repo: Repository) => void;
  setLoading: (loading: boolean) => void;
  setSyncingStars: (syncing: boolean) => void;
  setLastSync: (timestamp: string) => void;
  deleteRepository: (repoId: number) => void;
  setAnalyzingRepository: (repoId: number, isAnalyzing: boolean) => void;

  // AI actions
  addAIConfig: (config: AIConfig) => void;
  updateAIConfig: (id: string, updates: Partial<AIConfig>) => void;
  deleteAIConfig: (id: string) => void;
  setActiveAIConfig: (id: string | null) => void;
  setAIConfigs: (configs: AIConfig[]) => void;
  setRepositoryChatSettings: (settings: Partial<RepositoryChatSettings>) => void;

  // Embedding actions
  addEmbeddingConfig: (config: EmbeddingConfig) => void;
  updateEmbeddingConfig: (id: string, updates: Partial<EmbeddingConfig>) => void;
  deleteEmbeddingConfig: (id: string) => void;
  setActiveEmbeddingConfig: (id: string | null) => void;
  setEmbeddingConfigs: (configs: EmbeddingConfig[]) => void;

  // Vector Search actions
  setVectorSearchConfig: (config: Partial<VectorSearchConfig>) => void;
  setVectorSearchStatus: (status: VectorSearchStatus | undefined) => void;
  setVectorIndexingState: (state: Partial<VectorIndexingState>) => void;

  // MCP service (local prefs; backend SQLite is source of truth when connected)
  setMcpConfig: (config: Partial<McpServiceConfig>) => void;

  // Similar repositories view actions
  enterSimilarView: (repos: Repository[], anchor: Repository) => void;
  resetSimilarView: () => void;
  exitSimilarView: () => void;

  // Search actions
  setSearchFilters: (filters: Partial<SearchFilters>) => void;
  setSearchResults: (results: Repository[]) => void;

  // Release actions
  setReleases: (releases: Release[], options?: { allowEmpty?: boolean }) => void;
  addReleases: (releases: Release[]) => void;
  /** 按 id 合并更新已存在 Release 的资产/元数据；内容变化后重置为未读（is_read=false 并从 readReleases 移除） */
  upsertReleases: (releases: Release[]) => void;
  toggleReleaseSubscription: (repoId: number) => void;
  batchUnsubscribeReleases: (repoIds: number[]) => void;
  removeReleasesByRepoId: (repoId: number) => void;
  removeReleasesByRepoFullName: (fullName: string) => void;
  /** 标记 Release 已读；被标记的条目同时清空 updated_asset_ids（“资产已更新”标识随已读消失） */
  markReleaseAsRead: (releaseId: number) => void;
  /** 点击某条资产后清除其"资产已更新"标识（从 updated_asset_ids 移除），不影响 Release 级未读状态 */
  markAssetAsRead: (assetId: number) => void;
  markAllReleasesAsRead: () => void;
  setReleaseSourceSettings: (settings: ReleaseSourceSettings) => void;
  setReleaseEnabledSources: (sourceIds: ReleaseSourceId[]) => void;
  toggleReleaseSource: (sourceId: ReleaseSourceId) => void;
  setReleaseSourceRepositories: (sourceId: ReleaseSourceId, repos: CustomReleaseRepository[]) => void;
  addReleaseSourceRepository: (sourceId: ReleaseSourceId, repo: CustomReleaseRepository) => void;
  removeReleaseSourceRepository: (sourceId: ReleaseSourceId, fullName: string) => void;
  updateReleaseSourceRepository: (sourceId: ReleaseSourceId, fullName: string, updates: Partial<CustomReleaseRepository>) => void;

  // Category actions
  addCustomCategory: (category: Category) => void;
  updateCustomCategory: (id: string, updates: Partial<Category>) => void;
  updateDefaultCategory: (id: string, updates: Partial<Category>) => void;
  resetDefaultCategory: (id: string) => void;
  resetDefaultCategoryNameIcon: (id: string) => void;
  resetDefaultCategoryKeywords: (id: string) => void;
  deleteCustomCategory: (id: string) => void;
  hideDefaultCategory: (id: string) => void;
  showDefaultCategory: (id: string) => void;
  setCategoryOrder: (order: string[]) => void;
  reorderCategories: (oldIndex: number, newIndex: number) => void;
  setCollapsedSidebarCategoryCount: (count: number) => void;
  setCategoryMatchMode: (mode: 'legacy' | 'effective') => void;

  // Asset Filter actions
  addAssetFilter: (filter: AssetFilter) => void;
  updateAssetFilter: (id: string, updates: Partial<AssetFilter>) => void;
  deleteAssetFilter: (id: string) => void;

  // UI actions
  setThemeMode: (mode: ThemeMode) => void;
  setSystemTheme: (systemTheme: 'light' | 'dark') => void;
  setThemePresetLight: (preset: ThemePresetId) => void;
  setThemePresetDark: (preset: ThemePresetId) => void;
  setCurrentView: (view: 'repositories' | 'releases' | 'settings' | 'subscription') => void;
  setSelectedCategory: (category: string) => void;
  setLanguage: (language: AppLanguage) => void;
  setTranslationEngine: (engine: TranslationEngine) => void;
  setAutoTranslateRepoDescription: (enabled: boolean) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setReadmeModalOpen: (open: boolean) => void;
  setHeaderMenuConfig: (config: HeaderMenuItem[]) => void;

  // Hydration state
  setHasHydrated: (hydrated: boolean) => void;

  // Update Analysis Progress
  setAnalysisProgress: (newProgress: AnalysisProgress) => void;

  // Backend actions

  // Proxy actions

  // RPC Download actions

  // Repository list view actions
  setRepositoryViewMode: (mode: 'grid' | 'list') => void;

  // Release Timeline View actions
  setReleaseViewMode: (mode: 'timeline' | 'repository') => void;
  setReleaseShowMode: (mode: 'all' | 'unread') => void;
  setReleaseLatestMode: (mode: 'all' | 'latest') => void;
  setReleaseSelectedFilters: (filters: string[]) => void;
  toggleReleaseSelectedFilter: (filterId: string) => void;
  clearReleaseSelectedFilters: () => void;
  setReleaseSearchQuery: (query: string) => void;
  toggleReleaseExpandedRepository: (repoId: number) => void;
  setReleaseExpandedRepositories: (repoIds: Set<number>) => void;
  setReleaseIsRefreshing: (refreshing: boolean) => void;
  setIncludePreRelease: (include: boolean) => void;

  // Backup/Export key inclusion preference
  setIncludeKeysInBackup: (include: boolean) => void;

  // Discovery actions
  setSelectedDiscoveryChannel: (channel: DiscoveryChannelId) => void;
  setDiscoveryLoading: (channel: DiscoveryChannelId, loading: boolean) => void;
  setDiscoveryLoadingMore: (channel: DiscoveryChannelId, loading: boolean) => void;
  setDiscoveryLoadMoreError: (channel: DiscoveryChannelId, error: string | null) => void;
  setDiscoveryRepos: (channel: DiscoveryChannelId, repos: DiscoveryRepo[], append?: boolean) => void;
  setDiscoveryLastRefresh: (channel: DiscoveryChannelId, timestamp: string) => void;
  updateDiscoveryRepo: (repo: DiscoveryRepo) => void;
  toggleDiscoveryChannel: (channelId: DiscoveryChannelId) => void;
  setDiscoveryPlatform: (platform: DiscoveryPlatform) => void;
  setDiscoveryLanguage: (language: ProgrammingLanguage) => void;
  setDiscoverySortBy: (sortBy: SortBy) => void;
  setDiscoverySortOrder: (sortOrder: SortOrder) => void;
  setDiscoverySearchQuery: (query: string) => void;
  setDiscoverySearchMode: (mode: 'keyword' | 'semantic') => void;
  setDiscoverySearchPhase: (phase: string | null) => void;
  setDiscoverySearchPhaseDetail: (detail: string | null) => void;
  setDiscoverySearchEmptyReason: (reason: 'recall_empty' | 'ai_empty' | null) => void;
  setDiscoverySelectedTopic: (topic: TopicCategory | null) => void;
  setDiscoveryHasMore: (channel: DiscoveryChannelId, hasMore: boolean) => void;
  setDiscoveryNextPage: (channel: DiscoveryChannelId, page: number) => void;
  setDiscoveryTotalCount: (channel: DiscoveryChannelId, count: number) => void;
  setDiscoveryScrollPosition: (channel: DiscoveryChannelId, position: number) => void;
  setWeeklyOnlyCollected: (only: boolean) => void;
  setWeeklySyncStatus: (status: WeeklySyncStatus | null) => void;
  appendDiscoveryRepos: (channel: DiscoveryChannelId, repos: DiscoveryRepo[]) => void;

  // Theme tokens（开发守则 §14）
  /** 局部更新：内部与当前值合并，调用方不必自己展开（避免拿到过期的渲染值）。 */
  updateThemeTokens: (patch: Partial<ThemeTokens>) => void;
  // 仓库卡片可见字段（开发守则 §14）
  /** 切换某个字段的显示；未提供的字段沿用当前值。 */
  setRepositoryCardField: (id: RepositoryCardFieldId, visible: boolean) => void;
  setRepositoryCardActions: (actions: RepositoryCardActionPreference[]) => void;
}

export type AppStoreState = AppState & AppActions;
export type AppStoreSet = StoreApi<AppStoreState>['setState'];
export type AppStoreGet = StoreApi<AppStoreState>['getState'];
export type AppStoreSlice<T> = (set: AppStoreSet, get: AppStoreGet) => T;
