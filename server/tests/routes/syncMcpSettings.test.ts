import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

const getDbMock = vi.fn();

vi.mock('../../src/db/connection.js', () => ({ getDb: () => getDbMock() }));
vi.mock('../../src/config.js', () => ({ config: { encryptionKey: 'test-key' } }));
vi.mock('../../src/services/crypto.js', () => ({ encrypt: (v: string) => v, decrypt: (v: string) => v }));

const { default: syncRouter } = await import('../../src/routes/sync.js');

const app = () => {
  const a = express();
  a.use(express.json());
  a.use(syncRouter);
  return a;
};

/** In-memory settings table behind the minimal prepare/run/all surface the sync routes use. */
function settingsDb(initial: Record<string, string>) {
  const table = new Map<string, string | null>(Object.entries(initial));
  const db = {
    prepare: (sql: string) => ({
      all: () => (sql.includes('FROM settings') ? [...table].map(([key, value]) => ({ key, value })) : []),
      run: (...p: unknown[]) => {
        if (sql.includes('INTO settings')) table.set(p[0] as string, p[1] as string | null);
        return { changes: 1 };
      },
      get: () => undefined,
    }),
    transaction: (fn: () => void) => fn,
    exec: () => undefined,
  };
  getDbMock.mockReturnValue(db);
  return table;
}

describe('sync leaves MCP admin state alone', () => {
  it('export omits mcp_token and mcp_enabled but keeps ordinary settings', async () => {
    settingsDb({ mcp_token: 'enc:secret', mcp_enabled: '1', theme: 'dark' });
    const res = await request(app()).post('/api/sync/export').expect(200);
    expect(res.body.settings).toEqual({ theme: 'dark' });
  });

  it('import ignores mcp_token and mcp_enabled and leaves the existing values unchanged', async () => {
    const table = settingsDb({ mcp_token: 'enc:original', mcp_enabled: '0' });
    await request(app())
      .post('/api/sync/import')
      .send({ settings: { mcp_token: 'attacker', mcp_enabled: '1', theme: 'dark' } })
      .expect(200);
    expect(table.get('mcp_token')).toBe('enc:original');
    expect(table.get('mcp_enabled')).toBe('0');
    expect(table.get('theme')).toBe('dark');
  });
});
