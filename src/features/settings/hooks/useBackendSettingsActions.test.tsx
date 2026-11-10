import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../../../store/useAppStore';
import { useBackendSettingsActions } from './useBackendSettingsActions';

const mocks = vi.hoisted(() => ({
  backendInit: vi.fn(),
  backendCheckHealth: vi.fn(),
  backendAuthStatus: vi.fn(),
  backendLogout: vi.fn(),
  storeLogout: vi.fn(),
  toast: vi.fn(),
  confirm: vi.fn(),
  tryRestoreAuthFromBackend: vi.fn(),
  useAppStore: Object.assign(vi.fn(), { setState: vi.fn(), getState: () => ({ logout: mocks.storeLogout }) }),
}));

vi.mock('../../../store/useAppStore', () => ({ useAppStore: mocks.useAppStore }));
vi.mock('../../../services/backendAdapter', () => ({
  backend: {
    isAvailable: false,
    init: mocks.backendInit,
    checkHealth: mocks.backendCheckHealth,
    authStatus: mocks.backendAuthStatus,
    logout: mocks.backendLogout,
  },
}));
vi.mock('../../../services/autoSync', () => ({
  tryRestoreAuthFromBackend: mocks.tryRestoreAuthFromBackend,
}));
vi.mock('../../../hooks/useDialog', () => ({
  useDialog: () => ({ toast: mocks.toast, confirm: mocks.confirm }),
}));

const storeState = {
  language: 'zh',
  repositories: [],
  releases: [],
  activeWebDAVConfig: null,
  hiddenDefaultCategoryIds: [] as string[],
  categoryOrder: [] as string[],
  customCategories: [],
  assetFilters: [],
  defaultCategoryOverrides: {},
  collapsedSidebarCategoryCount: 0,
  setRepositories: vi.fn(),
  setReleases: vi.fn(),
  setWebDAVConfigs: vi.fn(),
  showDefaultCategory: vi.fn(),
  hideDefaultCategory: vi.fn(),
};

const mockUseAppStore = vi.mocked(useAppStore);

describe('useBackendSettingsActions 后端地址配置', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.backendInit.mockResolvedValue(undefined);
    mocks.backendCheckHealth.mockResolvedValue({ version: '1.0.0', timestamp: '2026-09-05T00:00:00Z' });
    mocks.backendAuthStatus.mockResolvedValue({ authenticated: true, githubConfigured: true });
    mocks.backendLogout.mockResolvedValue(undefined);
    mockUseAppStore.mockImplementation(((selector?: (state: typeof storeState) => unknown) => (
      selector ? selector(storeState) : storeState
    )) as never);
  });

  const render = () => renderHook(() => useBackendSettingsActions());

  it('reports GitHub as configured from the cookie-auth status', async () => {
    const { result } = render();
    await act(async () => {});
    expect(result.current.githubConfigured).toBe(true);
    expect(result.current.status).toBe('connected');
  });

  it('reports GitHub as not configured when the server holds no token', async () => {
    mocks.backendAuthStatus.mockResolvedValue({ authenticated: true, githubConfigured: false });
    const { result } = render();
    await act(async () => {});
    expect(result.current.githubConfigured).toBe(false);
  });

  it('testConnection probes the same origin only and toasts success', async () => {
    const { result } = render();
    await act(async () => {
      await result.current.testConnection();
    });
    expect(mocks.backendInit.mock.calls.every((call) => call.length === 0)).toBe(true);
    expect(mocks.toast).toHaveBeenCalledWith('后端连接成功！', 'success');
  });

  it('testConnection toasts failure when the health check fails', async () => {
    mocks.backendCheckHealth.mockResolvedValue(null);
    const { result } = render();
    await act(async () => {
      await result.current.testConnection();
    });
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining('后端连接失败'), 'error');
  });

  it('logout ends the cookie session and clears the local identity', async () => {
    const { result } = render();
    await act(async () => {
      await result.current.logout();
    });
    expect(mocks.backendLogout).toHaveBeenCalledOnce();
    expect(mocks.storeLogout).toHaveBeenCalledOnce();
  });
});
