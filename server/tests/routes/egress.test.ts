import { describe, it, expect, beforeAll, afterAll, beforeEach, vi, type Mock } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsm-egress-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.API_SECRET = 'egress-test-secret';

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
const AUTH = { Authorization: 'Bearer egress-test-secret' };

describe('translate and codesearch relays', () => {
  let app: import('express').Express;
  let closeDb: () => void;

  beforeAll(async () => {
    const conn = await import('../../src/db/connection.js');
    const index = await import('../../src/index.js');
    closeDb = conn.closeDb;
    app = index.createApp();
  });

  beforeEach(() => {
    axiosMock.mockReset();
    dnsMock.mockReset().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  });

  afterAll(() => {
    try {
      closeDb();
    } catch {
      // already closed
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('POST /api/translate/:engine', () => {
    it('requires authentication', async () => {
      await request(app).post('/api/translate/microsoft').send('["hi"]').expect(401);
    });

    it('relays microsoft to the fixed upstream with only whitelisted params', async () => {
      axiosMock.mockResolvedValue({ status: 200, headers: { 'content-type': 'application/json' }, data: '[{"translations":[]}]' });
      const res = await request(app)
        .post('/api/translate/microsoft?from=en&to=zh-Hans&isEnterpriseClient=false&evil=1')
        .set(AUTH)
        .set('Content-Type', 'application/json')
        .send('["hello"]')
        .expect(200);
      expect(res.body).toEqual([{ translations: [] }]);
      const sent = axiosMock.mock.calls[0][0];
      const url = new URL(sent.url);
      expect(url.origin + url.pathname).toBe('https://edge.microsoft.com/translate/translatetext');
      expect([...url.searchParams.keys()].sort()).toEqual(['from', 'isEnterpriseClient', 'to']);
    });

    it('relays google with a q-only form body', async () => {
      axiosMock.mockResolvedValue({ status: 200, headers: {}, data: '["hola"]' });
      await request(app)
        .post('/api/translate/google?client=gtx&sl=en&tl=es')
        .set(AUTH)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('q=hello')
        .expect(200);
      expect(new URL(axiosMock.mock.calls[0][0].url).hostname).toBe('clients5.google.com');
    });

    it('404 for an unknown engine, including prototype names', async () => {
      for (const engine of ['deepl', 'constructor', '__proto__', 'toString']) {
        await request(app).post(`/api/translate/${engine}`).set(AUTH).send('["x"]').expect(404);
      }
      expect(axiosMock).not.toHaveBeenCalled();
    });

    it('400 for invalid bodies and for parameter values carrying URL syntax', async () => {
      await request(app).post('/api/translate/microsoft').set(AUTH).send('not json').expect(400);
      await request(app).post('/api/translate/microsoft').set(AUTH).send('{"a":1}').expect(400);
      await request(app).post('/api/translate/google').set(AUTH).send('url=http://x').expect(400);
      await request(app).post('/api/translate/microsoft?to=en%26x%3D1').set(AUTH).send('["x"]').expect(400);
      expect(axiosMock).not.toHaveBeenCalled();
    });

    it('rejects bodies over 64KB with 413', async () => {
      const big = JSON.stringify(['a'.repeat(70 * 1024)]);
      const res = await request(app).post('/api/translate/microsoft').set(AUTH).set('Content-Type', 'application/json').send(big);
      expect(res.status).toBe(413);
      expect(axiosMock).not.toHaveBeenCalled();
    });

    it('never serves upstream text as html', async () => {
      axiosMock.mockResolvedValue({ status: 200, headers: { 'content-type': 'text/html' }, data: '<script>alert(1)</script>' });
      const res = await request(app).post('/api/translate/microsoft').set(AUTH).send('["x"]').expect(200);
      expect(res.headers['content-type']).toMatch(/^text\/plain/);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    });
  });

  describe('GET /api/codesearch', () => {
    it('requires authentication', async () => {
      await request(app).get('/api/codesearch?q=x').expect(401);
    });

    it('400 without q', async () => {
      await request(app).get('/api/codesearch').set(AUTH).expect(400);
      expect(axiosMock).not.toHaveBeenCalled();
    });

    it('relays to grep.app with whitelisted params only', async () => {
      axiosMock.mockResolvedValue({ status: 200, headers: {}, data: '{"hits":{"hits":[]}}' });
      const res = await request(app).get('/api/codesearch').query({ q: 'useState', 'f.lang': 'TypeScript', page: '2', evil: 'x' }).set(AUTH).expect(200);
      expect(res.body).toEqual({ hits: { hits: [] } });
      const url = new URL(axiosMock.mock.calls[0][0].url);
      expect(url.origin + url.pathname).toBe('https://grep.app/api/search');
      expect([...url.searchParams.keys()].sort()).toEqual(['f.lang', 'page', 'q']);
    });

    it('passes 429 and Retry-After through', async () => {
      axiosMock.mockResolvedValue({ status: 429, headers: { 'retry-after': '30' }, data: '{"error":"slow down"}' });
      const res = await request(app).get('/api/codesearch?q=x').set(AUTH);
      expect(res.status).toBe(429);
      expect(res.headers['retry-after']).toBe('30');
    });

    it('400 for over-long parameter values', async () => {
      await request(app).get('/api/codesearch').query({ q: 'a'.repeat(600) }).set(AUTH).expect(400);
    });
  });
});
