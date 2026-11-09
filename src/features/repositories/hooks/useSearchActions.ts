import { useT } from "../../../i18n/useT";
import { useCallback, useMemo, useState, type MutableRefObject, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { Repository } from '../../../types';
import { useAppStore } from '../../../store/useAppStore';
import { AIService, isAbortError } from '../../../services/aiService';
import { EmbeddingClient, VectorSearchService } from '../../../services/vectorSearchService';
import { CrossEncoderReranker } from '../../../services/crossEncoderReranker';
import { runVectorSearchPipeline } from '../../../services/vectorSearchPipeline';
import { createGitHubApiService } from '../../../services/githubApiFactory';
import { forceSyncToBackend } from '../../../services/autoSync';
import { useDialog } from '../../../hooks/useDialog';
import type { VectorQueryResult } from '../../../services/vectorSearchService';
import { performBasicTextSearch } from '../../../utils/repoSearch';
import { assignIdentityMatches } from '../../../utils/repositoryIdentity';

// ===== 提纯纯函数（来源逐字对应 SearchBar 基线行号） =====

// SearchBar 446-459：轻量关键词加分 + scoreMap 构造。
export const buildSearchPatch = (
  query: string,
  vectorResults: VectorQueryResult[],
): Map<string, number> => {
  const queryLower = query.toLowerCase();
  const boostedResults = vectorResults.map(r => {
    let bonus = 0;
    const name = (r.metadata?.full_name || '').toLowerCase();
    const desc = (r.metadata?.description || '').toLowerCase();
    const tags = (r.metadata?.tags || []).map(tag => tag.toLowerCase());
    if (name.includes(queryLower)) bonus += 0.05;
    if (desc.includes(queryLower)) bonus += 0.03;
    if (tags.some(tag => tag.includes(queryLower))) bonus += 0.02;
    return { ...r, score: r.score + bonus };
  });
  return new Map(boostedResults.map(r => [r.id, r.score]));
};

/**
 * 星标同步的分配结果：与 `newRepos` 一一对齐（`undefined` = 新增）。
 *
 * 规则本体在 `utils/repositoryIdentity`（id 优先，合成 id 的名称兜底其次），
 * 与 `addRepository` 共用同一份实现，避免两处口径漂移。
 */
const assignStarredRepositories = (
  newRepos: Repository[],
  storeRepos: Repository[],
): Array<Repository | undefined> => assignIdentityMatches(newRepos, storeRepos);

// 当前在途 AI 搜索的控制器（模块级）：新搜索启动时中止旧请求（超代语义），
// Quick Access 等外部流程也通过 cancelActiveAiSearch 中止，避免过期结果落盘
const aiSearchAbortRef: { current: AbortController | null } = { current: null };

export const cancelActiveAiSearch = () => {
  aiSearchAbortRef.current?.abort();
};

/** 统计本次同步中真正新增的仓库数（与合并口径一致）。 */
export const countNewStarredRepositories = (
  newRepos: Repository[],
  storeRepos: Repository[],
): number => assignStarredRepositories(newRepos, storeRepos)
  .filter(assignment => assignment === undefined).length;

// SearchBar 725-750：星标同步结果与本地仓库逐字段合并（license `?? null` 回填）。
export const mergeStarredRepositories = (
  newRepos: Repository[],
  storeRepos: Repository[],
): Repository[] => {
  // 与 countNewStarredRepositories 共用同一套分配结果，保证「合并」与
  // 「新增计数」口径一致，且名称兜底不会把同一份本地记录重复用掉。
  const assignments = assignStarredRepositories(newRepos, storeRepos);
  return newRepos.map((newRepo, index) => {
    const existing = assignments[index];
    if (existing) {
      return {
        ...existing,
        name: newRepo.name,
        full_name: newRepo.full_name,
        description: newRepo.description,
        html_url: newRepo.html_url,
        stargazers_count: newRepo.stargazers_count,
        forks_count: newRepo.forks_count,
        forks: newRepo.forks,
        language: newRepo.language,
        updated_at: newRepo.updated_at,
        pushed_at: newRepo.pushed_at,
        starred_at: newRepo.starred_at,
        owner: newRepo.owner,
        topics: newRepo.topics,
        // 回填历史仓库缺失的 license 字段（GitHub 源元数据，跟随 newRepo）
        license: newRepo.license ?? null,
        // GitHub 原生状态字段：跟随 newRepo 刷新（归档/停用状态会随上游变化）。
        // 源缺失时保留本地已获得的值，避免把已有 Health 事实退化成「未知」。
        archived: newRepo.archived ?? existing.archived,
        disabled: newRepo.disabled ?? existing.disabled,
        fork: newRepo.fork ?? existing.fork,
        is_template: newRepo.is_template ?? existing.is_template,
        open_issues_count: newRepo.open_issues_count ?? existing.open_issues_count,
        default_branch: newRepo.default_branch ?? existing.default_branch,
      };
    }
    return newRepo;
  });
};

export interface SearchActions {
  isSearching: boolean;
  searchPhase: string | null;
  // 渲染相关 ref：View 的过滤 effect 仍要读写，故以 RefObject 暴露。
  // 实体挂 hook、以 RefObject 暴露给 View 原样读写——写点在 aiSearch（本 hook），
  // 读点在 View 的过滤 effect（依赖 View 本地 applyFilters 闭包），整体搬入 hook
  // 会扩大改动面、引入漂移风险，"只搬运不改语义"约束下这是风险最低的切法。
  vectorScoreMapRef: MutableRefObject<{ query: string; scores: Map<string, number> } | null>;
  skipNextTextSearchRef: MutableRefObject<boolean>;
  aiSearch: (query: string, applyFilters: (repos: Repository[]) => Repository[]) => Promise<void>;
  keywordSearch: (
    query: string,
    applyFilters: (repos: Repository[]) => Repository[],
    options?: { signal?: AbortSignal },
  ) => Promise<void>;
  syncStars: () => Promise<void>;
}

export const useSearchActions = (): SearchActions => {
  const {
    repositories,
    aiConfigs,
    activeAIConfig,
    language,
    setSearchFilters,
    setSearchResults,
    githubToken,
    setRepositories,
    setLastSync,
    setSyncingStars,
  } = useAppStore(useShallow((state) => ({
    repositories: state.repositories,
    aiConfigs: state.aiConfigs,
    activeAIConfig: state.activeAIConfig,
    language: state.language,
    setSearchFilters: state.setSearchFilters,
    setSearchResults: state.setSearchResults,
    githubToken: state.githubToken,
    setRepositories: state.setRepositories,
    setLastSync: state.setLastSync,
    setSyncingStars: state.setSyncingStars,
  })));

  const { toast } = useDialog();
  const [isSearching, setIsSearching] = useState(false);
  const [searchPhase, setSearchPhase] = useState<string | null>(null);
  const vectorScoreMapRef = useRef<{ query: string; scores: Map<string, number> } | null>(null);
  const skipNextTextSearchRef = useRef(false);
  const t = useT('repositories');

  const keywordSearch = useCallback(async (
    query: string,
    applyFilters: (repos: Repository[]) => Repository[],
    options?: { signal?: AbortSignal },
  ): Promise<void> => {
    const activeConfig = aiConfigs.find(config => config.id === activeAIConfig);

    let filtered = repositories;
    let aiOrdered = false;
    if (activeConfig) {
      try {
        // 无向量降级链：查询扩展+意图复述 → 词法候选召回 → LLM 精选排序
        setSearchPhase(t('useSearchActions.ai-semantic-analysis'));
        const aiService = new AIService(activeConfig, language);
        const aiResults = await aiService.searchRepositoriesWithSelection(repositories, query, {
          signal: options?.signal,
          onPhase: (phase) => {
            setSearchPhase(phase === 'selecting'
              ? t('useSearchActions.ai-selecting-relevant-repositories')
              : t('useSearchActions.ai-semantic-analysis'));
          },
          onFallback: (reason) => {
            // 端点抖动/配置问题时用户看到的不能只是"空结果"：明确告知已降级
            if (reason === 'ai_failed') {
              toast(t('useSearchActions.ai-request-failed-fell-back-to-local-lexical-sea'), 'warning');
            }
          },
        });
        console.log('✅ AI selection search completed, results:', aiResults.length);
        filtered = aiResults;
        aiOrdered = true;
      } catch (error) {
        // 取消不是失败：向上传播交给 aiSearch 静默结束，不产出兜底结果
        if (options?.signal?.aborted || isAbortError(error)) {
          throw new DOMException('Search cancelled', 'AbortError');
        }
        console.warn('❌ AI search failed, falling back to basic search:', error);
        toast(t('useSearchActions.ai-request-failed-fell-back-to-local-lexical-sea'), 'warning');
        filtered = performBasicTextSearch(repositories, query);
      }
    } else {
      console.log('⚠️ No AI config found, using basic text search');
      // Basic text search if no AI config
      filtered = performBasicTextSearch(repositories, query);
    }

    if (options?.signal?.aborted) {
      throw new DOMException('Search cancelled', 'AbortError');
    }

    // Apply other filters and update results
    const finalFiltered = applyFilters(filtered);
    if (aiOrdered) {
      // AI 返回的顺序（LLM 精选序或词法兜底序）就是相关性顺序；applyFilters 会按
      // 排序控件重排（默认 star 降序），这里恢复 AI 顺序——与向量路径的
      // rerankOrder 恢复逻辑同构。
      const aiOrder = new Map(filtered.map((repo, index) => [String(repo.id), index]));
      finalFiltered.sort((a, b) =>
        (aiOrder.get(String(a.id)) ?? Number.MAX_SAFE_INTEGER)
        - (aiOrder.get(String(b.id)) ?? Number.MAX_SAFE_INTEGER));
      // 下面 setSearchFilters({ query }) 会触发 SearchBar 的过滤 effect，用基础
      // 文本搜索+star 排序重设结果——LLM 精选的顺序、子集与显式空态都会被覆盖。
      // 与向量路径同用 skipNextTextSearchRef 挡掉这次 effect（含空结果场景）。
      skipNextTextSearchRef.current = true;
    }
    setSearchResults(finalFiltered);

    // Update search filters to mark that AI search was performed
    setSearchFilters({ query });
  }, [repositories, aiConfigs, activeAIConfig, language, setSearchResults, setSearchFilters, toast, t]);

  const aiSearch = useCallback(async (
    query: string,
    applyFilters: (repos: Repository[]) => Repository[],
  ): Promise<void> => {
    if (!query.trim()) return;

    // 新搜索接管：中止上一次仍在途的 AI 请求（搜索进行中按 Enter 可再次触发），
    // 防止过期结果落盘覆盖新结果。被取代的搜索在 finally 里不复位搜索状态。
    aiSearchAbortRef.current?.abort();
    const controller = new AbortController();
    aiSearchAbortRef.current = controller;

    setIsSearching(true);
    setSearchPhase(null);
    vectorScoreMapRef.current = null;

    try {
      // ====== 向量搜索分支 ======
      // 保持原时机：非响应式 getState() 读取（原文件如此，不改成响应式 selector）
      const vsConfig = useAppStore.getState().vectorSearchConfig;
      const embConfigs = useAppStore.getState().embeddingConfigs;
      const activeEmbConfig = embConfigs.find(c => c.id === vsConfig?.embeddingConfigId);

      if (vsConfig?.enabled && vsConfig?.workerUrl && activeEmbConfig) {
        try {
          const embeddingClient = new EmbeddingClient(activeEmbConfig);
          const vectorService = new VectorSearchService(vsConfig);
          const aiConfig = aiConfigs.find(config => config.id === activeAIConfig);
          const aiService = aiConfig
            && (vsConfig.enableHyDE !== false || vsConfig.enableReranking !== false)
            ? new AIService(aiConfig, language)
            : null;
          const crossEncoder = activeEmbConfig.apiType === 'siliconflow'
            ? new CrossEncoderReranker(activeEmbConfig)
            : null;
          const result = await runVectorSearchPipeline({
            query,
            repositories,
            vectorConfig: vsConfig,
            embeddingConfig: activeEmbConfig,
            aiService,
            embeddingClient,
            vectorService,
            crossEncoder,
            signal: controller.signal,
            onPhase: (phase) => {
              setSearchPhase(
                phase === 'analyzing'
                  ? t('useSearchActions.ai-analyzing-query')
                  : phase === 'embedding'
                    ? t('useSearchActions.generating-query-vector')
                    : phase === 'recalling'
                      ? t('useSearchActions.searching-vector-index')
                      : t('useSearchActions.ai-semantic-reranking'),
              );
            },
          });

          if (controller.signal.aborted || aiSearchAbortRef.current !== controller) {
            throw new DOMException('Search superseded', 'AbortError');
          }
          if (result === null) {
            await keywordSearch(query, applyFilters, { signal: controller.signal });
            return;
          }

          const finalFiltered = applyFilters([...result.repositories]);
          const order = new Map(
            result.repositories.map((repo, index) => [String(repo.id), index]),
          );
          finalFiltered.sort((a, b) =>
            (order.get(String(a.id)) ?? Number.MAX_SAFE_INTEGER)
            - (order.get(String(b.id)) ?? Number.MAX_SAFE_INTEGER));
          vectorScoreMapRef.current = { query, scores: result.scoreMap };
          skipNextTextSearchRef.current = true;
          setSearchResults(finalFiltered);
          setSearchFilters({ query });
          return;
        } catch (vectorError) {
          if (controller.signal.aborted || isAbortError(vectorError)) {
            throw new DOMException('Search superseded', 'AbortError');
          }
          console.warn('❌ Vector search failed, falling back to keyword search:', vectorError);
        }
      }
      // ====== 向量搜索分支结束 ======

      await keywordSearch(query, applyFilters, { signal: controller.signal });
    } catch (error) {
      // 取消不是失败：静默结束当前搜索（不产出结果），不当作可恢复的 AI 失败
      if (isAbortError(error)) {
        console.log('🚫 AI search cancelled');
        return;
      }
      console.error('💥 Search failed:', error);
    } finally {
      // 仅当本次搜索仍是"当前搜索"时才复位状态：被新搜索取代的旧搜索
      // 不把新搜索的 isSearching/searchPhase 状态清掉
      if (aiSearchAbortRef.current === controller) {
        aiSearchAbortRef.current = null;
        setIsSearching(false);
        setSearchPhase(null);
      }
    }
  }, [repositories, aiConfigs, activeAIConfig, language, setSearchResults, setSearchFilters, keywordSearch, t]);

  const syncStars = useCallback(async () => {
    if (!githubToken) {
      toast(t('useSearchActions.github-token-not-found-please-login-again'), 'error');
      return;
    }

    setSyncingStars(true);
    try {
      const githubApi = createGitHubApiService(githubToken);
      const newRepositories = await githubApi.getAllStarredRepositories();

      const storeRepos = useAppStore.getState().repositories;
      const mergedRepositories = mergeStarredRepositories(newRepositories, storeRepos);

      // 「新增仓库」计数必须与 mergeStarredRepositories 用同一套匹配口径
      // （id 优先，full_name 兜底）：否则被 full_name 兜底救回的存量仓库
      // 会被误报为新增，弹出「发现 N 个新仓库」的错误提示。
      const newRepoCount = countNewStarredRepositories(newRepositories, storeRepos);

      setRepositories(mergedRepositories);
      await forceSyncToBackend();

      setLastSync(new Date().toISOString());

      if (newRepoCount > 0) {
        toast(t('useSearchActions.sync-completed-found-newrepocount-new-repositori', { newRepoCount: newRepoCount }), 'success');
      } else {
        toast(t('useSearchActions.sync-completed-all-repositories-are-up-to-date'), 'info');
      }

    } catch (error) {
      console.error('Sync failed:', error);
      if (error instanceof Error && error.message.includes('token')) {
        toast(t('useSearchActions.github-token-has-expired-or-is-invalid-please-lo'), 'error');
      } else {
        toast(t('useSearchActions.sync-failed-please-check-your-network-connection'), 'error');
      }
    } finally {
      setSyncingStars(false);
    }
  }, [githubToken, setSyncingStars, t, toast, setRepositories, setLastSync]);

  return useMemo(() => ({
    isSearching,
    searchPhase,
    vectorScoreMapRef,
    skipNextTextSearchRef,
    aiSearch,
    keywordSearch,
    syncStars,
  }), [isSearching, searchPhase, aiSearch, keywordSearch, syncStars]);
};
