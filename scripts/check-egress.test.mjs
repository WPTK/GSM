import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { extractHosts, findViolations, parseAllowlist } from './check-egress.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'check-egress.mjs');

test('extractHosts finds http, https and ws hosts, lower-cased, without ports or paths', () => {
  const hosts = extractHosts(
    'fetch("https://API.GitHub.com/user?x=1"); a="http://127.0.0.1:3000/x"; w="wss://Sock.Example.org:8443/s"; b="https://${host}/a"',
  );
  assert.deepEqual([...hosts].sort(), ['127.0.0.1', 'api.github.com', 'sock.example.org']);
});

test('extractHosts ignores bare words and protocol fragments', () => {
  assert.equal(extractHosts('"https://" + x; "http://localhostish"').size, 0);
  assert.deepEqual([...extractHosts('http://localhost:5173/')], ['localhost']);
});

test('parseAllowlist skips sections and comments and lower-cases hosts', () => {
  const allowed = parseAllowlist('[runtime]\nApi.GitHub.com  # trailing\n# full comment\n\n[link-outs]\ngithub.com\n');
  assert.deepEqual([...allowed].sort(), ['api.github.com', 'github.com']);
});

test('findViolations reports unlisted hosts with their files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egress-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.js'), 'x("https://api.github.com/a"); y("https://tracker.example.net/p")');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'https://ignored.example.com');
    const result = findViolations([dir], new Set(['api.github.com']), dir);
    assert.deepEqual([...result.keys()], ['tracker.example.net']);
    assert.deepEqual([...result.get('tracker.example.net')], ['a.js']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI exits 1 on a violation and 0 when the host is allowed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egress-cli-'));
  try {
    const dist = path.join(dir, 'dist');
    fs.mkdirSync(dist);
    fs.writeFileSync(path.join(dist, 'a.js'), 'fetch("https://tracker.example.net/p")');
    const list = path.join(dir, 'allow.txt');

    fs.writeFileSync(list, '[runtime]\napi.github.com\n');
    const bad = spawnSync(process.execPath, [SCRIPT, '--allowlist', list, dist], { encoding: 'utf8' });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /tracker\.example\.net/);

    fs.writeFileSync(list, '[runtime]\ntracker.example.net\n');
    const good = spawnSync(process.execPath, [SCRIPT, '--allowlist', list, dist], { encoding: 'utf8' });
    assert.equal(good.status, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI fails when the build directory is missing', () => {
  const result = spawnSync(process.execPath, [SCRIPT, path.join(os.tmpdir(), 'no-such-dist-dir-xyz')], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /build first/);
});
