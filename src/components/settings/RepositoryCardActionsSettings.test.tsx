import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RepositoryCardActionsSettings } from './RepositoryCardActionsSettings';
import { useAppStore } from '../../store/useAppStore';
import { DEFAULT_REPOSITORY_CARD_ACTIONS, type RepositoryCardActionPreference } from '../../types/repositoryCardActions';

const mockUseAppStore = vi.mocked(useAppStore);

interface MockSettingsState {
  language: string;
  repositoryCardActions: RepositoryCardActionPreference[];
  setRepositoryCardActions: (actions: RepositoryCardActionPreference[]) => void;
}

describe('RepositoryCardActionsSettings', () => {
  const setRepositoryCardActions = vi.fn();
  let state: MockSettingsState;

  beforeEach(() => {
    vi.clearAllMocks();
    state = {
      language: 'zh',
      repositoryCardActions: DEFAULT_REPOSITORY_CARD_ACTIONS.map((item) => ({ ...item })),
      setRepositoryCardActions: setRepositoryCardActions.mockImplementation((actions) => {
        state.repositoryCardActions = actions;
      }),
    };

    mockUseAppStore.mockImplementation(((selector?: (s: MockSettingsState) => unknown) =>
      (selector ? selector(state) : state)) as unknown as typeof useAppStore,
    );

  });

  const renderComponent = () =>
    render(
      <RepositoryCardActionsSettings
        title="快捷操作设置"
        hint="调整按钮顺序"
        resetLabel="恢复默认按钮排列"
        moveUpLabel={(a) => `${a}上移`}
        moveDownLabel={(a) => `${a}下移`}
        visibilityLabel={(a) => `显示${a}`}
      />,
    );

  it('lists exactly the built-in actions', () => {
    renderComponent();
    expect(screen.getAllByRole('switch')).toHaveLength(DEFAULT_REPOSITORY_CARD_ACTIONS.length);
  });

  it('toggles visibility of an action', async () => {
    renderComponent();
    await userEvent.click(screen.getAllByRole('switch')[0]);
    expect(setRepositoryCardActions).toHaveBeenCalledTimes(1);
    const next = setRepositoryCardActions.mock.calls[0][0] as RepositoryCardActionPreference[];
    expect(next[0].visible).toBe(false);
  });

  it('resets to the default order', async () => {
    renderComponent();
    await userEvent.click(screen.getByRole('button', { name: '恢复默认按钮排列' }));
    expect(setRepositoryCardActions).toHaveBeenCalledWith(DEFAULT_REPOSITORY_CARD_ACTIONS);
  });
});
