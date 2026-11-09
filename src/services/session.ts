import { backend } from './backendAdapter';
import { useAppStore } from '../store/useAppStore';

let expiredNotice = false;
const listeners = new Set<() => void>();

const emit = () => { for (const l of listeners) l(); };

/** True after the app signed the user out because the server session was gone. */
export const getSessionExpiredNotice = (): boolean => expiredNotice;
export const subscribeSessionExpiredNotice = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
export const clearSessionExpiredNotice = (): void => {
  if (!expiredNotice) return;
  expiredNotice = false;
  emit();
};

let inFlight: Promise<void> | null = null;

/**
 * The one logout. Ends the server session (DELETE /api/auth/session, which
 * clears the HttpOnly cookie), then clears the identity from the store and any
 * legacy browser storage. Every logout path (header, settings, clear-all,
 * expiry) goes through here, otherwise the still-valid cookie would sign the
 * user straight back in on the next load.
 */
export function logoutSession(options: { expired?: boolean } = {}): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      await backend.logout();
    } catch (error) {
      console.warn('Logout request failed:', error);
    }
    useAppStore.getState().logout();
    expiredNotice = options.expired === true;
    emit();
  })().finally(() => { inFlight = null; });
  return inFlight;
}

/** A proxy call came back 401 UNAUTHORIZED: the cookie is expired or revoked. */
export function handleSessionExpired(): Promise<void> {
  if (!useAppStore.getState().user) return Promise.resolve();
  return logoutSession({ expired: true });
}
