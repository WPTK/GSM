import { z } from 'zod';
import { AI_PLATFORMS, AnalysisResultSchema, type AnalysisResult } from './contract.js';

/**
 * The schema sent to the API (output_config.format). It stays plain on purpose:
 * structured outputs support only a subset of JSON Schema, so length and count
 * limits are enforced afterwards by AnalysisResultSchema.
 */
export const AnalysisWireSchema = z
  .object({
    summary: z.string(),
    tags: z.array(z.string()),
    platforms: z.array(z.enum(AI_PLATFORMS)),
  })
  .strict();

export function analysisJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(AnalysisWireSchema) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}

export type ParsedAnalysis = { ok: true; value: AnalysisResult } | { ok: false; reason: string };

/** Parses the model's text into an AnalysisResult, trimming tags to five and de-duplicating. */
export function parseAnalysisText(text: string): ParsedAnalysis {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'response was not valid JSON' };
  }
  if (raw && typeof raw === 'object' && Array.isArray((raw as { tags?: unknown }).tags)) {
    const r = raw as { tags: unknown[]; platforms?: unknown };
    r.tags = [...new Set(r.tags.filter((t): t is string => typeof t === 'string').map((t) => t.trim()).filter(Boolean))].slice(0, 5);
    if (Array.isArray(r.platforms)) r.platforms = [...new Set(r.platforms)];
  }
  const parsed = AnalysisResultSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { ok: false, reason: `${first?.path.join('.') || 'response'}: ${first?.message ?? 'invalid'}` };
  }
  return { ok: true, value: parsed.data };
}
