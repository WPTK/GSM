import { Router } from 'express';
import { ImageCache } from '../services/imageCache.js';
import { RequestRejectedError, proxyRequest } from '../services/proxyService.js';

/** Largest image the proxy will fetch or serve. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_URL_LENGTH = 2048;
const CACHE_MAX_BYTES = 64 * 1024 * 1024;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const BROWSER_CACHE_SECONDS = 7 * 24 * 60 * 60;

export const imageCache = new ImageCache(CACHE_MAX_BYTES, CACHE_TTL_MS);

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
): void {
  res.status(200);
  res.set({
    'Content-Type': image.contentType,
    'Content-Length': String(image.body.length),
    'Cache-Control': `private, max-age=${BROWSER_CACHE_SECONDS}`,
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

  const cacheKey = target.toString();
  const cached = imageCache.get(cacheKey);
  if (cached) {
    sendImage(res, cached);
    return;
  }

  const result = await proxyRequest({
    url: cacheKey,
    method: 'GET',
    // No credentials: these are public image locations.
    headers: { Accept: 'image/*', 'User-Agent': 'GithubStarsManager-Backend' },
    timeout: 15000,
    responseType: 'buffer',
    maxBytes: MAX_IMAGE_BYTES,
    checkUrl: assertAllowedImageUrl,
  });

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
  imageCache.set(cacheKey, image);
  sendImage(res, image);
});

export default router;
