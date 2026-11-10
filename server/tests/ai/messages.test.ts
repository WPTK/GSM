import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshDb, makeFakeClient, resetAiEnv, textMessage, HttpError, type FakeClient } from './helpers.js';

vi.mock('../../src/db/connection.js', () => ({
  getDb: () => (globalThis as unknown as { __testDb: unknown }).__testDb,
  closeDb: () => undefined,
}));

const { default: aiRouter } = await import('../../src/routes/ai.js');
const { setAnthropicClientForTests } = await import('../../src/ai/client.js');
const { resetClaudeConfigForTests, markModelsVerified } = await import('../../src/ai/claudeConfig.js');
const { stopCreditProbeForTests, getAiState } = await import('../../src/ai/creditState.js');

function app() {
  const a = express();
  a.use(express.json({ limit: '2mb' }));
  a.use(aiRouter);
  return a;
}

let fake: FakeClient;

beforeEach(() => {
  resetAiEnv();
  resetClaudeConfigForTests();
  process.env.ANTHROPIC_API_KEY = 'fake-anthropic-key-abcdefgh-9z8y';
  freshDb();
  markModelsVerified();
  fake = makeFakeClient();
  setAnthropicClientForTests(fake);
});
afterEach(() => {
  setAnthropicClientForTests(null);
  stopCreditProbeForTests();
  resetAiEnv();
  resetClaudeConfigForTests();
});

const base = { system: 'sys', messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 };

describe('GET /api/ai/status', () => {
  it('shows at most the last 4 key characters', async () => {
    const res = await request(app()).get('/api/ai/status').expect(200);
    expect(res.body.connected).toBe(true);
    expect(res.body.keySuffix).toBe('9z8y');
    expect(JSON.stringify(res.body)).not.toContain('abcdefgh');
    expect(res.body.models).toEqual({ bulk: 'claude-haiku-5-5', chat: 'claude-sonnet-5-5' });
    expect(res.body.state).toBe('ok');
  });

  it('reports not connected before the models are verified', async () => {
    markModelsVerified(false);
    const res = await request(app()).get('/api/ai/status').expect(200);
    expect(res.body.connected).toBe(false);
  });
});

describe('POST /api/ai/messages', () => {
  it.each([
    ['chat', 'claude-sonnet-5-5'],
    ['tools', 'claude-sonnet-5-5'],
    ['search', 'claude-haiku-5-5'],
    ['translate', 'claude-haiku-5-5'],
    ['release-summary', 'claude-haiku-5-5'],
  ])('purpose %s uses %s', async (purpose, model) => {
    fake.impl.create = () => textMessage('hello');
    const res = await request(app()).post('/api/ai/messages').send({ ...base, purpose }).expect(200);
    expect(fake.calls.create[0].model).toBe(model);
    expect(res.body.text).toBe('hello');
    expect(res.body.usage).toEqual({ inputTokens: 10, outputTokens: 5, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 });
    expect(res.body.stopReason).toBe('end_turn');
  });

  it('honours CLAUDE_MODEL_* overrides', async () => {
    process.env.CLAUDE_MODEL_CHAT = 'claude-custom-chat';
    await request(app()).post('/api/ai/messages').send({ ...base, purpose: 'chat' }).expect(200);
    expect(fake.calls.create[0].model).toBe('claude-custom-chat');
  });

  it('rejects model and baseUrl in the body with 400', async () => {
    for (const extra of [{ model: 'claude-opus-9' }, { baseUrl: 'https://evil.example' }]) {
      const res = await request(app()).post('/api/ai/messages').send({ ...base, purpose: 'chat', ...extra }).expect(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    }
    expect(fake.calls.create).toHaveLength(0);
  });

  it('caps maxTokens per purpose', async () => {
    await request(app()).post('/api/ai/messages').send({ ...base, purpose: 'search', maxTokens: 4097 }).expect(400);
    await request(app()).post('/api/ai/messages').send({ ...base, purpose: 'search', maxTokens: 4096 }).expect(200);
    await request(app()).post('/api/ai/messages').send({ ...base, purpose: 'chat', maxTokens: 8193 }).expect(400);
  });

  it('returns tool calls', async () => {
    fake.impl.create = () => ({
      ...textMessage(''),
      content: [{ type: 'tool_use', id: 'tu_1', name: 'search', input: { q: 'x' } }],
      stop_reason: 'tool_use',
    });
    const res = await request(app()).post('/api/ai/messages').send({ ...base, purpose: 'tools', tools: [{ name: 'search', input_schema: { type: 'object' } }] }).expect(200);
    expect(res.body.toolCalls).toEqual([{ id: 'tu_1', name: 'search', input: { q: 'x' } }]);
    expect(res.body.stopReason).toBe('tool_use');
  });

  it('maps a 429 to AI_RATE_LIMITED with retry-after', async () => {
    fake.impl.create = () => { throw new HttpError(429, 'rate', { 'retry-after': '7' }); };
    const res = await request(app()).post('/api/ai/messages').send({ ...base, purpose: 'chat' }).expect(429);
    expect(res.body.code).toBe('AI_RATE_LIMITED');
    expect(res.headers['retry-after']).toBe('7');
  });

  it('answers 503 AI_CREDIT_LOW on a credit error and stays closed afterwards', async () => {
    fake.impl.create = () => { throw new HttpError(400, 'Your credit balance is too low to access the Anthropic API'); };
    const res = await request(app()).post('/api/ai/messages').send({ ...base, purpose: 'chat' }).expect(503);
    expect(res.body.code).toBe('AI_CREDIT_LOW');
    expect(getAiState().state).toBe('credit_low');
    const calls = fake.calls.create.length;
    const again = await request(app()).post('/api/ai/messages').send({ ...base, purpose: 'chat' }).expect(503);
    expect(again.body.code).toBe('AI_CREDIT_LOW');
    expect(fake.calls.create).toHaveLength(calls);
  });

  it('treats HTTP 402 as credit low too', async () => {
    fake.impl.create = () => { throw new HttpError(402, 'billing'); };
    await request(app()).post('/api/ai/messages').send({ ...base, purpose: 'chat' }).expect(503);
    expect(getAiState().state).toBe('credit_low');
  });
});

function fakeStream(texts: string[], opts: { fail?: Error; hang?: boolean } = {}) {
  const handlers: Record<string, (t: string) => void> = {};
  const state = { aborted: false };
  let rejectHang: (e: Error) => void = () => undefined;
  return {
    state,
    on(ev: string, cb: (t: string) => void) { handlers[ev] = cb; return this; },
    abort() { state.aborted = true; rejectHang(new Error('aborted')); },
    async finalMessage() {
      for (const t of texts) handlers.text?.(t);
      if (opts.hang) await new Promise<never>((_, rej) => { rejectHang = rej; });
      if (opts.fail) throw opts.fail;
      return textMessage(texts.join(''));
    },
  };
}

function parseSse(body: string) {
  return body.split('\n\n').filter(Boolean).map((f) => {
    const lines = f.split('\n');
    return { event: lines[0].replace('event: ', ''), data: JSON.parse(lines[1].replace('data: ', '')) };
  });
}

describe('POST /api/ai/messages stream', () => {
  it('sends delta frames then done, with the SSE headers', async () => {
    fake.impl.stream = () => fakeStream(['Hel', 'lo']);
    const res = await request(app()).post('/api/ai/messages').send({ ...base, purpose: 'chat', stream: true }).expect(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.headers['x-accel-buffering']).toBe('no');
    const frames = parseSse(res.text);
    expect(frames.map((f) => f.event)).toEqual(['delta', 'delta', 'done']);
    expect(frames[0].data).toEqual({ type: 'delta', text: 'Hel' });
    expect(frames[2].data.usage.inputTokens).toBe(10);
    expect(frames[2].data.stopReason).toBe('end_turn');
  });

  it('ends with an error frame when the upstream fails', async () => {
    fake.impl.stream = () => fakeStream(['partial'], { fail: new HttpError(529, 'overloaded') });
    const res = await request(app()).post('/api/ai/messages').send({ ...base, purpose: 'chat', stream: true }).expect(200);
    const frames = parseSse(res.text);
    expect(frames.map((f) => f.event)).toEqual(['delta', 'error']);
    expect(frames[1].data.code).toBe('AI_UPSTREAM_ERROR');
  });

  it('aborts the upstream stream when the client disconnects', async () => {
    const s = fakeStream(['x'], { hang: true });
    fake.impl.stream = () => s;
    const server = app().listen(0);
    const port = (server.address() as { port: number }).port;
    const controller = new AbortController();
    const req = fetch(`http://127.0.0.1:${port}/api/ai/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...base, purpose: 'chat', stream: true }),
      signal: controller.signal,
    }).catch(() => undefined);
    await vi.waitFor(() => expect(fake.calls.stream).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 50));
    controller.abort();
    await req;
    await vi.waitFor(() => expect(s.state.aborted).toBe(true));
    server.close();
  });
});

describe('GET/PUT /api/ai/settings', () => {
  it('stores the custom analysis prompt and caps its length', async () => {
    await request(app()).put('/api/ai/settings').send({ customAnalysisPrompt: 'Prefer short tags' }).expect(200);
    const res = await request(app()).get('/api/ai/settings').expect(200);
    expect(res.body).toEqual({ customAnalysisPrompt: 'Prefer short tags' });
    await request(app()).put('/api/ai/settings').send({ customAnalysisPrompt: 'x'.repeat(4001) }).expect(400);
    await request(app()).put('/api/ai/settings').send({ customAnalysisPrompt: 'a', extra: 1 }).expect(400);
  });
});

describe('relay limits', () => {
  it('rejects a conversation over the total character cap', async () => {
    const big = 'x'.repeat(500_000);
    const res = await request(app()).post('/api/ai/messages').send({
      purpose: 'chat', maxTokens: 10, system: big, messages: [{ role: 'user', content: big }],
    }).expect(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(fake.calls.create).toHaveLength(0);
  });

  it('answers 429 beyond 4 concurrent upstream calls and frees slots afterwards', async () => {
    const release: Array<() => void> = [];
    fake.impl.create = () => new Promise((resolve) => { release.push(() => resolve(textMessage('ok'))); });
    const server = app().listen(0);
    const port = (server.address() as { port: number }).port;
    const post = () => fetch(`http://127.0.0.1:${port}/api/ai/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...base, purpose: 'chat' }),
    });
    const inflight = [post(), post(), post(), post()];
    await vi.waitFor(() => expect(fake.calls.create).toHaveLength(4));
    const fifth = await post();
    expect(fifth.status).toBe(429);
    expect((await fifth.json()).code).toBe('AI_RATE_LIMITED');
    expect(fifth.headers.get('retry-after')).toBe('1');
    release.forEach((r) => r());
    expect((await Promise.all(inflight)).every((r) => r.status === 200)).toBe(true);
    fake.impl.create = () => textMessage('again');
    expect((await post()).status).toBe(200);
    server.close();
  });

  it('aborts the upstream call of a non-stream request when the client disconnects', async () => {
    let seen: AbortSignal | undefined;
    fake.impl.create = (_p, options) => new Promise((_res, rej) => {
      seen = options?.signal;
      options?.signal?.addEventListener('abort', () => rej(new Error('aborted')));
    });
    const server = app().listen(0);
    const port = (server.address() as { port: number }).port;
    const controller = new AbortController();
    const req = fetch(`http://127.0.0.1:${port}/api/ai/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...base, purpose: 'chat' }), signal: controller.signal,
    }).catch(() => undefined);
    await vi.waitFor(() => expect(seen).toBeDefined());
    controller.abort();
    await req;
    await vi.waitFor(() => expect(seen?.aborted).toBe(true));
    server.close();
  });

  it('the app gives /api/ai a 2 MB body limit', async () => {
    const { createApp } = await import('../../src/index.js');
    const res = await request(createApp()).post('/api/ai/messages').send({ ...base, purpose: 'chat', system: 'x'.repeat(3 * 1024 * 1024) });
    expect(res.status).toBe(413);
  });
});