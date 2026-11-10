import { beforeEach, describe, expect, it, vi } from 'vitest';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

const status = { connected: true, keySuffix: 'abcd', models: { bulk: 'b', chat: 'c' }, state: 'ok' };

describe('claudeStatusStore', () => {
  beforeEach(() => {
    vi.resetModules();
    (window.fetch as ReturnType<typeof vi.fn>).mockReset();
  });

  it('keeps the last good status when a later poll fails', async () => {
    const store = await import('./claudeStatusStore');
    (window.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(json(status));
    await store.refreshClaudeStatus();
    expect(store.getClaudeStatusSnapshot().status?.connected).toBe(true);

    (window.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(json({ error: 'down' }, 502));
    await store.refreshClaudeStatus();

    const snapshot = store.getClaudeStatusSnapshot();
    expect(snapshot.status?.connected).toBe(true);
    expect(snapshot.error).toMatch(/502/);
    expect(snapshot.loading).toBe(false);
  });

  it('has no status when the very first poll fails', async () => {
    const store = await import('./claudeStatusStore');
    (window.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(json({ error: 'down' }, 502));
    await store.refreshClaudeStatus();
    expect(store.getClaudeStatusSnapshot().status).toBeNull();
  });
});
