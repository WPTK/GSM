import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { useT } from '../i18n/useT';
import { useClaudeStatus } from '../hooks/useClaudeStatus';

/**
 * Shown on every page of the signed-in app while the server reports the Anthropic
 * account balance as too low (GET /api/ai/status state "credit_low"). The server pauses
 * analysis jobs by itself and resumes them when the balance is back.
 */
export const CreditLowBanner: React.FC = () => {
  const t = useT('app');
  const { state, status } = useClaudeStatus();
  if (state !== 'credit_low') return null;
  const nextCheck = status?.nextCheckAt ? new Date(status.nextCheckAt) : null;
  return (
    <div
      role="alert"
      className="flex items-start gap-3 border-b border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive"
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div>
        <p className="font-medium">{t('creditBanner.title')}</p>
        <p>{t('creditBanner.message')}</p>
        {nextCheck && !Number.isNaN(nextCheck.getTime()) && (
          <p className="text-xs">{t('creditBanner.next-check', { time: nextCheck.toLocaleTimeString() })}</p>
        )}
      </div>
    </div>
  );
};
