import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

describe('config: no key file, API_SECRET and ENCRYPTION_KEY required', () => {
  let cwd: string;
  let prevCwd: string;
  beforeEach(() => {
    prevCwd = process.cwd();
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsm-config-'));
    process.chdir(cwd);
    vi.resetModules();
  });
  afterEach(() => {
    process.chdir(prevCwd);
    fs.rmSync(cwd, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('creates no data/.encryption-key when ENCRYPTION_KEY is set', async () => {
    vi.stubEnv('ENCRYPTION_KEY', KEY);
    vi.stubEnv('API_SECRET', 'test-api-secret');
    const { config } = await import('../src/config.js');
    expect(config.encryptionKey).toBe(KEY);
    expect(fs.existsSync(path.join(cwd, 'data', '.encryption-key'))).toBe(false);
  });

  it('throws (and writes no key file) when ENCRYPTION_KEY is missing', async () => {
    vi.stubEnv('ENCRYPTION_KEY', '');
    vi.stubEnv('ENCRYPTION_KEY_FILE', '');
    vi.stubEnv('API_SECRET', 'test-api-secret');
    await expect(import('../src/config.js')).rejects.toThrow(/ENCRYPTION_KEY/);
    expect(fs.existsSync(path.join(cwd, 'data', '.encryption-key'))).toBe(false);
  });

  it('throws when API_SECRET is missing', async () => {
    vi.stubEnv('ENCRYPTION_KEY', KEY);
    vi.stubEnv('API_SECRET', '');
    vi.stubEnv('API_SECRET_FILE', '');
    await expect(import('../src/config.js')).rejects.toThrow(/API_SECRET/);
  });

  it('reads both from _FILE variants', async () => {
    fs.writeFileSync(path.join(cwd, 'k'), KEY + '\n');
    fs.writeFileSync(path.join(cwd, 's'), 'test-api-secret\n');
    vi.stubEnv('ENCRYPTION_KEY', '');
    vi.stubEnv('API_SECRET', '');
    vi.stubEnv('ENCRYPTION_KEY_FILE', path.join(cwd, 'k'));
    vi.stubEnv('API_SECRET_FILE', path.join(cwd, 's'));
    const { config } = await import('../src/config.js');
    expect(config.encryptionKey).toBe(KEY);
    expect(config.apiSecret).toBe('test-api-secret');
  });

  it('an existing data/.encryption-key logs one line, is not read, not printed, not deleted', async () => {
    const legacyContents = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
    fs.mkdirSync(path.join(cwd, 'data'));
    const keyFile = path.join(cwd, 'data', '.encryption-key');
    fs.writeFileSync(keyFile, legacyContents);
    vi.stubEnv('ENCRYPTION_KEY', KEY);
    vi.stubEnv('API_SECRET', 'test-api-secret');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { config } = await import('../src/config.js');
    expect(config.encryptionKey).toBe(KEY);
    const lines = [...warn.mock.calls, ...log.mock.calls].map((c) => String(c[0]));
    expect(lines.filter((l) => l.includes('.encryption-key'))).toHaveLength(1);
    expect(lines.join('\n')).not.toContain(legacyContents);
    expect(fs.readFileSync(keyFile, 'utf8')).toBe(legacyContents);
  });
});

describe('session cookie signing key', () => {
  it('derives from API_SECRET only, not ENCRYPTION_KEY', async () => {
    vi.resetModules();
    const { config } = await import('../src/config.js');
    const cookie = await import('../src/services/sessionCookie.js');
    const token = cookie.createSessionToken();
    expect(cookie.verifySessionToken(token)).toBe(true);

    // Changing ENCRYPTION_KEY does not affect the signature; changing API_SECRET does.
    const original = { ...config };
    config.encryptionKey = 'f'.repeat(64);
    expect(cookie.verifySessionToken(token)).toBe(true);
    config.apiSecret = 'a-different-secret';
    expect(cookie.verifySessionToken(token)).toBe(false);
    Object.assign(config, original);
  });
});
