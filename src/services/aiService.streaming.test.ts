import { afterEach, describe, expect, it, vi } from 'vitest';
import { AIRequestError, AIService, consumeSseStream } from './aiService';

const streamFrom = (chunks: string[]): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[index]));
      index += 1;
    },
  });
};

const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const doneFrame = { type: 'done', usage: { inputTokens: 1, outputTokens: 2, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }, stopReason: 'end_turn' };

const sseResponse = (chunks: string[], status = 200) => new Response(streamFrom(chunks), {
  status,
  headers: { 'Content-Type': 'text/event-stream' },
});

describe('consumeSseStream', () => {
  it('dispatches complete events and buffers lines split across chunks', async () => {
    const payloads: string[] = [];
    await consumeSseStream(streamFrom([
      'data: {"a":1}\n\ndata: {"b"',
      ':2}\n\n',
      'data: [DON',
      'E]\n\n',
    ]), (payload) => payloads.push(payload));
    expect(payloads).toEqual(['{"a":1}', '{"b":2}', '[DONE]']);
  });

  it('parses event-stream bodies separated only by bare CR', async () => {
    const payloads: string[] = [];
    await consumeSseStream(streamFrom([
      'data: {"a":1}\r\rdata: {"b":2}\r\rdata: [DONE]\r',
    ]), (payload) => payloads.push(payload));
    expect(payloads).toEqual(['{"a":1}', '{"b":2}', '[DONE]']);
  });

  it('handles CRLF separators and ignores event/comment lines', async () => {
    const payloads: string[] = [];
    await consumeSseStream(streamFrom([
      'event: delta\r\ndata: first\r\n\r\n: keep-alive\n\ndata: second\n\n',
    ]), (payload) => payloads.push(payload));
    expect(payloads).toEqual(['first', 'second']);
  });
});

describe('AIService.generateChatTextStream over /api/ai/messages', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts stream:true with purpose "chat" and joins delta frames', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse([
      frame({ type: 'delta', text: 'Hi' }),
      frame({ type: 'delta', text: ' there' }),
      frame(doneFrame),
    ]));
    vi.stubGlobal('fetch', fetchMock);

    const chunks: string[] = [];
    const full = await new AIService('en').generateChatTextStream({ system: 's', user: 'u', onChunk: (delta) => chunks.push(delta) });

    expect(full).toBe('Hi there');
    expect(chunks).toEqual(['Hi', ' there']);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/ai/messages');
    expect(init.redirect).toBe('error');
    expect(init.credentials).toBe('same-origin');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ purpose: 'chat', stream: true });
    expect(body).not.toHaveProperty('model');
  });

  it('handles frames split across network chunks', async () => {
    const whole = frame({ type: 'delta', text: 'Split' }) + frame(doneFrame);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([whole.slice(0, 20), whole.slice(20)])));
    const full = await new AIService('en').generateChatTextStream({ system: 's', user: 'u', onChunk: () => {} });
    expect(full).toBe('Split');
  });

  it('turns an error frame into an AIRequestError (rate limit keeps status 429)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([
      frame({ type: 'delta', text: 'partial' }),
      frame({ type: 'error', code: 'AI_RATE_LIMITED', message: 'slow down' }),
    ])));
    const chunks: string[] = [];
    const error = await new AIService('en')
      .generateChatTextStream({ system: 's', user: 'u', onChunk: (delta) => chunks.push(delta) })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AIRequestError);
    expect(error).toMatchObject({ status: 429, code: 'AI_RATE_LIMITED' });
    expect(chunks).toEqual(['partial']);
  });

  it('fails when the stream ends without a done frame', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([frame({ type: 'delta', text: 'cut off' })])));
    await expect(new AIService('en').generateChatTextStream({ system: 's', user: 'u', onChunk: () => {} }))
      .rejects.toMatchObject({ status: 502, code: 'AI_UPSTREAM_ERROR' });
  });

  it('rejects a reply that is not an event stream', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('plain', { status: 200, headers: { 'Content-Type': 'text/plain' } })));
    await expect(new AIService('en').generateChatTextStream({ system: 's', user: 'u', onChunk: () => {} }))
      .rejects.toMatchObject({ status: 502 });
  });

  it('maps an HTTP error before the stream starts to AIRequestError with the server code', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: 'credit low', code: 'AI_CREDIT_LOW' }),
      { status: 402, headers: { 'Content-Type': 'application/json' } },
    )));
    await expect(new AIService('en').generateChatTextStream({ system: 's', user: 'u', onChunk: () => {} }))
      .rejects.toMatchObject({ status: 402, code: 'AI_CREDIT_LOW' });
  });
});
