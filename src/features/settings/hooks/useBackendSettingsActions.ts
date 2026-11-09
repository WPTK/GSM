
import { useT } from '../../../i18n/useT';
import { useCallback, useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { Category } from '../../../types';
import { useAppStore } from '../../../store/useAppStore';
import { useDialog } from '../../../hooks/useDialog';
import { backend } from '../../../services/backendAdapter';
import { tryRestoreAuthFromBackend } from '../../../services/autoSync';

type BackendStatus = 'connected' | 'disconnected' | 'checking';

export interface BackendSettingsActions {
  status: BackendStatus;
  health: { version: string; timestamp: string } | null;
  /** Whether the server holds a GitHub token; null until the status is known. */
  githubConfigured: boolean | null;
  backendAvailable: boolean;
  isSyncingToBackend: boolean;
  isSyncingFromBackend: boolean;
  testConnection: () => Promise<void>;
  logout: () => Promise<void>;
  syncToBackend: () => Promise<void>;
  syncFromBackend: () => Promise<void>;
}

/**
 * Encapsulates manual settings-panel backend operations. Application-start auth
 * lifecycle remains outside this hook for the later lifecycle extraction work.
 */
export const useBackendSettingsActions = (): BackendSettingsActions => {
  const t = useT('settings');
  const state = useAppStore(useShallow((store) => ({
    repositories: store.repositories,
    releases: store.releases,
    aiConfigs: store.aiConfigs,
    activeAIConfig: store.activeAIConfig,
    hiddenDefaultCategoryIds: store.hiddenDefaultCategoryIds,
    categoryOrder: store.categoryOrder,
    customCategories: store.customCategories,
    assetFilters: store.assetFilters,
    defaultCategoryOverrides: store.defaultCategoryOverrides,
    collapsedSidebarCategoryCount: store.collapsedSidebarCategoryCount,
    setRepositories: store.setRepositories,
    setReleases: store.setReleases,
    setAIConfigs: store.setAIConfigs,
    showDefaultCategory: store.showDefaultCategory,
    hideDefaultCategory: store.hideDefaultCategory,
  })));
  const { toast, confirm } = useDialog();
  const [status, setStatus] = useState<BackendStatus>('disconnected');
  const [health, setHealth] = useState<{ version: string; timestamp: string } | null>(null);
  const [isSyncingToBackend, setIsSyncingToBackend] = useState(false);
  const [isSyncingFromBackend, setIsSyncingFromBackend] = useState(false);
  const [githubConfigured, setGithubConfigured] = useState<boolean | null>(null);

  const checkConnection = useCallback(async () => {
    setStatus('checking');
    try {
      await backend.init();
      const healthData = await backend.checkHealth();
      if (healthData) {
        setStatus('connected');
        setHealth({ version: healthData.version, timestamp: healthData.timestamp });
        const auth = await backend.authStatus();
        setGithubConfigured(auth ? auth.githubConfigured : null);
        return true;
      }
    } catch {
      // A disconnected backend must leave the settings screen usable.
    }
    setStatus('disconnected');
    setHealth(null);
    setGithubConfigured(null);
    return false;
  }, []);

  useEffect(() => {
    void checkConnection();
  }, [checkConnection]);

  const testConnection = useCallback(async () => {
    const connected = await checkConnection();
    if (!connected) {
      toast(t('useBackendSettingsActions.backend-connection-failed-please-check-the-serve'), 'error');
      return;
    }
    toast(t('useBackendSettingsActions.backend-connection-successful'), 'success');
    // A deliberate manual action; app-start restoration is not moved here.
    void tryRestoreAuthFromBackend();
  }, [checkConnection, t, toast]);

  const logout = useCallback(async () => {
    try {
      await backend.logout();
    } catch (error) {
      console.warn('Logout request failed:', error);
    }
    // Clearing the local identity returns the app to the login screen.
    useAppStore.getState().logout();
  }, []);

  const syncToBackend = useCallback(async () => {
    if (!backend.isAvailable) {
      toast(t('useBackendSettingsActions.backend-not-available'), 'error');
      return;
    }
    setIsSyncingToBackend(true);
    try {
      const results = await Promise.allSettled([
        backend.syncRepositories(state.repositories),
        backend.syncReleases(state.releases),
        backend.syncAIConfigs(state.aiConfigs),
        backend.syncSettings({
          activeAIConfig: state.activeAIConfig,
          hiddenDefaultCategoryIds: state.hiddenDefaultCategoryIds,
          categoryOrder: state.categoryOrder,
          customCategories: state.customCategories,
          assetFilters: state.assetFilters,
          defaultCategoryOverrides: state.defaultCategoryOverrides,
          collapsedSidebarCategoryCount: state.collapsedSidebarCategoryCount,
        }),
      ]);
      const failures = results.filter((result) => result.status === 'rejected');
      const successes = results.filter((result) => result.status === 'fulfilled');
      if (failures.length) {
        console.warn('Some syncs failed:', failures.map((failure) => (failure as PromiseRejectedResult).reason));
        toast(t('useBackendSettingsActions.partial-sync-failure-v1-failed-v2-succeeded', { v1: failures.length, v2: successes.length }), 'error');
      } else {
        toast(t('useBackendSettingsActions.synced-to-backend-repos-v1-releases-v2-ai-config', { v1: state.repositories.length, v2: state.releases.length, v3: state.aiConfigs.length }), 'success');
      }
    } catch (error) {
      console.error('Sync to backend failed:', error);
      toast(`${t('useBackendSettingsActions.sync-failed')}: ${(error as Error).message}`, 'error');
    } finally {
      setIsSyncingToBackend(false);
    }
  }, [state, t, toast]);

  const syncFromBackend = useCallback(async () => {
    if (!backend.isAvailable) {
      toast(t('useBackendSettingsActions.backend-not-available'), 'error');
      return;
    }
    const confirmed = await confirm(
      t('useBackendSettingsActions.sync-from-backend'),
      t('useBackendSettingsActions.syncing-from-backend-will-overwrite-local-data-c'),
      { type: 'warning' },
    );
    if (!confirmed) return;
    setIsSyncingFromBackend(true);
    try {
      const [repoData, releaseData, aiConfigData, settingsData] = await Promise.all([
        backend.fetchRepositories(),
        backend.fetchReleases(),
        backend.fetchAIConfigs(),
        backend.fetchSettings(),
      ]);
      state.setRepositories(repoData.repositories, { allowEmpty: true });
      state.setReleases(releaseData.releases, { allowEmpty: true });
      state.setAIConfigs(aiConfigData);
      const serverHidden = Array.isArray(settingsData.hiddenDefaultCategoryIds) ? settingsData.hiddenDefaultCategoryIds : [];
      for (const categoryId of serverHidden) if (typeof categoryId === 'string') state.hideDefaultCategory(categoryId);
      for (const categoryId of state.hiddenDefaultCategoryIds) {
        if (typeof categoryId === 'string' && !serverHidden.includes(categoryId)) state.showDefaultCategory(categoryId);
      }
      if (
        settingsData.defaultCategoryOverrides !== null
        && typeof settingsData.defaultCategoryOverrides === 'object'
        && !Array.isArray(settingsData.defaultCategoryOverrides)
      ) {
        useAppStore.setState({
          defaultCategoryOverrides: settingsData.defaultCategoryOverrides as Record<string, Partial<Category>>,
        });
      }
      toast(t('useBackendSettingsActions.synced-from-backend-repos-v1-releases-v2-ai-conf', { v1: repoData.repositories.length, v2: releaseData.releases.length, v3: aiConfigData.length }), 'success');
    } catch (error) {
      console.error('Sync from backend failed:', error);
      toast(`${t('useBackendSettingsActions.sync-failed')}: ${(error as Error).message}`, 'error');
    } finally {
      setIsSyncingFromBackend(false);
    }
  }, [confirm, state, t, toast]);

  return {
    status,
    health,
    githubConfigured,
    backendAvailable: backend.isAvailable,
    isSyncingToBackend,
    isSyncingFromBackend,
    testConnection,
    logout,
    syncToBackend,
    syncFromBackend,
  };
};
