/**
 * The browser never loads images from third-party hosts directly. GitHub image
 * locations are fetched through the same-origin `/api/img` route (the server
 * re-checks the allowlist on every redirect hop); everything else is blocked
 * unless the reader explicitly asks for it (see MarkdownRenderer "Load images").
 *
 * Keep the allowlist in sync with server/src/routes/img.ts (`isAllowedImageUrl`).
 */

const IMAGE_CDN_HOSTS = new Set([
  'avatars.githubusercontent.com',
  'raw.githubusercontent.com',
  'user-images.githubusercontent.com',
  'private-user-images.githubusercontent.com',
  'repository-images.githubusercontent.com',
]);

const SEGMENT = '[A-Za-z0-9._-]+';
const GITHUB_RAW_PATH = new RegExp(`^/${SEGMENT}/${SEGMENT}/raw/.+`);
const GITHUB_BLOB_PATH = new RegExp(`^/${SEGMENT}/${SEGMENT}/blob/.+`);
const GITHUB_ATTACHMENT_PATH = /^\/user-attachments\/assets\/[A-Za-z0-9-]+$/;
const GITHUB_USER_PNG_PATH = /^\/[A-Za-z0-9-]+\.png$/;

const MAX_URL_LENGTH = 2048;

/** True when `url` is an image location the backend `/api/img` route will fetch. */
export function isGitHubImageUrl(url: string | null | undefined): boolean {
  if (typeof url !== 'string' || url.length === 0 || url.length > MAX_URL_LENGTH) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  if (parsed.username || parsed.password) return false;
  if (parsed.port && parsed.port !== '443') return false;

  const host = parsed.hostname.toLowerCase();
  if (IMAGE_CDN_HOSTS.has(host)) return true;
  if (host !== 'github.com') return false;

  const path = parsed.pathname;
  if (path.includes('..')) return false;
  if (GITHUB_RAW_PATH.test(path)) return true;
  if (GITHUB_BLOB_PATH.test(path)) return parsed.searchParams.get('raw') === 'true';
  return GITHUB_ATTACHMENT_PATH.test(path) || GITHUB_USER_PNG_PATH.test(path);
}

/**
 * The URL to put in an `<img src>`: the same-origin proxy URL for GitHub image
 * locations, `data:image/` URLs unchanged (no network), and `undefined` for
 * anything else, so the caller renders a placeholder instead of leaking the
 * reader's address to a third-party host.
 */
export function imageProxySrc(url: string | null | undefined): string | undefined {
  if (typeof url !== 'string') return undefined;
  if (/^data:image\//i.test(url)) return url;
  if (!isGitHubImageUrl(url)) return undefined;
  return `/api/img?url=${encodeURIComponent(url)}`;
}
