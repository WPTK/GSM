// Harmless fixed fake values so modules that load config.ts work without a real
// environment. Each is set only when unset, and none looks like a real credential.
// (The server refuses to start without these four; see src/preflight.ts.)
const FAKES: Record<string, string> = {
  API_SECRET: 'test-api-secret',
  ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  ANTHROPIC_API_KEY: 'sk-abcdef123456789012345678',
  GITHUB_TOKEN: 'value-token-123456',
};

for (const [name, value] of Object.entries(FAKES)) {
  if (!process.env[name] && !process.env[`${name}_FILE`]) process.env[name] = value;
}
