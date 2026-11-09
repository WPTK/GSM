import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildAnthropicClient } from '../../src/ai/client.js';
import { guardedFetch, resetOutboundAllowlistForTests } from '../../src/services/proxyService.js';

describe('guardedFetch', () => {
  afterEach(() => { vi.unstubAllGlobals(); resetOutboundAllowlistForTests(); });

  it('rejects hosts that are not on the allowlist', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    await expect(guardedFetch('https://evil.example.com/v1/messages')).rejects.toMatchObject({ code: 'EGRESS_BLOCKED' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects plain http even for an allowed host', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    await expect(guardedFetch('http://api.anthropic.com/v1/messages')).rejects.toMatchObject({ code: 'EGRESS_BLOCKED' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('forwards allowed hosts and refuses redirects', async () => {
    const spy = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', spy);
    await guardedFetch('https://api.anthropic.com/v1/messages', { method: 'POST' });
    expect(spy).toHaveBeenCalledTimes(1);
    expect((spy.mock.calls[0] as unknown as [string, RequestInit])[1].redirect).toBe('error');
  });
});

describe('Anthropic client retries', () => {
  it('retries a 429 and honours retry-after', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls === 1) {
        return new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }), {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '0' },
        });
      }
      return new Response(
        JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'x', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;
    const client = buildAnthropicClient({ apiKey: 'sk-test-0000', fetch: fetchImpl });
    const msg = await client.messages.create({ model: 'claude-haiku-5-5', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] });
    expect(calls).toBe(2);
    expect(msg.content[0].text).toBe('ok');
  });
});
