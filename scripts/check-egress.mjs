#!/usr/bin/env node
// Fails when the built frontend (dist/) or server (server/dist/) mention a URL
// host that is not listed in docs/hardening/egress-allowlist.txt.
//
// The allowlist is a plain text file. `[section]` lines group hosts by why they
// appear; every host in every section is accepted. `#` starts a comment.
// Usage: node scripts/check-egress.mjs [--allowlist file] [dir ...]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_ALLOWLIST = path.join(ROOT, 'docs', 'hardening', 'egress-allowlist.txt');
const DEFAULT_DIRS = [path.join(ROOT, 'dist'), path.join(ROOT, 'server', 'dist')];
const SCANNED_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.html', '.css', '.json', '.svg', '.map']);

const URL_HOST_PATTERN = /\b(?:https?|wss?):\/\/([a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)(?::\d+)?/gi;

/** Hosts mentioned as absolute http(s)/ws(s) URLs in a text blob, lower-cased. */
export function extractHosts(text) {
  const hosts = new Set();
  for (const match of text.matchAll(URL_HOST_PATTERN)) {
    const host = match[1].toLowerCase().replace(/\.+$/, '');
    // Skip fragments such as "http://" followed by a template placeholder.
    if (host.length > 0 && (host.includes('.') || host === 'localhost')) hosts.add(host);
  }
  return hosts;
}

/** Parses the allowlist file into a Set of exact lower-case hosts. */
export function parseAllowlist(text) {
  const hosts = new Set();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line || /^\[[^\]]+\]$/.test(line)) continue;
    hosts.add(line.toLowerCase());
  }
  return hosts;
}

function* walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (SCANNED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) yield full;
  }
}

/** Returns Map<host, Set<relative file>> for every host not on the allowlist. */
export function findViolations(dirs, allowed, baseDir = ROOT) {
  const violations = new Map();
  for (const dir of dirs) {
    for (const file of walk(dir)) {
      for (const host of extractHosts(fs.readFileSync(file, 'utf8'))) {
        if (allowed.has(host)) continue;
        if (!violations.has(host)) violations.set(host, new Set());
        violations.get(host).add(path.relative(baseDir, file).split(path.sep).join('/'));
      }
    }
  }
  return violations;
}

function main(argv) {
  let allowlistFile = DEFAULT_ALLOWLIST;
  const dirs = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--allowlist') allowlistFile = path.resolve(argv[++i]);
    else dirs.push(path.resolve(argv[i]));
  }
  const targets = dirs.length > 0 ? dirs : DEFAULT_DIRS;

  const missing = targets.filter((dir) => !fs.existsSync(dir));
  if (missing.length > 0) {
    console.error(`check:egress: nothing to scan, build first (missing ${missing.map((d) => path.relative(ROOT, d)).join(', ')}).`);
    return 1;
  }

  const allowed = parseAllowlist(fs.readFileSync(allowlistFile, 'utf8'));
  const violations = findViolations(targets, allowed);
  if (violations.size === 0) {
    console.log(`check:egress: ok, every URL host in the build is on the allowlist (${allowed.size} hosts).`);
    return 0;
  }

  console.error(`check:egress: ${violations.size} host(s) in the build are not on the allowlist:`);
  for (const host of [...violations.keys()].sort()) {
    const files = [...violations.get(host)].sort();
    const shown = files.slice(0, 3).join(', ') + (files.length > 3 ? `, +${files.length - 3} more` : '');
    console.error(`  ${host}  (${shown})`);
  }
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
