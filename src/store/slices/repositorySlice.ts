import type { Repository } from '../../types';
import { logger } from '../../services/logger';
import type { AppStoreSlice } from '../types';
import { initialSearchFilters } from '../schema';
import { hasActiveSearchFilters } from '../../utils/repoSearch';
import { areRepositoryRecordsEqual, replaceRepositoryInList } from '../helpers/repositoryRecords';
import { shouldPreserveExisting } from '../helpers/accountWorkspace';
import { findIdentityMatch, isValidGitHubRepositoryId } from '../../utils/repositoryIdentity';

/** 合成一个不与现有记录冲突的本地 id（timestamp + random，避免并发竞态）。 */
const generateFallbackRepositoryId = (existingRepositories: Repository[]): number => {
  const timestamp = Date.now();
  const random = Math.floor(Math.random() * 10000);
  const maxExistingId = existingRepositories.length > 0
    ? Math.max(...existingRepositories.map((r) => r.id))
    : 0;
  return Math.max(timestamp, maxExistingId + 1) + random;
};

export const createRepositorySlice: AppStoreSlice<Pick<import('../types').AppActions,
  | 'setRepositories'
  | 'updateRepository'
  | 'updateRepositoriesMetadata'
  | 'addRepository'
  | 'setLoading'
  | 'setSyncingStars'
  | 'setLastSync'
  | 'deleteRepository'
  | 'setAnalyzingRepository'
  | 'enterSimilarView'
  | 'resetSimilarView'
  | 'exitSimilarView'
  | 'setSearchFilters'
  | 'setSearchResults'
>> = (set) => ({
      // Repository actions
      setRepositories: (repositories, options) => set((state) => {
        if (shouldPreserveExisting(repositories, state.repositories, options?.allowEmpty)) {
          logger.warn('store.setRepositories', 'Refusing empty overwrite of local repositories');
          return state;
        }
        return {
          repositories,
          // Background sync must not wipe an active search result set: replacing
          // it with the full list shrinks the visible slice and unmounts the card
          // being edited (closing its edit modal). SearchBar recomputes results
          // from the new repositories on its own effect.
          searchResults: hasActiveSearchFilters(state.searchFilters) ? state.searchResults : repositories,
        };
      }),
      updateRepository: (repo) => set((state) => {
        const repositoriesResult = replaceRepositoryInList(state.repositories, repo);
        const searchResultsResult = state.searchResults === state.repositories
          ? repositoriesResult
          : replaceRepositoryInList(state.searchResults, repo);
        const similarResultsResult = state.similarView
          ? replaceRepositoryInList(state.similarView.similarResults, repo)
          : null;

        if (!repositoriesResult.changed && !searchResultsResult.changed && !similarResultsResult?.changed) {
          return state;
        }

        return {
          repositories: repositoriesResult.repositories,
          searchResults: searchResultsResult.repositories,
          similarView: similarResultsResult
            ? { ...state.similarView!, similarResults: similarResultsResult.repositories }
            : state.similarView,
        };
      }),
      updateRepositoriesMetadata: (updates) => set((state) => {
        if (!updates.length) return state;
        const patchMap = new Map(updates.map((u) => [u.id, u.patch]));

        const applyPatches = (list: Repository[]): { repositories: Repository[]; changed: boolean } => {
          let changed = false;
          // 用 Map 索引避免多次 findIndex；重复 id 的所有记录统一应用补丁：
          // 向量按 id 唯一，索引标记是 id 级事实，只标首条/末条都会让增量
          // 模式下实际上传的副本漏标而反复重嵌。
          const indicesById = new Map<number, number[]>();
          list.forEach((r, i) => {
            const indices = indicesById.get(r.id);
            if (indices) indices.push(i);
            else indicesById.set(r.id, [i]);
          });
          const next = list.slice();
          for (const [id, patch] of patchMap) {
            for (const idx of indicesById.get(id) ?? []) {
              const merged = { ...next[idx], ...patch };
              if (!areRepositoryRecordsEqual(next[idx], merged)) {
                next[idx] = merged;
                changed = true;
              }
            }
          }
          return { repositories: next, changed };
        };

        const repositoriesResult = applyPatches(state.repositories);
        const searchResultsResult = state.searchResults === state.repositories
          ? repositoriesResult
          : applyPatches(state.searchResults);
        const similarResultsResult = state.similarView
          ? applyPatches(state.similarView.similarResults)
          : { repositories: [], changed: false };

        if (!repositoriesResult.changed && !searchResultsResult.changed && !similarResultsResult.changed) {
          return state;
        }

        return {
          repositories: repositoriesResult.repositories,
          searchResults: searchResultsResult.repositories,
          similarView: state.similarView
            ? { ...state.similarView, similarResults: similarResultsResult.repositories }
            : state.similarView,
        };
      }),
      addRepository: (repo) => set((state) => {
        // 身份判定统一走 findIdentityMatch（id 优先，合成 id 的名称兜底其次）——
        // 与星标同步 mergeStarredRepositories 共用同一份规则，避免两处口径漂移。
        const existing = findIdentityMatch(repo, state.repositories);
        let updatedRepositories;

        if (existing) {
          // 同一 GitHub 身份：更新现有仓库（沿用其 ID，保留 AI 分析与自定义字段）。
          // 入参是完整 GitHub 数据，full_name 等源字段随之刷新（改名即在此生效）。
          const existingRepoIndex = state.repositories.indexOf(existing);
          updatedRepositories = [...state.repositories];
          updatedRepositories[existingRepoIndex] = {
            ...repo,
            id: existing.id,
            // 保留自定义编辑的内容
            custom_description: existing.custom_description,
            custom_tags: existing.custom_tags,
            custom_category: existing.custom_category,
            category_locked: existing.category_locked,
            last_edited: existing.last_edited,
            subscribed_to_releases: existing.subscribed_to_releases,
            // 保留已完成的 AI 分析：入参来自 GitHub 详情 / 发现页数据，
            // 不带这些字段，直接展开会把已有 AI 摘要与标签清空。
            // 用 `?? existing.x` 而非无条件回填：入参若显式带了新值则采用新值。
            ai_summary: repo.ai_summary ?? existing.ai_summary,
            ai_tags: repo.ai_tags ?? existing.ai_tags,
            ai_platforms: repo.ai_platforms ?? existing.ai_platforms,
            analyzed_at: repo.analyzed_at ?? existing.analyzed_at,
            analysis_failed: repo.analysis_failed ?? existing.analysis_failed,
            analysis_error: repo.analysis_error ?? existing.analysis_error,
          };
        } else {
          // 新增为独立记录：本地没有该仓库，或同名但属于**另一个** GitHub 仓库。
          // 此时绝不能沿用 existing.id —— 否则新仓库会被写到旧仓库的 ID 下：
          // 用户对新仓库做完 AI 分析后，下次同步按 GitHub ID 匹配不到本地记录
          // （id 不同，且名称兜底只认领合成 id 记录），分析结果会再次丢失；
          // 若旧仓库仍在星标里，新仓库的分析还会被错误归属到旧仓库。
          // 优先沿用入参的 GitHub 真实 id；仅当 id 不可用时，才退回合成 id
          // （timestamp + random，确保唯一性，避免并发竞态）。
          updatedRepositories = isValidGitHubRepositoryId(repo.id)
            ? [...state.repositories, { ...repo, id: repo.id }]
            : [...state.repositories, { ...repo, id: generateFallbackRepositoryId(state.repositories) }];
        }

        return {
          repositories: updatedRepositories,
          // Same guard as setRepositories: while search filters are active the
          // visible list is searchResults, and swapping in the full list would
          // unmount filtered cards (closing their edit modal). SearchBar
          // recomputes results from the updated repositories on its own effect.
          searchResults: hasActiveSearchFilters(state.searchFilters)
            ? state.searchResults
            : updatedRepositories
        };
      }),
      setLoading: (isLoading) => set({ isLoading }),
      setSyncingStars: (isSyncingStars) => set({ isSyncingStars }),
      setLastSync: (lastSync) => set({ lastSync }),
      deleteRepository: (repoId) => set((state) => {
        const nextReleaseSubscriptions = new Set(state.releaseSubscriptions);
        nextReleaseSubscriptions.delete(repoId);

        const filteredReleases = state.releases.filter(release => release.repository.id !== repoId);
        const remainingReleaseIds = new Set(filteredReleases.map(release => release.id));
        const nextReadReleases = new Set(
          Array.from(state.readReleases).filter(releaseId => remainingReleaseIds.has(releaseId))
        );

        return {
          repositories: state.repositories.filter(r => r.id !== repoId),
          searchResults: state.searchResults.filter(r => r.id !== repoId),
          similarView: state.similarView
            ? { ...state.similarView, similarResults: state.similarView.similarResults.filter(r => r.id !== repoId) }
            : state.similarView,
          releases: filteredReleases,
          releaseSubscriptions: nextReleaseSubscriptions,
          readReleases: nextReadReleases,
        };
      }),
      setAnalyzingRepository: (repoId, isAnalyzing) => set((state) => {
        const alreadyAnalyzing = state.analyzingRepositoryIds.has(repoId);
        if (alreadyAnalyzing === isAnalyzing) {
          return state;
        }

        const nextAnalyzingIds = new Set(state.analyzingRepositoryIds);
        if (isAnalyzing) {
          nextAnalyzingIds.add(repoId);
        } else {
          nextAnalyzingIds.delete(repoId);
        }
        return { analyzingRepositoryIds: nextAnalyzingIds };
      }),

      // Similar repositories view actions
      /**
       * 进入"查找相似仓库"视图：保存当前相似结果、锚点仓库，并快照进入前的
       * searchResults/searchFilters 用于重置恢复（链式查找时保留首次快照）。
       */
      enterSimilarView: (repos, anchor) => set((state) => ({
        similarView: {
          active: true,
          anchorRepoFullName: anchor.full_name,
          anchorRepoName: anchor.name,
          similarResults: repos,
          // 链式查找时保留首次进入的快照，避免覆盖重置目标
          originalSearchResults: state.similarView?.originalSearchResults ?? state.searchResults,
          originalSearchFilters: state.similarView?.originalSearchFilters ?? state.searchFilters,
        },
        // 进入相似视图时清空搜索条件，但保留用户选择的排序。
        searchFilters: {
          ...initialSearchFilters,
          sortBy: state.searchFilters.sortBy,
          sortOrder: state.searchFilters.sortOrder,
        },
      })),
      /**
       * 重置相似视图：恢复进入前的搜索结果与条件（回到"查找相似之前"的状态）。
       */
      resetSimilarView: () => set((state) => ({
        // 重置恢复进入前的搜索结果与条件（回到"查找相似之前"的状态）
        searchResults: state.similarView?.originalSearchResults ?? state.repositories,
        searchFilters: state.similarView?.originalSearchFilters ?? { ...initialSearchFilters },
        similarView: null,
      })),
      /**
       * 退出相似视图（不恢复进入前的搜索状态）：用于用户发起新搜索或切换分类时，
       * 避免把旧快照覆盖到新的搜索/分类结果上。
       */
      exitSimilarView: () => set({ similarView: null }),

      // Search actions
      setSearchFilters: (filters) => set((state) => {
        const newFilters = { ...state.searchFilters, ...filters };

        // 处理互斥筛选器：isAnalyzed 和 analysisFailed 不能同时设置
        if (filters.isAnalyzed !== undefined && filters.isAnalyzed !== null) {
          // 如果设置了 isAnalyzed，清除 analysisFailed
          newFilters.analysisFailed = undefined;
        }
        if (filters.analysisFailed !== undefined && filters.analysisFailed !== null) {
          // 如果设置了 analysisFailed，清除 isAnalyzed
          newFilters.isAnalyzed = undefined;
        }

        return { searchFilters: newFilters };
      }),
      setSearchResults: (searchResults) => set({ searchResults }),

});
