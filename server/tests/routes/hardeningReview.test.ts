import { describe, it, expect, beforeAll, afterAll, beforeEach, vi, type Mock } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsm-review-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.API_SECRET = 'review-test-secret';

vi.mock('axios', () => {
  const fn = vi.fn();
  fn.isAxiosError = (e: unknown): boolean => Boolean(e && (e as { isAxiosError?: boolean }).isAxiosError);
  return { default: fn };
});
vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }));

import axios from 'axios';
import { lookup as dnsLookup } from 'node:dns/promises';
import request from 'supertest';

const axiosMock = axios as unknown as Mock;
const dnsMock = dnsLookup as unknown as Mock;
const AUTH = { Authorization: 'Bearer review-test-secret' };
const png = (): ArrayBuffer => Uint8Array.from([1, 2, 3, 4]).buffer;

describe('review fixes', () => {
  let app: import('express').Express;
  let closeDb: () => void;
  let getDb: () => import('better-sqlite3').Database;
  let logger: typeof import('../../src/services/logger.js').logger;
  let imageCache: typeof import('../../src/routes/img.js').imageCache;

  beforeAll(async () => {
    const conn = await import('../../src/db/connection.js');
    const index = await import('../../src/index.js');
    logger = (await import('../../src/services/logger.js')).logger;
    imageCache = (await import('../../src/routes/img.js')).imageCache;
    closeDb = conn.closeDb;
    getDb = conn.getDb as typeof getDb;
    (await import('../../src/db/migrations.js')).runMigrations(conn.getDb());
    app = index.createApp();
  });

  beforeEach(() => {
    axiosMock.mockReset();
    dnsMock.mockReset().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    imageCache.clear();
  });

  afterAll(() => {
    try {
      closeDb();
    } catch {
      // already closed
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('access log records the path only, never the query string or referrer query', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(logger, 'info').mockImplementation(((module: string, message: string) => {
      if (module === 'http.access') lines.push(message);
    }) as never);
    try {
      await request(app)
        .get('/api/codesearch')
        .query({ q: 'topsecretsearchterm' })
        .set(AUTH)
        .set('Referer', 'https://app.test/page?jwt=refsecret')
        .expect(502); // axios mock returns undefined -> bad gateway; irrelevant here
    } finally {
      spy.mockRestore();
    }
    const joined = lines.join('\n');
    expect(joined).toContain('/api/codesearch');
    expect(joined).not.toMatch(/topsecretsearchterm|refsecret|jwt=|\?q=/);
  });

  it('relays map an upstream 401/403 to 502', async () => {
    for (const status of [401, 403]) {
      axiosMock.mockResolvedValueOnce({ status, headers: {}, data: '{"message":"nope"}' });
      const res = await request(app).get('/api/codesearch?q=x').set(AUTH);
      expect(res.status).toBe(502);
      expect(res.body.code).toBe('UPSTREAM_ERROR');
    }
  });

  it('private image URLs are cached without their query and for at most 5 minutes', async () => {
    axiosMock.mockResolvedValue({ status: 200, headers: { 'content-type': 'image/png' }, data: png() });
    const base = 'https://private-user-images.githubusercontent.com/1/abc.png';
    const res = await request(app).get('/api/img').query({ url: `${base}?jwt=SIGNEDTOKEN1` }).set(AUTH).expect(200);
    expect(res.headers['cache-control']).toBe('private, max-age=300');
    // a different signature is served from cache: the key has no query
    await request(app).get('/api/img').query({ url: `${base}?jwt=SIGNEDTOKEN2` }).set(AUTH).expect(200);
    expect(axiosMock).toHaveBeenCalledTimes(1);

    expect(imageCache.get(base)).toBeDefined();
    expect(imageCache.get(base, Date.now() + 5 * 60 * 1000 + 1000)).toBeUndefined();
  });

  it('limits concurrent upstream image fetches to 4', async () => {
    let active = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    axiosMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          active++;
          peak = Math.max(peak, active);
          releases.push(() => {
            active--;
            resolve({ status: 200, headers: { 'content-type': 'image/png' }, data: png() });
          });
        }),
    );
    const calls = Array.from({ length: 8 }, (_, i) =>
      request(app).get('/api/img').query({ url: `https://avatars.githubusercontent.com/u/${i}` }).set(AUTH).then((r) => r),
    );
    for (let i = 0; i < 100 && releases.length < 4; i++) await new Promise((r) => setTimeout(r, 10));
    expect(releases.length).toBe(4);
    await new Promise((r) => setTimeout(r, 50));
    expect(peak).toBe(4);
    while (releases.length > 0 || active > 0) {
      releases.shift()?.();
      await new Promise((r) => setTimeout(r, 10));
      if (calls.length === 0) break;
    }
    const results = await Promise.all(calls);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(peak).toBe(4);
  });

  it('legacy proxy_config and rpc_download_config rows are not served, and a migration removes them', async () => {
    const db = getDb();
    const put = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    put.run('proxy_config', '{"host":"x"}');
    put.run('rpc_download_config', '{"url":"y"}');
    put.run('github_token', 'enc');
    put.run('theme', 'dark');

    const res = await request(app).get('/api/settings').set(AUTH).expect(200);
    expect(res.body.theme).toBe('dark');
    expect(res.body).not.toHaveProperty('proxy_config');
    expect(res.body).not.toHaveProperty('rpc_download_config');
    expect(res.body).not.toHaveProperty('github_token');

    // Re-run the migration step as an upgrade from v3 would.
    db.prepare('DELETE FROM schema_version WHERE version >= 4').run();
    const { runMigrations } = await import('../../src/db/migrations.js');
    runMigrations(db);
    const keys = (db.prepare('SELECT key FROM settings').all() as Array<{ key: string }>).map((r) => r.key);
    expect(keys).not.toContain('proxy_config');
    expect(keys).not.toContain('rpc_download_config');
    expect(keys).toContain('theme');
  });
});
