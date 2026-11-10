import { useCallback } from 'react';
import { useT } from '../i18n/useT';
import { useDialog } from './useDialog';
import type { AnalysisEstimateResponse } from '../services/claudeContract';

/**
 * Confirm dialog for an expensive Claude analysis. The server decides when an estimate
 * is over its threshold (needsConfirm); this only shows the figures and asks.
 */
export function useClaudeSpendConfirm(): (estimate: AnalysisEstimateResponse) => Promise<boolean> {
  const t = useT('app');
  const { confirm } = useDialog();
  return useCallback((estimate: AnalysisEstimateResponse) => confirm(
    t('spendConfirm.title'),
    t(estimate.batch ? 'spendConfirm.message-batch' : 'spendConfirm.message', {
      repos: estimate.repos,
      usd: estimate.usd.toFixed(2),
      threshold: estimate.confirmThresholdUsd.toFixed(2),
      model: estimate.model,
    }),
    { type: 'warning', confirmText: t('spendConfirm.confirm') },
  ), [confirm, t]);
}
