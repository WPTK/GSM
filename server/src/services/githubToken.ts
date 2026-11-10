import { readSecret } from '../secrets.js';

/**
 * The GitHub token lives only on the server, in the environment:
 * GITHUB_TOKEN, or GITHUB_TOKEN_FILE (a path, for Docker secrets).
 * It is never stored in the database and never sent to the browser.
 */
let cached: string | null | undefined;

function readToken(): string | null {
  return readSecret('GITHUB_TOKEN');
}

/** Returns the configured GitHub token, or null. Read once, then cached. */
export function getGithubToken(): string | null {
  if (cached === undefined) {
    cached = readToken();
  }
  return cached;
}

export function isGithubConfigured(): boolean {
  return getGithubToken() !== null;
}

/** Test hook: forget the cached token so the next call re-reads the environment. */
export function resetGithubTokenForTests(): void {
  cached = undefined;
}
