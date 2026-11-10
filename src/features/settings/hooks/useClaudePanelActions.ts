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

  useEffect(() => {
    const controller = new AbortController();
    fetchAiSettings(controller.signal)
      .then((settings) => {
        setValue(settings.customAnalysisPrompt);
        setSaved(settings.customAnalysisPrompt);
      })
      .catch(() => {
        // Left empty: the field stays editable and the save toast reports a real failure.
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);

  const save = useCallback(async () => {
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
  }, [t, toast, value]);

  return { value, setValue, loading, saving, dirty: value !== saved, save };
};
