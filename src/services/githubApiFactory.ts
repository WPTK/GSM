import { GitHubApiService } from './githubApi';
import { GitHubListsApiService } from './githubListsApi';

/**
 * The browser never holds a GitHub token: every request goes to the same-origin
 * /api/proxy/github route, where the server attaches its own token. The
 * `githubToken` store field is kept (to avoid upstream-merge churn) but only
 * ever carries this constant.
 */
export const SERVER_HELD_TOKEN = 'server';

export function createGitHubApiService(token: string = SERVER_HELD_TOKEN): GitHubApiService {
  return new GitHubApiService(token);
}

export function createGitHubListsApiService(token: string = SERVER_HELD_TOKEN): GitHubListsApiService {
  const api = new GitHubListsApiService(token);
  // Lists is removed by the strip stream; until then keep it same-origin.
  api.setBackendUrl('/api');
  return api;
}
