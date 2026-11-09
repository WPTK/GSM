import { describe, expect, it } from 'vitest';
import { AI_LANGUAGES } from '../../src/ai/contract.js';
import { buildAnalysisPrefix, buildRepoMessage, cleanCustomPrompt } from '../../src/ai/prompts.js';

const categories = [
  { name: 'Dev Tools', keywords: ['cli', 'compiler'] },
  { name: 'Media', keywords: [] },
];
const repo = { fullName: 'octo/cat', description: 'A cat tracker', language: 'TypeScript', topics: ['cats', 'tracker'], stars: 42 };

describe('analysis prompts', () => {
  it('matches the stored snapshot for every language variant', async () => {
    const out: Record<string, { prefix: string; message: string }> = {};
    for (const lang of AI_LANGUAGES) {
      out[lang] = { prefix: buildAnalysisPrefix(lang, categories, 'Prefer short tags'), message: buildRepoMessage(lang, repo, 'x'.repeat(2500)) };
    }
    await expect(JSON.stringify(out, null, 2) + '\n').toMatchFileSnapshot('./prompts.snapshot.json');
  });

  it('the category list and the custom prompt are in the prefix, the repo is not', () => {
    const prefix = buildAnalysisPrefix('en', categories, 'Prefer short tags');
    expect(prefix).toContain('- Dev Tools: cli, compiler');
    expect(prefix).toContain('Prefer short tags');
    expect(prefix).not.toContain('octo/cat');
  });

  it('truncates the README at the cap and wraps untrusted text', () => {
    const msg = buildRepoMessage('en', repo, 'Q'.repeat(5000));
    expect(msg.match(/Q/g)?.length).toBe(2000);
    expect(msg).toContain('<readme>');
  });

  it('cleans legacy placeholders from the custom prompt', () => {
    expect(cleanCustomPrompt('Use {LANGUAGE}. {REPO_INFO}{CATEGORIES_INFO} {CATEGORIES_HINT}done', 'fr')).toBe('Use fr.  done');
  });
});

