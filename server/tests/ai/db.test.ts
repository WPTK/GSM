import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { freshDb, testDb } from './helpers.js';
import { runMigrations } from '../../src/db/migrations.js';
import { encrypt } from '../../src/services/crypto.js';
import { config } from '../../src/config.js';

vi.mock('../../src/db/connection.js', () => ({ getDb: () => (globalThis as unknown as { __testDb: unknown }).__testDb, closeDb: () => undefined }));

const { default: syncRouter } = await import('../../src/routes/sync.js');
const { default: repositoriesRouter } = await import('../../src/routes/repositories.js');

function app() {
  const a = express();
  a.use(express.json());
  a.use(syncRouter);
  a.use(repositoriesRouter);
  return a;
}

function oldDbAtV4(): Database.Database {
  // Build a v4 database the way an existing install would have it, then migrate.
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')));`);
  return db;
}

describe('migration v5', () => {
  it('creates the job tables and leaves ai_configs rows and activeAIConfig untouched', () => {
    const db = oldDbAtV4();
    // apply v1-v4 by running all, then rewind to v4 and re-seed old data
    runMigrations(db);
    db.exec('DROP TABLE ai_job_items; DROP TABLE ai_jobs; DELETE FROM schema_version WHERE version = 5;');
    db.prepare(
      "INSERT INTO ai_configs (id, name, api_type, base_url, api_key_encrypted, model, is_active, custom_prompt, use_custom_prompt) VALUES ('c1','My','openai','https://x',?, 'm', 1, 'Be terse. {REPO_INFO}', 1)",
    ).run(encrypt('sk-old-secret', config.encryptionKey));
    db.prepare("INSERT INTO settings (key, value) VALUES ('activeAIConfig', 'c1')").run();

    runMigrations(db);

    expect(db.prepare('SELECT COUNT(*) c FROM ai_configs').get()).toEqual({ c: 1 });
    expect(db.prepare("SELECT value FROM settings WHERE key = 'activeAIConfig'").get()).toEqual({ value: 'c1' });
    expect((db.prepare("SELECT api_key_encrypted k FROM ai_configs WHERE id = 'c1'").get() as { k: string }).k).toBeTruthy();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('ai_jobs','ai_job_items') ORDER BY name").all()).toEqual([
      { name: 'ai_job_items' },
      { name: 'ai_jobs' },
    ]);
    // read-only copy of the active config's custom prompt
    expect(db.prepare("SELECT value FROM settings WHERE key = 'ai.customAnalysisPrompt'").get()).toEqual({ value: 'Be terse. {REPO_INFO}' });
    expect(db.prepare("SELECT custom_prompt FROM ai_configs WHERE id = 'c1'").get()).toEqual({ custom_prompt: 'Be terse. {REPO_INFO}' });
    expect(db.prepare('SELECT MAX(version) v FROM schema_version').get()).toEqual({ v: 5 });
  });

  it('falls back to the is_active row when activeAIConfig points at a missing config', () => {
    const db = oldDbAtV4();
    runMigrations(db);
    db.exec('DROP TABLE ai_job_items; DROP TABLE ai_jobs; DELETE FROM schema_version WHERE version = 5;');
    db.prepare("INSERT INTO ai_configs (id, name, base_url, api_key_encrypted, model, is_active, custom_prompt, use_custom_prompt) VALUES ('c2','Other','https://x','k','m',1,'Use the fallback',1)").run();
    db.prepare("INSERT INTO settings (key, value) VALUES ('activeAIConfig', 'gone')").run();
    runMigrations(db);
    expect(db.prepare("SELECT value FROM settings WHERE key = 'ai.customAnalysisPrompt'").get()).toEqual({ value: 'Use the fallback' });
  });

  it('does not overwrite an existing server prompt and skips configs with the prompt switched off', () => {
    const db = oldDbAtV4();
    runMigrations(db);
    db.exec('DROP TABLE ai_job_items; DROP TABLE ai_jobs; DELETE FROM schema_version WHERE version = 5;');
    db.prepare("INSERT INTO ai_configs (id, name, base_url, api_key_encrypted, model, is_active, custom_prompt, use_custom_prompt) VALUES ('c1','My','https://x','k','m',1,'Old text',0)").run();
    runMigrations(db);
    expect(db.prepare("SELECT value FROM settings WHERE key = 'ai.customAnalysisPrompt'").get()).toBeUndefined();
  });
});

describe('sync export', () => {
  beforeEach(() => { freshDb(); });

  it('never contains an AI key in the clear or encrypted', async () => {
    const secret = 'sk-ant-api03-THISMUSTNOTLEAK-abcd';
    testDb().prepare(
      "INSERT INTO ai_configs (id, name, api_type, base_url, api_key_encrypted, model, is_active) VALUES ('c1','My','claude','https://api.anthropic.com',?, 'm', 1)",
    ).run(encrypt(secret, config.encryptionKey));
    const res = await request(app()).post('/api/sync/export').expect(200);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain('THISMUSTNOTLEAK');
    expect(res.body.ai_configs[0].api_key_encrypted).toBeUndefined();
    expect(res.body.ai_configs[0].api_key_masked).toBe('***abcd');
    expect(text).not.toContain('ai.state');
  });
});

describe('repositories upsert keeps newer server analysis', () => {
  const repo = (extra: Record<string, unknown> = {}) => ({
    id: 1, name: 'r', full_name: 'o/r', html_url: 'https://github.com/o/r', stargazers_count: 1,
    owner: { login: 'o', avatar_url: 'https://a/b' }, ...extra,
  });

  beforeEach(() => { freshDb(); });

  it('a stale browser snapshot does not wipe a newer server result', async () => {
    await request(app()).put('/api/repositories').send({ repositories: [repo()] }).expect(200);
    testDb().prepare("UPDATE repositories SET ai_summary='server', ai_tags='[\"a\"]', ai_platforms='[\"cli\"]', analyzed_at='2026-11-09T12:00:00.000Z' WHERE id=1").run();
    await request(app()).put('/api/repositories').send({
      repositories: [repo({ ai_summary: 'old browser', ai_tags: ['b'], ai_platforms: ['web'], analyzed_at: '2026-11-01T00:00:00.000Z' })],
    }).expect(200);
    expect(testDb().prepare('SELECT ai_summary, ai_tags, analyzed_at FROM repositories WHERE id=1').get()).toEqual({
      ai_summary: 'server', ai_tags: '["a"]', analyzed_at: '2026-11-09T12:00:00.000Z',
    });
  });

  it('a newer analyzed_at from the browser still wins', async () => {
    await request(app()).put('/api/repositories').send({ repositories: [repo()] }).expect(200);
    testDb().prepare("UPDATE repositories SET ai_summary='server', analyzed_at='2026-11-01T00:00:00.000Z' WHERE id=1").run();
    await request(app()).put('/api/repositories').send({
      repositories: [repo({ ai_summary: 'newer', ai_tags: ['b'], analyzed_at: '2026-11-09T00:00:00.000Z' })],
    }).expect(200);
    expect(testDb().prepare('SELECT ai_summary FROM repositories WHERE id=1').get()).toEqual({ ai_summary: 'newer' });
  });

  it('an unanalysed snapshot does not wipe stored analysis', async () => {
    await request(app()).put('/api/repositories').send({ repositories: [repo()] }).expect(200);
    testDb().prepare("UPDATE repositories SET ai_summary='server', analyzed_at='2026-11-01T00:00:00.000Z' WHERE id=1").run();
    await request(app()).put('/api/repositories').send({ repositories: [repo()] }).expect(200);
    expect(testDb().prepare('SELECT ai_summary FROM repositories WHERE id=1').get()).toEqual({ ai_summary: 'server' });
  });
});
