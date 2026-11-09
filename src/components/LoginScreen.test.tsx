import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from './ui/tooltip';

const mocks = vi.hoisted(() => ({
  safeReadText: vi.fn(),
  loginWithApiSecret: vi.fn(),
  syncBackendData: vi.fn(),
  store: {
    setUser: vi.fn(),
    setGitHubToken: vi.fn(),
    accountWorkspaces: {} as Record<string, unknown>,
  },
}));

vi.mock('../utils/clipboardUtils', () => ({ safeReadText: mocks.safeReadText }));
vi.mock('../features/lifecycle/hooks/useLoginActions', () => ({
  useLoginActions: () => ({
    loginWithApiSecret: mocks.loginWithApiSecret,
    syncBackendData: mocks.syncBackendData,
  }),
}));
vi.mock('../store/useAppStore', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      setUser: mocks.store.setUser,
      setGitHubToken: mocks.store.setGitHubToken,
      repositories: [],
      gists: [],
      releases: [],
      forks: [],
      customCategories: [],
      categoryOrder: [],
      hiddenDefaultCategoryIds: [],
      defaultCategoryOverrides: {},
      categoryListIdMap: {},
      lastSync: null,
      accountWorkspaces: mocks.store.accountWorkspaces,
      language: 'zh',
      setLanguage: vi.fn(),
      theme: 'light',
      setTheme: vi.fn(),
    }),
}));

import { LoginScreen } from './LoginScreen';

const connectedResult = {
  status: 'connected',
  githubToken: 'server',
  user: { id: 1, login: 'octocat' },
};

const renderLogin = () => {
  const view = render(
    <TooltipProvider>
      <LoginScreen />
    </TooltipProvider>
  );
  const secretInput = view.container.querySelector('#backend-api-key') as HTMLInputElement;
  return { ...view, secretInput };
};

const submit = (secretInput: HTMLInputElement, secret = 'secret') => {
  fireEvent.change(secretInput, { target: { value: secret } });
  fireEvent.click(screen.getByRole('button', { name: '连接并恢复数据' }));
};

describe('LoginScreen same-origin sign-in', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.safeReadText.mockResolvedValue({ success: false, error: 'empty' });
    mocks.syncBackendData.mockReset().mockResolvedValue(undefined);
    mocks.store.accountWorkspaces = {};
  });

  it('asks only for the API secret: no backend URL, no GitHub token field', () => {
    const { container, secretInput } = renderLogin();
    expect(secretInput).toHaveAttribute('type', 'password');
    expect(container.querySelectorAll('input')).toHaveLength(1);
    expect(screen.queryByText('GitHub Token 权限')).not.toBeInTheDocument();
  });

  it('Ctrl+V pastes the secret into the field', async () => {
    mocks.safeReadText.mockResolvedValue({ success: true, text: 'pasted-secret' });
    const { secretInput } = renderLogin();

    fireEvent.keyDown(secretInput, { key: 'v', ctrlKey: true });

    await waitFor(() => expect(secretInput).toHaveValue('pasted-secret'));
  });

  it('signs in with the secret, syncs backend data first, then commits the placeholder token', async () => {
    mocks.loginWithApiSecret.mockResolvedValue(connectedResult);
    const { secretInput } = renderLogin();

    submit(secretInput, 's3cret');

    await waitFor(() => expect(mocks.store.setUser).toHaveBeenCalledWith({ id: 1, login: 'octocat' }));
    expect(mocks.loginWithApiSecret).toHaveBeenCalledWith('s3cret');
    expect(mocks.syncBackendData).toHaveBeenCalledOnce();
    expect(mocks.store.setGitHubToken).toHaveBeenCalledWith('server');
    expect(mocks.syncBackendData.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.store.setUser.mock.invocationCallOrder[0],
    );
  });

  it('shows an error for a rejected secret and commits nothing', async () => {
    mocks.loginWithApiSecret.mockResolvedValue({ status: 'unauthorized' });
    const { secretInput } = renderLogin();

    submit(secretInput, 'wrong');

    expect(await screen.findByRole('alert')).toHaveTextContent('API');
    expect(mocks.store.setUser).not.toHaveBeenCalled();
    expect(mocks.store.setGitHubToken).not.toHaveBeenCalled();
  });

  it('shows an error when the server has no GitHub token configured', async () => {
    mocks.loginWithApiSecret.mockResolvedValue({ status: 'github-not-configured' });
    const { secretInput } = renderLogin();

    submit(secretInput);

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(mocks.store.setUser).not.toHaveBeenCalled();
  });

  it('does not commit the login when the backend data sync fails', async () => {
    mocks.loginWithApiSecret.mockResolvedValue(connectedResult);
    mocks.syncBackendData.mockRejectedValueOnce(new Error('sync failed'));
    const { secretInput } = renderLogin();

    submit(secretInput);

    expect(await screen.findByRole('alert')).toHaveTextContent('sync failed');
    expect(mocks.store.setUser).not.toHaveBeenCalled();
    expect(mocks.store.setGitHubToken).not.toHaveBeenCalled();
  });

  it('asks before overwriting archived local data and syncs on confirm', async () => {
    mocks.store.accountWorkspaces = {
      '1': {
        repositories: [],
        customCategories: [{ id: 'cat-1', name: 'Cat', icon: '', isCustom: true, keywords: [] }],
      },
    };
    mocks.loginWithApiSecret.mockResolvedValue(connectedResult);
    const { secretInput } = renderLogin();

    submit(secretInput);

    expect(await screen.findByText('本地数据冲突')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '使用后端数据' }));

    await waitFor(() => expect(mocks.store.setUser).toHaveBeenCalledWith({ id: 1, login: 'octocat' }));
    expect(mocks.syncBackendData).toHaveBeenCalledOnce();
    expect(mocks.store.setGitHubToken).toHaveBeenCalledWith('server');
  });
});
