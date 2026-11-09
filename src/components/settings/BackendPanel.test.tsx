import { makeT } from '../../i18n/useT';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BackendPanel } from './BackendPanel';

const mocks = vi.hoisted(() => {
  const storeState = {
    language: 'zh',
    repositories: [],
    releases: [],
    aiConfigs: [],
    activeAIConfig: null,
    activeWebDAVConfig: null,
    hiddenDefaultCategoryIds: [],
    categoryOrder: [],
    customCategories: [],
    assetFilters: {},
    collapsedSidebarCategoryCount: 20,
    setRepositories: vi.fn(),
    setReleases: vi.fn(),
    setAIConfigs: vi.fn(),
    setWebDAVConfigs: vi.fn(),
    showDefaultCategory: vi.fn(),
    hideDefaultCategory: vi.fn(),
  };

  return {
    storeState,
    useAppStore: Object.assign(
      vi.fn((selector?: (state: typeof storeState) => unknown) => (selector ? selector(storeState) : storeState)),
      { getState: () => ({ logout: vi.fn() }) },
    ),
    backend: {
      init: vi.fn(),
      checkHealth: vi.fn(),
      authStatus: vi.fn(),
      logout: vi.fn(),
      isAvailable: true,
      syncRepositories: vi.fn(),
      syncReleases: vi.fn(),
      syncAIConfigs: vi.fn(),
      syncWebDAVConfigs: vi.fn(),
      syncSettings: vi.fn(),
      fetchRepositories: vi.fn(),
      fetchReleases: vi.fn(),
      fetchAIConfigs: vi.fn(),
      fetchWebDAVConfigs: vi.fn(),
      fetchSettings: vi.fn(),
    },
    tryRestoreAuthFromBackend: vi.fn(),
    toast: vi.fn(),
    confirm: vi.fn(),
  };
});

vi.mock('../../store/useAppStore', () => ({ useAppStore: mocks.useAppStore }));
vi.mock('../../services/backendAdapter', () => ({ backend: mocks.backend }));
vi.mock('../../services/autoSync', () => ({
  tryRestoreAuthFromBackend: mocks.tryRestoreAuthFromBackend,
}));
vi.mock('../../hooks/useDialog', () => ({
  useDialog: () => ({ toast: mocks.toast, confirm: mocks.confirm }),
}));

const health = { version: '0.1.0', timestamp: '2026-08-19T00:00:00Z' };
const t = makeT('en', 'app');

describe('BackendPanel same-origin status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.backend.init.mockResolvedValue(undefined);
    mocks.backend.authStatus.mockResolvedValue({ authenticated: true, githubConfigured: true });
    mocks.tryRestoreAuthFromBackend.mockResolvedValue(false);
  });

  it('shows the connection state and has no URL, secret or token inputs', async () => {
    mocks.backend.checkHealth.mockResolvedValue(health);

    const { container } = render(<BackendPanel t={t} />);

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText('Connected')).toBeTruthy();
    expect(container.querySelector('input')).toBeNull();
  });

  it('re-checks the connection on a manual test', async () => {
    mocks.backend.checkHealth.mockResolvedValueOnce(null).mockResolvedValue(health);

    render(<BackendPanel t={t} />);

    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText('Not Connected')).toBeTruthy();

    fireEvent.click(screen.getByText('Test Connection'));

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText('Connected')).toBeTruthy();
  });

  it('logs out through the backend', async () => {
    mocks.backend.checkHealth.mockResolvedValue(health);
    mocks.backend.logout.mockResolvedValue(undefined);

    render(<BackendPanel t={t} />);
    await act(async () => {
      await Promise.resolve();
    });

    fireEvent.click(screen.getByText('Logout'));
    await act(async () => {
      await Promise.resolve();
    });

    expect(mocks.backend.logout).toHaveBeenCalledOnce();
  });
});
