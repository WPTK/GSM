import fs from 'node:fs';

/** The four secrets the server refuses to start without. Each also has a `<NAME>_FILE` variant. */
export const REQUIRED_SECRETS = ['API_SECRET', 'ENCRYPTION_KEY', 'ANTHROPIC_API_KEY', 'GITHUB_TOKEN'] as const;
export type RequiredSecret = (typeof REQUIRED_SECRETS)[number];

type Env = Record<string, string | undefined>;

/**
 * Read one secret. When `NAME_FILE` is set and non-empty, the file wins over `NAME`: its trimmed
 * contents are the value. If the file is unreadable or empty the secret counts as missing; there is
 * no fallback to the plain variable (a broken secret mount must fail loudly, not run on a stale
 * value). Without `NAME_FILE`, `NAME` is used. Neither the path nor the value is ever logged.
 */
export function readSecret(name: string, env: Env = process.env): string | null {
  const file = env[`${name}_FILE`]?.trim();
  if (file) {
    try {
      return fs.readFileSync(file, 'utf8').trim() || null;
    } catch {
      return null; // Unreadable file = missing; the path is not logged.
    }
  }
  return env[name]?.trim() || null;
}
/** Names (only) of the required secrets that are not set. */
export function missingSecrets(env: Env = process.env): RequiredSecret[] {
  return REQUIRED_SECRETS.filter((name) => readSecret(name, env) === null);
}

/** The single startup error line for a non-empty missing list. Names only. */
export function missingSecretsMessage(missing: readonly string[]): string {
  return `Refusing to start: missing required secret(s): ${missing.join(', ')} (set each, or its _FILE variant)`;
}
