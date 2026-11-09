import { Router } from 'express';
import { proxyRequest, validateUrl } from '../services/proxyService.js';
import { getGithubToken } from '../services/githubToken.js';
import { logger } from '../services/logger.js';

const router = Router();

// 透传上游与限流相关的响应头，供前端（含直连模式）统一识别 Retry-After 与剩余配额。
const UPSTREAM_RATE_LIMIT_HEADERS = new Set([
  'retry-after',
  'retry-after-ms',
  'x-ratelimit-remaining-requests',
  'x-ratelimit-remaining-tokens',
  'x-ratelimit-reset-requests',
  'x-ratelimit-reset-tokens',
  'x-ratelimit-limit-requests',
  'x-ratelimit-limit-tokens',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
  'x-ratelimit-limit',
  'ratelimit-remaining',
  'ratelimit-reset',
  'ratelimit-limit',
  'anthropic-ratelimit-requests-remaining',
  'anthropic-ratelimit-requests-reset',
  'anthropic-ratelimit-input-tokens-remaining',
  'anthropic-ratelimit-input-tokens-reset',
  'anthropic-ratelimit-output-tokens-remaining',
  'anthropic-ratelimit-output-tokens-reset',
  'x-should-retry',
]);

function relayRateLimitHeaders(res: import('express').Response, headers: Record<string, string> | undefined): void {
  if (!headers) return;
  for (const [key, value] of Object.entries(headers)) {
    if (UPSTREAM_RATE_LIMIT_HEADERS.has(key.toLowerCase()) && typeof value === 'string' && value) {
      try {
        res.setHeader(key, value);
      } catch { /* ignore invalid header name */ }
    }
  }
}

// POST /api/proxy/github/*
router.post(/^\/api\/proxy\/github\/(.*)/, async (req, res) => {
  try {
    const rawPath = (req.params as Record<string, string>)[0];
    const githubPath = Array.isArray(rawPath) ? rawPath.join('/') : (rawPath ?? '');

    // Prevent path traversal
    if (typeof githubPath !== 'string' || githubPath.includes('..') || githubPath.includes('\\')) {
      res.status(400).json({ error: 'Invalid target path', code: 'INVALID_TARGET_PATH' });
      return;
    }
    
    const token = getGithubToken();
    if (!token) {
      res.status(400).json({ error: 'GitHub token not configured', code: 'GITHUB_TOKEN_NOT_CONFIGURED' });
      return;
    }

    const cleanPath = githubPath.replace(/^\/+/, '');
    const safeSegments = cleanPath.split('/').map(seg => encodeURIComponent(seg)).join('/');

    const searchParams = new URL(req.url, 'http://localhost').searchParams;
    const safeSearchParams = new URLSearchParams();
    for (const [key, value] of searchParams.entries()) {
      // URLSearchParams already decoded the incoming values; set them raw so
      // toString() performs exactly one round of encoding.
      safeSearchParams.set(key, value);
    }
    const safeQuery = safeSearchParams.toString() ? `?${safeSearchParams.toString()}` : '';

    const targetUrl = `https://api.github.com/${safeSegments}${safeQuery}`;

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(targetUrl);
    } catch {
      res.status(400).json({ error: 'Invalid target path', code: 'INVALID_TARGET_PATH' });
      return;
    }

    if (parsedUrl.protocol !== 'https:' || parsedUrl.hostname !== 'api.github.com') {
      res.status(400).json({ error: 'Host not allowed', code: 'HOST_NOT_ALLOWED' });
      return;
    }
    validateUrl(targetUrl);

    const body = req.body as { method?: string; headers?: Record<string, string>; body?: string | object };
    const method = body.method || 'GET';
    
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${token}`,
      'Accept': body.headers?.Accept || 'application/vnd.github.v3+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'GithubStarsManager-Backend',
    };
    const contentType = body.headers?.['Content-Type'] || body.headers?.['content-type'];
    if (contentType) {
      headers['Content-Type'] = contentType;
    }

    const result = await proxyRequest({ url: targetUrl, method, headers, body: body.body });
    relayRateLimitHeaders(res, result.headers);
    res.status(result.status).json(result.data);
  } catch (err) {
    logger.errorFromError('proxy.github', 'GitHub proxy error', err);
    res.status(500).json({ error: 'GitHub proxy failed', code: 'GITHUB_PROXY_FAILED' });
  }
});

// POST /api/proxy/github/search/repositories
router.post('/api/proxy/github/search/repositories', async (req, res) => {
  try {
    const githubPath = 'search/repositories';
    const { query_params } = req.body as { query_params?: Record<string, string> };

    const token = getGithubToken();
    if (!token) {
      res.status(400).json({ error: 'GitHub token not configured', code: 'GITHUB_TOKEN_NOT_CONFIGURED' });
      return;
    }

    const queryString = query_params ? '?' + new URLSearchParams(query_params).toString() : '';
    const targetUrl = `https://api.github.com/${githubPath}${queryString}`;

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github.v3+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'GithubStarsManager-Backend',
    };

    const result = await proxyRequest({ url: targetUrl, method: 'GET', headers });
    relayRateLimitHeaders(res, result.headers);
    res.status(result.status).json(result.data);
  } catch (err) {
    logger.errorFromError('proxy.github.search', 'GitHub search repositories proxy error', err);
    res.status(500).json({ error: 'GitHub search proxy failed', code: 'GITHUB_SEARCH_PROXY_FAILED' });
  }
});

// POST /api/proxy/github/search/users
router.post('/api/proxy/github/search/users', async (req, res) => {
  try {
    const githubPath = 'search/users';
    const { query_params } = req.body as { query_params?: Record<string, string> };

    const token = getGithubToken();
    if (!token) {
      res.status(400).json({ error: 'GitHub token not configured', code: 'GITHUB_TOKEN_NOT_CONFIGURED' });
      return;
    }

    const queryString = query_params ? '?' + new URLSearchParams(query_params).toString() : '';
    const targetUrl = `https://api.github.com/${githubPath}${queryString}`;

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github.v3+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'GithubStarsManager-Backend',
    };

    const result = await proxyRequest({ url: targetUrl, method: 'GET', headers });
    relayRateLimitHeaders(res, result.headers);
    res.status(result.status).json(result.data);
  } catch (err) {
    logger.errorFromError('proxy.github.search', 'GitHub search users proxy error', err);
    res.status(500).json({ error: 'GitHub search proxy failed', code: 'GITHUB_SEARCH_PROXY_FAILED' });
  }
});

export default router;
