import { useT } from "../../../i18n/useT";
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { Category, Repository } from '../../../types';
import { useAppStore } from '../../../store/useAppStore';
import { useDialog } from '../../../hooks/useDialog';
import { useClaudeStatus } from '../../../hooks/useClaudeStatus';
import { useClaudeSpendConfirm } from '../../../hooks/useClaudeSpendConfirm';
import { runClaudeAnalysis } from '../../../services/claudeJobs';
import { forceSyncToBackend } from '../../../services/autoSync';
import { resolveCategoryAssignment } from '../../../utils/categoryUtils';
import { applyAnalysisFailure, applyAnalysisSuccess } from '../application/repositoryPatches';

export type RepositoryAnalysisScope = 'all' | 'unanalyzed' | 'failed' | 'selected';

interface UseRepositoryAnalysisJobOptions {
  allCategories: Category[];
}

interface RunRepositoryAnalysisOptions {
  repositories: Repository[];
  scope: RepositoryAnalysisScope;
  syncOnComplete: boolean;
}

export interface RepositoryAnalysisJob {
  run: (options: RunRepositoryAnalysisOptions) => Promise<boolean>;
  requestStop: () => Promise<boolean>;
  isRunning: boolean;
  progress: { current: number; total: number };
}

/**
 * Owns the lifecycle of one RepositoryList batch-analysis job. The work runs on the
 * server (estimate, job, poll); the hook keeps the abort controller in a ref so stop and
 * unmount cleanup always cancel the active job without putting a mutable job in the store.
 */
export const useRepositoryAnalysisJob = ({
  allCategories,
}: UseRepositoryAnalysisJobOptions): RepositoryAnalysisJob => {
  const {
    language,
    updateRepository,
    setLoading,
    setAnalysisProgress,
  } = useAppStore(useShallow((state) => ({
    language: state.language,
    updateRepository: state.updateRepository,
    setLoading: state.setLoading,
    setAnalysisProgress: state.setAnalysisProgress,
  })));

  const { toast, confirm } = useDialog();
  const { connected } = useClaudeStatus();
  const confirmSpend = useClaudeSpendConfirm();
  const abortRef = useRef<AbortController | null>(null);
  const isRunningRef = useRef(false);
  const stopRequestedRef = useRef(false);
  const mountedRef = useRef(true);
  const [isRunning, setIsRunning] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0 });

  const tApp = useT('app');
  const t = useT('repositories');

  const resetVisibleState = useCallback(() => {
    setLoading(false);
    setAnalysisProgress({ current: 0, total: 0 });
    if (mountedRef.current) {
      setIsRunning(false);
      setProgress({ current: 0, total: 0 });
    }
  }, [setAnalysisProgress, setLoading]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
      abortRef.current = null;
      isRunningRef.current = false;
      stopRequestedRef.current = false;
      setLoading(false);
      setAnalysisProgress({ current: 0, total: 0 });
    };
  }, [setAnalysisProgress, setLoading]);

  const requestStop = useCallback(async () => {
    if (!isRunningRef.current) return false;

    const confirmed = await confirm(
      t('useRepositoryAnalysisJob.stop-ai-analysis'),
      t('useRepositoryAnalysisJob.are-you-sure-you-want-to-stop-ai-analysis-analyz'),
      { type: 'warning' },
    );
    if (!confirmed || !isRunningRef.current) return false;

    stopRequestedRef.current = true;
    abortRef.current?.abort();
    return true;
  }, [confirm, t]);

  const run = useCallback(async ({
    repositories,
    scope,
    syncOnComplete,
  }: RunRepositoryAnalysisOptions) => {
    if (isRunningRef.current) return false;

    if (!connected) {
      toast(tApp('claudePanel.not-connected'), 'error');
      return false;
    }

    if (repositories.length === 0) {
      const message = scope === 'failed'
        ? t('useRepositoryAnalysisJob.no-failed-repositories-to-re-analyze')
        : scope === 'unanalyzed'
          ? t('useRepositoryAnalysisJob.all-repositories-have-been-analyzed')
          : t('useRepositoryAnalysisJob.no-repositories-to-analyze');
      toast(message, 'info');
      return false;
    }

    const actionText = scope === 'failed'
      ? (t('useRepositoryAnalysisJob.failed'))
      : scope === 'unanalyzed'
        ? (t('useRepositoryAnalysisJob.unanalyzed'))
        : (t('useRepositoryAnalysisJob.all'));
    const confirmationMessage = scope === 'selected'
      ? (t('useRepositoryAnalysisJob.will-analyze-v1-repositories-with-ai-this-may-ta', { v1: repositories.length }))
      : (t('useRepositoryAnalysisJob.will-analyze-v1-actiontext-repositories-with-ai', { v1: repositories.length, actionText: actionText }));

    const confirmed = await confirm(
      t('useRepositoryAnalysisJob.ai-analysis-confirmation'),
      confirmationMessage,
      { type: 'warning' },
    );
    if (!confirmed) return false;

    const controller = new AbortController();
    abortRef.current = controller;
    stopRequestedRef.current = false;
    isRunningRef.current = true;
    setLoading(true);
    setAnalysisProgress({ current: 0, total: repositories.length });
    if (mountedRef.current) {
      setIsRunning(true);
      setProgress({ current: 0, total: repositories.length });
    }

    let successCount = 0;
    let failedCount = 0;
    const byId = new Map(repositories.map((repository) => [repository.id, repository]));

    try {
      const outcome = await runClaudeAnalysis(
        { repoIds: repositories.map((repository) => repository.id), language },
        {
          signal: controller.signal,
          confirmSpend,
          onProgress: (job) => {
            if (!mountedRef.current || abortRef.current !== controller) return;
            const current = job.done + job.failed;
            setAnalysisProgress({ current, total: job.total });
            setProgress({ current, total: job.total });
          },
          onItem: (item) => {
            if (!mountedRef.current || abortRef.current !== controller) return;
            const repo = byId.get(item.repoId);
            if (!repo) return;
            if (item.status === 'done' && item.result) {
              const resolvedCategory = resolveCategoryAssignment(
                { ...repo, ai_summary: item.result.summary },
                item.result.tags || [],
                allCategories,
              );
              updateRepository(applyAnalysisSuccess(repo, {
                summary: item.result.summary,
                tags: item.result.tags,
                platforms: item.result.platforms,
                category: resolvedCategory,
                categoryLocked: !!repo.category_locked,
                analyzedAt: new Date().toISOString(),
              }));
              successCount += 1;
              return;
            }
            updateRepository(applyAnalysisFailure(repo, {
              analyzedAt: new Date().toISOString(),
              error: item.error || undefined,
            }));
            failedCount += 1;
          },
        },
      );

      if (outcome.declined) return false;
      if (syncOnComplete) {
        await forceSyncToBackend();
      }

      if (scope === 'selected') {
        toast(
          t('useRepositoryAnalysisJob.successfully-analyzed-successcount-repositories', { successCount: successCount, failedCount: failedCount }),
          failedCount > 0 ? 'error' : 'success',
        );
      } else {
        toast(
          stopRequestedRef.current || outcome.cancelled
            ? (t('useRepositoryAnalysisJob.ai-analysis-stopped-success-successcount-failed', { successCount: successCount, failedCount: failedCount }))
            : (t('useRepositoryAnalysisJob.ai-analysis-completed-success-successcount-faile', { successCount: successCount, failedCount: failedCount })),
          'success',
        );
      }
      return true;
    } catch (error) {
      console.error(scope === 'selected' ? 'Bulk AI analysis failed:' : 'AI analysis failed:', error);
      toast(
        scope === 'selected'
          ? (t('useRepositoryAnalysisJob.bulk-ai-analysis-failed'))
          : (t('useRepositoryAnalysisJob.ai-analysis-failed-please-check-ai-configuration')),
        'error',
      );
      return false;
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        isRunningRef.current = false;
        stopRequestedRef.current = false;
        resetVisibleState();
      }
    }
  }, [allCategories, confirm, confirmSpend, connected, language, resetVisibleState, setAnalysisProgress, setLoading, t, tApp, toast, updateRepository]);

  return useMemo(() => ({
    run,
    requestStop,
    isRunning,
    progress,
  }), [isRunning, progress, requestStop, run]);
};
