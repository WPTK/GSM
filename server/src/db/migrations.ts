import { LEGACY_SETTING_KEYS, CUSTOM_ANALYSIS_PROMPT_KEY } from './settingsKeys.js';
import type Database from 'better-sqlite3';
import { initializeSchema, addColumnIfMissing } from './schema.js';
import { logger } from '../services/logger.js';

const migrations: Record<number, (db: Database.Database) => void> = {
  1: (db) => {
    initializeSchema(db);
  },
  2: (db) => {
    addColumnIfMissing(db, 'webdav_configs', 'custom_user_agent', 'TEXT');
  },
  3: (db) => {
    addColumnIfMissing(db, 'repositories', 'description_display', 'TEXT');
    addColumnIfMissing(db, 'repositories', 'tags_display', 'TEXT');
  },
  // Stream A: the proxy and RPC-download features are gone; drop their stored rows.
  4: (db) => {
    const del = db.prepare('DELETE FROM settings WHERE key = ?');
    for (const key of LEGACY_SETTING_KEYS) del.run(key);
  },
  // Phase 3: Claude runs from the server's own key. Saved provider configs are no longer used, and
  // analysis jobs (direct and Message Batches) are tracked in SQLite so a restart resumes them.
  5: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ai_jobs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        mode TEXT NOT NULL,
        persisted INTEGER NOT NULL DEFAULT 1,
        language TEXT NOT NULL,
        model TEXT NOT NULL,
        usd REAL NOT NULL DEFAULT 0,
        cache_json TEXT NOT NULL,
        batch_id TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ai_job_items (
        job_id TEXT NOT NULL REFERENCES ai_jobs(id) ON DELETE CASCADE,
        repo_id INTEGER NOT NULL,
        full_name TEXT NOT NULL,
        repo_json TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        result_json TEXT,
        error TEXT,
        PRIMARY KEY (job_id, repo_id)
      );
    `);
    // The saved provider configs stay on disk untouched (owner decision): the server just no
    // longer reads or serves them. Only the active config's custom analysis prompt is copied
    // (read-only) into the new server setting.
    const hasConfigs = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ai_configs'").get();
    if (hasConfigs) {
      const activeId = (db.prepare('SELECT value FROM settings WHERE key = ?').get('activeAIConfig') as { value: string | null } | undefined)?.value;
      const row = (activeId
        ? db.prepare('SELECT custom_prompt, use_custom_prompt FROM ai_configs WHERE id = ?').get(activeId)
        : db.prepare('SELECT custom_prompt, use_custom_prompt FROM ai_configs WHERE is_active = 1 LIMIT 1').get()) as
        | { custom_prompt: string | null; use_custom_prompt: number }
        | undefined;
      const prompt = row?.use_custom_prompt && row.custom_prompt ? row.custom_prompt.trim() : '';
      if (prompt) {
        db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run(CUSTOM_ANALYSIS_PROMPT_KEY, prompt.slice(0, 4000));
      }
    }
  },
};

export function runMigrations(db: Database.Database): void {
  // Ensure schema_version table exists first
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const currentVersionRow = db
    .prepare('SELECT MAX(version) as version FROM schema_version')
    .get() as { version: number | null } | undefined;

  const currentVersion = currentVersionRow?.version ?? 0;
  const targetVersion = Math.max(...Object.keys(migrations).map(Number));

  if (currentVersion >= targetVersion) {
    return;
  }

  const applyMigration = db.transaction(() => {
    for (let v = currentVersion + 1; v <= targetVersion; v++) {
      const migration = migrations[v];
      if (migration) {
        logger.info('db.migration', `Applying migration v${v}...`);
        migration(db);
        db.prepare('INSERT OR REPLACE INTO schema_version (version) VALUES (?)').run(v);
        logger.info('db.migration', `Migration v${v} applied.`);
      }
    }
  });

  applyMigration();
}
