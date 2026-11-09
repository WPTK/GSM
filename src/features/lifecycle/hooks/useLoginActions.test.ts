import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  apiTokens: [] as string[],
  getCurrentUser: vi.fn(),
  syncFromBackend: vi.fn(),
  backend: {
    init: vi.fn(),
    isAvailable: true,
    login: vi.fn(),
    authStatus: vi.fn(),
  },
}));

vi.mock('../../../services/githubApi', () => ({
  GITHUB_TOKEN_INVALID_ERROR: 'GitHub token expired or invalid',
  GitHubApiService: class {
    constructor(token: string) {
      mocks.apiTokens.push(token);
    }

    getCurrentUser() {
      return mocks.getCurrentUser();
    }
  },
}));
vi.mock('../../../services/backendAdapter', () => ({ backend: mocks.backend }));
vi.mock('../../../services/autoSync', () => ({ syncFromBackend: mocks.syncFromBackend }));

import { useLoginActions } from './useLoginActions';

const user = { id: 1, login: 'octocat' };

describe('useLoginActions.loginWithApiSecret', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.apiTokens.splice(0);
    mocks.backend.init.mockReset();
    mocks.backend.isAvailable = true;
    mocks.backend.login.mockResolvedValue(true);
    mocks.backend.authStatus.mockResolvedValue({ authenticated: true, githubConfigured: true });
    mocks.getCurrentUser.mockResolvedValue(user);
  });

  it('logs in with the secret and returns the server-held identity with the placeholder token', async () => {
    const { result } = renderHook(() => useLoginActions());

    let outcome;
    await act(async () => {
      outcome = await result.current.loginWithApiSecret('s3cret');
    });

    expect(mocks.backend.login).toHaveBeenCalledWith('s3cret');
    expect(mocks.apiTokens).toEqual(['server']);
    expect(outcome).toEqual({ status: 'connected', githubToken: 'server', user });
  });

  it('probes the backend first when it has not been initialised', async () => {
    mocks.backend.isAvailable = false;
    mocks.backend.init.mockImplementation(async () => { mocks.backend.isAvailable = true; });
    const { result } = renderHook(() => useLoginActions());

    await act(async () => {
      await result.current.loginWithApiSecret('s3cret');
    });

    expect(mocks.backend.init).toHaveBeenCalledOnce();
    expect(mocks.backend.login).toHaveBeenCalledOnce();
  });

  it('reports an unreachable backend without attempting login', async () => {
    mocks.backend.isAvailable = false;
    const { result } = renderHook(() => useLoginActions());

    let outcome;
    await act(async () => {
      outcome = await result.current.loginWithApiSecret('s3cret');
    });

    expect(outcome).toEqual({ status: 'backend-unavailable' });
    expect(mocks.backend.login).not.toHaveBeenCalled();
  });

  it('reports a rejected secret', async () => {
    mocks.backend.login.mockResolvedValue(false);
    const { result } = renderHook(() => useLoginActions());

    let outcome;
    await act(async () => {
      outcome = await result.current.loginWithApiSecret('wrong');
    });

    expect(outcome).toEqual({ status: 'unauthorized' });
    expect(mocks.backend.authStatus).not.toHaveBeenCalled();
  });

  it('reports a server without a GitHub token', async () => {
    mocks.backend.authStatus.mockResolvedValue({ authenticated: true, githubConfigured: false });
    const { result } = renderHook(() => useLoginActions());

    let outcome;
    await act(async () => {
      outcome = await result.current.loginWithApiSecret('s3cret');
    });

    expect(outcome).toEqual({ status: 'github-not-configured' });
    expect(mocks.getCurrentUser).not.toHaveBeenCalled();
  });

  it('reports an invalid server-held GitHub token', async () => {
    mocks.getCurrentUser.mockRejectedValue(new Error('GitHub token expired or invalid'));
    const { result } = renderHook(() => useLoginActions());

    let outcome;
    await act(async () => {
      outcome = await result.current.loginWithApiSecret('s3cret');
    });

    expect(outcome).toEqual({ status: 'github-token-invalid' });
  });

  it('propagates transient GitHub errors so the user can retry', async () => {
    mocks.getCurrentUser.mockRejectedValue(new Error('network down'));
    const { result } = renderHook(() => useLoginActions());

    await act(async () => {
      await expect(result.current.loginWithApiSecret('s3cret')).rejects.toThrow('network down');
    });
  });

  it('syncs backend data with force', async () => {
    const { result } = renderHook(() => useLoginActions());
    await act(async () => {
      await result.current.syncBackendData();
    });
    expect(mocks.syncFromBackend).toHaveBeenCalledWith({ force: true });
  });
});
