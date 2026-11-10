import fs from 'node:fs';

/** The four secrets the server refuses to start without. Each also has a `<NAME>_FILE` variant. */
export const REQUIRED_SECRETS = ['API_SECRET', 'ENCRYPTION_KEY', 'ANTHROPIC_API_KEY', 'GITHUB_TOKEN'] as const;
export type RequiredSecret = (typeof REQUIRED_SECRETS)[number];

type Env = Record<string, string | undefined>;

/**
 * Read one secret from `NAME`, else from the file named by `NAME_FILE` (trimmed).
 * An unreadable or empty file counts as missing. Neither the path nor the value is ever logged.
 */
export function readSecret(name: string, env: Env = process.env): string | null {
  const direct = env[name]?.trim();
  if (direct) return direct;

  const file = env[`${name}_FILE`]?.trim();
  if (file) {
    try {
      const fromFile = fs.readFileSync(file, 'utf8').trim();
      if (fromFile) return fromFile;
    } catch {
      // Unreadable file = missing; the path is not logged.
    }
  }
  return null;
}

/** Names (only) of the required secrets that are not set. */
export function missingSecrets(env: Env = process.env): RequiredSecret[] {
  return REQUIRED_SECRETS.filter((name) => readSecret(name, env) === null);
}

/** The single startup error line for a non-empty missing list. Names only. */
export function missingSecretsMessage(missing: readonly string[]): string {
  return `Refusing to start: missing required secret(s): ${missing.join(', ')} (set each, or its _FILE variant)`;
}
