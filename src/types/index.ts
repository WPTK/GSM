import type { ThemePresetId } from '../constants/themePresets';
import type { AppLanguage } from '../i18n/languages';

import type { RepositoryCardFields } from './repositoryCardFields';
export type { RepositoryCardFieldId, RepositoryCardFields } from './repositoryCardFields';
import type { RepositoryCardActionPreference } from './repositoryCardActions';
export type {
  BuiltinRepositoryCardActionId,
  RepositoryCardActionId,
  RepositoryCardActionPreference,
} from './repositoryCardActions';
import type { RepositoryChatSettings } from './repositoryChat';
export type { RepositoryChatSettings } from './repositoryChat';
import type { ThemeTokens } from './themeTokens';
export type { ThemeTokens } from './themeTokens';

/** 显示模式偏好：system = 跟随操作系统深浅设置 */
export type ThemeMode = 'light' | 'dark' | 'system';
export type {
  RepositoryHealthEnrichment,
  RepositoryHealthFact,
  RepositoryHealthFactId,
  RepositoryHealthFactKind,
  RepositoryHealthFactSource,
  RepositoryHealthGroup,
  RepositoryHealthGroupView,
  RepositoryHealthSignal,
  RepositoryHealthSignalId,
  RepositoryHealthSnapshot,
} from './health';

export interface Repository {
  id: number;
  name: string;
  full_name: string;
  description: string | null;
  html_url: string;
  stargazers_count: number;
  forks_count: number;
  forks: number;
  language: string | null;
  created_at: string;
  updated_at: string;
  pushed_at: string;
  starred_at?: string;
  owner: {
    login: string;
    avatar_url: string;
  };
  topics: string[];
  /**
   * GitHub 原生状态字段。`/user/starred` 原始响应本就包含这些字段，
   * 这里把它们纳入类型以便 Repository Health 与筛选复用。
   *
   * 后端不持久化这些字段，因此 `src/utils/repositoryMerge.ts` 把它们同时列入
   * `CLIENT_ONLY_REPOSITORY_FIELDS`（不参与后端同步指纹，避免 Issue #304 的哈希抖动）
   * 与 `LOCAL_REPOSITORY_FIELDS`（拉取时保留本地值，不被后端响应清空）。
   */
  archived?: boolean;
  disabled?: boolean;
  fork?: boolean;
  is_template?: boolean;
  open_issues_count?: number;
  default_branch?: string;
  ai_summary?: string;
  ai_tags?: string[];
  ai_platforms?: string[];
  analyzed_at?: string;
  analysis_failed?: boolean;
  analysis_error?: string;
  subscribed_to_releases?: boolean;
  custom_description?: string;
  custom_tags?: string[];
  custom_category?: string;
  category_locked?: boolean;
  /** 描述显示偏好：follow=跟随列表页"显示内容"开关（默认），ai=固定显示AI总结，original=固定显示原始描述 */
  description_display?: 'follow' | 'ai' | 'original';
  /** 标签显示偏好：follow=跟随列表页"显示内容"开关（默认），ai=固定显示AI标签，topics=固定显示Topics */
  tags_display?: 'follow' | 'ai' | 'topics';
  last_edited?: string;
  vector_indexed_at?: string;  // ISO timestamp of last successful vector indexing
  /** 上次向量索引时采用的 license（SPDX id / null）。增量谓词据此判断 license 是否变化以触发重索引。 */
  vector_indexed_license?: string | null;
  last_release_fetch_time?: string;  // ISO timestamp, for incremental sync
  has_fetched_releases?: boolean;   // whether this repo has been synced for releases
  /** SPDX id（如 'MIT'、'Apache-2.0'）；无许可证/未识别为 null。AI/搜索/过滤均以此为准。 */
  license?: string | null;
}

export interface ReleaseAsset {
  id: number;
  name: string;
  size: number;
  download_count: number;
  browser_download_url: string;
  content_type: string;
  created_at: string;
  updated_at: string;
}

export interface Release {
  id: number;
  tag_name: string;
  name: string | null;
  body: string | null;
  published_at: string;
  html_url: string;
  assets: ReleaseAsset[];
  zipball_url?: string;
  tarball_url?: string;
  prerelease?: boolean;
  repository: {
    id: number;
    full_name: string;
    name: string;
  };
  /** IDs of assets added or changed during the latest refresh. */
  updated_asset_ids?: number[];
  is_read?: boolean;
}

export type ReleaseSourceId = 'starred-release-subscription' | 'watch-custom-release' | 'custom-release';

export interface CustomReleaseRepository {
  id: number;
  name: string;
  full_name: string;
  html_url: string;
  owner: {
    login: string;
    avatar_url: string;
  };
  has_fetched_releases?: boolean;
  last_release_fetch_time?: string;
  source_added_at?: string;
  release_hidden?: boolean;
}

export interface ReleaseSourceSettings {
  enabledSourceIds: ReleaseSourceId[];
  watchCustomReleaseRepos: CustomReleaseRepository[];
  customReleaseRepos: CustomReleaseRepository[];
}

export const defaultReleaseSourceSettings: ReleaseSourceSettings = {
  enabledSourceIds: ['starred-release-subscription'],
  watchCustomReleaseRepos: [],
  customReleaseRepos: [],
};

export interface GitHubUser {
  id: number;
  login: string;
  name: string;
  avatar_url: string;
  email: string | null;
}

export type AIApiType = 'openai' | 'openai-responses' | 'claude' | 'gemini' | 'deepseek' | 'mimo' | 'openai-compatible';

// Embedding 提供商类型
export type EmbeddingApiType = 'openai' | 'openai-compatible' | 'gemini' | 'cohere' | 'ollama' | 'siliconflow';

// Embedding 配置（结构与 AIConfig 平行）
export interface EmbeddingConfig {
  id: string;
  name: string;
  apiType: EmbeddingApiType;
  baseUrl: string;
  apiKey: string;
  model: string;
  dimensions: number;
  isActive: boolean;
  apiKeyStatus?: SecretStatus;
}

// 索引内容模式
export type VectorIndexMode = 'description' | 'readme';

// 向量搜索整体配置（持久化 + 同步，不含运行时状态）
export interface VectorSearchConfig {
  enabled: boolean;
  workerUrl: string;
  authToken: string;
  embeddingConfigId: string;
  indexMode: VectorIndexMode;
  readmeMaxChars: number;  // README 截取字符数，默认 6000
  // 搜索参数（可选，有默认值）
  searchThreshold?: number;   // 相似度阈值，默认 0.35
  searchTopK?: number;        // 返回结果数，默认 30
  enableHyDE?: boolean;       // 是否启用 HyDE 查询预处理，默认 true
  enableReranking?: boolean;  // 是否启用 LLM 语义重排序，默认 true
  // 嵌入文本格式版本，buildEmbeddingText 格式变化时递增
  embeddingFormatVersion?: number;
}

export interface VectorSearchStatus {
  connected: boolean;
  vectorCount: number;
  dimensions: number;
  lastSyncAt?: string;
  error?: string;
}

export interface VectorIndexingState {
  isIndexing: boolean;
  phase: 'readme' | 'embedding' | 'uploading' | null;
  phaseDone: number;
  phaseTotal: number;
  result: { indexed: number; skipped: number; errors: number; error?: string } | null;
}

/** Local (Electron) / client-side MCP service preferences. Server is source of truth when backend is on. */
export interface McpServiceConfig {
  enabled: boolean;
  /** Local bind host for Electron standalone MCP (default 127.0.0.1) */
  host: string;
  /** Local bind port for Electron standalone MCP (default 3927) */
  port: number;
  /** Plaintext MCP bearer token — viewable anytime; regenerate via reset */
  token: string;
}

// 相似仓库视图状态：进入"查找相似仓库"后保存当前上下文，重置时恢复
export interface SimilarViewState {
  active: boolean;
  anchorRepoFullName: string;   // 当前锚点仓库 full_name（横幅展示）
  anchorRepoName: string;        // 锚点仓库名
  similarResults: Repository[];  // 相似结果，渲染用
  originalSearchResults: Repository[]; // 进入前的 searchResults 快照，重置恢复用
  originalSearchFilters: SearchFilters; // 进入前的 searchFilters 快照，重置恢复用
}
export type AIReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh';
export type MiMoPlan = 'api' | 'token-plan';

/** README 文档翻译使用的引擎：微软 Edge 翻译（免费）、Google 翻译（免费）或用户配置的 AI。 */
export type TranslationEngine = 'microsoft' | 'google' | 'ai';

export type SecretStatus = 'ok' | 'empty' | 'decrypt_failed';

export interface AIConfig {
  id: string;
  name: string;
  apiType?: AIApiType; // API 格式/兼容协议（默认 openai）
  baseUrl: string;
  apiKey: string;
  model: string;
  isActive: boolean;
  customPrompt?: string; // 自定义提示词
  useCustomPrompt?: boolean; // 是否使用自定义提示词
  concurrency?: number; // AI分析并发数，默认为1
  requestsPerMinute?: number; // 每分钟 AI 请求数上限（供批量分析的共享限流器使用），0/缺省=不限制
  reasoningEffort?: AIReasoningEffort; // OpenAI GPT-5/Responses 可选 reasoning 强度
  /** 问答内部 JSON 步骤（理解/规划/gate）是否关闭思考；默认 true，不暴露 UI。仅对有请求级关闭开关的供应商生效：OpenAI gpt-5.1+ 发送 reasoning.effort:'none'，DeepSeek/MiMo 发送 thinking:'disabled'；其余供应商无关闭参数，保持原有请求形态（Claude 默认不开启思考；Gemini 2.5 默认开启且当前请求不发送 thinkingConfig）。 */
  disableThinkingForInternalSteps?: boolean;
  mimoPlan?: MiMoPlan; // MiMo 渠道：api（按量付费）或 token-plan（订阅制）
  supportsToolCalls?: boolean; // 端点/模型支持 OpenAI 风格 function calling（仓库问答工具循环用，默认关闭）
  apiKeyStatus?: SecretStatus;
}

export type ProxyType = 'http' | 'socks5';

/** GitHub/Release 数据面请求出口偏好；仅影响本设备，不参与后端/autoSync 同步。 */
export type RouteMode = 'auto' | 'backend' | 'browser';

export interface ProxyConfig {
  enabled: boolean;
  type: ProxyType;
  host: string;
  port: number;
  username?: string;
  password?: string;
}

export interface RpcDownloadConfig {
  enabled: boolean;
  host: string;
  port: number;
  secret?: string;
}

export interface SearchFilters {
  query: string;
  tags: string[];
  languages: string[];
  platforms: string[]; // 新增：平台过滤
  sortBy: 'stars' | 'updated' | 'name' | 'starred' | 'created';
  sortOrder: 'desc' | 'asc';
  minStars?: number;
  maxStars?: number;
  isAnalyzed?: boolean; // 新增：是否已AI分析
  isSubscribed?: boolean; // 新增：是否订阅Release
  isEdited?: boolean; // 新增：是否已编辑
  isCategoryLocked?: boolean; // 新增：分类是否已锁定
  analysisFailed?: boolean; // 新增：分析是否失败
  /** SPDX id 过滤；过滤面板可采用 `NO_LICENSE_SENTINEL` 表示「无/未声明 license」。 */
  licenses: string[]; // 新增：开源许可过滤
  /**
   * Repository Health 客观事实施加的筛选（见 `src/utils/repositoryHealth.ts`）。
   * 仅使用本地已存在的 `Repository` 字段，不触发额外网络请求；
   * 依赖 Release 的事实（是否有 Release、最新版本）由 Health 面板与 MCP/AI 复用，
   * 不进列表筛选——列表筛选器拿不到 Release 数组，硬塞会产生全量重渲染。
   */
  healthArchived?: boolean;
  healthRecentActivity?: boolean;
  healthHasLicense?: boolean;
}

export type CategoryMatchMode = 'legacy' | 'effective';

export interface Category {
  id: string;
  name: string;
  icon: string;
  keywords: string[];
  isCustom?: boolean;
  isHidden?: boolean;
}

export interface AssetFilter {
  id: string;
  name: string;
  keywords: string[];
  /**
   * 黑名单关键词：资产文件名命中任一关键词时，即使命中 keywords 也不匹配。
   * 用于在同平台过滤器内剔除安装包等噪声（如 "setup"、"installer"）。
   */
  excludeKeywords?: string[];
  /**
   * 始终包含的仓库（Repository.full_name）：该过滤器启用时，这些仓库的 Release
   * 无需命中关键词也会出现在筛选结果中（用于 Release 不含过滤器关键词的仓库，
   * 如仅发布 zip 或源码归档的项目）；未选过滤器时列表不受影响，也不影响订阅。
   */
  includeRepos?: string[];
  /**
   * 始终排除的仓库（Repository.full_name）：仅作用于所属过滤器。该过滤器启用时，
   * 这些仓库的 Release 不通过本过滤器（优先于本过滤器的关键词与 includeRepos），
   * 但不会否决其它已启用过滤器的命中。不复用 #405 遗留的 `excludeRepos` 键，
   * 避免历史数据被重新解释为该语义。
   */
  alwaysExcludeRepos?: string[];
  isPreset?: boolean;
  icon?: string;
}

export type HeaderMenuId = 'repositories' | 'releases' | 'subscription' | 'settings';

export interface HeaderMenuItem {
  id: HeaderMenuId;
  visible: boolean;
  order: number;
}

export const defaultHeaderMenuConfig: HeaderMenuItem[] = [
  { id: 'repositories', visible: true, order: 0 },
  { id: 'releases', visible: true, order: 1 },
  { id: 'subscription', visible: true, order: 2 },
  { id: 'settings', visible: true, order: 3 },
];

export interface AccountWorkspace {
  repositories: Repository[];
  lastSync: string | null;
  releases: Release[];
  releaseSubscriptions: number[];
  releaseSourceSettings: ReleaseSourceSettings;
  readReleases: number[];
  customCategories: Category[];
  hiddenDefaultCategoryIds: string[];
  categoryOrder: string[];
  defaultCategoryOverrides: Record<string, Partial<Category>>;
}

export interface AppState {
  // Auth
  user: GitHubUser | null;
  githubToken: string | null;
  isAuthenticated: boolean;
  hasHydrated: boolean;
  accountWorkspaces: Record<string, AccountWorkspace>;
  
  // Repositories
  repositories: Repository[];
  isLoading: boolean;
  isSyncingStars: boolean;
  lastSync: string | null;
  analyzingRepositoryIds: Set<number>;
  repositoryViewMode: 'grid' | 'list';
  /** 仓库卡片显示哪些字段（开发守则 §14）：只保存声明式开关 */
  repositoryCardFields: RepositoryCardFields;
  /** Quick-action order and toolbar visibility; hidden actions remain in the menu. */
  repositoryCardActions: RepositoryCardActionPreference[];
  /** Custom icons for plugins: mapping pluginId to built-in icon key. */
  pluginCustomIcons: Record<string, string>;

  // Theme tokens（开发守则 §14）：声明式外观偏好，落到 <html> 的 CSS 变量上
  themeTokens: ThemeTokens;

  // AI
  aiConfigs: AIConfig[];
  activeAIConfig: string | null;
  repositoryChatSettings: RepositoryChatSettings;

  // Embedding
  embeddingConfigs: EmbeddingConfig[];
  activeEmbeddingConfig: string | null;

  // Vector Search
  vectorSearchConfig: VectorSearchConfig;
  vectorSearchStatus?: VectorSearchStatus;
  vectorIndexingState: VectorIndexingState;

  // Similar repositories view (triggered by "查找相似仓库")
  similarView: SimilarViewState | null;

  // Search
  searchFilters: SearchFilters;
  searchResults: Repository[];
  
  // Releases
  releases: Release[];
  releaseSubscriptions: Set<number>;
  releaseSourceSettings: ReleaseSourceSettings;
  readReleases: Set<number>; // 新增：已读Release
  
  // Categories
  customCategories: Category[]; // 新增：自定义分类
  hiddenDefaultCategoryIds: string[];
  defaultCategoryOverrides: Record<string, Partial<Category>>;
  categoryOrder: string[]; // 新增：分类排序顺序
  collapsedSidebarCategoryCount: number; // 新增：折叠状态下显示的分类个数
  categoryMatchMode: CategoryMatchMode; // 分类匹配模式：按卡片展示标签（含自定义）或仅AI标签
  
  // Asset Filters
  assetFilters: AssetFilter[]; // 新增：资源过滤器
  
  // UI
  /** 显示模式偏好：跟随系统时由 systemTheme 解析出实际深浅 */
  themeMode: ThemeMode;
  /** 操作系统当前深浅偏好（不持久化，仅跟随 system 模式使用） */
  systemTheme: 'light' | 'dark';
  /** 主题配色预设（默认 + 内置精选），见 constants/themePresets */
  themePresetLight: ThemePresetId;
  themePresetDark: ThemePresetId;
  currentView: 'repositories' | 'releases' | 'settings' | 'subscription';
  selectedCategory: string;
  language: AppLanguage;
  /** README 文档翻译引擎（微软 / Google / AI），见 TranslationEngine */
  translationEngine: TranslationEngine;
  /** 自动翻译卡片上的仓库原始描述为界面语言（默认关闭；同语言/失败时显示原文） */
  autoTranslateRepoDescription: boolean;
  isSidebarCollapsed: boolean;
  readmeModalOpen: boolean;
  headerMenuConfig: HeaderMenuItem[];
  
  // Analysis Progress
  analysisProgress: AnalysisProgress

  // Backend
  backendApiSecret: string | null;

  // MCP (local Electron prefs; backend uses SQLite settings when available)
  mcpConfig: McpServiceConfig;

  // Network Proxy
  proxyConfig: ProxyConfig;
  rpcDownloadConfig: RpcDownloadConfig;
  /** 本地路由偏好；不参与后端/autoSync 同步 */
  routeMode: RouteMode;

  // Release Timeline View
  releaseViewMode: 'timeline' | 'repository';
  releaseShowMode: 'all' | 'unread';
  releaseLatestMode: 'all' | 'latest';
  releaseSelectedFilters: string[];
  releaseSearchQuery: string;
  releaseExpandedRepositories: Set<number>;
  releaseIsRefreshing: boolean;
  includePreRelease: boolean;  // whether to include pre-release in refresh

  // Backup/Export key inclusion preference
  includeKeysInBackup: boolean;

  // Discovery
  discoveryChannels: DiscoveryChannel[];
  discoveryRepos: Record<DiscoveryChannelId, DiscoveryRepo[]>;
  discoveryLastRefresh: Record<DiscoveryChannelId, string | null>;
  discoveryIsLoading: Record<DiscoveryChannelId, boolean>;
  discoveryIsLoadingMore: Record<DiscoveryChannelId, boolean>;
  discoveryLoadMoreError: Record<DiscoveryChannelId, string | null>;
  selectedDiscoveryChannel: DiscoveryChannelId;
  discoveryPlatform: DiscoveryPlatform;
  discoveryLanguage: ProgrammingLanguage;
  discoverySortBy: SortBy;
  discoverySortOrder: SortOrder;
  discoverySearchQuery: string;
  /** 仓库搜索模式：keyword=关键词（默认，行为不变）；semantic=AI 语义（全网仓库） */
  discoverySearchMode: 'keyword' | 'semantic';
  /** 语义搜索当前阶段（会话级，不持久化；原始阶段 id：expanding/recalling/enriching/reranking，null=不在搜索中） */
  discoverySearchPhase: string | null;
  /** 当前阶段的补充明细（如补全计数 "30/60"；会话级，不持久化） */
  discoverySearchPhaseDetail: string | null;
  /** 语义搜索空态原因（会话级，不持久化；recall_empty=召回为空，ai_empty=AI 判定空） */
  discoverySearchEmptyReason: 'recall_empty' | 'ai_empty' | null;
  discoverySelectedTopic: TopicCategory | null;
  discoveryHasMore: Record<DiscoveryChannelId, boolean>;
  discoveryNextPage: Record<DiscoveryChannelId, number>;
  discoveryTotalCount: Record<DiscoveryChannelId, number>;
  discoveryScrollPositions: Record<DiscoveryChannelId, number>;
  /** 周刊频道过滤器：仅显示已被周刊收录（issue labels 含 'weekly'）的条目 */
  weeklyOnlyCollected: boolean;
  /** 周刊频道同步进度（会话级，不持久化） */
  weeklySyncStatus: WeeklySyncStatus | null;

  // Subscription
  subscriptionRepos: Record<string, SubscriptionRepo[]>;
  subscriptionLastRefresh: Record<string, string | null>;
  subscriptionIsLoading: Record<string, boolean>;
  subscriptionChannels: SubscriptionChannel[];
}

export interface AnalysisProgress {
  current: number;
  total: number;
}

export type DiscoveryPlatform = 'All' | 'Android' | 'Macos' | 'Windows' | 'Linux';

export type ProgrammingLanguage = 
  | 'All' 
  | 'Kotlin' 
  | 'Java' 
  | 'JavaScript' 
  | 'TypeScript' 
  | 'Python' 
  | 'Swift' 
  | 'Rust' 
  | 'Go' 
  | 'CSharp' 
  | 'CPlusPlus' 
  | 'C' 
  | 'Dart' 
  | 'Ruby' 
  | 'PHP';

export type SortBy = 'BestMatch' | 'MostStars' | 'MostForks';

export type SortOrder = 'Descending' | 'Ascending';

export type DiscoveryChannelId = 'hot-release' | 'most-popular' | 'topic' | 'weekly' | 'search' | 'code-search';

export type DiscoveryChannelIcon = 'rocket' | 'star' | 'tag' | 'weekly' | 'search';

/** 阮一峰周刊频道：来源 issue 的引用信息（周刊收录 = labels 含 'weekly'） */
export interface WeeklyIssueRef {
  number: number;
  title: string;
  html_url: string;
  labels: string[];
  createdAt: string;
}

/** 周刊频道同步/详情补全进度 */
export interface WeeklySyncStatus {
  phase: 'syncing' | 'enriching';
  current: number;
  total: number;
}

export interface DiscoveryChannel {
  id: DiscoveryChannelId;
  name: string;
  nameEn: string;
  icon: DiscoveryChannelIcon;
  description: string;
  enabled: boolean;
}

export interface PaginatedDiscoveryRepositories {
  repos: DiscoveryRepo[];
  hasMore: boolean;
  nextPageIndex: number;
  totalCount?: number;
}

export interface DiscoveryRepo extends Repository {
  rank: number;
  channel: DiscoveryChannelId;
  platform: DiscoveryPlatform;
  /** 仅 weekly 频道：该仓库对应的周刊投稿 issue */
  weeklyIssue?: WeeklyIssueRef;
}

export type TopicCategory = 
  | 'ai' 
  | 'ml' 
  | 'database' 
  | 'web' 
  | 'mobile' 
  | 'devtools' 
  | 'security' 
  | 'game';

export interface TopicInfo {
  id: TopicCategory;
  name: string;
  nameEn: string;
  keywords: string;
}

// Subscription related types
export interface SubscriptionRepo extends Repository {
  rank: number;
  channel: 'most-stars' | 'most-forks' | 'most-dev';
}

export interface SubscriptionDev {
  rank: number;
  login: string;
  avatar_url: string;
  html_url: string;
  name: string | null;
  bio: string | null;
  public_repos: number;
  followers: number;
  topRepo: SubscriptionRepo | null;
}

// GitHub API response types
export interface GitHubSearchUserResponse {
  items: Array<{
    login: string;
    avatar_url: string;
    html_url: string;
  }>;
}

export interface GitHubUserDetail {
  login: string;
  avatar_url: string;
  html_url: string;
  name: string | null;
  bio: string | null;
  public_repos: number;
  followers: number;
}

// Subscription channel types
export interface SubscriptionChannel {
  id: string;
  name: string;
  nameEn: string;
  icon: string;
  description: string;
  enabled: boolean;
}

export const defaultSubscriptionChannels: SubscriptionChannel[] = [
  {
    id: 'most-stars',
    name: '最多星标',
    nameEn: 'Most Stars',
    icon: '⭐',
    description: 'GitHub 上星标数最多的项目 Top 10',
    enabled: true,
  },
  {
    id: 'most-forks',
    name: '最多复刻',
    nameEn: 'Most Forks',
    icon: '🍴',
    description: 'GitHub 上复刻数最多的项目 Top 10',
    enabled: true,
  },
  {
    id: 'most-dev',
    name: '热门开发者',
    nameEn: 'Top Developers',
    icon: '👤',
    description: 'GitHub 上最受关注的开发者 Top 10',
    enabled: true,
  },
];
