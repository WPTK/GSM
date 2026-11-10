import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsm-bodylimit-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.API_SECRET = 'test-api-secret';

const conn = await import('../../src/db/connection.js');
const { createApp } = await import('../../src/index.js');

afterAll(() => {
  try {
    conn.closeDb();
  } catch {
    // already closed
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Claude route body limit', () => {
  const big = JSON.stringify({ system: 'x'.repeat(3 * 1024 * 1024), messages: [], maxTokens: 1 });

  it.each(['/api/ai/messages', '/api/AI/messages', '/API/Ai/messages'])('applies the 2 MB limit on %s', async (route) => {
    const res = await request(createApp())
      .post(route)
      .set('Authorization', 'Bearer test-api-secret')
      .set('Content-Type', 'application/json')
      .send(big);
    expect(res.status).toBe(413);
  });
});
