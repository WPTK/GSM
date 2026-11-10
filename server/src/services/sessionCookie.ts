import crypto from 'node:crypto';
import type { Request } from 'express';
import { config } from '../config.js';

/**
 * Stateless, HMAC-signed session cookie.
 *
 * Token = base64url(JSON payload) + '.' + base64url(HMAC-SHA256(key, payload part)).
 * The signing key is derived from API_SECRET (required at startup), so there is no
 * extra secret to manage, and changing API_SECRET invalidates
 * every existing session. The cookie never contains the secret itself.
 */
export const SESSION_COOKIE_NAME = 'gsm_session';
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

const KEY_CONTEXT = 'gsm-session-cookie-v1';

function deriveKey(): Buffer {
  return crypto.createHmac('sha256', config.apiSecret).update(KEY_CONTEXT).digest();
}

function sign(payloadPart: string): Buffer {
  return crypto.createHmac('sha256', deriveKey()).update(payloadPart).digest();
}

export function createSessionToken(nowMs: number = Date.now()): string {
  const iat = Math.floor(nowMs / 1000);
  const payload = { v: 1, iat, exp: iat + SESSION_MAX_AGE_SECONDS };
  const payloadPart = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${payloadPart}.${sign(payloadPart).toString('base64url')}`;
}

export function verifySessionToken(token: string, nowMs: number = Date.now()): boolean {
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return false;
  const [payloadPart, sigPart] = parts;

  const expected = sign(payloadPart);
  const given = Buffer.from(sigPart, 'base64url');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return false;

  try {
    const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')) as {
      v?: unknown;
      exp?: unknown;
    };
    return payload.v === 1 && typeof payload.exp === 'number' && payload.exp > Math.floor(nowMs / 1000);
  } catch {
    return false;
  }
}

/** Read one cookie value from the Cookie header (no cookie-parser dependency). */
export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      return part.slice(eq + 1).trim();
    }
  }
  return undefined;
}

export function hasValidSessionCookie(req: Request): boolean {
  const token = readCookie(req, SESSION_COOKIE_NAME);
  return token !== undefined && verifySessionToken(token);
}

/** Constant-time comparison of two strings without leaking their lengths. */
export function secretsMatch(given: string, expected: string): boolean {
  const a = crypto.createHash('sha256').update(given, 'utf8').digest();
  const b = crypto.createHash('sha256').update(expected, 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}
