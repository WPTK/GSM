import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../../store/useAppStore';
import { i18n } from '../../i18n';
import type { AiStatusResponse } from '../../services/claudeContract';
import { ClaudePanel } from './ClaudePanel';

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  status: { connected: true, loading: false } as { connected: boolean; loading: boolean },
  statusBody: null as unknown,
}));

vi.mock('../../hooks/useDialog', () => ({
  useDialog: () => ({ toast: mocks.toast, confirm: vi.fn() }),
}));

vi.mock('../../hooks/useClaudeStatus', () => ({
  useClaudeStatus: () => ({
    connected: mocks.status.connected,
    loading: mocks.status.loading,
    state: 'ok',
    status: mocks.statusBody,
    error: null,
    refresh: async () => {},
  }),
}));

const t = i18n.getFixedT('zh', 'app');

const chatSettings = {
  enabled: true,
  retainSessionDays: 90,
  taskDepth: 'default',
  enableWebTools: false,
  enableAgentToolLoop: false,
  fastPath: true,
  streamingMode: 'auto',
  maxToolsPerTurn: 12,
  agentBudget: { maxToolCalls: 12, maxTurns: 4, maxNoProgressRounds: 2, maxReadFiles: 6, maxCodeReads: 3, maxDurationMs: 90000 },
};

const baseStatus = (overrides: Partial<AiStatusResponse> = {}): AiStatusResponse => ({
  connected: true,
  keySuffix: 'wxyz',
  models: { bulk: 'claude-haiku-test', chat: 'claude-sonnet-test' },
  state: 'ok',
  ...overrides,
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

describe('ClaudePanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.status = { connected: true, loading: false };
    mocks.statusBody = baseStatus();
    (useAppStore as unknown as ReturnType<typeof vi.fn>).mockImplementation((selector?: (state: Record<string, unknown>) => unknown) => {
      const state = {
        language: 'zh',
        translationEngine: 'microsoft',
        autoTranslateRepoDescription: false,
        repositoryChatSettings: chatSettings,
        setTranslationEngine: vi.fn(),
        setAutoTranslateRepoDescription: vi.fn(),
        setRepositoryChatSettings: vi.fn(),
      };
      return selector ? selector(state) : state;
    });
    (window.fetch as ReturnType<typeof vi.fn>).mockReset();
    (window.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(json({ customAnalysisPrompt: 'Focus on CLI tools' }));
  });

  it('shows the connected state, only the last four key characters and both models', async () => {
    render(<ClaudePanel t={t} />);

    expect(screen.getByText('Claude 已连接')).toBeInTheDocument();
    expect(screen.getByText('密钥末尾为 wxyz')).toBeInTheDocument();
    expect(screen.getByText('聊天模型：claude-sonnet-test')).toBeInTheDocument();
    expect(screen.getByText('分析、搜索和翻译模型：claude-haiku-test')).toBeInTheDocument();
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('textbox', { name: '自定义分析提示词' })).toHaveValue('Focus on CLI tools'));
  });

  it('shows the cache-skipped note with the prefix and minimum token counts', async () => {
    mocks.statusBody = baseStatus({ cache: { cache: 'skipped', prefixTokens: 1500, minTokens: 4096 } });
    render(<ClaudePanel t={t} />);

    expect(screen.getByRole('note')).toHaveTextContent('1500');
    expect(screen.getByRole('note')).toHaveTextContent('4096');
    await waitFor(() => expect(screen.getByRole('textbox', { name: '自定义分析提示词' })).not.toBeDisabled());
  });

  it('tells the owner to ask the server owner for a key when not connected', async () => {
    mocks.status = { connected: false, loading: false };
    mocks.statusBody = baseStatus({ connected: false, keySuffix: null });
    render(<ClaudePanel t={t} />);

    expect(screen.getByText('Claude 未连接。请让服务器所有者添加 Anthropic API 密钥。')).toBeInTheDocument();
    expect(screen.queryByText(/密钥末尾为/)).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('textbox', { name: '自定义分析提示词' })).not.toBeDisabled());
  });

  it('saves an edited custom analysis prompt with PUT /api/ai/settings', async () => {
    const user = userEvent.setup();
    render(<ClaudePanel t={t} />);
    const field = await screen.findByRole('textbox', { name: '自定义分析提示词' });
    await waitFor(() => expect(field).toHaveValue('Focus on CLI tools'));
    const save = screen.getByRole('button', { name: '保存提示词' });
    expect(save).toBeDisabled();

    (window.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(json({ customAnalysisPrompt: 'Focus on libraries' }));
    await user.clear(field);
    await user.type(field, 'Focus on libraries');
    expect(save).toBeEnabled();
    await user.click(save);

    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('分析提示词已保存', 'success'));
    const putCall = (window.fetch as ReturnType<typeof vi.fn>).mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'PUT');
    expect(putCall?.[0]).toBe('/api/ai/settings');
    expect(JSON.parse(String((putCall?.[1] as RequestInit).body))).toEqual({ customAnalysisPrompt: 'Focus on libraries' });
    await waitFor(() => expect(save).toBeDisabled());
  });

  it('reports a failed save without clearing the field', async () => {
    const user = userEvent.setup();
    render(<ClaudePanel t={t} />);
    const field = await screen.findByRole('textbox', { name: '自定义分析提示词' });
    await waitFor(() => expect(field).toHaveValue('Focus on CLI tools'));

    (window.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(json({ error: 'too long', code: 'VALIDATION_ERROR' }, 400));
    await user.type(field, '!');
    await user.click(screen.getByRole('button', { name: '保存提示词' }));

    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining('无法保存分析提示词'), 'error'));
    expect(field).toHaveValue('Focus on CLI tools!');
  });
});
