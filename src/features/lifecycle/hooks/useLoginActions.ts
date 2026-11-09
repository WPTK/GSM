import { useCallback } from 'react';
import { GITHUB_TOKEN_INVALID_ERROR } from '../../../services/githubApi';
import { createGitHubApiService, SERVER_HELD_TOKEN } from '../../../services/githubApiFactory';
import { backend } from '../../../services/backendAdapter';
import { syncFromBackend } from '../../../services/autoSync';
import type { GitHubUser } from '../../../types';

export type BackendLoginResult =
  | { status: 'connected'; githubToken: string; user: GitHubUser }
  | { status: 'backend-unavailable' }
  | { status: 'unauthorized' }
  | { status: 'github-not-configured' }
  | { status: 'github-token-invalid' };

export interface LoginActions {
  /** Exchange the API secret for the session cookie, then verify the server-held GitHub token. */
  loginWithApiSecret: (secret: string) => Promise<BackendLoginResult>;
  syncBackendData: () => Promise<void>;
}

export const useLoginActions = (): LoginActions => {
  const loginWithApiSecret = useCallback(async (secret: string): Promise<BackendLoginResult> => {
    if (!backend.isAvailable) await backend.init();
    if (!backend.isAvailable) return { status: 'backend-unavailable' };
    if (!await backend.login(secret)) return { status: 'unauthorized' };

    const status = await backend.authStatus();
    if (!status?.githubConfigured) return { status: 'github-not-configured' };

    try {
      const user = await createGitHubApiService().getCurrentUser();
      return { status: 'connected', githubToken: SERVER_HELD_TOKEN, user };
    } catch (err) {
      if (err instanceof Error && err.message === GITHUB_TOKEN_INVALID_ERROR) {
        return { status: 'github-token-invalid' };
      }
      // Network failures, rate limits and 5xx are transient: let the user retry.
      throw err;
    }
  }, []);
  const syncBackendData = useCallback(async () => {
    await syncFromBackend({ force: true });
  }, []);

  return { loginWithApiSecret, syncBackendData };
};
