import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

const getDbMock = vi.fn();

vi.mock('../../src/db/connection.js', () => ({
  getDb: () => getDbMock(),
}));
vi.mock('../../src/config.js', () => ({ config: { encryptionKey: 'test-key' } }));
vi.mock('../../src/services/crypto.js', () => ({
  encrypt: (value: string) => `encrypted:${value}`,
  decrypt: (value: string) => value,
}));
vi.mock('../../src/services/logger.js', () => ({
  logger: {
    warn: vi.fn(),
    errorFromError: vi.fn(),
  },
}));

const { default: configsRouter } = await import('../../src/routes/configs.js');

/**
 * Create an in-memory settings database stub for the route test.
 */
function createSettingsDb() {
  const values = new Map<string, string | null>();
  const statement = {
    run: (key: string, value: string | null) => {
      values.set(key, value);
      return { changes: 1 };
    },
  };
  const db = {
    prepare: () => statement,
    transaction: (fn: () => void) => fn,
  };
  getDbMock.mockReturnValue(db);
  return values;
}

/**
 * Build an Express app containing the settings route under test.
 */
const createTestApp = () => {
  const app = express();
  app.use(express.json());
  app.use(configsRouter);
  return app;
};

describe('PUT /api/settings', () => {
  it('stores ordinary settings', async () => {
    const values = createSettingsDb();
    const app = createTestApp();

    await request(app).put('/api/settings').send({ activeAIConfig: 'default' }).expect(200);

    expect(values.get('activeAIConfig')).toBe('default');
  });

  it('rejects github_token: the token is server configuration (GITHUB_TOKEN)', async () => {
    const values = createSettingsDb();
    const app = createTestApp();

    const res = await request(app)
      .put('/api/settings')
      .send({ github_token: 'ghp-local-token', activeAIConfig: 'default' })
      .expect(400);

    expect(res.body.code).toBe('GITHUB_TOKEN_NOT_SETTABLE');
    expect(JSON.stringify(res.body)).not.toContain('ghp-local-token');
    // Nothing from the rejected request was stored.
    expect(values.size).toBe(0);
  });
});

describe('PUT /api/settings server-owned AI keys', () => {
  it.each(['ai.state', 'ai.customAnalysisPrompt'])('rejects %s with 400 and stores nothing', async (key) => {
    const values = createSettingsDb();
    const res = await request(createTestApp())
      .put('/api/settings')
      .send({ [key]: 'x', activeAIConfig: 'default' })
      .expect(400);
    expect(res.body.code).toBe('SETTING_NOT_SETTABLE');
    expect(values.size).toBe(0);
  });
});

describe('GET /api/settings', () => {
  it('never reports a stored github_token, even a masked one', async () => {
    getDbMock.mockReturnValue({
      prepare: () => ({
        all: () => [
          { key: 'github_token', value: 'encrypted-legacy-token' },
          { key: 'activeAIConfig', value: 'default' },
        ],
      }),
    });

    const res = await request(createTestApp()).get('/api/settings').expect(200);

    expect(res.body).toEqual({ activeAIConfig: 'default' });
  });
});
