import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '../../i18n';
import { useAppStore } from '../../store/useAppStore';
import { DataManagementPanel } from './DataManagementPanel';

// The global test setup replaces the store with a stub; the export reads the real one.
vi.mock('../../store/useAppStore', async () => await vi.importActual('../../store/useAppStore'));

vi.mock('../../hooks/useDialog', () => ({
  useDialog: () => ({ toast: vi.fn(), confirm: vi.fn() }),
}));

const t = i18n.getFixedT('zh', 'app');

describe('DataManagementPanel backup export', () => {
  let captured: string | null;

  beforeEach(() => {
    captured = null;
    vi.stubGlobal('URL', Object.assign(URL, {
      createObjectURL: (blob: Blob) => {
        void blob.text().then((text) => { captured = text; });
        return 'blob:test';
      },
      revokeObjectURL: () => undefined,
    }));
    // Pretend an older build left provider configs in memory: the export must not read them.
    useAppStore.setState({ includeKeysInBackup: true, ...({
      aiConfigs: [{ id: 'c1', name: 'Old', apiKey: 'sk-old-provider-key', baseUrl: 'https://api.example.com', model: 'm' }],
    } as Record<string, unknown>) });
  });

  it('writes no aiConfigs and no provider key even with the include-keys toggle on', async () => {
    const user = userEvent.setup();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    render(<DataManagementPanel t={t} />);

    await user.click(screen.getByRole('button', { name: '导出选中数据' }));

    await waitFor(() => expect(captured).not.toBeNull());
    const exported = JSON.parse(captured ?? '{}') as { data: Record<string, unknown> };
    expect(exported.data).not.toHaveProperty('aiConfigs');
    expect(exported.data.includeKeysInBackup).toBe(true);
    expect(captured).not.toContain('sk-old-provider-key');
    expect(captured).not.toMatch(/apiKey/);
  });
});
