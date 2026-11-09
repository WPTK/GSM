import fs from 'node:fs';

/**
 * The GitHub token lives only on the server, in the environment:
 * GITHUB_TOKEN, or GITHUB_TOKEN_FILE (a path, for Docker secrets).
 * It is never stored in the database and never sent to the browser.
 */
let cached: string | null | undefined;

function readToken(): string | null {
  const direct = process.env.GITHUB_TOKEN?.trim();
  if (direct) return direct;

  const file = process.env.GITHUB_TOKEN_FILE?.trim();
  if (file) {
    try {
      const fromFile = fs.readFileSync(file, 'utf8').trim();
      if (fromFile) return fromFile;
    } catch {
      // An unreadable file is the same as "not configured"; the path is not logged.
    }
  }
  return null;
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
