import {
  Repository,
  Release,
  GitHubUser,
  DiscoveryPlatform,
  ProgrammingLanguage,
  SortBy,
  SortOrder,
  PaginatedDiscoveryRepositories,
  DiscoveryChannelId,
  TopicCategory,
  SubscriptionRepo,
  SubscriptionDev,
  GitHubSearchUserResponse,
  GitHubUserDetail,
} from '../types';
import { logger } from './logger';
import { redactInline } from '../utils/logSanitizer';
import { isReadmeCandidateItem, type GitHubReadmeCandidateItem } from '../utils/readmeVariants';
import { createCombinedAbortController } from '../utils/abortUtils';

// 单次 fetch 尝试的超时：断网/睡眠时挂起的连接不会自行 reject，
// 没有超时会让上层同步流程永远等待，刷新按钮一直处于禁用状态。
const REQUEST_TIMEOUT_MS = 30_000;
const TIMEOUT_ERROR_MESSAGE = `GitHub API request timed out after ${REQUEST_TIMEOUT_MS}ms`;
const SAFE_METHODS = new Set(['GET', 'HEAD']);
const GITHUB_SEARCH_INTERVAL_MS = 2100;
// 发布刷新批次的总等待上限：单请求最坏约 127s（4 次 ×30s + 退避），
// 没有批次上限时持续断网会让刷新一直占住。超预算后跳过剩余仓库，
// 已完成的仓库结果照常返回，跳过的仓库不推进 watermark、下次刷新重试。
const REFRESH_BATCH_BUDGET_MS = 10 * 60_000;

/** 超时中止与用户主动取消都表现为 AbortError；父信号未中止时才算超时。 */
function isTimeoutAbort(error: unknown, parentSignal: AbortSignal | undefined): boolean {
  return (error as { name?: string } | null)?.name === 'AbortError' && !parentSignal?.aborted;
}

/** 退避等待，可被父信号中止。 */
function delayWithAbort(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeoutId);
      signal?.removeEventListener('abort', onAbort);
      reject(new Error('Aborted'));
    };
    const timeoutId = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener('abort', onAbort);
    if (signal?.aborted) onAbort();
  });
}

// Search has a separate, per-token quota bucket. Keep every /search/* caller
// on one timeline so discovery recall cannot race issue search or other tools.
let githubSearchPacingIntervalMs = GITHUB_SEARCH_INTERVAL_MS;
const nextGithubSearchAtByToken = new Map<string, number>();

/** Test hook: disable pacing for ordinary unit tests, or install a test interval. */
export function __setGithubSearchPacingForTest(intervalMs: number): void {
  githubSearchPacingIntervalMs = Math.max(0, intervalMs);
  nextGithubSearchAtByToken.clear();
}

async function waitForGithubSearchSlot(token: string, signal?: AbortSignal): Promise<void> {
  if (githubSearchPacingIntervalMs <= 0) return;
  const now = Date.now();
  const scheduledAt = Math.max(now, nextGithubSearchAtByToken.get(token) ?? 0);
  const reservedUntil = scheduledAt + githubSearchPacingIntervalMs;
  nextGithubSearchAtByToken.set(token, reservedUntil);
  if (scheduledAt <= now) return;
  try {
    await delayWithAbort(scheduledAt - now, signal);
  } catch (error) {
    // Release the unused slot if no later request has claimed it.
    if (nextGithubSearchAtByToken.get(token) === reservedUntil) {
      nextGithubSearchAtByToken.set(token, scheduledAt);
    }
    throw error;
  }
}

interface GitHubContentResponse {
  content?: string;
  encoding?: string;
  path?: string;
  sha?: string;
  size?: number;
  type?: string;
}

export interface GitHubRepositoryTreeEntry {
  path: string;
  type?: string;
  sha?: string;
  size?: number;
}

interface GitHubTreeResponse {
  sha?: string;
  tree?: GitHubRepositoryTreeEntry[];
  truncated?: boolean;
}

export interface RepositoryMetaRead {
  defaultBranch: string;
}

export interface RepositoryTreeRead {
  ref: string;
  sha?: string;
  truncated: boolean;
  entries: GitHubRepositoryTreeEntry[];
}

export interface RepositoryFileRead {
  path: string;
  ref: string;
  sha?: string;
  size: number;
  content: string;
}

/** 仓库问答 search_issues 工具使用的 Issue 搜索结果（正文已截断以限制体积）。 */
export interface RepositoryIssueSearchRead {
  number: number;
  title: string;
  state: 'open' | 'closed';
  html_url: string;
  body: string;
  comments: number;
  updated_at: string;
  labels: string[];
}

/** Issue 评论（供疑难排查场景补充解决方案摘录）。 */
export interface RepositoryIssueCommentRead {
  user: string;
  createdAt: string;
  body: string;
}

/** 仓库 issue 列表端点的原始条目（PR 条目带 isPullRequest 标记，调用方自行过滤）。 */
export interface GitHubIssueListRead {
  number: number;
  title: string;
  state: 'open' | 'closed';
  html_url: string;
  body: string | null;
  created_at: string;
  updated_at: string;
  labels: string[];
  isPullRequest: boolean;
}

/** 周刊频道补全用的仓库详情最小字段集（兼容 Repository 的子集形状）。 */
export interface GitHubRepoDetailRead {
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
  topics: string[];
  owner: { login: string; avatar_url: string };
  license: string | null;
  /** GitHub 原生状态字段：Repository Health 的客观事实来源（详情路径免费携带）。 */
  archived?: boolean;
  disabled?: boolean;
  fork?: boolean;
  is_template?: boolean;
  open_issues_count?: number;
  default_branch?: string;
}

interface GitHubStarredItem {
  starred_at?: string;
  repo?: Repository;
  [key: string]: unknown;
}

/**
 * 把 GitHub 返回的 license 值统一为 SPDX id 字符串或 null。
 * 接受 GitHub 原始对象 `{ key, spdx_id, name, url }`、已规范化的字符串、null。
 * 优先取 spdx_id（如 "MIT"），无则回退 key（如 "Other"）。
 */
function toLicenseSpdxId(license: unknown): string | null {
  if (license == null) return null;
  if (typeof license === 'string') return license.trim() || null;
  if (typeof license === 'object') {
    // 运行时校验：malformed 备份/第三方源可能把 spdx_id/key 写成非字符串
    const l = license as { spdx_id?: unknown; key?: unknown };
    const spdx = typeof l.spdx_id === 'string' ? l.spdx_id.trim() : '';
    const key = typeof l.key === 'string' ? l.key.trim() : '';
    return spdx || key || null;
  }
  return null;
}

interface GitHubRateLimitResponse {
  rate: {
    remaining: number;
    reset: number;
  };
}

/** 把 REST issue 条目归一化为 GitHubIssueListRead（labels 对象数组展开为 name）。 */
function mapRestIssueListItem(item: Record<string, unknown>): GitHubIssueListRead {
  const labels = Array.isArray(item.labels)
    ? item.labels.map((label) => {
        if (label && typeof label === 'object' && typeof (label as { name?: unknown }).name === 'string') return (label as { name: string }).name;
        return '';
      }).filter(Boolean)
    : [];
  return {
    number: typeof item.number === 'number' ? item.number : 0,
    title: typeof item.title === 'string' ? item.title : '',
    state: item.state === 'closed' ? 'closed' : 'open',
    html_url: typeof item.html_url === 'string' ? item.html_url : '',
    body: typeof item.body === 'string' ? item.body : null,
    created_at: typeof item.created_at === 'string' ? item.created_at : '',
    updated_at: typeof item.updated_at === 'string' ? item.updated_at : '',
    labels,
    isPullRequest: item.pull_request != null,
  };
}

/** 把 REST /repos/{owner}/{repo} 响应归一化为 GitHubRepoDetailRead。 */
function mapRestRepoDetail(data: Record<string, unknown>): GitHubRepoDetailRead {
  const owner = (data.owner as { login?: unknown; avatar_url?: unknown } | undefined) ?? {};
  return {
    id: typeof data.id === 'number' ? data.id : 0,
    name: typeof data.name === 'string' ? data.name : '',
    full_name: typeof data.full_name === 'string' ? data.full_name : '',
    description: typeof data.description === 'string' ? data.description : null,
    html_url: typeof data.html_url === 'string' ? data.html_url : '',
    stargazers_count: typeof data.stargazers_count === 'number' ? data.stargazers_count : 0,
    forks_count: typeof data.forks_count === 'number' ? data.forks_count : 0,
    forks: typeof data.forks === 'number' ? data.forks : 0,
    language: typeof data.language === 'string' ? data.language : null,
    created_at: typeof data.created_at === 'string' ? data.created_at : '',
    updated_at: typeof data.updated_at === 'string' ? data.updated_at : '',
    pushed_at: typeof data.pushed_at === 'string' ? data.pushed_at : '',
    topics: Array.isArray(data.topics) ? data.topics.filter((t): t is string => typeof t === 'string') : [],
    owner: {
      login: typeof owner.login === 'string' ? owner.login : '',
      avatar_url: typeof owner.avatar_url === 'string' ? owner.avatar_url : '',
    },
    license: toLicenseSpdxId(data.license),
    archived: data.archived === true,
    disabled: data.disabled === true,
    fork: data.fork === true,
    is_template: data.is_template === true,
    open_issues_count: typeof data.open_issues_count === 'number' ? data.open_issues_count : 0,
    default_branch: typeof data.default_branch === 'string' ? data.default_branch : '',
  };
}

/** 把 GraphQL Repository 节点归一化为 GitHubRepoDetailRead。 */
function mapGraphqlRepoDetail(node: Record<string, unknown>): GitHubRepoDetailRead {
  const owner = (node.owner as { login?: unknown; avatarUrl?: unknown } | undefined) ?? {};
  const primaryLanguage = node.primaryLanguage as { name?: unknown } | null | undefined;
  const licenseInfo = node.licenseInfo as { spdxId?: unknown } | null | undefined;
  const topics: string[] = [];
  const topicNodes = (node.repositoryTopics as { nodes?: Array<{ topic?: { name?: unknown } }> } | null | undefined)?.nodes;
  if (Array.isArray(topicNodes)) {
    for (const topicNode of topicNodes) {
      const name = topicNode?.topic?.name;
      if (typeof name === 'string' && name) topics.push(name);
    }
  }
  return {
    id: typeof node.databaseId === 'number' ? node.databaseId : 0,
    name: typeof node.name === 'string' ? node.name : '',
    full_name: typeof node.nameWithOwner === 'string' ? node.nameWithOwner : '',
    description: typeof node.description === 'string' ? node.description : null,
    html_url: typeof node.url === 'string' ? node.url : '',
    stargazers_count: typeof node.stargazerCount === 'number' ? node.stargazerCount : 0,
    forks_count: typeof node.forkCount === 'number' ? node.forkCount : 0,
    forks: typeof node.forkCount === 'number' ? node.forkCount : 0,
    language: primaryLanguage && typeof primaryLanguage.name === 'string' ? primaryLanguage.name : null,
    created_at: typeof node.createdAt === 'string' ? node.createdAt : '',
    updated_at: typeof node.updatedAt === 'string' ? node.updatedAt : '',
    pushed_at: typeof node.pushedAt === 'string' ? node.pushedAt : '',
    topics,
    owner: {
      login: typeof owner.login === 'string' ? owner.login : '',
      avatar_url: typeof owner.avatarUrl === 'string' ? owner.avatarUrl : '',
    },
    license: licenseInfo && typeof licenseInfo.spdxId === 'string' ? licenseInfo.spdxId : null,
    archived: node.isArchived === true,
    disabled: node.isDisabled === true,
    fork: node.isFork === true,
    is_template: node.isTemplate === true,
    // GraphQL schema 已移除 openIssues 字段，fragment 改请求 issues(states: OPEN) { totalCount }，
    // 语义等价（均只统计 open issue）；字段缺省时兜底为 0，与 REST 路径 mapRestRepoDetail 一致
    open_issues_count:
      typeof (node.issues as { totalCount?: unknown } | undefined)?.totalCount === 'number'
        ? (node.issues as { totalCount: number }).totalCount
        : 0,
    default_branch:
      typeof (node.defaultBranchRef as { name?: unknown } | null | undefined)?.name === 'string'
        ? (node.defaultBranchRef as { name: string }).name
        : '',
  };
}

const GITHUB_API_BASE = 'https://api.github.com';
// 会话级 403 去重：README/Release/Gist 等生产路径按操作新建 service 实例，
// 实例级状态会让同一 403 在同一会话内重复 warn。按「凭据 + 后端上下文」的
// 非敏感指纹分桶（指纹仅用于判断凭据是否变化，绝不写入日志），凭据切换后
// 自然换桶重新 warn。
const warned403RequestsByContext = new Map<string, Set<string>>();
const credentialContextFingerprint = (value: string): string => {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
};

/** 仅供测试重置会话级 403 去重状态，避免模块级状态跨用例泄漏。 */
export function __reset403WarnStateForTest(): void {
  warned403RequestsByContext.clear();
}
// Sentinel message for the 401 thrown above; callers match on it to tell a
// confirmed auth failure apart from network/rate-limit/5xx errors.
export const GITHUB_TOKEN_INVALID_ERROR = 'GitHub token expired or invalid';

/** GitHub accepted the token, but it lacks permission for this request. */
export class GitHubTokenPermissionError extends Error {
  constructor() {
    super('Resource not accessible by personal access token');
    this.name = 'GitHubTokenPermissionError';
  }
}
// Sentinel for 401s produced by the backend proxy's own auth middleware (its
// body carries code: 'UNAUTHORIZED'). Kept distinct from the GitHub sentinel
// so callers can tell a stale backend API key from a dead GitHub token.
export const BACKEND_PROXY_UNAUTHORIZED_ERROR = 'Backend API key was rejected. Please check your backend settings';
const REPOSITORY_CHAT_MAX_FILE_BYTES = 96 * 1024;
// Larger Markdown files are common repository documentation. This bounded exception is
// deliberately narrower than the normal chat-file reader: only non-sensitive Markdown
// can use it, it remains pinned to the caller's SHA, and repository chat exposes only
// line-ranged excerpts to the model.
const REPOSITORY_CHAT_MAX_MARKDOWN_EVIDENCE_BYTES = 512 * 1024;
const REPOSITORY_CHAT_MARKDOWN_EXTENSIONS = new Set(['.md', '.mdx', '.markdown', '.txt']);
const REPOSITORY_CHAT_ALLOWED_EXTENSIONS = new Set([
  '.md', '.mdx', '.markdown', '.txt', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.yaml', '.yml', '.toml',
  '.py', '.go', '.rs', '.java', '.kt', '.rb', '.php', '.cs', '.c', '.h', '.cpp', '.hpp', '.vue', '.svelte',
  '.html', '.css', '.scss', '.sql', '.graphql', '.gql', '.sh', '.bash', '.zsh', '.xml', '.ini', '.properties',
]);
const REPOSITORY_CHAT_SENSITIVE_PATH = /(^|\/)(?:\.env(?:\.[^/]*)?|[^/]*(?:secret|credential|private[_-]?key|id_rsa)[^/]*|[^/]*\.(?:pem|p12|pfx|key))(?:$|\/)/i;
const REPOSITORY_CHAT_LOCK_FILE = /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|composer\.lock|cargo\.lock|poetry\.lock)$/i;
const REPOSITORY_CHAT_MINIFIED_FILE = /\.min\.(?:js|css)$/i;

const isRepositoryChatSensitivePath = (path: string): boolean => {
  const pathSegments = path.split('/');
  const fileName = pathSegments[pathSegments.length - 1] || path;
  const fileNameSegments = fileName.split('.');
  const extension = fileName.includes('.') ? `.${fileNameSegments[fileNameSegments.length - 1]}`.toLowerCase() : '';
  return REPOSITORY_CHAT_SENSITIVE_PATH.test(path)
    || REPOSITORY_CHAT_LOCK_FILE.test(path)
    || REPOSITORY_CHAT_MINIFIED_FILE.test(path)
    || !REPOSITORY_CHAT_ALLOWED_EXTENSIONS.has(extension);
};

interface GitHubSearchRepoResponse {
  items: (Repository & { forks_count?: number })[];
  total_count: number;
}
export interface ReleaseFetchOptions {

  includePreRelease?: boolean;
  /**
   * 开启后，对已同步仓库额外检测“每仓最新一条 Release”的资产指纹是否变化，
   * 并把“资产已变化但 id 已存在”的条目放入 updatedReleases，供调用方按 id 合并更新。
   * 不产生额外网络请求：最新一条 Release 由增量分支第一页（per_page=10）即可获得。
   */
  refreshExistingAssets?: boolean;
}

export interface MultipleReleasesResult {
  /** 新增（本地不存在的 id）的 Release */
  releases: Release[];
  /**
   * 已同步仓库“最新一条”Release（仅当 refreshExistingAssets 开启时收集）。
   * 用于调用方与本地存储做资产指纹比对，指纹变化则合并更新资产并重置为未读。
   */
  latestReleases?: Release[];
  failedRepos: { repoId: number; full_name: string; error: string }[];
}


/** GitHub 搜索的裸布尔操作符：不可信关键词中一律丢弃，防止改变查询语义。 */
const SEARCH_BOOLEAN_OPERATORS = new Set(['or', 'and', 'not']);

export class GitHubApiService {
  private token: string;
  private rateLimitRemaining: number | null = null;
  private rateLimitReset: number | null = null;
  private backendUrl: string | null = null;
  private backendAuthToken: string | null = null;

  constructor(token: string) {
    this.token = token;
  }

  /**
   * 设置后端代理地址。设置后所有请求（makeRequest / getGistFileRaw）将
   * 通过服务器的 /api/proxy/github/* 路由转发，从而走用户配置的代理。
   * 传 null 恢复直连模式。
   */
  setBackendUrl(url: string | null): void {
    this.backendUrl = url;
  }

  setBackendAuthToken(token: string | null): void {
    this.backendAuthToken = token;
  }

  private getBackendHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.backendAuthToken) {
      headers.Authorization = `Bearer ${this.backendAuthToken}`;
    }
    return headers;
  }

  // 403 多来自无 token/低速率限制的周期性探测，属于持续噪音：同一（凭据上下文,
  // 后端路由, method, endpoint, 失败原因）只 warn 一次，重复失败降级为 debug。
  // 键含失败原因，新出现的不同 403 成因仍可 warn。仅影响日志，不改变抛错行为。
  private log403Failure(
    message: string,
    meta: { method: string; endpoint: string; status: number; durationMs: number },
  ): void {
    // message 可能来自代理/后端响应体，写入日志与去重键前先做内联脱敏。
    const safeMessage = redactInline(message);
    const contextKey = credentialContextFingerprint(
      `${this.token}\u0000${this.backendAuthToken ?? ''}\u0000${this.backendUrl ?? ''}`,
    );
    let warned403Requests = warned403RequestsByContext.get(contextKey);
    if (!warned403Requests) {
      warned403Requests = new Set();
      warned403RequestsByContext.set(contextKey, warned403Requests);
    }
    const warnKey = `${this.backendUrl ?? 'direct'} ${meta.method} ${meta.endpoint} ${safeMessage}`;
    if (warned403Requests.has(warnKey)) {
      logger.debug('githubApi', `${safeMessage} (deduplicated)`, meta);
    } else {
      warned403Requests.add(warnKey);
      logger.warn('githubApi', safeMessage, meta);
    }
  }

  private async makeRequest<T>(endpoint: string, options: RequestInit & { operationTag?: string } = {}, signal?: AbortSignal): Promise<T> {
    const startTime = Date.now();
    const method = (options.method || 'GET') as string;
    const { operationTag, ...fetchOptions } = options;
    // Search API 有独立配额桶（认证态 30/min），核心桶的剩余量/重置时间对它不适用：
    // 共用状态会让多查询召回每条都等满一个重置窗口，也会让 search 的剩余量污染核心桶。
    const isSearchEndpoint = endpoint.startsWith('/search/');
    if (isSearchEndpoint) {
      await waitForGithubSearchSlot(this.token, signal);
    }

    // Check rate limit before making request
    if (!isSearchEndpoint && this.rateLimitRemaining !== null && this.rateLimitRemaining < 100 && this.rateLimitReset !== null) {
      const waitMs = (this.rateLimitReset * 1000) - Date.now();
      if (waitMs > 0) {
        logger.warn('githubApi', 'Rate limit low, waiting for reset', { remaining: this.rateLimitRemaining, resetTime: this.rateLimitReset });
        // Honor abort signal during rate limit wait
        await new Promise<void>((resolve, reject) => {
          const timeoutId = setTimeout(() => resolve(), waitMs + 1000);
          const signalHandler = () => {
            clearTimeout(timeoutId);
            reject(new Error('Aborted'));
          };
          signal?.addEventListener('abort', signalHandler);
          // Also check if already aborted
          if (signal?.aborted) {
            clearTimeout(timeoutId);
            signal?.removeEventListener('abort', signalHandler);
            reject(new Error('Aborted'));
          }
        }).catch(err => {
          if (err.message === 'Aborted') throw err;
        });
      }
    }

    // GitHub 的 gist 等端点偶发 502/503/504（网关瞬时故障），这里对 5xx 做指数退避重试，
    // 退避策略与 backendAdapter.fetchWithRetry 保持一致（1s/2s/4s，最多重试 3 次）。
    const maxRetries = 3;
    const isSafeMethod = SAFE_METHODS.has(method.toUpperCase());
    let response: Response | undefined;
    let data: T | null | undefined;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const viaProxy = this.backendUrl != null;
      // 每次尝试独立超时：超时上限不被重试+退避消耗（与 githubListsApi 一致）
      const timeoutController = createCombinedAbortController(signal, REQUEST_TIMEOUT_MS);
      try {
        if (this.backendUrl) {
          // 通过后端代理路由：POST {backendUrl}/proxy/github/{endpoint}?query
          // 服务端负责加鉴权头 + 读取代理配置 + 转发，所以客户端不再传 Authorization。
          const proxyUrl = `${this.backendUrl}/proxy/github${endpoint}`;
          const proxyBody: Record<string, unknown> = { method };
          const requestHeaders = fetchOptions.headers as Record<string, string> | undefined;
          // 转发必要头（如 starred repos 需要 star+json，POST/PATCH 需要 JSON Content-Type）
          const acceptHeader = requestHeaders?.Accept || requestHeaders?.accept;
          const contentTypeHeader = requestHeaders?.['Content-Type'] || requestHeaders?.['content-type'];
          const proxyHeaders: Record<string, string> = {};
          if (acceptHeader) proxyHeaders.Accept = acceptHeader;
          if (contentTypeHeader) proxyHeaders['Content-Type'] = contentTypeHeader;
          if (Object.keys(proxyHeaders).length > 0) proxyBody.headers = proxyHeaders;
          if (fetchOptions.body) proxyBody.body = fetchOptions.body;

          response = await fetch(proxyUrl, {
            method: 'POST',
            signal: timeoutController.signal,
            headers: this.getBackendHeaders(),
            body: JSON.stringify(proxyBody),
          });
        } else {
          response = await fetch(`${GITHUB_API_BASE}${endpoint}`, {
            ...fetchOptions,
            signal: timeoutController.signal,
            headers: {
              'Authorization': `Bearer ${this.token}`,
              'Accept': 'application/vnd.github.v3+json',
              'X-GitHub-Api-Version': '2022-11-28',
              ...fetchOptions.headers,
            },
          });
        }
      } catch (caughtError) {
        const timedOut = isTimeoutAbort(caughtError, signal);
        const fetchError = timedOut ? new Error(TIMEOUT_ERROR_MESSAGE) : caughtError;
        const durationMs = Date.now() - startTime;
        // 非幂等请求超时可能已在服务端生效，重试会造成重复副作用
        // （如重复创建 gist / 重复触发 workflow），直接抛出。
        if (timedOut && !isSafeMethod) {
          logger.error('githubApi', 'API request timed out, not retrying non-idempotent method', { method, endpoint, durationMs, attempt: attempt + 1 });
          throw fetchError;
        }
        // 网络错误（连接断开、DNS 超时、socket hang-up 等）视为可重试的瞬时故障，
        // 仅在最后一次尝试时抛出；之前的尝试会继续走指数退避重试。
        if (attempt === maxRetries || signal?.aborted) {
          logger.error('githubApi', 'API request network error', { method, endpoint, durationMs, attempt: attempt + 1, maxRetries: maxRetries + 1, error: fetchError instanceof Error ? fetchError.message : String(fetchError) });
          throw fetchError;
        }
        logger.warn('githubApi', 'API request network error, retrying', { method, endpoint, attempt: attempt + 1, maxRetries: maxRetries + 1, durationMs, error: fetchError instanceof Error ? fetchError.message : String(fetchError) });
        const delayMs = Math.min(1000 * Math.pow(2, attempt), 4000);
        await delayWithAbort(delayMs, signal);
        continue;
      }

      // Parse rate limit headers
      const remaining = response.headers.get('X-RateLimit-Remaining');
      const reset = response.headers.get('X-RateLimit-Reset');
      if (!isSearchEndpoint && remaining !== null) {
        this.rateLimitRemaining = parseInt(remaining, 10);
      }
      if (!isSearchEndpoint && reset !== null) {
        this.rateLimitReset = parseInt(reset, 10);
      }

      if (response.ok) {
        try {
          data = response.status === 204 ? null : await response.json() as T;
          break;
        } catch (bodyError) {
          const timedOut = isTimeoutAbort(bodyError, signal);
          // 响应体停滞同样只对幂等读请求重试；写请求可能已成功，不能重放。
          if (!timedOut || !isSafeMethod || attempt === maxRetries || signal?.aborted) {
            throw timedOut ? new Error(TIMEOUT_ERROR_MESSAGE) : bodyError;
          }
          logger.warn('githubApi', 'API response body timed out, retrying', { method, endpoint, attempt: attempt + 1, maxRetries: maxRetries + 1 });
          await delayWithAbort(Math.min(1000 * Math.pow(2, attempt), 4000), signal);
          continue;
        }
      }

      const durationMs = Date.now() - startTime;
      if (response.status === 401) {
        logger.warn('githubApi', 'API request failed: unauthorized', { method, endpoint, status: response.status, durationMs });
        if (viaProxy) {
          // The proxy forwards upstream GitHub bodies verbatim, while the
          // backend's own auth middleware marks its 401s with code
          // 'UNAUTHORIZED'. Only the latter is a backend API key problem.
          let body: { code?: string } | null = null;
          try {
            body = await response.json() as { code?: string } | null;
          } catch (bodyError) {
            // 响应体读取超时不能吞成 "token 无效"，如实抛超时错误。
            if (isTimeoutAbort(bodyError, signal)) throw new Error(TIMEOUT_ERROR_MESSAGE);
          }
          if (body?.code === 'UNAUTHORIZED') {
            throw new Error(BACKEND_PROXY_UNAUTHORIZED_ERROR);
          }
        }
        throw new Error(GITHUB_TOKEN_INVALID_ERROR);
      }
      if (response.status === 403 && remaining === '0') {
        // Search has its own quota bucket: read the reset from the current
        // response, since this.rateLimitReset only tracks the core bucket.
        const resetEpoch = isSearchEndpoint ? parseInt(reset ?? '', 10) : this.rateLimitReset;
        const resetDate = resetEpoch
          ? new Date(resetEpoch * 1000).toLocaleString()
          : 'unknown';
        this.log403Failure('API request failed: rate limit exceeded', { method, endpoint, status: response.status, durationMs });
        throw new Error(`GitHub API rate limit exceeded. Resets at ${resetDate}`);
      }
      if (response.status === 403) {
        const body = await response.clone().json().catch(() => null) as { message?: string } | null;
        if (body?.message === 'Resource not accessible by personal access token') {
          this.log403Failure('API request failed: token permission', { method, endpoint, status: response.status, durationMs });
          throw new GitHubTokenPermissionError();
        }
      }

      // 5xx 视为可重试的瞬时故障；其余 4xx 直接抛出（重试无意义）。
      const isRetryable = response.status >= 500 && response.status <= 599;
      if (!isRetryable || attempt === maxRetries) {
        const failureMeta = { method, endpoint, status: response.status, durationMs };
        if (response.status === 403) {
          // 与 log403Failure 的键约定一致：失败原因取响应体 message，不同成因各自 warn 一次。
          const failureBody = await response.clone().json().catch(() => null) as { message?: string } | null;
          this.log403Failure(failureBody?.message || 'API request failed', failureMeta);
        } else {
          logger.warn('githubApi', 'API request failed', failureMeta);
        }
        throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
      }

      // 重试前若请求已被取消，则不再等待，直接以当前失败状态抛出。
      if (signal?.aborted) {
        logger.warn('githubApi', 'API request aborted before retry', { method, endpoint, status: response.status });
        throw new Error('Aborted');
      }
      const delayMs = Math.min(1000 * Math.pow(2, attempt), 4000);
      logger.warn('githubApi', 'API request failed, retrying', { method, endpoint, status: response.status, attempt: attempt + 1, maxRetries: maxRetries + 1, delayMs, durationMs });
      await delayWithAbort(delayMs, signal);
    }

    // 循环正常退出时 response 一定已赋值（最后一次成功 break 或在循环内抛出）。
    const finalResponse = response!;

    if (logger.isDebugMode()) {
      // Capture request headers (mask auth)
      const requestHeaders: Record<string, string> = {
        'Authorization': 'Bearer ***',
        'Accept': 'application/vnd.github.v3+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(options.headers as Record<string, string> || {}),
      };
      // Capture response headers
      const responseHeaders: Record<string, string> = {};
      finalResponse.headers.forEach((v, k) => { responseHeaders[k] = v; });
      // Capture response body preview (clone to avoid consuming)
      let responseBody: string | undefined;
      try {
        const cloned = finalResponse.clone();
        const text = await cloned.text();
        if (text.length > 0) {
          responseBody = text.length > 4000 ? text.slice(0, 4000) + '...[truncated]' : text;
        }
      } catch { /* body not readable */ }
      logger.debug('githubApi', 'API request', {
        method, endpoint, status: finalResponse.status, durationMs: Date.now() - startTime,
        rateLimitRemaining: finalResponse.headers.get('x-ratelimit-remaining'),
        requestHeaders, responseHeaders, responseBody,
        ...(operationTag ? { operationTag } : {}),
      });
    }

    // 如果是starred repositories的响应，需要处理特殊格式
    if (endpoint.includes('/user/starred') && Array.isArray(data)) {
      return (data as GitHubStarredItem[]).map((item) => {
        // 如果使用了star+json格式，数据结构会不同
        if (item.starred_at && item.repo) {
          return {
            ...item.repo,
            // 归一化 GitHub 的 license 值（对象/字符串/null）为 SPDX id 字符串或 null
            license: toLicenseSpdxId(item.repo.license),
            starred_at: item.starred_at
          };
        }
        return {
          ...item,
          license: toLicenseSpdxId(item.license),
        };
      }) as T;
    }

    return data as T;
  }

  async getCurrentUser(): Promise<GitHubUser> {
    return this.makeRequest<GitHubUser>('/user');
  }

  async getStarredRepositories(page = 1, perPage = 100): Promise<Repository[]> {
    const repos = await this.makeRequest<Repository[]>(
      `/user/starred?page=${page}&per_page=${perPage}&sort=updated`,
      {
        headers: {
          'Accept': 'application/vnd.github.star+json'
        }
      }
    );
    return repos;
  }

  async getAllStarredRepositories(): Promise<Repository[]> {
    let allRepos: Repository[] = [];
    let page = 1;
    const perPage = 100;

    while (true) {
      const repos = await this.getStarredRepositories(page, perPage);
      if (repos.length === 0) break;

      allRepos = [...allRepos, ...repos];

      if (repos.length < perPage) break;
      page++;

      // Rate limiting protection
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    return allRepos;
  }

  async getWatchedRepositories(page = 1, perPage = 100): Promise<Repository[]> {
    // GitHub 对 watched repos 同样返回原始 license 对象，这里统一归一化为 SPDX id / null，
    // 与 /user/starred 路径保持一致，避免下游 normalizeLicense 拿到对象时崩溃。
    // 空响应体（204）会被 makeRequest 归一化为 null，这里按空列表处理，避免 .map 抛错拖垮同步。
    const repos = await this.makeRequest<Repository[] | null>(`/user/subscriptions?page=${page}&per_page=${perPage}`);
    return (repos ?? []).map((repo) => ({ ...repo, license: toLicenseSpdxId(repo.license) }));
  }

  async getAllWatchedRepositories(): Promise<Repository[]> {
    let allRepos: Repository[] = [];
    let page = 1;
    const perPage = 100;

    while (true) {
      const repos = await this.getWatchedRepositories(page, perPage);
      if (repos.length === 0) break;

      allRepos = [...allRepos, ...repos];

      if (repos.length < perPage) break;
      page++;

      await new Promise(resolve => setTimeout(resolve, 100));
    }

    return allRepos;
  }

  private decodeContentResponse(response: GitHubContentResponse): string {
    if (response.encoding === 'base64' && response.content) {
      // 使用 TextDecoder 正确处理 UTF-8 编码，避免中文乱码
      const binaryString = atob(response.content.replace(/\s/g, ''));
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      return new TextDecoder('utf-8').decode(bytes);
    }
    return response.content || '';
  }

  private encodeContentPath(path: string): string {
    return path.split('/').map(encodeURIComponent).join('/');
  }

  async getRepositoryMeta(owner: string, repo: string, signal?: AbortSignal): Promise<RepositoryMetaRead> {
    const response = await this.makeRequest<{ default_branch?: unknown }>(
      `/repos/${owner}/${repo}`,
      { operationTag: 'repository-chat:meta' },
      signal,
    );
    if (typeof response.default_branch !== 'string' || !response.default_branch.trim()) {
      throw new Error('GitHub did not return a default branch for this repository');
    }
    return { defaultBranch: response.default_branch };
  }

  async getRepositoryHeadSha(owner: string, repo: string, branch: string, signal?: AbortSignal): Promise<string> {
    const response = await this.makeRequest<{ sha?: unknown }>(
      `/repos/${owner}/${repo}/commits/${encodeURIComponent(branch)}`,
      { operationTag: 'repository-chat:head-sha' },
      signal,
    );
    if (typeof response.sha !== 'string' || !response.sha.trim()) {
      throw new Error('GitHub did not return a commit SHA for the default branch');
    }
    return response.sha;
  }

  async getRepositoryTree(owner: string, repo: string, ref: string, signal?: AbortSignal): Promise<RepositoryTreeRead> {
    const response = await this.makeRequest<GitHubTreeResponse>(
      `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
      { operationTag: 'repository-chat:tree' },
      signal,
    );
    return {
      ref,
      sha: response.sha,
      truncated: response.truncated === true,
      entries: Array.isArray(response.tree) ? response.tree.filter((entry) => typeof entry.path === 'string') : [],
    };
  }

  async getRepositoryFile(owner: string, repo: string, path: string, ref: string, signal?: AbortSignal): Promise<RepositoryFileRead> {
    const normalizedPath = path.replace(/^\/+/, '');
    if (!normalizedPath || normalizedPath.includes('..') || normalizedPath.includes('\\')) {
      throw new Error('Invalid repository file path');
    }
    if (isRepositoryChatSensitivePath(normalizedPath)) {
      throw new Error('This file is excluded from repository chat for safety');
    }

    const response = await this.makeRequest<GitHubContentResponse>(
      `/repos/${owner}/${repo}/contents/${this.encodeContentPath(normalizedPath)}?ref=${encodeURIComponent(ref)}`,
      { operationTag: 'repository-chat:file' },
      signal,
    );
    if (response.type && response.type !== 'file') {
      throw new Error('The requested repository path is not a text file');
    }
    if (typeof response.size === 'number' && response.size > REPOSITORY_CHAT_MAX_FILE_BYTES) {
      throw new Error('The requested file exceeds the 96 KB repository chat limit');
    }

    const content = this.decodeContentResponse(response);
    const contentSize = new TextEncoder().encode(content).byteLength;
    if (contentSize > REPOSITORY_CHAT_MAX_FILE_BYTES) {
      throw new Error('The requested file exceeds the 96 KB repository chat limit');
    }
    return {
      path: response.path || normalizedPath,
      ref,
      sha: response.sha,
      size: typeof response.size === 'number' ? response.size : contentSize,
      content,
    };
  }

  async getRepositoryMarkdownEvidenceFile(owner: string, repo: string, path: string, ref: string, signal?: AbortSignal): Promise<RepositoryFileRead> {
    const normalizedPath = path.replace(/^\/+/, '');
    if (!normalizedPath || normalizedPath.includes('..') || normalizedPath.includes('\\')) {
      throw new Error('Invalid repository file path');
    }
    if (isRepositoryChatSensitivePath(normalizedPath)) {
      throw new Error('This file is excluded from repository chat for safety');
    }
    const fileName = normalizedPath.split('/').pop() || normalizedPath;
    const extension = fileName.includes('.') ? `.${fileName.split('.').pop()}`.toLowerCase() : '';
    if (!REPOSITORY_CHAT_MARKDOWN_EXTENSIONS.has(extension)) {
      throw new Error('The requested repository evidence path is not Markdown text');
    }

    const response = await this.makeRequest<GitHubContentResponse>(
      `/repos/${owner}/${repo}/contents/${this.encodeContentPath(normalizedPath)}?ref=${encodeURIComponent(ref)}`,
      { operationTag: 'repository-chat:markdown-evidence' },
      signal,
    );
    if (response.type && response.type !== 'file') {
      throw new Error('The requested repository path is not a text file');
    }
    if (typeof response.size === 'number' && response.size > REPOSITORY_CHAT_MAX_MARKDOWN_EVIDENCE_BYTES) {
      throw new Error('The requested Markdown file exceeds the 512 KB repository chat evidence limit');
    }

    const content = this.decodeContentResponse(response);
    const contentSize = new TextEncoder().encode(content).byteLength;
    if (contentSize > REPOSITORY_CHAT_MAX_MARKDOWN_EVIDENCE_BYTES) {
      throw new Error('The requested Markdown file exceeds the 512 KB repository chat evidence limit');
    }
    return {
      path: response.path || normalizedPath,
      ref,
      sha: response.sha,
      size: typeof response.size === 'number' ? response.size : contentSize,
      content,
    };
  }

  async getRepositoryReadme(owner: string, repo: string, signal?: AbortSignal): Promise<string> {
    try {
      const response = await this.makeRequest<GitHubContentResponse>(
        `/repos/${owner}/${repo}/readme`,
        undefined,
        signal
      );

      return this.decodeContentResponse(response);
    } catch (error) {
      logger.warn('githubApi', `Failed to fetch README for ${owner}/${repo}`, error);
      return '';
    }
  }

  async listRepositoryReadmeCandidates(owner: string, repo: string, defaultBranch?: string, signal?: AbortSignal): Promise<GitHubReadmeCandidateItem[]> {
    const fetchRootContents = async (): Promise<GitHubReadmeCandidateItem[]> => {
      const rootItems = await this.makeRequest<GitHubReadmeCandidateItem[]>(
        `/repos/${owner}/${repo}/contents`,
        undefined,
        signal
      );
      return rootItems.filter(isReadmeCandidateItem);
    };

    let branch = defaultBranch;
    if (!branch) {
      try {
        const repoDetails = await this.makeRequest<{ default_branch?: string }>(
          `/repos/${owner}/${repo}`,
          undefined,
          signal
        );
        branch = repoDetails.default_branch;
      } catch (error) {
        logger.warn('githubApi', `Failed to fetch default branch for ${owner}/${repo}`, error);
      }
    }

    if (!branch) {
      try {
        return await fetchRootContents();
      } catch (error) {
        logger.warn('githubApi', `Failed to list README candidates for ${owner}/${repo}`, error);
        return [];
      }
    }

    try {
      const tree = await this.makeRequest<GitHubTreeResponse>(
        `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
        undefined,
        signal
      );
      const candidates = (tree.tree || []).filter(isReadmeCandidateItem);
      if (tree.truncated) {
        logger.warn('githubApi', `README candidate tree was truncated for ${owner}/${repo}`);
        if (candidates.length === 0) return await fetchRootContents();
      }
      return candidates;
    } catch (error) {
      logger.warn('githubApi', `Failed to list README candidates from tree for ${owner}/${repo}`, error);
      try {
        return await fetchRootContents();
      } catch (contentsError) {
        logger.warn('githubApi', `Failed to list README candidates from root contents for ${owner}/${repo}`, contentsError);
        return [];
      }
    }
  }

  async getRepositoryReadmeByPath(owner: string, repo: string, path: string, signal?: AbortSignal): Promise<string> {
    try {
      const response = await this.makeRequest<GitHubContentResponse>(
        `/repos/${owner}/${repo}/contents/${this.encodeContentPath(path)}`,
        undefined,
        signal
      );

      return this.decodeContentResponse(response);
    } catch (error) {
      logger.warn('githubApi', `Failed to fetch README ${path} for ${owner}/${repo}`, error);
      return '';
    }
  }

  async getRepositoryReleasesPage(
    owner: string,
    repo: string,
    page = 1,
    perPage = 30,
    signal?: AbortSignal,
  ): Promise<{ releases: Release[]; hasMore: boolean }> {
    try {
      const rawReleases = await this.makeRequest<Array<Release & { draft?: boolean; published_at: string | null }>>(
        `/repos/${owner}/${repo}/releases?page=${page}&per_page=${perPage}`,
        { operationTag: 'release' },
        signal,
      );

      return {
        releases: rawReleases
          .filter((release) => release.draft !== true && typeof release.published_at === 'string')
          .map(release => ({
            id: release.id,
            tag_name: release.tag_name,
            name: release.name || release.tag_name,
            body: release.body || '',
            published_at: release.published_at,
            html_url: release.html_url,
            assets: release.assets || [],
            zipball_url: release.zipball_url,
            tarball_url: release.tarball_url,
            prerelease: release.prerelease ?? false,
            repository: {
              id: 0,
              full_name: `${owner}/${repo}`,
              name: repo,
            },
          })),
        hasMore: rawReleases.length === perPage,
      };
    } catch (error) {
      logger.warn('githubApi', `Failed to fetch releases for ${owner}/${repo}`, error);
      throw error;
    }
  }

  async getRepositoryReleases(
    owner: string,
    repo: string,
    page = 1,
    perPage = 30,
    signal?: AbortSignal,
  ): Promise<Release[]> {
    const result = await this.getRepositoryReleasesPage(owner, repo, page, perPage, signal);
    return result.releases;
  }

  /**
   * Fetch all releases for a repository with pagination.
   * New repos (never synced) use this for full sync - paginates until exhausted.
   */
  async fetchAllReleasesForRepo(owner: string, repo: string): Promise<Release[]> {
    const allReleases: Release[] = [];
    let page = 1;

    while (true) {
      const { releases, hasMore } = await this.getRepositoryReleasesPage(owner, repo, page, 30);

      allReleases.push(...releases);

      if (!hasMore) break;
      page++;

      // Rate limiting protection between pages
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    return allReleases;
  }

  /**
   * 按关键词搜索仓库 Issue（open + closed，best-match 排序）。
   * 供仓库问答的 search_issues 工具使用：search API 有独立限速（认证后
   * 30 次/分钟），调用方每轮最多发起一次。
   */
  async searchRepositoryIssues(
    owner: string,
    repo: string,
    keywords: string[],
    options: { perPage?: number; signal?: AbortSignal } = {},
  ): Promise<RepositoryIssueSearchRead[]> {
    const perPage = Math.min(20, Math.max(1, options.perPage ?? 8));
    // 关键词来自模型与用户问题（不可信输入）：按空白分词后只保留"纯文本"词元。
    // 丢弃含冒号（任何位置的 key:value 限定符）、括号（分组限定符）与 -/+ 前缀
    // （一元操作符）的词元，以及裸布尔操作符，防止 `repo:other/repo`、`is:pr`、
    // `OR (repo:x/y)`、`-repo:owner/repo` 之类改变固定的仓库范围或混入 PR。
    const sanitizedKeywords = keywords
      .flatMap((keyword) => keyword.split(/\s+/))
      .filter((token) => {
        if (!token || token.includes(':') || token.includes('(') || token.includes(')')) return false;
        if (/^[-+]/.test(token)) return false;
        return !SEARCH_BOOLEAN_OPERATORS.has(token.toLowerCase());
      });
    // 无纯文本关键词时不发起搜索：仅含 repo/is:issue 的裸查询会命中仓库内
    // 任意 Issue，返回与问题无关的证据。
    if (sanitizedKeywords.length === 0) return [];
    const query = [`repo:${owner}/${repo}`, 'is:issue', ...sanitizedKeywords]
      .filter(Boolean)
      .join(' ');
    const endpoint = `/search/issues?q=${encodeURIComponent(query)}&per_page=${perPage}`;
    const response = await this.makeRequest<{ total_count?: number; items?: Array<Record<string, unknown>> }>(
      endpoint,
      { operationTag: 'issue-search' },
      options.signal,
    );
    const items = Array.isArray(response.items) ? response.items : [];
    return items.map((item) => {
      const state: 'open' | 'closed' = item.state === 'closed' ? 'closed' : 'open';
      const labels = Array.isArray(item.labels)
        ? item.labels.map((label) => {
            if (label && typeof label === 'object' && typeof (label as { name?: unknown }).name === 'string') return (label as { name: string }).name;
            return '';
          }).filter(Boolean).slice(0, 6)
        : [];
      return {
        number: typeof item.number === 'number' ? item.number : 0,
        title: typeof item.title === 'string' ? item.title : '',
        state,
        html_url: typeof item.html_url === 'string' ? item.html_url : '',
        // 搜索结果正文在这里截断，保证响应体积可控；摘要层还有更细的上限。
        body: typeof item.body === 'string' ? item.body.slice(0, 8_000) : '',
        comments: typeof item.comments === 'number' ? item.comments : 0,
        updated_at: typeof item.updated_at === 'string' ? item.updated_at : '',
        labels,
      };
    }).filter((issue) => issue.number > 0);
  }

  /** 抓取单条 Issue 的评论（时间正序），供疑难排查场景补充解决方案。 */
  async getRepositoryIssueComments(
    owner: string,
    repo: string,
    issueNumber: number,
    options: { perPage?: number; signal?: AbortSignal } = {},
  ): Promise<RepositoryIssueCommentRead[]> {
    const perPage = Math.min(30, Math.max(1, options.perPage ?? 10));
    const response = await this.makeRequest<Array<Record<string, unknown>>>(
      `/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=${perPage}`,
      { operationTag: 'issue-comments' },
      options.signal,
    );
    return (Array.isArray(response) ? response : []).map((comment) => ({
      user: (comment.user as { login?: unknown } | undefined)?.login ? String((comment.user as { login: unknown }).login) : 'unknown',
      createdAt: typeof comment.created_at === 'string' ? comment.created_at : '',
      body: typeof comment.body === 'string' ? comment.body.slice(0, 4_000) : '',
    }));
  }

  /**
   * 分页列出仓库 issues（state=all 含已关闭，按 updated 排序可配合 since 做
   * 增量同步；PR 条目以 isPullRequest 标记，由调用方过滤）。
   */
  async listRepositoryIssues(
    owner: string,
    repo: string,
    options: {
      state?: 'open' | 'closed' | 'all';
      sort?: 'created' | 'updated' | 'comments';
      direction?: 'asc' | 'desc';
      since?: string;
      perPage?: number;
      page?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<GitHubIssueListRead[]> {
    const params = new URLSearchParams({
      state: options.state ?? 'all',
      sort: options.sort ?? 'created',
      direction: options.direction ?? 'desc',
      per_page: String(Math.min(100, Math.max(1, options.perPage ?? 100))),
      page: String(Math.max(1, options.page ?? 1)),
    });
    if (options.since) params.set('since', options.since);
    const response = await this.makeRequest<Array<Record<string, unknown>>>(
      `/repos/${owner}/${repo}/issues?${params.toString()}`,
      { operationTag: 'issue-list' },
      options.signal,
    );
    return (Array.isArray(response) ? response : []).map(mapRestIssueListItem).filter((issue) => issue.number > 0);
  }

  /** 抓取单条 issue 完整正文（周刊"查看原贴"缓存缺失时的兜底路径）。 */
  async getRepositoryIssue(owner: string, repo: string, issueNumber: number, signal?: AbortSignal): Promise<GitHubIssueListRead> {
    const item = await this.makeRequest<Record<string, unknown>>(
      `/repos/${owner}/${repo}/issues/${issueNumber}`,
      { operationTag: 'issue-list' },
      signal,
    );
    return mapRestIssueListItem(item);
  }

  /** 抓取仓库详情（周刊频道 REST 逐仓补全路径）。 */
  async getRepositoryDetails(owner: string, repo: string, signal?: AbortSignal): Promise<GitHubRepoDetailRead> {
    const data = await this.makeRequest<Record<string, unknown>>(
      `/repos/${owner}/${repo}`,
      { operationTag: 'repo-detail' },
      signal,
    );
    return mapRestRepoDetail(data);
  }

  /**
   * 批量抓取仓库详情（GraphQL alias 批处理，默认 100 个/请求，每批间隔 150ms）。
   * 返回 Map 以调用方传入的 full_name 小写为键；仓库不存在/不可访问时值为 null。
   * 整批请求失败（网络/代理不支持/鉴权）时抛错，由调用方决定是否回退 REST 逐仓补全。
   */
  async graphqlFetchRepositories(
    fullNames: string[],
    options: { signal?: AbortSignal; batchSize?: number; onBatchDone?: (doneBatches: number, totalBatches: number) => void } = {},
  ): Promise<Map<string, GitHubRepoDetailRead | null>> {
    const result = new Map<string, GitHubRepoDetailRead | null>();
    const fullNamePattern = /^[^/\s]+\/[^/\s]+$/;
    const validFullNames = fullNames.filter((fullName) => fullNamePattern.test(fullName));
    const validSet = new Set(validFullNames);
    for (const fullName of fullNames) {
      if (!validSet.has(fullName)) result.set(fullName.toLowerCase(), null);
    }
    const batchSize = Math.min(100, Math.max(1, options.batchSize ?? 100));
    const batches: string[][] = [];
    for (let i = 0; i < validFullNames.length; i += batchSize) {
      batches.push(validFullNames.slice(i, i + batchSize));
    }
    const escapeGraphQlString = (value: string) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batch = batches[batchIndex];
      const aliases = batch.map((fullName, idx) => {
        const [owner, name] = fullName.split('/');
        return `a${idx}: repository(owner: "${escapeGraphQlString(owner)}", name: "${escapeGraphQlString(name)}") { ...WeeklyRepoDetailFragment }`;
      });
      // 注意：GitHub schema 已移除 openIssues 字段（实测报 undefinedField），改用语义等价的
      // issues(states: OPEN) { totalCount }，mapGraphqlRepoDetail 消费端同步改为读 node.issues
      const query = `query WeeklyRepoBatch {\n${aliases.join('\n')}\n}\nfragment WeeklyRepoDetailFragment on Repository {\n  databaseId\n  name\n  nameWithOwner\n  description\n  url\n  stargazerCount\n  forkCount\n  primaryLanguage { name }\n  createdAt\n  updatedAt\n  pushedAt\n  repositoryTopics(first: 20) { nodes { topic { name } } }\n  owner { login avatarUrl }\n  licenseInfo { spdxId }\n  isArchived\n  isDisabled\n  isFork\n  isTemplate\n  issues(states: OPEN) { totalCount }\n  defaultBranchRef { name }\n}`;
      const response = await this.makeRequest<{ data?: Record<string, unknown> | null; errors?: Array<{ message?: string }> }>(
        '/graphql',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query }),
          operationTag: 'graphql-repo-batch',
        },
        options.signal,
      );
      if (!response.data || typeof response.data !== 'object') {
        const message = response.errors?.map((e) => e.message ?? '').filter(Boolean).join('; ');
        throw new Error(message ? `GraphQL batch failed: ${message}` : 'GraphQL batch failed: empty data');
      }
      batch.forEach((fullName, idx) => {
        const node = response.data![`a${idx}`];
        result.set(fullName.toLowerCase(), node && typeof node === 'object' ? mapGraphqlRepoDetail(node as Record<string, unknown>) : null);
      });
      options.onBatchDone?.(batchIndex + 1, batches.length);
      if (batchIndex < batches.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    }
    return result;
  }

  async getMultipleRepositoryReleases(
    repositories: Repository[],
    options: ReleaseFetchOptions = {}
  ): Promise<MultipleReleasesResult> {
    const startTime = Date.now();
    // 用单调时钟，避免系统时钟回拨导致批次预算失效；startTime 仅用于日志。
    const batchDeadline = performance.now() + REFRESH_BATCH_BUDGET_MS;
    const { includePreRelease = true, refreshExistingAssets = false } = options;
    const allReleases: Release[] = [];
    const latestReleases: Release[] = [];
    const failedRepos: { repoId: number; full_name: string; error: string }[] = [];

    // Controlled concurrency: process 3 repos at a time
    const concurrency = 3;
    let index = 0;

    const workers = Array.from({ length: Math.min(concurrency, repositories.length) }, async () => {
      while (true) {
        const currentIndex = index++;
        if (currentIndex >= repositories.length) break;

        const repo = repositories[currentIndex];
        if (performance.now() >= batchDeadline) {
          failedRepos.push({
            repoId: repo.id,
            full_name: repo.full_name,
            error: `刷新批次超过 ${REFRESH_BATCH_BUDGET_MS / 60_000} 分钟上限，已跳过以保留已完成结果`,
          });
          continue;
        }
        const [owner, name] = repo.full_name.split('/');

        try {
          let releases: Release[];

          if (!repo.has_fetched_releases) {
            // New subscription: full sync (fetch up to 30)
            releases = await this.fetchAllReleasesForRepo(owner, name);
          } else {
            // Already synced: incremental sync with pagination until we cross the watermark
            const sinceTime = repo.last_release_fetch_time
              ? new Date(repo.last_release_fetch_time)
              : null;

            let page = 1;
            releases = [];
            // 资产刷新：收集“每仓最新一条、且符合预发布过滤的 Release”。
            // 当 includePreRelease=false 且前几页全是预发布时，需继续翻页找最新正式版，
            // 不能只看 page=1 就停（否则正式版资产变化会被漏掉）。
            let collectedLatest = false;
            while (true) {
              const { releases: batch, hasMore } = await this.getRepositoryReleasesPage(owner, name, page, 10);

              if (batch.length === 0 && !hasMore) break;

              if (refreshExistingAssets && !collectedLatest && batch.length > 0) {
                const latest = includePreRelease
                  ? batch[0]
                  : batch.find(r => !r.prerelease);
                if (latest) {
                  latest.repository.id = repo.id;
                  latestReleases.push(latest);
                  collectedLatest = true;
                }
              }

              const fresh = sinceTime
                ? batch.filter(r => new Date(r.published_at) > sinceTime)
                : batch;

              releases.push(...fresh);

              // 未收集到符合过滤条件的最新 Release 时，即使已触达水印也继续翻页，
              // 直到找到候选或耗尽分页（避免前 10 条全是预发布时漏掉正式版）。
              const needMoreForLatest = refreshExistingAssets && !collectedLatest && hasMore;
              if (needMoreForLatest) {
                page++;
                continue;
              }

              // Stop if we hit the watermark or ran out of data
              if (
                !hasMore ||
                (sinceTime && batch.some(r => new Date(r.published_at) <= sinceTime))
              ) {
                break;
              }

              page++;
            }
          }

          // Add repository info to releases
          releases.forEach(release => {
            release.repository.id = repo.id;
          });

          // Filter by pre-release setting
          if (!includePreRelease) {
            releases = releases.filter(r => !r.prerelease);
          }

          allReleases.push(...releases);
        } catch (error) {
          failedRepos.push({
            repoId: repo.id,
            full_name: repo.full_name,
            error: error instanceof Error ? error.message : String(error)
          });
        }

        // Rate limiting protection between repos
        await new Promise(resolve => setTimeout(resolve, 150));
      }
    });

    await Promise.all(workers);

    // Sort by published date (newest first)
    const sortedReleases = allReleases.sort((a, b) =>
      new Date(b.published_at).getTime() - new Date(a.published_at).getTime()
    );

    logger.info('githubApi', 'Update releases completed', { repoCount: repositories.length, releaseCount: sortedReleases.length, latestReleaseCount: latestReleases.length, durationMs: Date.now() - startTime });

    if (refreshExistingAssets) {
      const latest = includePreRelease
        ? latestReleases
        : latestReleases.filter(r => !r.prerelease);
      return { releases: sortedReleases, latestReleases: latest, failedRepos };
    }
    return { releases: sortedReleases, failedRepos };
  }

  // 新增：获取仓库的增量releases（基于时间戳）
  async getIncrementalRepositoryReleases(
    owner: string,
    repo: string,
    since?: string,
    perPage = 10
  ): Promise<Release[]> {
    try {
      const endpoint = `/repos/${owner}/${repo}/releases?per_page=${perPage}`;

      const releases = await this.makeRequest<Release[]>(endpoint, { operationTag: 'release' });

      const mappedReleases = releases.map(release => ({
        id: release.id,
        tag_name: release.tag_name,
        name: release.name || release.tag_name,
        body: release.body || '',
        published_at: release.published_at,
        html_url: release.html_url,
        assets: release.assets || [],
        zipball_url: release.zipball_url,
        tarball_url: release.tarball_url,
        prerelease: release.prerelease ?? false,
        repository: {
          id: 0,
          full_name: `${owner}/${repo}`,
          name: repo,
        },
      }));

      // 如果提供了since时间戳，只返回更新的releases
      if (since) {
        const sinceDate = new Date(since);
        return mappedReleases.filter(release =>
          new Date(release.published_at) > sinceDate
        );
      }

      return mappedReleases;
    } catch (error) {
      logger.warn('githubApi', `Failed to fetch incremental releases for ${owner}/${repo}`, error);
      return [];
    }
  }

  async unstarRepository(owner: string, repo: string): Promise<void> {
    await this.makeRequest<void>(`/user/starred/${owner}/${repo}`, {
      method: 'DELETE',
    });
  }

  async starRepository(owner: string, repo: string): Promise<void> {
    await this.makeRequest<void>(`/user/starred/${owner}/${repo}`, {
      method: 'PUT',
    });
  }

  /** GitHub returns 204 for a starred repository and 404 when it is not starred. */
  async isRepositoryStarred(owner: string, repo: string): Promise<boolean> {
    try {
      await this.makeRequest<void>(`/user/starred/${owner}/${repo}`);
      return true;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('GitHub API error: 404 ')) {
        return false;
      }
      throw error;
    }
  }

  async checkRateLimit(): Promise<{ remaining: number; reset: number }> {
    const response = await this.makeRequest<GitHubRateLimitResponse>('/rate_limit');
    return {
      remaining: response.rate.remaining,
      reset: response.rate.reset,
    };
  }

  private buildPlatformQuery(platform: DiscoveryPlatform): string {
    switch (platform) {
      case 'Android':
        return 'android';
      case 'Macos':
        return 'macos OR mac OR osx';
      case 'Windows':
        return 'windows';
      case 'Linux':
        return 'linux';
      case 'All':
      default:
        return '';
    }
  }

  async searchMostStars(perPage = 10): Promise<SubscriptionRepo[]> {
    const data = await this.makeRequest<GitHubSearchRepoResponse>(
      `/search/repositories?q=stars:>1000&sort=stars&order=desc&per_page=${perPage}`
    );
    return (data.items || []).map((repo, index) => ({
      ...repo,
      rank: index + 1,
      channel: 'most-stars' as const,
    }));
  }

  async searchMostForks(perPage = 10): Promise<SubscriptionRepo[]> {
    const data = await this.makeRequest<GitHubSearchRepoResponse>(
      `/search/repositories?q=forks:>1000&sort=forks&order=desc&per_page=${perPage}`
    );
    return (data.items || []).map((repo, index) => ({
      ...repo,
      rank: index + 1,
      channel: 'most-forks' as const,
      forks_count: repo.forks_count,
    }));
  }

  async searchDailyDevs(perPage = 10): Promise<SubscriptionDev[]> {
    const usersData = await this.makeRequest<GitHubSearchUserResponse>(
      `/search/users?q=followers:>1000&sort=followers&order=desc&per_page=${perPage}`
    );

    const devs: SubscriptionDev[] = [];
    for (let i = 0; i < (usersData.items || []).length; i++) {
      const searchUser = usersData.items[i];

      // The search API only returns basic fields; fetch the full profile for name/bio/followers/public_repos
      let userDetail: GitHubUserDetail = {
        login: searchUser.login,
        avatar_url: searchUser.avatar_url,
        html_url: searchUser.html_url,
        name: null,
        bio: null,
        public_repos: 0,
        followers: 0,
      };
      try {
        userDetail = await this.makeRequest<GitHubUserDetail>(`/users/${searchUser.login}`);
      } catch (error) {
        logger.warn('githubApi', `Failed to fetch user details for ${searchUser.login}`, error);
      }

      let topRepo: SubscriptionRepo | null = null;
      try {
        const reposData = await this.makeRequest<Repository[]>(
          `/users/${searchUser.login}/repos?sort=stars&per_page=1`
        );
        if (reposData && reposData.length > 0) {
          topRepo = {
            ...reposData[0],
            rank: 1,
            channel: 'most-dev' as const,
          };
        }
      } catch (error) {
        logger.warn('githubApi', `Failed to fetch top repo for ${searchUser.login}`, error);
      }
      devs.push({
        rank: i + 1,
        login: userDetail.login,
        avatar_url: userDetail.avatar_url,
        html_url: userDetail.html_url,
        name: userDetail.name,
        bio: userDetail.bio,
        public_repos: userDetail.public_repos,
        followers: userDetail.followers,
        topRepo,
      });
      if (i < (usersData.items || []).length - 1) {
        await new Promise(resolve => setTimeout(resolve, 150));
      }
    }
    return devs;
  }

  private buildLanguageQuery(language: ProgrammingLanguage): string {
    if (language === 'All') return '';
    const languageMap: Record<ProgrammingLanguage, string> = {
      'All': '',
      'Kotlin': 'Kotlin',
      'Java': 'Java',
      'JavaScript': 'JavaScript',
      'TypeScript': 'TypeScript',
      'Python': 'Python',
      'Swift': 'Swift',
      'Rust': 'Rust',
      'Go': 'Go',
      'CSharp': 'C#',
      'CPlusPlus': 'C++',
      'C': 'C',
      'Dart': 'Dart',
      'Ruby': 'Ruby',
      'PHP': 'PHP',
    };
    return `language:${languageMap[language]}`;
  }

  private buildSortParams(sortBy: SortBy, sortOrder: SortOrder): { sort: string; order: string } {
    const sortMap: Record<SortBy, string> = {
      'BestMatch': 'best-match',
      'MostStars': 'stars',
      'MostForks': 'forks',
    };
    const orderMap: Record<SortOrder, string> = {
      'Descending': 'desc',
      'Ascending': 'asc',
    };
    return {
      sort: sortMap[sortBy],
      order: orderMap[sortOrder],
    };
  }

  async getHotReleaseRepositories(
    platform: DiscoveryPlatform,
    page: number = 1,
    perPage: number = 20
  ): Promise<PaginatedDiscoveryRepositories> {
    const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const platformQuery = this.buildPlatformQuery(platform);

    let query = `stars:>10 archived:false pushed:>=${fourteenDaysAgo}`;
    if (platformQuery) {
      query += ` ${platformQuery}`;
    }

    const data = await this.makeRequest<GitHubSearchRepoResponse>(
      `/search/repositories?q=${encodeURIComponent(query)}&sort=updated&order=desc&per_page=${perPage}&page=${page}`
    );

    const repos = (data.items || []).map((repo, index) => ({
      ...repo,
      rank: (page - 1) * perPage + index + 1,
      channel: 'hot-release' as DiscoveryChannelId,
      platform,
    }));

    return {
      repos,
      hasMore: repos.length === perPage,
      nextPageIndex: page + 1,
      totalCount: data.total_count,
    };
  }

  async getMostPopular(
    platform: DiscoveryPlatform,
    page: number = 1,
    perPage: number = 20
  ): Promise<PaginatedDiscoveryRepositories> {
    const sixMonthsAgo = new Date(Date.now() - 6 * 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const oneYearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const platformQuery = this.buildPlatformQuery(platform);

    let query = `stars:>1000 archived:false created:<${sixMonthsAgo} pushed:>=${oneYearAgo}`;
    if (platformQuery) {
      query += ` ${platformQuery}`;
    }

    const data = await this.makeRequest<GitHubSearchRepoResponse>(
      `/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=${perPage}&page=${page}`
    );

    const repos = (data.items || []).map((repo, index) => ({
      ...repo,
      rank: (page - 1) * perPage + index + 1,
      channel: 'most-popular' as DiscoveryChannelId,
      platform,
    }));

    return {
      repos,
      hasMore: repos.length === perPage,
      nextPageIndex: page + 1,
      totalCount: data.total_count,
    };
  }

  async searchByTopic(
    searchKeywords: string,
    platform: DiscoveryPlatform,
    page: number = 1,
    perPage: number = 20
  ): Promise<PaginatedDiscoveryRepositories> {
    const platformQuery = this.buildPlatformQuery(platform);

    let query = `${searchKeywords} in:name,description,topics stars:>10 archived:false`;
    if (platformQuery) {
      query += ` ${platformQuery}`;
    }

    const data = await this.makeRequest<GitHubSearchRepoResponse>(
      `/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=${perPage}&page=${page}`
    );

    const repos = (data.items || []).map((repo, index) => ({
      ...repo,
      rank: (page - 1) * perPage + index + 1,
      channel: 'topic' as DiscoveryChannelId,
      platform,
    }));

    return {
      repos,
      hasMore: repos.length === perPage,
      nextPageIndex: page + 1,
      totalCount: data.total_count,
    };
  }

  async getTopicRepositories(
    topic: TopicCategory,
    platform: DiscoveryPlatform,
    page: number = 1,
    perPage: number = 20
  ): Promise<PaginatedDiscoveryRepositories> {
    const topicKeywords: Record<TopicCategory, string> = {
      'ai': 'artificial-intelligence machine-learning ai',
      'ml': 'machine-learning deep-learning neural-network',
      'database': 'database sql nosql mongodb postgresql mysql',
      'web': 'web frontend backend react vue angular',
      'mobile': 'mobile android ios flutter react-native',
      'devtools': 'devtools ide editor tools',
      'security': 'security cybersecurity encryption',
      'game': 'game game-engine unity unreal',
    };

    return this.searchByTopic(topicKeywords[topic], platform, page, perPage);
  }

  /**
   * 单次原始仓库搜索：q 由调用方完整构造（可携带 in: 限定符），
   * 复用 makeRequest 的鉴权、超时与限流语义。
   */
  async searchRepositoriesRaw(query: string, perPage = 25, signal?: AbortSignal): Promise<Repository[]> {
    const data = await this.makeRequest<GitHubSearchRepoResponse>(
      `/search/repositories?q=${encodeURIComponent(query)}&per_page=${perPage}`,
      { operationTag: 'repo-search-recall' },
      signal,
    );
    return Array.isArray(data.items) ? data.items : [];
  }

  async searchRepositories(
    query: string,
    platform: DiscoveryPlatform,
    language: ProgrammingLanguage,
    sortBy: SortBy,
    sortOrder: SortOrder,
    page: number = 1,
    perPage: number = 20,
    signal?: AbortSignal,
  ): Promise<PaginatedDiscoveryRepositories> {
    const platformQuery = this.buildPlatformQuery(platform);
    const languageQuery = this.buildLanguageQuery(language);
    const { sort, order } = this.buildSortParams(sortBy, sortOrder);

    let searchQuery = `${query} archived:false`;
    if (platformQuery) {
      searchQuery += ` ${platformQuery}`;
    }
    if (languageQuery) {
      searchQuery += ` ${languageQuery}`;
    }

    let url = `/search/repositories?q=${encodeURIComponent(searchQuery)}&per_page=${perPage}&page=${page}`;
    if (sort) {
      url += `&sort=${sort}&order=${order}`;
    }

    const data = await this.makeRequest<GitHubSearchRepoResponse>(url, {}, signal);

    const repos = (data.items || []).map((repo, index) => ({
      ...repo,
      rank: (page - 1) * perPage + index + 1,
      channel: 'search' as DiscoveryChannelId,
      platform,
    }));

    return {
      repos,
      hasMore: repos.length === perPage,
      nextPageIndex: page + 1,
      totalCount: data.total_count,
    };
  }



}
