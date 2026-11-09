import { describe, it, expect, beforeAll, afterAll, beforeEach, vi, type Mock } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsm-img-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.API_SECRET = 'img-test-secret';

vi.mock('axios', () => {
  const fn = vi.fn();
  fn.isAxiosError = (e: unknown): boolean => Boolean(e && (e as { isAxiosError?: boolean }).isAxiosError);
  return { default: fn };
});
vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }));

import axios from 'axios';
import { lookup as dnsLookup } from 'node:dns/promises';
import request from 'supertest';
import { ImageCache } from '../../src/services/imageCache.js';

const axiosMock = axios as unknown as Mock;
const dnsMock = dnsLookup as unknown as Mock;
const AUTH = { Authorization: 'Bearer img-test-secret' };
const AVATAR = 'https://avatars.githubusercontent.com/u/1?v=4';

const png = (): ArrayBuffer => Uint8Array.from([0x89, 0x50, 0x4e, 0x47]).buffer;

describe('GET /api/img', () => {
  let app: import('express').Express;
  let imgModule: typeof import('../../src/routes/img.js');
  let closeDb: () => void;

  beforeAll(async () => {
    const conn = await import('../../src/db/connection.js');
    const index = await import('../../src/index.js');
    imgModule = await import('../../src/routes/img.js');
    closeDb = conn.closeDb;
    app = index.createApp();
  });

  beforeEach(() => {
    axiosMock.mockReset();
    dnsMock.mockReset().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    imgModule.imageCache.clear();
  });

  afterAll(() => {
    try {
      closeDb();
    } catch {
      // already closed
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const get = (url?: string) =>
    request(app).get('/api/img').query(url === undefined ? {} : { url }).set(AUTH);

  it('requires authentication', async () => {
    await request(app).get('/api/img').query({ url: AVATAR }).expect(401);
  });

  it('400 INVALID_URL for missing, malformed, over-long and non-https urls', async () => {
    for (const url of [undefined, '', 'not a url', 'http://avatars.githubusercontent.com/u/1', 'ftp://x/y', 'https://a.example/' + 'a'.repeat(3000)]) {
      const res = await get(url);
      expect(res.status, String(url).slice(0, 40)).toBe(400);
      expect(res.body.code).toBe('INVALID_URL');
    }
    expect(axiosMock).not.toHaveBeenCalled();
  });

  it('403 IMAGE_HOST_NOT_ALLOWED for other hosts, userinfo, ports and bad github paths', async () => {
    for (const url of [
      'https://example.com/a.png',
      'https://api.github.com/user',
      'https://github.com/o/r/issues/1',
      'https://github.com/o/r/blob/main/a.png',
      'https://avatars.githubusercontent.com.evil.example/u/1',
      'https://user:pw@avatars.githubusercontent.com/u/1',
      'https://avatars.githubusercontent.com:8443/u/1',
      'https://169.254.169.254/latest/meta-data',
    ]) {
      const res = await get(url);
      expect(res.status, url).toBe(403);
      expect(res.body.code).toBe('IMAGE_HOST_NOT_ALLOWED');
    }
    expect(axiosMock).not.toHaveBeenCalled();
  });

  it('serves an image with safe headers and caches it', async () => {
    axiosMock.mockResolvedValue({ status: 200, headers: { 'content-type': 'image/png; charset=binary' }, data: png() });
    const first = await get(AVATAR).expect(200);
    expect(first.headers['content-type']).toBe('image/png');
    expect(first.headers['x-content-type-options']).toBe('nosniff');
    expect(first.headers['content-security-policy']).toContain("default-src 'none'");
    expect(first.headers['cache-control']).toMatch(/max-age=\d+/);
    expect(Buffer.from(first.body).length).toBe(4);

    await get(AVATAR).expect(200);
    expect(axiosMock).toHaveBeenCalledTimes(1); // second answer came from the cache
  });

  it('sends no credentials upstream', async () => {
    axiosMock.mockResolvedValue({ status: 200, headers: { 'content-type': 'image/png' }, data: png() });
    await get(AVATAR).expect(200);
    const sent = JSON.stringify(axiosMock.mock.calls[0][0].headers).toLowerCase();
    expect(sent).not.toContain('authorization');
    expect(sent).not.toContain('cookie');
  });

  it('502 when upstream returns a non-image content type', async () => {
    axiosMock.mockResolvedValue({ status: 200, headers: { 'content-type': 'text/html' }, data: Buffer.from('<script>1</script>') });
    const res = await get(AVATAR).expect(502);
    expect(res.body.code).toBe('UPSTREAM_NOT_IMAGE');
    expect(imgModule.imageCache.size).toBe(0);
  });

  it('502 when the content type is missing, or is image-like only by prefix trick', async () => {
    axiosMock.mockResolvedValueOnce({ status: 200, headers: {}, data: png() });
    await get(AVATAR).expect(502);
    axiosMock.mockResolvedValueOnce({ status: 200, headers: { 'content-type': 'text/html; x=image/png' }, data: png() });
    await get(AVATAR).expect(502);
  });

  it('502 on upstream error status', async () => {
    axiosMock.mockResolvedValue({ status: 404, headers: { 'content-type': 'image/png' }, data: png() });
    const res = await get(AVATAR).expect(502);
    expect(res.body.code).toBe('UPSTREAM_ERROR');
  });

  it('413 when the image exceeds the size cap', async () => {
    axiosMock.mockRejectedValue({ isAxiosError: true, code: 'ERR_BAD_RESPONSE', message: 'maxContentLength size of 10485760 exceeded' });
    const res = await get(AVATAR).expect(413);
    expect(res.body.code).toBe('IMAGE_TOO_LARGE');
    expect(axiosMock.mock.calls[0][0].maxContentLength).toBe(imgModule.MAX_IMAGE_BYTES);
  });

  it('follows a redirect between allowed image hosts', async () => {
    axiosMock
      .mockResolvedValueOnce({ status: 302, headers: { location: 'https://raw.githubusercontent.com/o/r/main/a.png' }, data: '' })
      .mockResolvedValueOnce({ status: 200, headers: { 'content-type': 'image/png' }, data: png() });
    await get('https://github.com/o/r/raw/main/a.png').expect(200);
    expect(axiosMock).toHaveBeenCalledTimes(2);
  });

  it('403 when a redirect hop leaves the image host list, even to an allowlisted API host', async () => {
    axiosMock.mockResolvedValueOnce({ status: 302, headers: { location: 'https://api.github.com/user' }, data: '' });
    const res = await get('https://github.com/o/r/raw/main/a.png').expect(403);
    expect(res.body.code).toBe('IMAGE_HOST_NOT_ALLOWED');
    expect(axiosMock).toHaveBeenCalledTimes(1);
  });

  it('403 when a redirect hop goes to an arbitrary host', async () => {
    axiosMock.mockResolvedValueOnce({ status: 302, headers: { location: 'https://evil.example/a.png' }, data: '' });
    const res = await get('https://github.com/o/r/raw/main/a.png').expect(403);
    expect(['EGRESS_BLOCKED', 'IMAGE_HOST_NOT_ALLOWED']).toContain(res.body.code);
    expect(axiosMock).toHaveBeenCalledTimes(1);
  });

  describe('isAllowedImageUrl', () => {
    it('accepts the documented github shapes', () => {
      const ok = [
        'https://avatars.githubusercontent.com/u/1',
        'https://github.com/o/r/raw/main/a.png',
        'https://github.com/o/r/blob/main/a.png?raw=true',
        'https://github.com/user-attachments/assets/1234-abcd',
        'https://github.com/octocat.png',
      ];
      for (const u of ok) expect(imgModule.isAllowedImageUrl(new URL(u)), u).toBe(true);
    });
    it('rejects traversal and unlisted shapes', () => {
      const bad = [
        'https://github.com/o/r/raw/../../etc/passwd',
        'https://github.com/o/r/blob/main/a.png',
        'https://github.com/login',
        'http://avatars.githubusercontent.com/u/1',
      ];
      for (const u of bad) expect(imgModule.isAllowedImageUrl(new URL(u)), u).toBe(false);
    });
  });
});

describe('ImageCache', () => {
  const img = (n: number) => ({ body: Buffer.alloc(n), contentType: 'image/png' });

  it('evicts least recently used entries beyond the byte budget', () => {
    const cache = new ImageCache(100, 1000);
    cache.set('a', img(40), 0);
    cache.set('b', img(40), 0);
    cache.get('a', 1); // a is now most recent
    cache.set('c', img(40), 2); // evicts b
    expect(cache.get('a', 3)).toBeDefined();
    expect(cache.get('b', 3)).toBeUndefined();
    expect(cache.get('c', 3)).toBeDefined();
    expect(cache.bytes).toBe(80);
  });

  it('expires entries after the ttl and tracks bytes', () => {
    const cache = new ImageCache(100, 10);
    cache.set('a', img(30), 0);
    expect(cache.get('a', 5)).toBeDefined();
    expect(cache.get('a', 11)).toBeUndefined();
    expect(cache.bytes).toBe(0);
  });

  it('refuses a single entry larger than the whole budget and replaces same-key entries', () => {
    const cache = new ImageCache(50, 1000);
    cache.set('big', img(60));
    expect(cache.size).toBe(0);
    cache.set('a', img(20));
    cache.set('a', img(30));
    expect(cache.size).toBe(1);
    expect(cache.bytes).toBe(30);
  });
});
