import { Router } from 'express';
import { ImageCache } from '../services/imageCache.js';
import { RequestRejectedError, proxyRequest } from '../services/proxyService.js';

/** Largest image the proxy will fetch or serve. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_URL_LENGTH = 2048;
const CACHE_MAX_BYTES = 64 * 1024 * 1024;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const BROWSER_CACHE_SECONDS = 7 * 24 * 60 * 60;
/** Signed private-image URLs expire quickly; keep them no longer than this. */
const PRIVATE_IMAGE_TTL_MS = 5 * 60 * 1000;
const PRIVATE_IMAGE_BROWSER_CACHE_SECONDS = 5 * 60;
const MAX_CONCURRENT_UPSTREAM = 4;
const MAX_QUEUED_UPSTREAM = 32;
const QUEUE_WAIT_MS = 10000;

export const imageCache = new ImageCache(CACHE_MAX_BYTES, CACHE_TTL_MS);

/** Bounds concurrent upstream fetches; extra requests wait briefly, then get 503. */
class UpstreamGate {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  async acquire(): Promise<boolean> {
    if (this.active < MAX_CONCURRENT_UPSTREAM) {
      this.active++;
      return true;
    }
    if (this.waiters.length >= MAX_QUEUED_UPSTREAM) return false;
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(grant);
        if (i >= 0) this.waiters.splice(i, 1);
        resolve(false);
      }, QUEUE_WAIT_MS);
      const grant = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      this.waiters.push(grant);
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) next(); // the slot passes straight to the next waiter
    else this.active--;
  }
}

const upstreamGate = new UpstreamGate();

const PRIVATE_IMAGE_HOST = 'private-user-images.githubusercontent.com';

/** Cache key: the signed query of private images is never stored or kept as a key. */
function cacheKeyFor(url: URL): string {
  if (url.hostname.toLowerCase() === PRIVATE_IMAGE_HOST) return `${url.origin}${url.pathname}`;
  return url.toString();
}

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

/** True when the URL is an image location the proxy may fetch. */
export function isAllowedImageUrl(url: URL): boolean {
  if (url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;
  if (url.port && url.port !== '443') return false;

  const host = url.hostname.toLowerCase();
  if (IMAGE_CDN_HOSTS.has(host)) return true;
  if (host !== 'github.com') return false;

  const path = url.pathname;
  if (path.includes('..')) return false;
  if (GITHUB_RAW_PATH.test(path)) return true;
  if (GITHUB_BLOB_PATH.test(path)) return url.searchParams.get('raw') === 'true';
  return GITHUB_ATTACHMENT_PATH.test(path) || GITHUB_USER_PNG_PATH.test(path);
}

/** Run on the first URL and on every redirect hop. */
function assertAllowedImageUrl(url: URL): void {
  if (!isAllowedImageUrl(url)) {
    throw new RequestRejectedError('Image host or path is not allowed', 403, 'IMAGE_HOST_NOT_ALLOWED');
  }
}

function baseContentType(header: string | undefined): string | null {
  const base = (header ?? '').split(';')[0].trim().toLowerCase();
  return /^image\/[a-z0-9.+-]+$/.test(base) ? base : null;
}

function sendImage(
  res: import('express').Response,
  image: { body: Buffer; contentType: string },
  isPrivate = false,
): void {
  res.status(200);
  res.set({
    'Content-Type': image.contentType,
    'Content-Length': String(image.body.length),
    'Cache-Control': `private, max-age=${isPrivate ? PRIVATE_IMAGE_BROWSER_CACHE_SECONDS : BROWSER_CACHE_SECONDS}`,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
  });
  res.end(image.body);
}

const router = Router();

// GET /api/img?url=<encoded image url>
router.get('/api/img', async (req, res) => {
  const raw = req.query.url;
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_URL_LENGTH) {
    res.status(400).json({ error: 'Invalid url', code: 'INVALID_URL' });
    return;
  }

  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    res.status(400).json({ error: 'Invalid url', code: 'INVALID_URL' });
    return;
  }
  if (target.protocol !== 'https:') {
    res.status(400).json({ error: 'Invalid url', code: 'INVALID_URL' });
    return;
  }
  if (!isAllowedImageUrl(target)) {
    res.status(403).json({ error: 'Image host or path is not allowed', code: 'IMAGE_HOST_NOT_ALLOWED' });
    return;
  }

  const isPrivate = target.hostname.toLowerCase() === PRIVATE_IMAGE_HOST;
  const cacheKey = cacheKeyFor(target);
  const cached = imageCache.get(cacheKey);
  if (cached) {
    sendImage(res, cached, isPrivate);
    return;
  }

  if (!(await upstreamGate.acquire())) {
    res.set('Retry-After', '2');
    res.status(503).json({ error: 'Image proxy is busy', code: 'BUSY' });
    return;
  }
  let result: Awaited<ReturnType<typeof proxyRequest>>;
  try {
    result = await proxyRequest({
    url: target.toString(),
    method: 'GET',
    // No credentials: these are public image locations.
    headers: { Accept: 'image/*', 'User-Agent': 'GithubStarsManager-Backend' },
    timeout: 15000,
    responseType: 'buffer',
    maxBytes: MAX_IMAGE_BYTES,
    checkUrl: assertAllowedImageUrl,
    });
  } finally {
    upstreamGate.release();
  }

  if (result.status === 413) {
    res.status(413).json({ error: 'Image too large', code: 'IMAGE_TOO_LARGE' });
    return;
  }
  const rejection = result.data as { code?: string } | undefined;
  if (result.status === 403 && (rejection?.code === 'IMAGE_HOST_NOT_ALLOWED' || rejection?.code === 'EGRESS_BLOCKED')) {
    res.status(403).json({
      error: 'Image host or path is not allowed',
      code: rejection.code === 'EGRESS_BLOCKED' ? 'EGRESS_BLOCKED' : 'IMAGE_HOST_NOT_ALLOWED',
    });
    return;
  }
  if (result.status < 200 || result.status >= 300 || !Buffer.isBuffer(result.data)) {
    res.status(502).json({ error: 'Upstream image request failed', code: 'UPSTREAM_ERROR' });
    return;
  }

  const contentType = baseContentType(result.headers['content-type']);
  if (!contentType) {
    res.status(502).json({ error: 'Upstream did not return an image', code: 'UPSTREAM_NOT_IMAGE' });
    return;
  }
  if (result.data.length > MAX_IMAGE_BYTES) {
    res.status(413).json({ error: 'Image too large', code: 'IMAGE_TOO_LARGE' });
    return;
  }

  const image = { body: result.data, contentType };
  imageCache.set(cacheKey, image, Date.now(), isPrivate ? PRIVATE_IMAGE_TTL_MS : CACHE_TTL_MS);
  sendImage(res, image, isPrivate);
});

export default router;
