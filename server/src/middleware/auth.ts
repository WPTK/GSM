import type { Request, Response, NextFunction } from 'express';
import { config } from '../config.js';
import { hasValidSessionCookie, secretsMatch } from '../services/sessionCookie.js';

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Paths (relative to the /api mount) that work without credentials. */
function isPublic(req: Request): boolean {
  if (req.method === 'GET' && (req.path === '/health' || req.path === '/auth/status')) return true;
  if (req.path === '/auth/session' && (req.method === 'POST' || req.method === 'DELETE')) return true;
  return false;
}

/** True when the request's Origin header names this server's own host. */
export function originMatchesHost(req: Request): boolean {
  const origin = req.get('origin');
  if (!origin) return false;
  try {
    return new URL(origin).host.toLowerCase() === (req.host ?? '').toLowerCase();
  } catch {
    return false;
  }
}

/** True when the Authorization header carries the correct Bearer API secret. */
export function hasValidBearer(req: Request): boolean {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return false;
  return secretsMatch(authHeader.slice(7), config.apiSecret);
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (isPublic(req)) {
    next();
    return;
  }


  // Bearer token: not an ambient credential, so no CSRF check.
  if (req.headers.authorization) {
    if (hasValidBearer(req)) {
      next();
      return;
    }
    res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
    return;
  }

  // Session cookie: sent automatically by the browser, so unsafe methods also
  // need an Origin header that matches this server's Host (CSRF defence, on top
  // of SameSite=Strict).
  if (hasValidSessionCookie(req)) {
    if (UNSAFE_METHODS.has(req.method) && !originMatchesHost(req)) {
      res.status(403).json({ error: 'Cross-origin request refused', code: 'CSRF_ORIGIN_MISMATCH' });
      return;
    }
    next();
    return;
  }

  res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
}
