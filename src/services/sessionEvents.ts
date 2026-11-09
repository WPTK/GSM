/**
 * Leaf module (no imports) so low-level API clients can report an expired or
 * rejected session without depending on the store. The lifecycle hook listens
 * and routes the app back to the login screen.
 */
export const SESSION_EXPIRED_EVENT = 'gsm:session-expired';

export function notifySessionExpired(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
}
