// Must be the FIRST import of index.ts: ES imports evaluate in order, so this runs
// before config.ts and anything else that needs the secrets.
import { missingSecrets, missingSecretsMessage } from './secrets.js';

/** Exit 1 with one line naming every missing secret (names only), or return. */
export function runPreflight(
  env: Record<string, string | undefined> = process.env,
  exit: (code: number) => void = process.exit,
): void {
  const missing = missingSecrets(env);
  if (missing.length === 0) return;
  console.error(missingSecretsMessage(missing));
  exit(1);
}

// The vitest suite imports index.ts for createApp() with partial environments;
// the check itself is covered by calling runPreflight() with an env object.
if (!process.env.VITEST) {
  runPreflight();
}
