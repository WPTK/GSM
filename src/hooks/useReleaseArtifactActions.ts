import { useT } from "../i18n/useT";
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { Release } from '../types';
import { AIService } from '../services/aiService';
import { useAppStore } from '../store/useAppStore';
import { useDialog } from '../hooks/useDialog';

export type ReleaseArtifactSummaryState = {
  status: 'idle' | 'loading' | 'done' | 'error';
  content?: string;
  error?: string;
};

export type DownloadState = 'idle' | 'sending';

// 同一资产更新后 URL 不变但 updatedAt 会变，key 带上版本，
// 否则旧版本的状态会错误地残留在新版本上。
export const computeDownloadKey = (link: { url: string; updatedAt?: string }): string =>
  `${link.url}@${link.updatedAt ?? ''}`;

export interface ReleaseArtifactActions {
  summaries: Record<number, ReleaseArtifactSummaryState>;
  generateSummary: (release: Release) => Promise<void>;
  cancelSummaryRequests: () => void;
  /** 清空 summaries（sheet 在 loadReleases 时重置，原为其本地 state 置空）。 */
  reset: () => void;
}

/**
 * Release 资产动作（AI 总结），规范语义取自 ReleaseCard 版本；
 * useRepositoryReleaseSheet 委托本 hook（ADR 0001：同一逻辑不允许第三份拷贝）。
 */
export const useReleaseArtifactActions = (): ReleaseArtifactActions => {
  const { language, aiConfigs, activeAIConfig } = useAppStore(useShallow((state) => ({
    language: state.language,
    aiConfigs: state.aiConfigs,
    activeAIConfig: state.activeAIConfig,
  })));
  const { toast } = useDialog();
  const t = useT('app');

  const [summaries, setSummaries] = useState<Record<number, ReleaseArtifactSummaryState>>({});
  const summaryAbortRefs = useRef<Record<number, AbortController | undefined>>({});

  const cancelSummaryRequests = useCallback(() => {
    Object.values(summaryAbortRefs.current).forEach((controller) => controller?.abort());
    summaryAbortRefs.current = {};
  }, []);

  useEffect(() => cancelSummaryRequests, [cancelSummaryRequests]);

  const reset = useCallback(() => {
    // 先取消进行中的总结请求再清空：否则刷新（sheet 的 loadReleases）后，
    // 迟到的完成会回写旧结果到刚清空的状态里。
    cancelSummaryRequests();
    setSummaries({});
  }, [cancelSummaryRequests]);

  const generateSummary = useCallback(async (release: Release) => {
    const existing = summaries[release.id];
    // 前置守卫：loading 中或已有结论时不重跑。ReleaseCard 按钮在 loading 期间本就
    // disabled（原实现的"取消上一请求"由此不可达，此处守卫化并兼容 sheet 委托）。
    if (existing?.status === 'loading' || (existing?.status === 'done' && existing.content)) return;

    const activeConfig = aiConfigs.find((config) => config.id === activeAIConfig);
    if (!activeConfig) {
      toast(
        t('useReleaseArtifactActions.please-configure-ai-service-in-settings-first'),
        'error'
      );
      return;
    }

    // 同步门卫：loading 守卫读的是渲染快照，同一事件循环内的连续调用（双击/重复
    // 触发）拿到的还是旧快照、会双双通过；summaryAbortRefs 同步更新，可挡住并发
    // 双请求。
    if (summaryAbortRefs.current[release.id]) return;

    // 请求取消仅经由 cancelSummaryRequests（unmount / reset）；同步门卫 + loading
    // 守卫使同 id 并发不可达，无需"取消上一请求"。
    const controller = new AbortController();
    summaryAbortRefs.current[release.id] = controller;

    const config = activeConfig;
    setSummaries((previous) => ({ ...previous, [release.id]: { status: 'loading' } }));
    try {
      const aiService = new AIService(config, language);
      const content = await aiService.analyzeReleaseSummary(
        release.body || '',
        {
          repoName: release.repository.full_name,
          tagName: release.tag_name,
          releaseName: release.name && release.name !== release.tag_name ? release.name : undefined,
        },
        controller.signal
      );
      // 对齐原 sheet 的 post-await 守卫：服务不响应 signal 而迟到 resolve 时
      // （如 reset()/unmount 之后），丢弃过期结果，不得回写刚清空的状态。
      if (controller.signal.aborted) return;
      setSummaries((previous) => ({ ...previous, [release.id]: { status: 'done', content } }));
    } catch (error) {
      // 主动取消（卸载/重置）时静默处理，不更新状态、不弹错误
      if ((error instanceof Error && error.name === 'AbortError') || controller.signal.aborted) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      setSummaries((previous) => ({ ...previous, [release.id]: { status: 'error', error: message } }));
      toast(
        t('useReleaseArtifactActions.summary-failed-message', { message: message }),
        'error'
      );
    } finally {
      if (summaryAbortRefs.current[release.id] === controller) {
        delete summaryAbortRefs.current[release.id];
      }
    }
  }, [activeAIConfig, aiConfigs, language, summaries, toast, t]);

  return useMemo(() => ({
    summaries,
    generateSummary,
    cancelSummaryRequests,
    reset,
  }), [summaries, generateSummary, cancelSummaryRequests, reset]);
};
