import { AI_STATE_SETTING_KEY, CUSTOM_ANALYSIS_PROMPT_KEY, EXCLUDED_SETTING_KEYS } from '../db/settingsKeys.js';
import { randomUUID } from 'crypto';
import { Router } from 'express';
import { getDb } from '../db/connection.js';
import { encrypt, decrypt } from '../services/crypto.js';
import { config } from '../config.js';
import { logger } from '../services/logger.js';

const router = Router();

type SecretStatus = 'ok' | 'empty' | 'decrypt_failed';


function getMaskedSecretResult(params: {
  encryptedValue: unknown;
  encryptionKey: string;
  kind: 'AI API key';
  configId?: unknown;
  configName?: unknown;
}): { decryptedValue: string; status: SecretStatus } {
  const { encryptedValue, encryptionKey, kind, configId, configName } = params;

  if (!encryptedValue || typeof encryptedValue !== 'string') {
    return { decryptedValue: '', status: 'empty' };
  }

  try {
    return {
      decryptedValue: decrypt(encryptedValue, encryptionKey),
      status: 'ok',
    };
  } catch {
    logger.warn('configs.decrypt', 'Failed to decrypt stored secret', { kind, configId, configName });
    return { decryptedValue: '', status: 'decrypt_failed' };
  }
}

// ── Helpers ──

function maskApiKey(key: string | null | undefined): string {
  if (!key || typeof key !== 'string') return '';
  if (key.length <= 4) return '****';
  return '***' + key.slice(-4);
}

/**
 * 为加密配置表注册 bulk sync / single update / delete 路由
 * 消除 AI configs 和 embedding configs 之间的重复代码
 */
function registerEncryptedConfigRoutes(opts: {
  router: ReturnType<typeof Router>;
  basePath: string;           // e.g. '/api/configs/ai'
  table: string;              // e.g. 'ai_configs'
  secretColumn: string;       // e.g. 'api_key_encrypted'
  label: string;              // e.g. 'AI config' (for error messages)
  logPrefix: string;          // e.g. 'configs.ai'
  insertSql: string;          // full INSERT statement with ? placeholders
  updateSql: string;          // full UPDATE statement with ? placeholders (last ? is id)
  /** Extract ordered bind params from a config body item for INSERT */
  insertParams: (c: Record<string, unknown>, encryptedKey: string) => unknown[];
  /** Extract ordered bind params from a req.body for UPDATE (last element must be id) */
  updateParams: (body: Record<string, unknown>, id: string, encryptedKey: string) => unknown[];
  /** Shape the response object for a single config */
  shapeResponse: (c: Record<string, unknown>, id: string | number, maskedKey: string) => Record<string, unknown>;
  /** If false, configs without a secret are allowed (e.g. Ollama). Default true. */
  requiresSecret?: boolean;
}): void {
  const { router, basePath, table, secretColumn, label, logPrefix, insertSql, updateSql, insertParams, updateParams, shapeResponse, requiresSecret = true } = opts;

  // PUT /bulk — replace all configs (for sync)
  router.put(`${basePath}/bulk`, (req, res) => {
    const syncResult = { inserted: 0, skipped: [] as Array<{ id: string; name: string; reason: string }> };

    try {
      const db = getDb();
      const configs = req.body.configs as Array<Record<string, unknown>>;

      if (!Array.isArray(configs)) {
        res.status(400).json({ error: 'configs array required', code: 'INVALID_REQUEST' });
        return;
      }

      const bulkSync = db.transaction(() => {
        const existingKeys = new Map<string, string>();
        const existingRows = db.prepare(`SELECT id, ${secretColumn} FROM ${table}`).all() as Array<{ id: string; [key: string]: string }>;
        for (const row of existingRows) {
          if (row[secretColumn]) existingKeys.set(String(row.id), row[secretColumn]);
        }

        db.prepare(`DELETE FROM ${table}`).run();
        const stmt = db.prepare(insertSql);

        for (const c of configs) {
          let encryptedKey = '';
          const rawKey = c.apiKey ?? c.password;
          if (rawKey && typeof rawKey === 'string' && !rawKey.startsWith('***')) {
            try {
              encryptedKey = encrypt(String(rawKey), config.encryptionKey);
            } catch (encErr) {
              logger.errorFromError(`${logPrefix}.encrypt`, `Failed to encrypt secret for ${label}`, encErr, { configId: c.id, configName: c.name });
              encryptedKey = existingKeys.get(String(c.id)) ?? '';
              if (!encryptedKey) {
                syncResult.skipped.push({ id: String(c.id), name: String(c.name ?? ''), reason: 'encrypt_failed' });
                continue;
              }
            }
          } else if (rawKey === '') {
            // Explicit empty string = user wants to clear the secret
            encryptedKey = '';
          } else {
            // Omitted or masked = reuse existing
            encryptedKey = existingKeys.get(String(c.id)) ?? '';
          }

          if (!encryptedKey && requiresSecret) {
            syncResult.skipped.push({
              id: String(c.id),
              name: String(c.name ?? ''),
              reason: (typeof rawKey === 'string' && rawKey.startsWith('***'))
                ? 'Secret is masked and no existing key found'
                : 'Secret is empty',
            });
            continue;
          }

          stmt.run(...insertParams(c, encryptedKey));
          syncResult.inserted++;
        }

        // Rollback if any config was skipped (prevents partial replacement)
        if (syncResult.skipped.length > 0) {
          throw new Error('SOME_CONFIGS_SKIPPED');
        }
      });

      bulkSync();
      res.json({ synced: syncResult.inserted, skipped: 0, errors: [] });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.errorFromError(`${logPrefix}.bulk`, `PUT ${basePath}/bulk error`, err);
      if (errMsg === 'SOME_CONFIGS_SKIPPED') {
        res.status(422).json({
          error: `Some ${label} configs were skipped — check the errors field for per-config reasons`,
          code: `SYNC_${logPrefix.toUpperCase().replace(/\./g, '_')}_PARTIAL_SKIP`,
          synced: 0,
          skipped: syncResult.skipped.length,
          errors: syncResult.skipped,
        });
      } else {
        res.status(500).json({ error: `Failed to sync ${label} configs`, code: `SYNC_${logPrefix.toUpperCase().replace(/\./g, '_')}_FAILED` });
      }
    }
  });

  // PUT /:id — update single config
  router.put(`${basePath}/:id`, (req, res) => {
    try {
      const db = getDb();
      const id = req.params.id;
      const body = req.body as Record<string, unknown>;
      const rawKey = body.apiKey ?? body.password;

      let encryptedKey: string | null = null;
      if (rawKey && typeof rawKey === 'string' && !rawKey.startsWith('***')) {
        encryptedKey = encrypt(rawKey, config.encryptionKey);
      } else if (rawKey === '') {
        // Explicit empty string = user wants to clear the secret
        encryptedKey = '';
      } else {
        // Omitted or masked = reuse existing
        const existing = db.prepare(`SELECT ${secretColumn} FROM ${table} WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
        encryptedKey = (existing?.[secretColumn] as string) ?? null;
      }

      const result = db.prepare(updateSql).run(...updateParams(body, id, encryptedKey ?? ''));

      if (result.changes === 0) {
        res.status(404).json({ error: `${label} not found`, code: `${logPrefix.toUpperCase().replace(/\./g, '_')}_NOT_FOUND` });
        return;
      }

      let maskedKey = '';
      if (encryptedKey) {
        try { maskedKey = maskApiKey(decrypt(encryptedKey, config.encryptionKey)); } catch { maskedKey = '****'; }
      }

      res.json(shapeResponse(body, id, maskedKey));
    } catch (err) {
      logger.errorFromError(`${logPrefix}.update`, `PUT ${basePath}/:id error`, err);
      res.status(500).json({ error: `Failed to update ${label}`, code: `UPDATE_${logPrefix.toUpperCase().replace(/\./g, '_')}_FAILED` });
    }
  });

  // DELETE /:id
  router.delete(`${basePath}/:id`, (req, res) => {
    try {
      const db = getDb();
      const id = req.params.id;
      const result = db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
      if (result.changes === 0) {
        res.status(404).json({ error: `${label} not found`, code: `${logPrefix.toUpperCase().replace(/\./g, '_')}_NOT_FOUND` });
        return;
      }
      res.json({ deleted: true });
    } catch (err) {
      logger.errorFromError(`${logPrefix}.delete`, `DELETE ${basePath}/:id error`, err);
      res.status(500).json({ error: `Failed to delete ${label}`, code: `DELETE_${logPrefix.toUpperCase().replace(/\./g, '_')}_FAILED` });
    }
  });
}

// ── Settings ──

// GET /api/settings
router.get('/api/settings', (_req, res) => {
  try {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM settings').all() as Record<string, unknown>[];
    const settings: Record<string, unknown> = {};

    for (const row of rows) {
      const key = row.key as string;
      const value = row.value as string | null;

      // Server-side configuration (GITHUB_TOKEN) and legacy rows are never reported here.
      if (EXCLUDED_SETTING_KEYS.has(key)) continue;

      settings[key] = value;
    }

    res.json(settings);
  } catch (err) {
    logger.errorFromError('configs.getSettings', 'GET /api/settings error', err);
    res.status(500).json({ error: 'Failed to fetch settings', code: 'FETCH_SETTINGS_FAILED' });
  }
});

// PUT /api/settings
router.put('/api/settings', (req, res) => {
  try {
    const db = getDb();
    const updates = req.body as Record<string, unknown>;

    if (Object.prototype.hasOwnProperty.call(updates, 'github_token')) {
      res.status(400).json({
        error: 'The GitHub token is configured on the server (GITHUB_TOKEN) and cannot be set here',
        code: 'GITHUB_TOKEN_NOT_SETTABLE',
      });
      return;
    }

    // Server-owned AI settings have their own routes (/api/ai/settings) and state.
    for (const key of [AI_STATE_SETTING_KEY, CUSTOM_ANALYSIS_PROMPT_KEY]) {
      if (Object.prototype.hasOwnProperty.call(updates, key)) {
        res.status(400).json({
          error: `The setting ${key} cannot be set here`,
          code: 'SETTING_NOT_SETTABLE',
        });
        return;
      }
    }

    const stmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');

    const upsert = db.transaction(() => {
      for (const [key, rawValue] of Object.entries(updates)) {
        const value = rawValue as string | null;

        // better-sqlite3 interprets objects/arrays as named parameter maps,
        // causing RangeError. Serialize non-primitive values to JSON strings.
        const serialized =
          value === null || value === undefined
            ? null
            : typeof value === 'object'
              ? JSON.stringify(value)
              : value;
        stmt.run(key, serialized);
      }
    });

    upsert();
    res.json({ updated: true });
  } catch (err) {
    logger.errorFromError('configs.updateSettings', 'PUT /api/settings error', err);
    res.status(500).json({ error: 'Failed to update settings', code: 'UPDATE_SETTINGS_FAILED' });
  }
});

// ── Embedding Configs ──

// GET /api/configs/embedding
router.get('/api/configs/embedding', (req, res) => {
  try {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM embedding_configs ORDER BY id ASC').all() as Record<string, unknown>[];
    const configs = rows.map((row) => {
      const { decryptedValue, status } = getMaskedSecretResult({
        encryptedValue: row.api_key_encrypted,
        encryptionKey: config.encryptionKey,
        kind: 'AI API key',
        configId: row.id,
        configName: row.name,
      });
      return {
        id: row.id,
        name: row.name,
        apiType: row.api_type,
        baseUrl: row.base_url,
        apiKey: maskApiKey(decryptedValue),
        apiKeyStatus: status,
        model: row.model,
        dimensions: row.dimensions,
        isActive: !!row.is_active,
      };
    });
    res.json(configs);
  } catch (err) {
    logger.errorFromError('configs.getEmbedding', 'GET /api/configs/embedding error', err);
    res.status(500).json({ error: 'Failed to fetch embedding configs', code: 'FETCH_EMBEDDING_CONFIGS_FAILED' });
  }
});

// POST /api/configs/embedding
router.post('/api/configs/embedding', (req, res) => {
  try {
    const db = getDb();
    const { name, apiType, baseUrl, apiKey, model, dimensions, isActive } = req.body as Record<string, unknown>;

    const id = typeof req.body.id === 'string' && req.body.id ? req.body.id : randomUUID();
    const encryptedKey = apiKey && typeof apiKey === 'string' ? encrypt(apiKey, config.encryptionKey) : '';

    db.prepare(
      'INSERT INTO embedding_configs (id, name, api_type, base_url, api_key_encrypted, model, dimensions, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, name ?? '', apiType ?? 'openai', baseUrl ?? '', encryptedKey, model ?? '', dimensions ?? 1536, isActive ? 1 : 0);

    res.status(201).json({
      id,
      name,
      apiType,
      baseUrl,
      apiKey: maskApiKey(apiKey as string),
      model,
      dimensions: dimensions ?? 1536,
      isActive: !!isActive,
    });
  } catch (err) {
    logger.errorFromError('configs.createEmbedding', 'POST /api/configs/embedding error', err);
    res.status(500).json({ error: 'Failed to create embedding config', code: 'CREATE_EMBEDDING_CONFIG_FAILED' });
  }
});

// Embedding config bulk/update/delete — delegated to shared factory
registerEncryptedConfigRoutes({
  router,
  basePath: '/api/configs/embedding',
  table: 'embedding_configs',
  secretColumn: 'api_key_encrypted',
  label: 'Embedding config',
  logPrefix: 'configs.embedding',
  insertSql: `INSERT INTO embedding_configs (id, name, api_type, base_url, api_key_encrypted, model, dimensions, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  updateSql: `UPDATE embedding_configs SET name = ?, api_type = ?, base_url = ?, api_key_encrypted = ?, model = ?, dimensions = ?, is_active = ?, updated_at = datetime('now') WHERE id = ?`,
  insertParams: (c, ek) => [
    c.id, c.name ?? '', c.apiType ?? 'openai', c.baseUrl ?? '',
    ek, c.model ?? '', c.dimensions ?? 1536, c.isActive ? 1 : 0,
  ],
  updateParams: (b, id, ek) => [
    b.name ?? '', b.apiType ?? 'openai', b.baseUrl ?? '',
    ek, b.model ?? '', b.dimensions ?? 1536, b.isActive ? 1 : 0, id,
  ],
  shapeResponse: (c, id, maskedKey) => ({
    id, name: c.name, apiType: c.apiType, baseUrl: c.baseUrl,
    apiKey: maskedKey, model: c.model, dimensions: c.dimensions ?? 1536, isActive: !!c.isActive,
  }),
  requiresSecret: false, // Ollama 等本地模型不需要 API Key
});

// ── Vector Search Config ──

// GET /api/configs/vector-search
router.get('/api/configs/vector-search', (req, res) => {
  try {
    const db = getDb();
    const row = db.prepare('SELECT * FROM vector_search_configs WHERE id = ?').get('default') as Record<string, unknown> | undefined;

    if (!row) {
      res.json({ enabled: false, workerUrl: '', authToken: '', embeddingConfigId: '', indexMode: 'readme', readmeMaxChars: 6000, searchThreshold: 0.35, searchTopK: 30, enableHyDE: true, enableReranking: true });
      return;
    }

    let authToken = '';
    let authTokenStatus: SecretStatus = 'empty';
    if (row.auth_token_encrypted) {
      const result = getMaskedSecretResult({
        encryptedValue: row.auth_token_encrypted,
        encryptionKey: config.encryptionKey,
        kind: 'AI API key',
      });
      authToken = maskApiKey(result.decryptedValue);
      authTokenStatus = result.status;
    }

    let status = undefined;
    if (row.status_json && typeof row.status_json === 'string') {
      try { status = JSON.parse(row.status_json); } catch { /* ignore */ }
    }

    res.json({
      enabled: !!row.enabled,
      workerUrl: row.worker_url ?? '',
      authToken,
      authTokenStatus,
      embeddingConfigId: row.embedding_config_id ?? '',
      indexMode: row.index_mode ?? 'readme',
      readmeMaxChars: row.readme_max_chars ?? 6000,
      searchThreshold: typeof row.search_threshold === 'number' ? row.search_threshold : 0.35,
      searchTopK: typeof row.search_top_k === 'number' ? row.search_top_k : 30,
      enableHyDE: row.enable_hyde === 1,
      enableReranking: row.enable_reranking === 1,
      embeddingFormatVersion: typeof row.embedding_format_version === 'number' ? row.embedding_format_version : undefined,
      status,
      lastSyncAt: row.last_sync_at ?? null,
    });
  } catch (err) {
    logger.errorFromError('configs.getVectorSearch', 'GET /api/configs/vector-search error', err);
    res.status(500).json({ error: 'Failed to fetch vector search config', code: 'FETCH_VECTOR_SEARCH_CONFIG_FAILED' });
  }
});

// PUT /api/configs/vector-search
router.put('/api/configs/vector-search', (req, res) => {
  try {
    const db = getDb();
    const { enabled, workerUrl, authToken, embeddingConfigId, indexMode, readmeMaxChars, status, lastSyncAt } = req.body as Record<string, unknown>;
    const { searchThreshold, searchTopK, enableHyDE, enableReranking, embeddingFormatVersion } = req.body as Record<string, unknown>;

    let encryptedToken = '';
    const hasAuthToken = Object.prototype.hasOwnProperty.call(req.body, 'authToken');
    if (hasAuthToken && authToken === '') {
      // Explicit empty string = user wants to clear the token
      encryptedToken = '';
    } else if (authToken && typeof authToken === 'string' && !authToken.startsWith('***')) {
      encryptedToken = encrypt(authToken, config.encryptionKey);
    } else {
      // Omitted or masked = reuse existing
      const existing = db.prepare('SELECT auth_token_encrypted FROM vector_search_configs WHERE id = ?').get('default') as Record<string, unknown> | undefined;
      encryptedToken = (existing?.auth_token_encrypted as string) ?? '';
    }

    const statusJson = status ? JSON.stringify(status) : null;
    const mode = indexMode === 'description' ? 'description' : 'readme';
    const maxChars = typeof readmeMaxChars === 'number' && readmeMaxChars > 0 ? readmeMaxChars : 6000;
    const threshold = typeof searchThreshold === 'number' && Number.isFinite(searchThreshold) && searchThreshold >= 0 && searchThreshold <= 1
      ? searchThreshold
      : 0.35;
    const topK = typeof searchTopK === 'number' && Number.isInteger(searchTopK) && searchTopK >= 5 && searchTopK <= 50
      ? searchTopK
      : 30;
    const hyde = enableHyDE === true ? 1 : 0;
    const reranking = enableReranking === true ? 1 : 0;
    const formatVersion = typeof embeddingFormatVersion === 'number' && Number.isInteger(embeddingFormatVersion) && embeddingFormatVersion >= 1
      ? embeddingFormatVersion
      : null;

    db.prepare(`
      INSERT OR REPLACE INTO vector_search_configs (id, enabled, worker_url, auth_token_encrypted, embedding_config_id, index_mode, readme_max_chars, search_threshold, search_top_k, enable_hyde, enable_reranking, embedding_format_version, status_json, last_sync_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run('default', enabled ? 1 : 0, workerUrl ?? '', encryptedToken, embeddingConfigId ?? '', mode, maxChars, threshold, topK, hyde, reranking, formatVersion, statusJson, lastSyncAt ?? null);

    res.json({ updated: true });
  } catch (err) {
    logger.errorFromError('configs.updateVectorSearch', 'PUT /api/configs/vector-search error', err);
    res.status(500).json({ error: 'Failed to update vector search config', code: 'UPDATE_VECTOR_SEARCH_CONFIG_FAILED' });
  }
});

export default router;
