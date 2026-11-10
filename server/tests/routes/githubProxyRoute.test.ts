import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const proxyRequestMock = vi.fn();
const validateUrlMock = vi.fn();

vi.mock('../../src/services/proxyService.js', () => ({
  validateUrl: validateUrlMock,
  proxyRequest: proxyRequestMock,
  isPrivateOrLoopback: () => false,
}));

const { default: proxyRouter } = await import('../../src/routes/proxy.js');
const { resetGithubTokenForTests } = await import('../../src/services/githubToken.js');

const createTestApp = () => {
  const app = express();
  app.use(express.json());
  app.use(proxyRouter);
  return app;
};

describe('GitHub proxy routes', () => {
  afterEach(() => {
    delete process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN_FILE;
    resetGithubTokenForTests();
  });

  beforeEach(() => {
    process.env.GITHUB_TOKEN = 'github-token';
    resetGithubTokenForTests();
    proxyRequestMock.mockReset();
    validateUrlMock.mockReset();
    proxyRequestMock.mockResolvedValue({ status: 200, data: { ok: true }, headers: { 'content-type': 'application/json' } });
  });

  it('forwards the GitHub API request body with the server-side token', async () => {
    const app = createTestApp();

    await request(app)
      .post('/api/proxy/github/user/starred/octo/repo')
      .send({
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ a: 1 }),
      })
      .expect(200, { ok: true });

    expect(proxyRequestMock).toHaveBeenCalledOnce();
    const options = proxyRequestMock.mock.calls[0][0];
    expect(options.url).toBe('https://api.github.com/user/starred/octo/repo');
    expect(options.method).toBe('PUT');
    expect(options.body).toBe(JSON.stringify({ a: 1 }));
    expect(options.headers.Authorization).toBe('Bearer github-token');
    expect(options.headers['Content-Type']).toBe('application/json');
    expect(options).not.toHaveProperty('proxyConfig');
  });

  it('reads the token from GITHUB_TOKEN_FILE when GITHUB_TOKEN is not set', async () => {
    delete process.env.GITHUB_TOKEN;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsm-token-'));
    const file = path.join(dir, 'token');
    fs.writeFileSync(file, 'file-token\n');
    process.env.GITHUB_TOKEN_FILE = file;
    resetGithubTokenForTests();
    try {
      await request(createTestApp()).post('/api/proxy/github/user').send({ method: 'GET' }).expect(200);
      expect(proxyRequestMock.mock.calls[0][0].headers.Authorization).toBe('Bearer file-token');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('GITHUB_TOKEN_FILE wins over GITHUB_TOKEN when both are set', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsm-token-'));
    const file = path.join(dir, 'token');
    fs.writeFileSync(file, 'file-token\n');
    process.env.GITHUB_TOKEN_FILE = file;
    resetGithubTokenForTests();
    try {
      await request(createTestApp()).post('/api/proxy/github/user').send({ method: 'GET' }).expect(200);
      expect(proxyRequestMock.mock.calls[0][0].headers.Authorization).toBe('Bearer file-token');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an unreadable GITHUB_TOKEN_FILE is missing even when GITHUB_TOKEN is set', async () => {
    process.env.GITHUB_TOKEN_FILE = path.join(os.tmpdir(), 'gsm-no-such-token-file');
    resetGithubTokenForTests();
    await request(createTestApp())
      .post('/api/proxy/github/user')
      .send({ method: 'GET' })
      .expect(400, { error: 'GitHub token not configured', code: 'GITHUB_TOKEN_NOT_CONFIGURED' });
  });

  it('answers 400 GITHUB_TOKEN_NOT_CONFIGURED when no token is configured on the server', async () => {
    delete process.env.GITHUB_TOKEN;
    resetGithubTokenForTests();

    await request(createTestApp())
      .post('/api/proxy/github/user')
      .send({ method: 'GET' })
      .expect(400, { error: 'GitHub token not configured', code: 'GITHUB_TOKEN_NOT_CONFIGURED' });
    expect(proxyRequestMock).not.toHaveBeenCalled();
  });

  it('no longer exposes the raw-content proxy', async () => {
    const res = await request(createTestApp())
      .post('/api/proxy/github-raw')
      .send({ url: 'https://raw.githubusercontent.com/o/r/main/x' });
    expect(res.status).toBe(404);
    expect(proxyRequestMock).not.toHaveBeenCalled();
  });

  it('rejects path traversal in the target path', async () => {
    await request(createTestApp())
      .post('/api/proxy/github/repos/../../etc')
      .send({ method: 'GET' })
      .expect(400);
    expect(proxyRequestMock).not.toHaveBeenCalled();
  });

  it('relays upstream rate-limit headers to the client and skips unrelated ones', async () => {
    const app = createTestApp();
    proxyRequestMock.mockResolvedValueOnce({
      status: 429,
      data: { error: { message: 'rate limited' } },
      headers: {
        'content-type': 'application/json',
        'retry-after-ms': '2500',
        'retry-after': '5',
        'x-ratelimit-remaining-requests': '12',
        'x-ratelimit-remaining-tokens': '900',
        'x-debug-id': 'secret-upstream-id',
        'set-cookie': 'sid=abc',
      },
    });

    const res = await request(app)
      .post('/api/proxy/github/repos/octo/repo')
      .send({ method: 'GET' })
      .expect(429);

    expect(res.headers['retry-after-ms']).toBe('2500');
    expect(res.headers['retry-after']).toBe('5');
    expect(res.headers['x-ratelimit-remaining-requests']).toBe('12');
    expect(res.headers['x-ratelimit-remaining-tokens']).toBe('900');
    // 非限流相关头不应透传
    expect(res.headers['x-debug-id']).toBeUndefined();
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('encodes search query parameters exactly once', async () => {
    const app = createTestApp();

    await request(app)
      .post('/api/proxy/github/search/repositories?q=terminal%20file%20manager%20in%3Aname%2Cdescription%2Ctopics&per_page=25')
      .send({ method: 'GET' })
      .expect(200, { ok: true });

    const options = proxyRequestMock.mock.calls[0][0];
    expect(options.url).toBe(
      'https://api.github.com/search/repositories?q=terminal+file+manager+in%3Aname%2Cdescription%2Ctopics&per_page=25',
    );
  });
});
