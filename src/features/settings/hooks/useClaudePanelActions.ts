import { useCallback, useEffect, useState } from 'react';
import { useT } from '../../../i18n/useT';
import { useDialog } from '../../../hooks/useDialog';
import { fetchAiSettings, saveAiSettings } from '../../../services/claudeClient';

export interface ClaudePanelActions {
  value: string;
  setValue: (value: string) => void;
  loading: boolean;
  saving: boolean;
  dirty: boolean;
  /** True when the stored prompt could not be read; the field stays locked so Save cannot wipe it. */
  loadFailed: boolean;
  retry: () => void;
  save: () => Promise<void>;
};

/** Loads and saves the custom analysis prompt (GET/PUT /api/ai/settings). */
export const useClaudePanelActions = (): ClaudePanelActions => {
  const t = useT('app');
  const { toast } = useDialog();
  const [value, setValue] = useState('');
  const [saved, setSaved] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadFailed(false);
    fetchAiSettings(controller.signal)
      .then((settings) => {
        setValue(settings.customAnalysisPrompt);
        setSaved(settings.customAnalysisPrompt);
      })
      .catch(() => {
        // Locked, not empty: saving an empty field would overwrite the stored prompt.
        if (!controller.signal.aborted) setLoadFailed(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  const save = useCallback(async () => {
    if (loadFailed) return;
    setSaving(true);
    try {
      const result = await saveAiSettings(value);
      setValue(result.customAnalysisPrompt);
      setSaved(result.customAnalysisPrompt);
      toast(t('claudePanel.prompt-saved'), 'success');
    } catch (error) {
      toast(`${t('claudePanel.prompt-save-failed')}: ${error instanceof Error ? error.message : String(error)}`, 'error');
    } finally {
      setSaving(false);
    }
  }, [loadFailed, t, toast, value]);

  return { value, setValue, loading, saving, dirty: value !== saved, loadFailed, retry, save };
};
