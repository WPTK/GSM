import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  isAvailable: true,
  logout: vi.fn(async () => {}),
  authStatus: vi.fn(),
}));

vi.mock('./backendAdapter', () => ({
  backend: {
    get isAvailable() { return mocks.isAvailable; },
    logout: mocks.logout,
    authStatus: mocks.authStatus,
  },
}));

vi.mock('../store/useAppStore', async () => vi.importActual('../store/useAppStore'));

import { useAppStore } from '../store/useAppStore';
import { getSessionExpiredNotice, handleSessionExpired, logoutSession } from './session';
import { tryRestoreAuthFromBackend } from './autoSync';
import { notifySessionExpired, SESSION_EXPIRED_EVENT } from './sessionEvents';

const user = { id: 1, login: 'octo', name: 'Octo', avatar_url: 'https://x/a.png', email: null };

const signIn = () => {
  useAppStore.getState().setGitHubToken('server');
  useAppStore.getState().setUser(user);
};

describe('single logout path', () => {
  beforeEach(() => {
    mocks.logout.mockClear();
    mocks.authStatus.mockReset();
    mocks.isAvailable = true;
    useAppStore.getState().logout();
    window.localStorage.clear();
  });

  it('sends the DELETE (backend.logout) and then clears the identity', async () => {
    signIn();
    const order: string[] = [];
    mocks.logout.mockImplementationOnce(async () => { order.push('delete'); });
    await logoutSession();
    order.push(useAppStore.getState().user ? 'still-signed-in' : 'cleared');
    expect(order).toEqual(['delete', 'cleared']);
    expect(useAppStore.getState().githubToken).toBeNull();
    expect(getSessionExpiredNotice()).toBe(false);
  });

  it('erases legacy storage keys on logout', async () => {
    window.localStorage.setItem('github-stars-manager-backend-url', 'http://old');
    window.localStorage.setItem('github-stars-manager-auth', '{}');
    signIn();
    await logoutSession();
    expect(window.localStorage.getItem('github-stars-manager-backend-url')).toBeNull();
    expect(window.localStorage.getItem('github-stars-manager-auth')).toBeNull();
  });

  it('after logout a reload does not silently sign back in', async () => {
    signIn();
    await logoutSession();
    mocks.authStatus.mockResolvedValue({ authenticated: false, githubConfigured: true });
    expect(await tryRestoreAuthFromBackend()).toBe(false);
    expect(useAppStore.getState().user).toBeNull();
  });

  it('bootstrap signs out a stored user whose cookie is gone and flags the expiry', async () => {
    signIn();
    mocks.authStatus.mockResolvedValue({ authenticated: false, githubConfigured: true });
    await tryRestoreAuthFromBackend();
    expect(useAppStore.getState().user).toBeNull();
    expect(mocks.logout).toHaveBeenCalledTimes(1);
    expect(getSessionExpiredNotice()).toBe(true);
  });

  it('bootstrap keeps a stored user whose cookie is valid, and when the status call fails', async () => {
    signIn();
    mocks.authStatus.mockResolvedValue({ authenticated: true, githubConfigured: true });
    await tryRestoreAuthFromBackend();
    expect(useAppStore.getState().user).not.toBeNull();
    mocks.authStatus.mockResolvedValue(null);
    await tryRestoreAuthFromBackend();
    expect(useAppStore.getState().user).not.toBeNull();
    expect(mocks.logout).not.toHaveBeenCalled();
  });

  it('a 401 UNAUTHORIZED event leads to the same logout; with nobody signed in it does nothing', async () => {
    await handleSessionExpired();
    expect(mocks.logout).not.toHaveBeenCalled();
    signIn();
    const seen = vi.fn();
    window.addEventListener(SESSION_EXPIRED_EVENT, seen);
    notifySessionExpired();
    window.removeEventListener(SESSION_EXPIRED_EVENT, seen);
    expect(seen).toHaveBeenCalled();
    await handleSessionExpired();
    expect(useAppStore.getState().user).toBeNull();
    expect(getSessionExpiredNotice()).toBe(true);
  });
});
