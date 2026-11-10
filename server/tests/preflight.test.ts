import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REQUIRED_SECRETS, missingSecrets, missingSecretsMessage, readSecret } from '../src/secrets.js';
import { runPreflight } from '../src/preflight.js';

const FAKE: Record<string, string> = {
  API_SECRET: 'test-api-secret',
  ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  ANTHROPIC_API_KEY: 'sk-abcdef123456789012345678',
  GITHUB_TOKEN: 'value-token-123456',
};

describe('preflight: required secrets', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsm-secrets-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('passes with all four set', () => {
    expect(missingSecrets(FAKE)).toEqual([]);
  });

  for (const name of REQUIRED_SECRETS) {
    it(`reports ${name} when missing, and exits 1 without leaking the other values`, () => {
      const env = { ...FAKE };
      delete env[name];
      expect(missingSecrets(env)).toEqual([name]);

      const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const exit = vi.fn();
      runPreflight(env, exit);
      expect(exit).toHaveBeenCalledWith(1);
      const line = String(err.mock.calls[0][0]);
      expect(line).toContain(name);
      for (const v of Object.values(FAKE)) expect(line).not.toContain(v);
      err.mockRestore();
    });

    it(`accepts ${name}_FILE (trimmed)`, () => {
      const file = path.join(dir, `${name}.txt`);
      fs.writeFileSync(file, `  ${FAKE[name]}\n`);
      const env: Record<string, string | undefined> = { ...FAKE, [`${name}_FILE`]: file };
      delete env[name];
      expect(missingSecrets(env)).toEqual([]);
      expect(readSecret(name, env)).toBe(FAKE[name]);
    });

    it(`treats an empty or unreadable ${name}_FILE as missing, and never reports the path`, () => {
      const empty = path.join(dir, 'empty.txt');
      fs.writeFileSync(empty, '  \n');
      const gone = path.join(dir, 'does-not-exist.txt');
      for (const file of [empty, gone]) {
        const env: Record<string, string | undefined> = { ...FAKE, [`${name}_FILE`]: file };
        delete env[name];
        expect(missingSecrets(env)).toEqual([name]);
        const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        runPreflight(env, vi.fn());
        expect(String(err.mock.calls[0][0])).not.toContain(file);
        err.mockRestore();
      }
    });
  }

  it('names every missing variable in one line', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exit = vi.fn();
    runPreflight({}, exit);
    expect(exit).toHaveBeenCalledWith(1);
    expect(err).toHaveBeenCalledTimes(1);
    const line = String(err.mock.calls[0][0]);
    expect(line).not.toContain('\n');
    for (const name of REQUIRED_SECRETS) expect(line).toContain(name);
    expect(line).toBe(missingSecretsMessage([...REQUIRED_SECRETS]));
    err.mockRestore();
  });

  it('does not exit when nothing is missing', () => {
    const exit = vi.fn();
    runPreflight(FAKE, exit);
    expect(exit).not.toHaveBeenCalled();
  });
});
