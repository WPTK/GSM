import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Isolate DB before importing app modules that call getDb()
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsm-csp-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.API_SECRET = 'test-api-secret';

async function canOpenSqlite(): Promise<boolean> {
  try {
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
}

const dbAvailable = await canOpenSqlite();
const describeIfDb = dbAvailable ? describe : describe.skip;

describeIfDb('helmet CSP (same-origin browser)', () => {
  let request: typeof import('supertest').default;
  let closeDb: () => void;
  let createApp: () => import('express').Express;

  beforeAll(async () => {
    const conn = await import('../../src/db/connection.js');
    const index = await import('../../src/index.js');
    const supertest = await import('supertest');

    request = supertest.default;
    closeDb = conn.closeDb;
    createApp = index.createApp;
  });

  afterAll(() => {
    try {
      closeDb();
    } catch {
      // already closed
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const cspOf = async (app: import('express').Express): Promise<string> => {
    const response = await request(app).get('/api/health');
    expect(response.status).toBe(200);
    return response.headers['content-security-policy'] ?? '';
  };

  it('keeps default-src self and object-src none', async () => {
    const csp = await cspOf(createApp());
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
  });

  it('keeps script-src strict when no SPA shell is served', async () => {
    delete process.env.STATIC_DIR;
    const csp = await cspOf(createApp());
    const scriptSrc = csp.split(';').find((directive) => directive.trim().startsWith('script-src')) ?? '';
    expect(scriptSrc.trim()).toBe("script-src 'self'");
    expect(scriptSrc).not.toContain('unsafe-inline');
  });

  const directiveOf = (csp: string, name: string): string =>
    csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(`${name} `) || d === name) ?? '';

  it('serves the SPA shell with a strict script-src (no hashes, no inline, no data:)', async () => {
    const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsm-spa-'));
    fs.writeFileSync(
      path.join(staticDir, 'index.html'),
      '<!doctype html><html><head><script type="module" src="/assets/app.js"></script></head><body><div id="root"></div></body></html>'
    );

    process.env.STATIC_DIR = staticDir;
    try {
      const app = createApp();
      const shellResponse = await request(app).get('/').expect(200);
      const deepLinkResponse = await request(app).get('/onboarding').expect(200);
      const csp = shellResponse.headers['content-security-policy'] ?? '';
      expect(deepLinkResponse.headers['content-security-policy']).toBe(csp);
      expect(directiveOf(csp, 'script-src')).toBe("script-src 'self'");
    } finally {
      delete process.env.STATIC_DIR;
      fs.rmSync(staticDir, { recursive: true, force: true });
    }
  });

  it('limits connect-src to the app origin', async () => {
    const csp = await cspOf(createApp());
    expect(directiveOf(csp, 'connect-src')).toBe("connect-src 'self'");
  });

  it('ignores CSP_CONNECT_SRC: no extra connect origins can be configured', async () => {
    process.env.CSP_CONNECT_SRC = 'https://ai.example.com';
    try {
      const csp = await cspOf(createApp());
      expect(directiveOf(csp, 'connect-src')).toBe("connect-src 'self'");
      expect(csp).not.toContain('ai.example.com');
    } finally {
      delete process.env.CSP_CONNECT_SRC;
    }
  });

  it('limits fonts to self and data:', async () => {
    const csp = await cspOf(createApp());
    expect(directiveOf(csp, 'font-src')).toBe("font-src 'self' data:");
  });

  it('keeps unsafe-inline for style-src only (runtime <style> elements), never for scripts', async () => {
    const csp = await cspOf(createApp());
    expect(directiveOf(csp, 'style-src')).toBe("style-src 'self' 'unsafe-inline'");
    const withoutStyle = csp
      .split(';')
      .map((d) => d.trim())
      .filter((d) => !d.startsWith('style-src'))
      .join(';');
    expect(withoutStyle).not.toContain('unsafe-inline');
    expect(withoutStyle).not.toContain('unsafe-eval');
  });

  it('sends Referrer-Policy: no-referrer', async () => {
    const response = await request(createApp()).get('/api/health');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
  });

  it('does not send CORS headers (same-origin only)', async () => {
    const response = await request(createApp()).get('/api/health').set('Origin', 'https://evil.example');
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('allows remote avatar and README images via img-src', async () => {
    const csp = await cspOf(createApp());
    const imgSrc = csp.split(';').find((directive) => directive.trim().startsWith('img-src')) ?? '';
    expect(imgSrc).toContain("'self'");
    expect(imgSrc).toContain('data:');
    expect(imgSrc).toContain('blob:');
    expect(imgSrc).toContain('https:');
  });

  it('upgrades insecure requests by default', async () => {
    delete process.env.CSP_UPGRADE_INSECURE_REQUESTS;
    const csp = await cspOf(createApp());
    expect(csp).toContain('upgrade-insecure-requests');
  });

  it('keeps http:// deployments working when CSP_UPGRADE_INSECURE_REQUESTS is off', async () => {
    process.env.CSP_UPGRADE_INSECURE_REQUESTS = 'false';
    try {
      const app = createApp();
      const response = await request(app).get('/api/health');
      expect(response.headers['content-security-policy'] ?? '').not.toContain('upgrade-insecure-requests');
    } finally {
      delete process.env.CSP_UPGRADE_INSECURE_REQUESTS;
    }
  });
});
