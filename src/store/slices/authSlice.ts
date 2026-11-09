import { logger } from '../../services/logger';
import { resetSyncHashes } from '../../services/autoSync';
import type { AppStoreSlice } from '../types';
import { accountIdKey, applyAccountWorkspace, captureAccountWorkspace, switchAccountWorkspace } from '../helpers/accountWorkspace';
import { purgeLegacyAuthStorage } from '../persistence/legacyAuthStorage';

export const createAuthSlice: AppStoreSlice<Pick<import('../types').AppActions, 'setUser' | 'setGitHubToken' | 'logout'>> = (set, get) => ({
      setUser: (user) => {
        logger.info('store.setUser', 'Setting user', { hasUser: !!user, userId: user?.id ?? null });
        const current = get();
        const previousAccountId = accountIdKey(current.user);
        const nextAccountId = accountIdKey(user);
        if (user && nextAccountId) {
          const switched = switchAccountWorkspace(current, previousAccountId, nextAccountId);
          set({
            user,
            isAuthenticated: true,
            accountWorkspaces: switched.accountWorkspaces,
            ...(switched.workspace ?? {}),
          });
        } else {
          set({ user, isAuthenticated: !!user });
        }
      },
      setGitHubToken: (token) => {
        logger.info('store.setGitHubToken', 'Setting GitHub token', { hasToken: !!token });
        set({ githubToken: token });
      },
      logout: () => {
        // Credential teardown only. Snapshot the GitHub-id workspace first, then
        // park the live lists so the login screen cannot inherit another account.
        const current = get();
        const accountId = accountIdKey(current.user);
        const accountWorkspaces = accountId
          ? { ...current.accountWorkspaces, [accountId]: captureAccountWorkspace(current) }
          : current.accountWorkspaces;
        purgeLegacyAuthStorage();
        // Reset sync fingerprints so the next force sync (e.g. backend
        // login restore) applies every shard even if the backend data has
        // not changed since this session.
        resetSyncHashes();
        set({
          user: null,
          githubToken: null,
          isAuthenticated: false,
          accountWorkspaces,
          ...applyAccountWorkspace(undefined),
        });
      },

});
