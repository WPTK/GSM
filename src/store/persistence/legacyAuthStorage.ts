/**
 * Older builds kept the GitHub token, backend API secret and backend URL in browser storage.
 * The browser now authenticates with an HttpOnly session cookie only, so these
 * keys are erased on hydration and on logout. Nothing here ever writes them.
 */
const LEGACY_KEYS = [
  'github-stars-manager-auth',
  'github-stars-manager-backend-secret',
  'github-stars-manager-backend-url',
] as const;

export const purgeLegacyAuthStorage = (): void => {
  if (typeof window === 'undefined') return;
  for (const area of ['localStorage', 'sessionStorage'] as const) {
    try {
      for (const key of LEGACY_KEYS) window[area].removeItem(key);
    } catch {
      // Storage may be blocked; there is nothing to erase then.
    }
  }
};
