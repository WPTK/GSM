const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const composeFile = path.join(root, 'deploy', 'compose.yaml');
const compose = fs.readFileSync(composeFile, 'utf8');

test('compose forwards CSP_UPGRADE_INSECURE_REQUESTS with a safe default', () => {
  assert.match(
    compose,
    /^  gsm:\r?\n(?:(?!^  \S)[\s\S])*?^    environment:\r?\n(?:(?!^    \S)[\s\S])*?^      CSP_UPGRADE_INSECURE_REQUESTS:\s*\$\{CSP_UPGRADE_INSECURE_REQUESTS:-true\}\r?$/m,
    'the gsm service must pass the variable through and default it to true'
  );
});

test('no tracked deploy, compose or Docker file references the upstream registry', () => {
  const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
    .split(/\r?\n/)
    .filter((f) => /^(deploy\/|Dockerfile|DOCKER|docker-compose|\.env)/i.test(f));
  assert.ok(tracked.includes('deploy/compose.yaml'));
  for (const file of tracked) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    assert.ok(!/ghcr\.io\/amintacccp/i.test(text), `${file} must not reference ghcr.io/amintacccp`);
  }
});

test('the four required variables fail closed with :? and no default', () => {
  for (const name of ['API_SECRET', 'ENCRYPTION_KEY', 'ANTHROPIC_API_KEY', 'GITHUB_TOKEN']) {
    assert.match(compose, new RegExp(`^      ${name}: \\$\\{${name}:\\?[^}]+\\}\\s*$`, 'm'), `${name} must use \${${name}:?message}`);
  }
});

test('the container is locked down', () => {
  assert.match(compose, /^    read_only: true\s*$/m);
  assert.match(compose, /^    tmpfs:\r?\n      - \/tmp\s*$/m);
  assert.match(compose, /^    cap_drop:\r?\n      - ALL\s*$/m);
  assert.match(compose, /no-new-privileges:true/);
  assert.match(compose, /^    init: true\s*$/m);
  assert.match(compose, /^    restart: unless-stopped\s*$/m);
  assert.match(compose, /^    mem_limit: \S+/m);
  assert.match(compose, /^    pids_limit: \d+/m);
  assert.match(compose, /driver: json-file/);
  assert.match(compose, /max-size: 10m/);
  assert.match(compose, /max-file: "3"/);
  assert.match(compose, /gsm-data:\/app\/data/);
});

test('the port is published on 127.0.0.1 only', () => {
  const ports = [...compose.matchAll(/^      - "([^"]+:\d+)"\s*$/gm)].map((m) => m[1]);
  assert.ok(ports.length > 0, 'a port must be published');
  for (const p of ports) {
    assert.match(p, /^127\.0\.0\.1:/, `port mapping ${p} must bind to 127.0.0.1`);
  }
});
