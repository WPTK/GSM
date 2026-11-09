import type { AnthropicLike } from './client.js';
import type { AnalysisResult, AiUsage } from './contract.js';
import type { SystemBlock } from './cache.js';
import { analysisJsonSchema, parseAnalysisText } from './schema.js';

/** Output budget per repository; the estimate uses the same number as its upper bound. */
export const ANALYSIS_MAX_TOKENS = 1024;

/**
 * Structured output: both models support output_config.format (json_schema), so that is
 * the one path used. Forced tool use is not an option (Sonnet 5.5 rejects tool_choice).
 * No thinking parameter and no assistant prefill.
 */
export function buildAnalysisParams(model: string, system: SystemBlock[], userText: string): Record<string, unknown> {
  return {
    model,
    max_tokens: ANALYSIS_MAX_TOKENS,
    system,
    messages: [{ role: 'user', content: userText }],
    output_config: { format: { type: 'json_schema', schema: analysisJsonSchema() } },
  };
}

export function messageText(message: { content?: Array<{ type: string; text?: string }> }): string {
  return (message.content ?? [])
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('');
}

export function toUsage(raw: Record<string, unknown> | undefined): AiUsage {
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    inputTokens: n(raw?.input_tokens),
    outputTokens: n(raw?.output_tokens),
    cacheCreationInputTokens: n(raw?.cache_creation_input_tokens),
    cacheReadInputTokens: n(raw?.cache_read_input_tokens),
  };
}

export class AnalysisInvalidError extends Error {
  constructor(reason: string) {
    super(`Model output did not match the schema: ${reason}`);
    this.name = 'AnalysisInvalidError';
  }
}

/**
 * Analyses one repository. Invalid output gets exactly one retry (attempts = 2 by default);
 * after that the item fails with AnalysisInvalidError. API errors are not caught here.
 */
export async function analyzeRepo(opts: {
  client: AnthropicLike;
  model: string;
  system: SystemBlock[];
  userText: string;
  attempts?: number;
  signal?: AbortSignal;
}): Promise<{ result: AnalysisResult; usage: AiUsage }> {
  const attempts = opts.attempts ?? 2;
  let lastReason = 'no output';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const message = await opts.client.messages.create(
      buildAnalysisParams(opts.model, opts.system, opts.userText),
      opts.signal ? { signal: opts.signal } : undefined,
    );
    const parsed = parseAnalysisText(messageText(message));
    if (parsed.ok) return { result: parsed.value, usage: toUsage(message.usage) };
    lastReason = parsed.reason;
  }
  throw new AnalysisInvalidError(lastReason);
}

/** Parses one result already fetched elsewhere (a batch item); null when invalid. */
export function parseMessageResult(message: { content?: Array<{ type: string; text?: string }> }): AnalysisResult | null {
  const parsed = parseAnalysisText(messageText(message));
  return parsed.ok ? parsed.value : null;
}
