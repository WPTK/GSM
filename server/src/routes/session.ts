import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { config } from '../config.js';
import { hasValidBearer, originMatchesHost } from '../middleware/auth.js';
import { isGithubConfigured } from '../services/githubToken.js';
import {
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_SECONDS,
  createSessionToken,
  hasValidSessionCookie,
  secretsMatch,
} from '../services/sessionCookie.js';

export interface SessionRouterOptions {
  /** Failed-login limit per window per client (default 10 per 15 minutes). */
  maxFailedLogins?: number;
  windowMs?: number;
}

export function createSessionRouter(options: SessionRouterOptions = {}): Router {
  const router = Router();

  // Only failed attempts count, so brute-forcing the secret is capped while a
  // correct login is never locked out by someone else's earlier typos.
  const loginLimiter = rateLimit({
    windowMs: options.windowMs ?? 15 * 60 * 1000,
    max: options.maxFailedLogins ?? 10,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    message: { error: 'Too many login attempts', code: 'RATE_LIMITED' },
  });

  // POST /api/auth/session  { secret }  ->  204 + Set-Cookie
  router.post('/api/auth/session', loginLimiter, (req, res) => {
    // A browser login must come from this server's own page.
    if (req.get('origin') && !originMatchesHost(req)) {
      res.status(403).json({ error: 'Cross-origin request refused', code: 'CSRF_ORIGIN_MISMATCH' });
      return;
    }

    // Dev mode (no API_SECRET): nothing to log in to, nothing to sign.
    if (!config.apiSecret) {
      res.status(204).end();
      return;
    }

    const secret = (req.body as { secret?: unknown } | undefined)?.secret;
    if (typeof secret !== 'string' || !secretsMatch(secret, config.apiSecret)) {
      res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
      return;
    }

    res.cookie(SESSION_COOKIE_NAME, createSessionToken(), {
      httpOnly: true,
      sameSite: 'strict',
      path: '/',
      secure: req.secure,
      maxAge: SESSION_MAX_AGE_SECONDS * 1000,
    });
    res.status(204).end();
  });

  // DELETE /api/auth/session  ->  204 (clears the cookie)
  router.delete('/api/auth/session', (req, res) => {
    res.clearCookie(SESSION_COOKIE_NAME, {
      httpOnly: true,
      sameSite: 'strict',
      path: '/',
      secure: req.secure,
    });
    res.status(204).end();
  });

  // GET /api/auth/status  ->  { authenticated, githubConfigured }  (no auth needed)
  router.get('/api/auth/status', (req, res) => {
    const authenticated = !config.apiSecret || hasValidBearer(req) || hasValidSessionCookie(req);
    res.set('Cache-Control', 'no-store').json({ authenticated, githubConfigured: isGithubConfigured() });
  });

  return router;
}

export default createSessionRouter();
