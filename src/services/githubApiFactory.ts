import { GitHubApiService } from './githubApi';

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

