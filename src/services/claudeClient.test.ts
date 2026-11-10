import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AIRequestError,
  cancelAnalysisJob,
  fetchAiSettings,
  fetchAiStatus,
  postMessages,
  saveAiSettings,
} from './claudeClient';

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json', ...headers },
});

const fetchMock = () => window.fetch as ReturnType<typeof vi.fn>;

describe('claudeClient', () => {
  beforeEach(() => {
    fetchMock().mockReset();
  });

  it('GET /api/ai/status uses cookie auth and never sends an Authorization header', async () => {
    fetchMock().mockResolvedValue(json({ connected: true, keySuffix: 'abcd', models: { bulk: 'b', chat: 'c' }, state: 'ok' }));

    const status = await fetchAiStatus();

    expect(status.keySuffix).toBe('abcd');
    const [url, init] = fetchMock().mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/ai/status');
    expect(init.credentials).toBe('same-origin');
    expect(init.redirect).toBe('error');
    expect(JSON.stringify(init.headers)).not.toMatch(/authorization|x-api-key/i);
  });

  it('PUT /api/ai/settings sends only the prompt', async () => {
    fetchMock().mockResolvedValue(json({ customAnalysisPrompt: 'Be brief' }));

    await expect(saveAiSettings('Be brief')).resolves.toEqual({ customAnalysisPrompt: 'Be brief' });
    const [url, init] = fetchMock().mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/ai/settings');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({ customAnalysisPrompt: 'Be brief' });
  });

  it('GET /api/ai/settings returns the stored prompt', async () => {
    fetchMock().mockResolvedValue(json({ customAnalysisPrompt: 'x' }));
    await expect(fetchAiSettings()).resolves.toEqual({ customAnalysisPrompt: 'x' });
  });

  it('keeps the server error code and Retry-After on failures', async () => {
    fetchMock().mockResolvedValue(json({ error: 'slow down', code: 'AI_RATE_LIMITED' }, 429, { 'retry-after': '3' }));

    const error = await postMessages({ purpose: 'chat', messages: [{ role: 'user', content: 'hi' }], maxTokens: 10 })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AIRequestError);
    expect(error).toMatchObject({ status: 429, code: 'AI_RATE_LIMITED', retryAfterMs: 3000, isRateLimit: true });
  });

  it('maps a credit-low reply to AI_CREDIT_LOW with status 402', async () => {
    fetchMock().mockResolvedValue(json({ error: 'balance', code: 'AI_CREDIT_LOW' }, 402));
    await expect(postMessages({ purpose: 'chat', messages: [{ role: 'user', content: 'hi' }], maxTokens: 10 }))
      .rejects.toMatchObject({ status: 402, code: 'AI_CREDIT_LOW' });
  });

  it('URL-encodes the job id and posts an empty body when cancelling', async () => {
    fetchMock().mockResolvedValue(json({ job: { id: 'a/b', status: 'cancelled', items: [] } }));

    await cancelAnalysisJob('a/b');

    const [url, init] = fetchMock().mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/ai/analysis/jobs/a%2Fb/cancel');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{}');
  });
});
