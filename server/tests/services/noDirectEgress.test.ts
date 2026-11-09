import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src');
const CENTRAL = path.join(SRC, 'services', 'proxyService.ts');

function listTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTs(full));
    else if (/\.(ts|js|mjs|cjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const FORBIDDEN: Array<[string, RegExp]> = [
  ['global fetch()', /(?<![\w.$])fetch\s*\(/],
  ['axios import', /from\s+['"]axios['"]|require\(\s*['"]axios['"]\s*\)/],
  ['http/https import', /from\s+['"](?:node:)?https?['"]|require\(\s*['"](?:node:)?https?['"]\s*\)/],
  ['net/tls socket', /from\s+['"](?:node:)?(?:net|tls|http2)['"]/],
  ['undici/node-fetch/got', /from\s+['"](?:undici|node-fetch|got|superagent|ky)['"]/],
  ['XMLHttpRequest/WebSocket', /\b(?:XMLHttpRequest|new\s+WebSocket)\b/],
];

describe('central egress', () => {
  it('only proxyService makes outbound network calls in server/src', () => {
    const offenders: string[] = [];
    for (const file of listTs(SRC)) {
      if (file === CENTRAL) continue;
      const code = stripComments(fs.readFileSync(file, 'utf8'));
      for (const [label, re] of FORBIDDEN) {
        if (re.test(code)) offenders.push(`${path.relative(SRC, file)}: ${label}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('proxyService is the one place that imports axios', () => {
    const code = stripComments(fs.readFileSync(CENTRAL, 'utf8'));
    expect(code).toMatch(/from\s+['"]axios['"]/);
  });
});
