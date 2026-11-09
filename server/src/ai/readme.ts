import { proxyRequest } from '../services/proxyService.js';
import { getGithubToken } from '../services/githubToken.js';

const MAX_README_BYTES = 2 * 1024 * 1024;

/**
 * Fetches a repository's README as raw text through the central egress function with the
 * server's GitHub token. A missing README (404) is an empty string; other failures throw
 * so the item fails visibly instead of being analysed without its README.
 */
export async function fetchReadme(fullName: string): Promise<string> {
  const token = getGithubToken();
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.raw+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'GithubStarsManager-Backend',
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await proxyRequest({
    url: `https://api.github.com/repos/${fullName}/readme`,
    method: 'GET',
    headers,
    responseType: 'text',
    maxBytes: MAX_README_BYTES,
    timeout: 30000,
  });
  if (res.status === 404) return '';
  if (res.status !== 200) throw new Error(`README fetch failed (HTTP ${res.status})`);
  return typeof res.data === 'string' ? res.data : '';
}
