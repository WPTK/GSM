import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

// Isolate DB and secrets before importing app modules.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsm-session-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.API_SECRET = 'correct-horse-battery-staple';
delete process.env.GITHUB_TOKEN;
delete process.env.GITHUB_TOKEN_FILE;

const SECRET = 'correct-horse-battery-staple';

describe('session cookie auth', () => {
  let request: typeof import('supertest').default;
  let createApp: () => import('express').Express;
  let closeDb: () => void;
  let config: { apiSecret: string };
  let sessionCookie: typeof import('../../src/services/sessionCookie.js');
  let githubToken: typeof import('../../src/services/githubToken.js');
  let app: import('express').Express;

  beforeAll(async () => {
    const conn = await import('../../src/db/connection.js');
    const index = await import('../../src/index.js');
    const supertest = await import('supertest');
    config = (await import('../../src/config.js')).config;
    sessionCookie = await import('../../src/services/sessionCookie.js');
    githubToken = await import('../../src/services/githubToken.js');
    request = supertest.default;
    createApp = index.createApp;
    closeDb = conn.closeDb;
  });

  beforeEach(() => {
    config.apiSecret = SECRET;
    delete process.env.GITHUB_TOKEN;
    githubToken.resetGithubTokenForTests();
    app = createApp();
  });

  afterAll(() => {
    try {
      closeDb();
    } catch {
      // already closed
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const login = async (host = 'app.test') =>
    request(app).post('/api/auth/session').set('Host', host).set('Origin', `http://${host}`).send({ secret: SECRET });

  const cookieFrom = (res: { headers: Record<string, unknown> }): string => {
    const raw = res.headers['set-cookie'] as string[] | undefined;
    expect(raw).toBeTruthy();
    return raw![0].split(';')[0];
  };

  describe('GET /api/auth/status', () => {
    it('is public and reports unauthenticated + githubConfigured=false by default', async () => {
      const res = await request(app).get('/api/auth/status').expect(200);
      expect(res.body).toEqual({ authenticated: false, githubConfigured: false });
    });

    it('reports githubConfigured=true when GITHUB_TOKEN is set, without exposing it', async () => {
      process.env.GITHUB_TOKEN = 'ghp_thisshouldneverleak0000000000000000000';
      githubToken.resetGithubTokenForTests();
      const res = await request(createApp()).get('/api/auth/status').expect(200);
      expect(res.body).toEqual({ authenticated: false, githubConfigured: true });
      expect(JSON.stringify(res.body)).not.toContain('ghp_');
    });

    it('reports authenticated for a Bearer secret and for a session cookie', async () => {
      const viaBearer = await request(app).get('/api/auth/status').set('Authorization', `Bearer ${SECRET}`);
      expect(viaBearer.body.authenticated).toBe(true);

      const cookie = cookieFrom(await login());
      const viaCookie = await request(app).get('/api/auth/status').set('Cookie', cookie);
      expect(viaCookie.body.authenticated).toBe(true);
    });

    it('reports unauthenticated for a wrong Bearer secret', async () => {
      const res = await request(app).get('/api/auth/status').set('Authorization', 'Bearer nope');
      expect(res.body.authenticated).toBe(false);
    });
  });

  describe('POST /api/auth/session', () => {
    it('rejects a wrong secret with 401 UNAUTHORIZED and sets no cookie', async () => {
      const res = await request(app).post('/api/auth/session').send({ secret: 'wrong' }).expect(401);
      expect(res.body).toEqual({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
      expect(res.headers['set-cookie']).toBeUndefined();
    });

    it('rejects a missing or non-string secret', async () => {
      await request(app).post('/api/auth/session').send({}).expect(401);
      await request(app).post('/api/auth/session').send({ secret: 12345 }).expect(401);
      await request(app).post('/api/auth/session').send({ secret: [SECRET] }).expect(401);
    });

    it('answers 204 with an HttpOnly, SameSite=Strict, 30-day cookie that does not contain the secret', async () => {
      const res = await login().then((r) => {
        expect(r.status).toBe(204);
        return r;
      });
      const setCookie = (res.headers['set-cookie'] as string[])[0];
      expect(setCookie).toMatch(/^gsm_session=/);
      expect(setCookie).toContain('HttpOnly');
      expect(setCookie).toContain('SameSite=Strict');
      expect(setCookie).toContain('Path=/');
      expect(setCookie).toContain(`Max-Age=${30 * 24 * 60 * 60}`);
      expect(setCookie).not.toContain('Secure'); // plain http in this test
      expect(setCookie).not.toContain(SECRET);
      expect(Buffer.from(setCookie.split(';')[0].split('=')[1].split('.')[0], 'base64url').toString()).not.toContain(SECRET);
    });

    it('adds Secure when the request arrived over https (trusted proxy)', async () => {
      process.env.TRUST_PROXY = 'true';
      try {
        const secureApp = createApp();
        const res = await request(secureApp)
          .post('/api/auth/session')
          .set('X-Forwarded-Proto', 'https')
          .set('X-Forwarded-Host', 'app.test')
          .set('Origin', 'https://app.test')
          .send({ secret: SECRET })
          .expect(204);
        expect((res.headers['set-cookie'] as string[])[0]).toContain('Secure');
      } finally {
        delete process.env.TRUST_PROXY;
      }
    });

    it('refuses a login whose Origin is not this server', async () => {
      const res = await request(app)
        .post('/api/auth/session')
        .set('Host', 'app.test')
        .set('Origin', 'https://evil.example')
        .send({ secret: SECRET })
        .expect(403);
      expect(res.body.code).toBe('CSRF_ORIGIN_MISMATCH');
      expect(res.headers['set-cookie']).toBeUndefined();
    });

    it('rate-limits failed attempts', async () => {
      const express = (await import('express')).default;
      const { createSessionRouter } = await import('../../src/routes/session.js');
      const mini = express();
      mini.use(express.json());
      mini.use(createSessionRouter({ maxFailedLogins: 3 }));

      for (let i = 0; i < 3; i++) {
        await request(mini).post('/api/auth/session').send({ secret: 'wrong' }).expect(401);
      }
      const blocked = await request(mini).post('/api/auth/session').send({ secret: 'wrong' }).expect(429);
      expect(blocked.body.code).toBe('RATE_LIMITED');
      // A correct secret is rejected too while the window is exhausted for this client.
      await request(mini).post('/api/auth/session').send({ secret: SECRET }).expect(429);
    });

    it('does not count successful logins against the limit', async () => {
      const express = (await import('express')).default;
      const { createSessionRouter } = await import('../../src/routes/session.js');
      const mini = express();
      mini.use(express.json());
      mini.use(createSessionRouter({ maxFailedLogins: 2 }));
      for (let i = 0; i < 5; i++) {
        await request(mini).post('/api/auth/session').send({ secret: SECRET }).expect(204);
      }
    });
  });

  describe('cookie authentication', () => {
    it('authenticates a protected GET with the cookie, and still accepts Bearer', async () => {
      const cookie = cookieFrom(await login());
      await request(app).get('/api/logs').set('Cookie', cookie).expect(200);
      await request(app).get('/api/logs').set('Authorization', `Bearer ${SECRET}`).expect(200);
      await request(app).get('/api/logs').expect(401);
    });

    it('rejects a wrong Bearer even when a valid cookie is also sent', async () => {
      const cookie = cookieFrom(await login());
      await request(app).get('/api/logs').set('Cookie', cookie).set('Authorization', 'Bearer nope').expect(401);
    });

    it('rejects a tampered cookie', async () => {
      const cookie = cookieFrom(await login());
      const [name, value] = cookie.split('=');
      const flipped = value.slice(0, -2) + (value.endsWith('AA') ? 'BB' : 'AA');
      await request(app).get('/api/logs').set('Cookie', `${name}=${flipped}`).expect(401);

      const [payload, sig] = value.split('.');
      const forgedPayload = Buffer.from(JSON.stringify({ v: 1, iat: 1, exp: 9999999999 })).toString('base64url');
      expect(forgedPayload).not.toBe(payload);
      await request(app).get('/api/logs').set('Cookie', `${name}=${forgedPayload}.${sig}`).expect(401);
    });

    it('rejects an expired cookie and a cookie signed with another key', async () => {
      const longAgo = Date.now() - 31 * 24 * 60 * 60 * 1000;
      const expired = sessionCookie.createSessionToken(longAgo);
      await request(app).get('/api/logs').set('Cookie', `gsm_session=${expired}`).expect(401);

      const payload = Buffer.from(
        JSON.stringify({ v: 1, iat: 1, exp: Math.floor(Date.now() / 1000) + 1000 })
      ).toString('base64url');
      const foreignKey = crypto.createHmac('sha256', 'some-other-secret').update('gsm-session-cookie-v1').digest();
      const foreignSig = crypto.createHmac('sha256', foreignKey).update(payload).digest('base64url');
      await request(app).get('/api/logs').set('Cookie', `gsm_session=${payload}.${foreignSig}`).expect(401);
    });

    it('invalidates existing sessions when API_SECRET changes (key is derived from it)', async () => {
      const cookie = cookieFrom(await login());
      await request(app).get('/api/logs').set('Cookie', cookie).expect(200);
      config.apiSecret = 'a-different-secret';
      await request(app).get('/api/logs').set('Cookie', cookie).expect(401);
    });

    it('ignores malformed cookie headers', async () => {
      await request(app).get('/api/logs').set('Cookie', 'gsm_session').expect(401);
      await request(app).get('/api/logs').set('Cookie', 'gsm_session=;;==').expect(401);
      await request(app).get('/api/logs').set('Cookie', 'gsm_session=a.b.c').expect(401);
    });
  });

  describe('CSRF protection for cookie-authenticated unsafe methods', () => {
    it('refuses DELETE without an Origin header', async () => {
      const cookie = cookieFrom(await login());
      const res = await request(app).delete('/api/logs').set('Host', 'app.test').set('Cookie', cookie).expect(403);
      expect(res.body.code).toBe('CSRF_ORIGIN_MISMATCH');
    });

    it('refuses DELETE with a foreign or garbage Origin', async () => {
      const cookie = cookieFrom(await login());
      await request(app)
        .delete('/api/logs')
        .set('Host', 'app.test')
        .set('Cookie', cookie)
        .set('Origin', 'https://evil.example')
        .expect(403);
      await request(app).delete('/api/logs').set('Host', 'app.test').set('Cookie', cookie).set('Origin', 'null').expect(403);
      await request(app)
        .delete('/api/logs')
        .set('Host', 'app.test')
        .set('Cookie', cookie)
        .set('Origin', 'http://app.test.evil.example')
        .expect(403);
    });

    it('allows DELETE when Origin matches the Host', async () => {
      const cookie = cookieFrom(await login());
      const res = await request(app)
        .delete('/api/logs')
        .set('Host', 'app.test')
        .set('Cookie', cookie)
        .set('Origin', 'http://app.test');
      expect(res.status).not.toBe(403);
      expect(res.status).not.toBe(401);
    });

    it('does not require Origin for Bearer requests (no ambient credential)', async () => {
      const res = await request(app).delete('/api/logs').set('Authorization', `Bearer ${SECRET}`);
      expect(res.status).not.toBe(403);
      expect(res.status).not.toBe(401);
    });

    it('does not require Origin for cookie-authenticated safe methods', async () => {
      const cookie = cookieFrom(await login());
      await request(app).get('/api/logs').set('Cookie', cookie).expect(200);
    });
  });

  describe('DELETE /api/auth/session', () => {
    it('answers 204 and clears the cookie, without needing credentials', async () => {
      const res = await request(app).delete('/api/auth/session').expect(204);
      const setCookie = (res.headers['set-cookie'] as string[])[0];
      expect(setCookie).toMatch(/^gsm_session=;/);
      expect(setCookie).toMatch(/Expires=Thu, 01 Jan 1970/);
      expect(setCookie).toContain('HttpOnly');
      expect(setCookie).toContain('SameSite=Strict');
    });
  });

  describe('no dev mode', () => {
    it('rejects unauthenticated requests to protected routes and issues no cookie for a wrong secret', async () => {
      await request(app).get('/api/logs').expect(401);
      await request(app).get('/api/repositories').expect(401);
      await request(app).post('/api/sync/export').expect(401);
      const res = await request(app).post('/api/auth/session').send({ secret: 'anything' }).expect(401);
      expect(res.headers['set-cookie']).toBeUndefined();
      const status = await request(app).get('/api/auth/status');
      expect(status.body.authenticated).toBe(false);
    });
  });

  describe('public paths', () => {
    it('keeps /api/health public and everything else under /api protected', async () => {
      await request(app).get('/api/health').expect(200);
      await request(app).get('/api/logs').expect(401);
      await request(app).get('/api/img?url=https%3A%2F%2Favatars.githubusercontent.com%2Fu%2F1').expect(401);
      await request(app).post('/api/translate/microsoft').send('[]').expect(401);
      await request(app).get('/api/codesearch?q=x').expect(401);
    });

    it('no longer serves the removed routes', async () => {
      for (const [method, url] of [
        ['post', '/api/sync/auth'],
        ['post', '/api/proxy/github-raw'],
        ['post', '/api/proxy/webdav'],
        ['get', '/api/settings/proxy'],
        ['get', '/api/settings/rpc-download'],
        ['post', '/api/download/rpc'],
        ['get', '/api/xtweet/profile/someone'],
        ['get', '/api/telegram/channel/someone'],
        ['get', '/api/configs/webdav'],
      ] as const) {
        const res = await request(app)[method](url).set('Authorization', `Bearer ${SECRET}`).send({});
        expect(res.status, `${method} ${url}`).toBe(404);
      }
    });
  });
});
