import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readSecret, missingSecretsMessage } from './secrets.js';

interface Config {
  port: number;
  apiSecret: string;
  encryptionKey: string;
  dbPath: string;
  nodeEnv: string;
}

/** Resolve the data directory path, creating it if it doesn't exist. */
function resolveDataDir(): string {
  const dataDir = path.resolve(process.cwd(), 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  return dataDir;
}

/**
 * Normalize an encryption key to a 64-char hex string (32 bytes) suitable for AES-256.
 *
 * Backward compatibility:
 * - Valid 64-char hex string → returned as-is (no change for existing users)
 * - Short hex (e.g. 32 chars from `openssl rand -hex 16`) → SHA-256 derived
 * - Non-hex input (base64, plain text, too-long hex) → SHA-256 derived
 */
export function normalizeEncryptionKey(key: string): string {
  const trimmed = key.trim();

  // Already a valid 32-byte hex key — pass through unchanged
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return trimmed;
  }

  // Hex string but wrong length — derive via SHA-256 for deterministic 32-byte result
  if (/^[0-9a-fA-F]+$/.test(trimmed)) {
    console.warn(`[config] ENCRYPTION_KEY is ${trimmed.length} hex chars (expected 64). Deriving 32-byte key via SHA-256. Previously encrypted data may need re-encryption.`);
    return crypto.createHash('sha256').update(trimmed, 'utf8').digest('hex');
  }

  // Non-hex input (base64, plain text, etc.) — derive via SHA-256
  console.warn('[config] ENCRYPTION_KEY is not a valid hex string. Deriving 32-byte key via SHA-256.');
  return crypto.createHash('sha256').update(trimmed, 'utf8').digest('hex');
}

/**
 * Resolve the AES-256 encryption key from ENCRYPTION_KEY or ENCRYPTION_KEY_FILE.
 * It is required: there is no auto-generated fallback. All non-standard formats
 * are normalized to a 64-char hex string (32 bytes).
 */
function resolveEncryptionKey(dataDir: string): string {
  const key = readSecret('ENCRYPTION_KEY');
  if (!key) {
    throw new Error(missingSecretsMessage(['ENCRYPTION_KEY']));
  }

  // Older versions auto-generated this file. It is never read or deleted now.
  if (fs.existsSync(path.join(dataDir, '.encryption-key'))) {
    console.warn('[config] data/.encryption-key exists but is no longer read: move its value into ENCRYPTION_KEY (or ENCRYPTION_KEY_FILE); the file was not deleted.');
  }
  return normalizeEncryptionKey(key);
}

/** Load all server configuration from environment variables and defaults. */
function loadConfig(): Config {
  const dataDir = resolveDataDir();
  const apiSecret = readSecret('API_SECRET');
  if (!apiSecret) {
    throw new Error(missingSecretsMessage(['API_SECRET']));
  }

  return {
    port: parseInt(process.env.PORT || '3000', 10),
    apiSecret,
    encryptionKey: resolveEncryptionKey(dataDir),
    dbPath: process.env.DB_PATH || path.join(dataDir, 'data.db'),
    nodeEnv: process.env.NODE_ENV || 'development',
  };
}
export const config = loadConfig();
