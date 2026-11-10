import { missingSecrets, missingSecretsMessage } from './secrets.js';

/**
 * Exit 1 with one line naming every missing secret (names only), or return.
 * Called first thing in startServer(), before any database is opened or any port is bound.
 * (API_SECRET and ENCRYPTION_KEY also fail fast at import time, in config.ts.)
 */
export function runPreflight(
  env: Record<string, string | undefined> = process.env,
  exit: (code: number) => void = process.exit,
): void {
  const missing = missingSecrets(env);
  if (missing.length === 0) return;
  console.error(missingSecretsMessage(missing));
  exit(1);
}
