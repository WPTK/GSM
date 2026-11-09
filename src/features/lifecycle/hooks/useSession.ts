import { useSyncExternalStore } from 'react';
import {
  clearSessionExpiredNotice,
  getSessionExpiredNotice,
  logoutSession,
  subscribeSessionExpiredNotice,
} from '../../../services/session';

/** Single logout entry point for views: ends the server session, then clears local identity. */
export const useLogout = (): (() => Promise<void>) => logoutSession;

/** True when the user was signed out because the server session expired; `dismiss` clears it. */
export const useSessionExpiredNotice = (): { expired: boolean; dismiss: () => void } => {
  const expired = useSyncExternalStore(subscribeSessionExpiredNotice, getSessionExpiredNotice, () => false);
  return { expired, dismiss: clearSessionExpiredNotice };
};
