import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../store/useAppStore', () => ({
  useAppStore: { getState: () => ({ translationEngine: 'microsoft', language: 'zh' }) },
}));
vi.mock('./aiService', () => ({ AIService: vi.fn() }));

import { TRANSLATE_REQUEST_LIMIT_BYTES, translateBatch, translateText, utf8ByteLength } from './translateService';

describe('translate request size limit', () => {
  it('matches the relay limit in server/src/routes/egress.ts', () => {
    const source = readFileSync(resolve(__dirname, '../../server/src/routes/egress.ts'), 'utf8');
    const match = source.match(/TRANSLATE_BODY_LIMIT_BYTES\s*=\s*(\d+)\s*\*\s*1024/);
    expect(match).not.toBeNull();
    expect(Number(match![1]) * 1024).toBe(TRANSLATE_REQUEST_LIMIT_BYTES);
  });

  describe('large CJK input', () => {
    let bodies: string[];

    beforeEach(() => {
      bodies = [];
      vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
        const body = String(init.body);
        bodies.push(body);
        const items = JSON.parse(body) as unknown[];
        return {
          ok: true,
          status: 200,
          json: async () => items.map((item) => ({ translations: [{ text: typeof item === 'string' ? item : 'x' }] })),
        } as unknown as Response;
      }));
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('never sends a body over the relay limit for a 30k-character CJK README', async () => {
      const paragraph = '这是一个用于测试的中文段落，包含“引号”和换行。'.repeat(10);
      const readme = Array.from({ length: 100 }, () => paragraph).join('\n');
      expect(readme.length).toBeGreaterThan(20000);
      expect(utf8ByteLength(readme)).toBeGreaterThan(TRANSLATE_REQUEST_LIMIT_BYTES);

      const result = await translateText({ text: readme, to: 'en' });

      expect(bodies.length).toBeGreaterThan(1);
      for (const body of bodies) {
        expect(utf8ByteLength(body)).toBeLessThanOrEqual(TRANSLATE_REQUEST_LIMIT_BYTES);
      }
      expect(result.translatedText.replace(/\n/g, '')).toBe(readme.replace(/\n/g, ''));
    });

    it('splits a batch of many CJK segments across requests under the limit and keeps the order', async () => {
      const texts = Array.from({ length: 80 }, (_, i) => `第${i}段：` + '汉字'.repeat(400));
      const results = await translateBatch(texts, 'en');
      expect(results.map((r) => r.translatedText)).toEqual(texts);
      expect(bodies.length).toBeGreaterThan(1);
      for (const body of bodies) {
        expect(utf8ByteLength(body)).toBeLessThanOrEqual(TRANSLATE_REQUEST_LIMIT_BYTES);
      }
    });
  });
});
