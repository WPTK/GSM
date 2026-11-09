import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getAnthropicKey, getModels, getSpendConfirmUsd, keySuffix, resetClaudeConfigForTests, isConnected, markModelsVerified,
} from '../../src/ai/claudeConfig.js';
import { ClaudeStartupError, validateModels, validateModelsOrExit } from '../../src/ai/startup.js';
import { logger } from '../../src/services/logger.js';
import { makeFakeClient, resetAiEnv, HttpError } from './helpers.js';

const SECRET = 'sk-ant-api03-SECRETVALUE-7f3a';

describe('claude config', () => {
  beforeEach(() => { resetAiEnv(); resetClaudeConfigForTests(); });
  afterEach(() => { resetAiEnv(); resetClaudeConfigForTests(); });

  it('reads the key from ANTHROPIC_API_KEY', () => {
    process.env.ANTHROPIC_API_KEY = SECRET;
    expect(getAnthropicKey()).toBe(SECRET);
  });

  it('reads the key from ANTHROPIC_API_KEY_FILE', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gsm-key-')), 'key');
    fs.writeFileSync(file, `${SECRET}\n`);
    process.env.ANTHROPIC_API_KEY_FILE = file;
    expect(getAnthropicKey()).toBe(SECRET);
  });

  it('keySuffix returns only the last 4 characters', () => {
    process.env.ANTHROPIC_API_KEY = SECRET;
    expect(keySuffix()).toBe('7f3a');
    expect(keySuffix()).toHaveLength(4);
  });

  it('has the documented defaults', () => {
    expect(getModels()).toEqual({ bulk: 'claude-haiku-5-5', chat: 'claude-sonnet-5-5' });
    expect(getSpendConfirmUsd()).toBe(2);
    process.env.AI_SPEND_CONFIRM_USD = '5.5';
    expect(getSpendConfirmUsd()).toBe(5.5);
  });
});

describe('startup validation', () => {
  beforeEach(() => { resetAiEnv(); resetClaudeConfigForTests(); });
  afterEach(() => { resetAiEnv(); resetClaudeConfigForTests(); vi.restoreAllMocks(); });

  it('refuses to start without a key', async () => {
    await expect(validateModels(makeFakeClient())).rejects.toThrow(ClaudeStartupError);
    expect(isConnected()).toBe(false);
  });

  it('exits 1 with one clear line that does not contain the key', async () => {
    process.env.ANTHROPIC_API_KEY = SECRET;
    const fake = makeFakeClient();
    fake.impl.modelsRetrieve = () => { throw new HttpError(404, 'model: claude-haiku-5-5'); };
    const errors: string[] = [];
    vi.spyOn(logger, 'error').mockImplementation((_m: string, msg: string) => { errors.push(msg); });
    const exit = vi.fn((code: number) => { throw new Error(`exit ${code}`); }) as unknown as (c: number) => never;
    const real = await import('../../src/ai/client.js');
    real.setAnthropicClientForTests(fake);
    await expect(validateModelsOrExit(exit)).rejects.toThrow('exit 1');
    real.setAnthropicClientForTests(null);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('CLAUDE_MODEL_BULK=claude-haiku-5-5');
    expect(errors[0]).not.toContain('SECRETVALUE');
  });

  it('refuses to start when the chat model is missing', async () => {
    process.env.ANTHROPIC_API_KEY = SECRET;
    const fake = makeFakeClient();
    fake.impl.modelsRetrieve = (id: string) => {
      if (id === 'claude-sonnet-5-5') throw new HttpError(404, 'not found');
      return { id };
    };
    await expect(validateModels(fake)).rejects.toThrow(/CLAUDE_MODEL_CHAT=claude-sonnet-5-5/);
    expect(isConnected()).toBe(false);
  });

  it('refuses a bulk model without a pricing entry', async () => {
    process.env.ANTHROPIC_API_KEY = SECRET;
    process.env.CLAUDE_MODEL_BULK = 'claude-unpriced-9';
    await expect(validateModels(makeFakeClient())).rejects.toThrow(/pricing/);
  });

  it('checks both models and marks the server connected', async () => {
    process.env.ANTHROPIC_API_KEY = SECRET;
    const fake = makeFakeClient();
    await validateModels(fake);
    expect(fake.calls.modelsRetrieve.sort()).toEqual(['claude-haiku-5-5', 'claude-sonnet-5-5']);
    expect(isConnected()).toBe(true);
    markModelsVerified(false);
  });
});
