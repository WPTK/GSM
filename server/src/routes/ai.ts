import { Router, type Response } from 'express';
import { z } from 'zod';
import { getDb } from '../db/connection.js';
import { CUSTOM_ANALYSIS_PROMPT_KEY } from '../db/settingsKeys.js';
import { logger } from '../services/logger.js';
import { getAnthropicClient } from '../ai/client.js';
import { getModels, isConnected, keySuffix } from '../ai/claudeConfig.js';
import { getAiState, isCreditLowError, setCreditLow } from '../ai/creditState.js';
import { messageText, toUsage } from '../ai/analyze.js';
import {
  AiMessagesRequestSchema,
  AiSettingsUpdateSchema,
  AnalysisEstimateRequestSchema,
  AnalysisJobCreateRequestSchema,
  MAX_TOKENS_BY_PURPOSE,
  PURPOSE_MODEL_CLASS,
  type AiCacheInfo,
  type AiErrorBody,
  type AiErrorCode,
  type AiMessagesResponse,
  type AiSettingsResponse,
  type AiSseFrame,
  type AiStatusResponse,
  type AiStopReason,
  type AiToolCall,
} from '../ai/contract.js';
import {
  EstimateInputError,
  createEstimate,
  getCustomAnalysisPrompt,
  getLastCacheDecision,
} from '../ai/estimate.js';
import {
  EstimateNotFoundError,
  JobNotCancellableError,
  JobNotFoundError,
  SpendConfirmRequiredError,
  cancelJob,
  createJob,
  getJob,
} from '../ai/jobs.js';

const router = Router();

function sendError(res: Response, status: number, code: AiErrorCode, message: string): void {
  const body: AiErrorBody = { error: message, code };
  res.status(status).json(body);
}

function validationMessage(error: z.ZodError): string {
  const first = error.issues[0];
  return first ? `${first.path.join('.') || 'body'}: ${first.message}` : 'Invalid request';
}

/** Maps an error from the SDK or the jobs layer to an HTTP status and code. Never echoes upstream bodies. */
function describeUpstreamError(err: unknown): { status: number; code: AiErrorCode; message: string; retryAfter?: string } {
  if (isCreditLowError(err)) {
    setCreditLow();
    return { status: 503, code: 'AI_CREDIT_LOW', message: 'The Anthropic credit balance is too low' };
  }
  const e = err as { status?: number; headers?: Record<string, string> | { get?: (k: string) => string | null } };
  if (e?.status === 429) {
    const h = e.headers as any;
    const retryAfter = typeof h?.get === 'function' ? h.get('retry-after') : h?.['retry-after'];
    return { status: 429, code: 'AI_RATE_LIMITED', message: 'Anthropic rate limit reached', retryAfter: retryAfter ?? undefined };
  }
  return { status: 502, code: 'AI_UPSTREAM_ERROR', message: 'The Anthropic API request failed' };
}

function ensureReady(res: Response): boolean {
  if (!isConnected()) {
    sendError(res, 503, 'AI_NOT_CONFIGURED', 'Claude is not configured');
    return false;
  }
  return true;
}

/** Relay is blocked while credit is low. */
function ensureCredit(res: Response): boolean {
  if (getAiState().state === 'credit_low') {
    sendError(res, 503, 'AI_CREDIT_LOW', 'The Anthropic credit balance is too low');
    return false;
  }
  return true;
}

// GET /api/ai/status
router.get('/api/ai/status', (_req, res) => {
  const state = getAiState();
  let cache: AiCacheInfo | undefined = getLastCacheDecision() ?? undefined;
  if (!cache) {
    const row = getDb().prepare('SELECT cache_json FROM ai_jobs ORDER BY created_at DESC LIMIT 1').get() as { cache_json: string } | undefined;
    if (row) cache = JSON.parse(row.cache_json) as AiCacheInfo;
  }
  const body: AiStatusResponse = {
    connected: isConnected(),
    keySuffix: keySuffix(),
    models: getModels(),
    state: state.state,
    ...(state.since ? { since: state.since } : {}),
    ...(state.nextCheckAt ? { nextCheckAt: state.nextCheckAt } : {}),
    ...(cache ? { cache } : {}),
  };
  res.json(body);
});

function readSettings(): AiSettingsResponse {
  return { customAnalysisPrompt: getCustomAnalysisPrompt() };
}

// GET/PUT /api/ai/settings
router.get('/api/ai/settings', (_req, res) => {
  res.json(readSettings());
});

router.put('/api/ai/settings', (req, res) => {
  const parsed = AiSettingsUpdateSchema.safeParse(req.body);
  if (!parsed.success) return sendError(res, 400, 'VALIDATION_ERROR', validationMessage(parsed.error));
  getDb().prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(CUSTOM_ANALYSIS_PROMPT_KEY, parsed.data.customAnalysisPrompt);
  res.json(readSettings());
});

function buildParams(body: z.infer<typeof AiMessagesRequestSchema>) {
  const models = getModels();
  return {
    model: PURPOSE_MODEL_CLASS[body.purpose] === 'chat' ? models.chat : models.bulk,
    max_tokens: body.maxTokens,
    messages: body.messages,
    ...(body.system ? { system: body.system } : {}),
    ...(body.tools && body.tools.length > 0 ? { tools: body.tools } : {}),
    ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
  };
}

function toolCallsOf(message: { content?: Array<{ type: string; id?: string; name?: string; input?: unknown }> }): AiToolCall[] {
  return (message.content ?? [])
    .filter((b) => b.type === 'tool_use')
    .map((b) => ({ id: String(b.id), name: String(b.name), input: (b.input ?? {}) as Record<string, unknown> }));
}

function writeFrame(res: Response, frame: AiSseFrame): void {
  res.write(`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`);
}

// POST /api/ai/messages
router.post('/api/ai/messages', async (req, res) => {
  const parsed = AiMessagesRequestSchema.safeParse(req.body);
  if (!parsed.success) return sendError(res, 400, 'VALIDATION_ERROR', validationMessage(parsed.error));
  const body = parsed.data;
  if (body.maxTokens > MAX_TOKENS_BY_PURPOSE[body.purpose]) {
    return sendError(res, 400, 'VALIDATION_ERROR', `maxTokens: at most ${MAX_TOKENS_BY_PURPOSE[body.purpose]} for purpose ${body.purpose}`);
  }
  if (!ensureReady(res) || !ensureCredit(res)) return;

  const params = buildParams(body);
  const client = getAnthropicClient();

  if (!body.stream) {
    try {
      const message = await client.messages.create(params);
      const calls = toolCallsOf(message);
      const out: AiMessagesResponse = {
        text: messageText(message),
        ...(calls.length > 0 ? { toolCalls: calls } : {}),
        usage: toUsage(message.usage),
        stopReason: (message.stop_reason ?? 'end_turn') as AiStopReason,
      };
      res.json(out);
    } catch (err) {
      const d = describeUpstreamError(err);
      logger.warn('ai.messages', `relay failed (${d.code})`);
      if (d.retryAfter) res.setHeader('Retry-After', d.retryAfter);
      sendError(res, d.status, d.code, d.message);
    }
    return;
  }

  // Streaming: headers go out first so proxies do not buffer the frames.
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  let stream: any;
  let finished = false;
  res.on('close', () => {
    if (!finished) stream?.abort?.();
  });
  try {
    stream = client.messages.stream(params);
    stream.on('text', (text: string) => {
      if (!finished && !res.writableEnded) writeFrame(res, { type: 'delta', text });
    });
    const message = await stream.finalMessage();
    finished = true;
    const calls = toolCallsOf(message);
    writeFrame(res, {
      type: 'done',
      usage: toUsage(message.usage),
      stopReason: (message.stop_reason ?? 'end_turn') as AiStopReason,
      ...(calls.length > 0 ? { toolCalls: calls } : {}),
    });
  } catch (err) {
    const wasAborted = finished || res.destroyed;
    finished = true;
    if (!wasAborted) {
      const d = describeUpstreamError(err);
      logger.warn('ai.messages', `stream failed (${d.code})`);
      writeFrame(res, { type: 'error', code: d.code, message: d.message });
    }
  } finally {
    if (!res.writableEnded) res.end();
  }
});

// POST /api/ai/analysis/estimate
router.post('/api/ai/analysis/estimate', async (req, res) => {
  const parsed = AnalysisEstimateRequestSchema.safeParse(req.body);
  if (!parsed.success) return sendError(res, 400, 'VALIDATION_ERROR', validationMessage(parsed.error));
  if (!ensureReady(res)) return;
  try {
    const est = await createEstimate(parsed.data);
    res.json(est.response);
  } catch (err) {
    if (err instanceof EstimateInputError) return sendError(res, 400, 'VALIDATION_ERROR', err.message);
    const d = describeUpstreamError(err);
    logger.warn('ai.estimate', `estimate failed (${d.code})`);
    sendError(res, d.status, d.code, d.message);
  }
});

// POST /api/ai/analysis/jobs
router.post('/api/ai/analysis/jobs', (req, res) => {
  const parsed = AnalysisJobCreateRequestSchema.safeParse(req.body);
  if (!parsed.success) return sendError(res, 400, 'VALIDATION_ERROR', validationMessage(parsed.error));
  if (!ensureReady(res)) return;
  try {
    const job = createJob(parsed.data.estimateId, parsed.data.confirmed === true);
    res.status(202).json({ job });
  } catch (err) {
    if (err instanceof SpendConfirmRequiredError) {
      return sendError(res, 409, 'AI_SPEND_CONFIRM_REQUIRED', 'The estimate is over the spend threshold; confirm to continue');
    }
    if (err instanceof EstimateNotFoundError) return sendError(res, 404, 'AI_ESTIMATE_NOT_FOUND', 'Estimate not found or expired');
    logger.errorFromError('ai.jobs', 'create job failed', err);
    sendError(res, 502, 'AI_UPSTREAM_ERROR', 'Could not start the job');
  }
});

// GET /api/ai/analysis/jobs/:id
router.get('/api/ai/analysis/jobs/:id', (req, res) => {
  try {
    res.json({ job: getJob(String(req.params.id)) });
  } catch (err) {
    if (err instanceof JobNotFoundError) return sendError(res, 404, 'AI_JOB_NOT_FOUND', 'Job not found');
    throw err;
  }
});

// POST /api/ai/analysis/jobs/:id/cancel
router.post('/api/ai/analysis/jobs/:id/cancel', (req, res) => {
  try {
    res.json({ job: cancelJob(String(req.params.id)) });
  } catch (err) {
    if (err instanceof JobNotFoundError) return sendError(res, 404, 'AI_JOB_NOT_FOUND', 'Job not found');
    if (err instanceof JobNotCancellableError) return sendError(res, 409, 'AI_JOB_NOT_CANCELLABLE', 'Job already finished');
    throw err;
  }
});

export default router;
