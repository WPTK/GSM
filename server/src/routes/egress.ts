import express, { Router, type Response } from 'express';
import { proxyRequest } from '../services/proxyService.js';

/**
 * Fixed-destination relays for the two features the browser used to call
 * directly: README translation and grep.app code search. The upstream URL is
 * constant; the client may only choose a small set of query parameters.
 */

export const TRANSLATE_BODY_LIMIT_BYTES = 64 * 1024;
const UPSTREAM_TIMEOUT_MS = 20000;
const MAX_UPSTREAM_BYTES = 5 * 1024 * 1024;
const MAX_PARAM_VALUE_LENGTH = 500;

interface TranslateEngine {
  url: string;
  allowedParams: ReadonlySet<string>;
  contentType: string;
  /** Returns true when the request body has the shape this engine accepts. */
  validateBody: (body: string) => boolean;
}

const TRANSLATE_ENGINES: Record<string, TranslateEngine> = {
  microsoft: {
    url: 'https://edge.microsoft.com/translate/translatetext',
    allowedParams: new Set(['from', 'to', 'isEnterpriseClient']),
    contentType: 'application/json',
    validateBody: (body) => {
      try {
        const parsed: unknown = JSON.parse(body);
        return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string' || (typeof item === 'object' && item !== null));
      } catch {
        return false;
      }
    },
  },
  google: {
    url: 'https://clients5.google.com/translate_a/t',
    allowedParams: new Set(['client', 'sl', 'tl']),
    contentType: 'application/x-www-form-urlencoded',
    validateBody: (body) => {
      const params = new URLSearchParams(body);
      let count = 0;
      for (const key of params.keys()) {
        if (key !== 'q') return false;
        count++;
      }
      return count > 0;
    },
  },
};

const GREP_SEARCH_URL = 'https://grep.app/api/search';
const GREP_ALLOWED_PARAMS = new Set(['q', 'words', 'regexp', 'case', 'f.lang', 'f.repo', 'f.path', 'page']);

/** Language codes and flags: letters, digits and a few separators, never URL syntax. */
const TRANSLATE_PARAM_VALUE = /^[A-Za-z0-9_.-]{0,32}$/;

function relayUpstream(res: Response, status: number, headers: Record<string, string>, data: unknown): void {
  // An upstream 401/403 is not about this user's session; passing it on would look like a logout.
  if (status === 401 || status === 403) {
    res.status(502).json({ error: 'Upstream refused the request', code: 'UPSTREAM_ERROR' });
    return;
  }
  const retryAfter = headers['retry-after'];
  if (retryAfter) res.set('Retry-After', retryAfter);
  res.set('X-Content-Type-Options', 'nosniff');

  if (typeof data === 'string') {
    // Upstream text that is not JSON is never served as HTML from our origin.
    res.status(status).type('text/plain').send(data);
    return;
  }
  res.status(status).json(data);
}

const router = Router();

// POST /api/translate/:engine   (microsoft | google)
router.post(
  '/api/translate/:engine',
  express.raw({ type: () => true, limit: TRANSLATE_BODY_LIMIT_BYTES }),
  async (req, res) => {
    const engine = Object.prototype.hasOwnProperty.call(TRANSLATE_ENGINES, req.params.engine)
      ? TRANSLATE_ENGINES[req.params.engine]
      : undefined;
    if (!engine) {
      res.status(404).json({ error: 'Unknown translation engine', code: 'UNKNOWN_ENGINE' });
      return;
    }

    const body = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    if (!body || !engine.validateBody(body)) {
      res.status(400).json({ error: 'Invalid translation request body', code: 'INVALID_BODY' });
      return;
    }

    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(req.query)) {
      if (!engine.allowedParams.has(key)) continue;
      if (typeof value !== 'string' || !TRANSLATE_PARAM_VALUE.test(value)) {
        res.status(400).json({ error: 'Invalid query parameter', code: 'INVALID_PARAMS' });
        return;
      }
      query.set(key, value);
    }

    const result = await proxyRequest({
      url: `${engine.url}?${query.toString()}`,
      method: 'POST',
      headers: { 'Content-Type': engine.contentType, Accept: 'application/json' },
      body,
      timeout: UPSTREAM_TIMEOUT_MS,
      responseType: 'text',
      maxBytes: MAX_UPSTREAM_BYTES,
    });
    sendJsonOrText(res, result.status, result.headers, result.data);
  },
);

// GET /api/codesearch?q=...&f.lang=...   -> grep.app/api/search
router.get('/api/codesearch', async (req, res) => {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(req.query)) {
    if (!GREP_ALLOWED_PARAMS.has(key)) continue;
    const values = Array.isArray(value) ? value : [value];
    for (const v of values) {
      if (typeof v !== 'string' || v.length > MAX_PARAM_VALUE_LENGTH) {
        res.status(400).json({ error: 'Invalid query parameter', code: 'INVALID_PARAMS' });
        return;
      }
      query.append(key, v);
    }
  }
  if (!query.get('q')) {
    res.status(400).json({ error: 'Missing search query', code: 'INVALID_PARAMS' });
    return;
  }

  const result = await proxyRequest({
    url: `${GREP_SEARCH_URL}?${query.toString()}`,
    method: 'GET',
    headers: { Accept: 'application/json', 'User-Agent': 'GithubStarsManager-Backend' },
    timeout: UPSTREAM_TIMEOUT_MS,
    responseType: 'text',
    maxBytes: MAX_UPSTREAM_BYTES,
  });
  sendJsonOrText(res, result.status, result.headers, result.data);
});

/** Pass the upstream body through: parsed JSON as JSON, anything else as plain text. */
function sendJsonOrText(res: Response, status: number, headers: Record<string, string>, data: unknown): void {
  if (typeof data === 'string') {
    try {
      relayUpstream(res, status, headers, JSON.parse(data));
      return;
    } catch {
      // not JSON
    }
  }
  relayUpstream(res, status, headers, data);
}

export default router;
