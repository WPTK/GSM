import { describe, expect, it, vi } from 'vitest';
import { AIService } from './aiService';

const okResponse = (text: string, stopReason = 'end_turn') => new Response(
  JSON.stringify({
    text,
    usage: { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
    stopReason,
  }),
  { status: 200, headers: { 'Content-Type': 'application/json' } },
);

const requestBodies = (): Array<{ purpose: string; maxTokens: number; messages: Array<{ role: string; content: string }> }> =>
  (window.fetch as ReturnType<typeof vi.fn>).mock.calls
    .map((call: unknown[]) => JSON.parse(String((call[1] as RequestInit | undefined)?.body ?? '{}')));

describe('AIService.generateChatTextDetailed (internal JSON steps)', () => {
  it('sends chat-purpose requests to /api/ai/messages without naming a model', async () => {
    (window.fetch as ReturnType<typeof vi.fn>).mockImplementation(async () => okResponse('{"ok":true}'));
    const service = new AIService('en');

    await service.generateChatTextDetailed({ system: 's', user: 'u', maxTokens: 800, purpose: 'internal-json' });
    await service.generateChatText({ system: 's', user: 'u', maxTokens: 800 });

    const calls = (window.fetch as ReturnType<typeof vi.fn>).mock.calls as Array<[string, RequestInit]>;
    expect(calls.every(([url]) => url === '/api/ai/messages')).toBe(true);
    const bodies = requestBodies();
    expect(bodies.map((body) => body.purpose)).toEqual(['chat', 'chat']);
    expect(bodies.every((body) => !('model' in body))).toBe(true);
    expect(bodies.map((body) => body.maxTokens)).toEqual([800, 800]);
  });

  it('retries once with doubled tokens and a JSON-only instruction when length truncation yields no text', async () => {
    (window.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(okResponse('', 'max_tokens'))
      .mockResolvedValueOnce(okResponse('{"ok":true}'));

    const result = await new AIService('en').generateChatTextDetailed({ system: 's', user: 'PLAN', maxTokens: 900, purpose: 'internal-json' });

    expect(result).toEqual({ text: '{"ok":true}', finishReason: 'stop' });
    const bodies = requestBodies();
    expect(bodies[0].maxTokens).toBe(900);
    expect(bodies[1].maxTokens).toBe(1800);
    expect(bodies[1].messages.at(-1)?.content).toContain('PLAN');
    expect(bodies[1].messages.at(-1)?.content).toContain('直接输出 JSON，不要思考过程');
  });

  it('retries when length truncation returns partial non-empty JSON', async () => {
    (window.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(okResponse('{"standalone_question":"How is the', 'max_tokens'))
      .mockResolvedValueOnce(okResponse('{"ok":true}'));

    const result = await new AIService('en').generateChatTextDetailed({ system: 's', user: 'PLAN', maxTokens: 800, purpose: 'internal-json' });

    expect(result).toEqual({ text: '{"ok":true}', finishReason: 'stop' });
    expect(requestBodies().map((body) => body.maxTokens)).toEqual([800, 1600]);
  });

  it('keeps a complete JSON result that was reported as length-truncated', async () => {
    (window.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(okResponse('{"standalone_question":"How is it built?"}', 'max_tokens'));

    const result = await new AIService('en').generateChatTextDetailed({ system: 's', user: 'PLAN', maxTokens: 800, purpose: 'internal-json' });

    expect(result).toEqual({ text: '{"standalone_question":"How is it built?"}', finishReason: 'length' });
    expect(requestBodies()).toHaveLength(1);
  });

  it('does not retry plain answers when the reply is length-truncated', async () => {
    (window.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(okResponse('partial answer', 'max_tokens'));

    const result = await new AIService('en').generateChatTextDetailed({ system: 's', user: 'u', maxTokens: 800 });

    expect(result).toEqual({ text: 'partial answer', finishReason: 'length' });
    expect(requestBodies()).toHaveLength(1);
  });

  it('does not retry on an HTTP error and keeps the server code', async () => {
    (window.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'bad request', code: 'AI_BAD_REQUEST' }), { status: 400 }));

    await expect(new AIService('en').generateChatTextDetailed({ system: 's', user: 'u', purpose: 'internal-json' }))
      .rejects.toMatchObject({ status: 400, code: 'AI_BAD_REQUEST' });
    expect(requestBodies()).toHaveLength(1);
  });
});
