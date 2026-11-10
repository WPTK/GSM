import { notifySessionExpired } from './sessionEvents';
import type {
  AiErrorCode,
  AiMessagesRequest,
  AiMessagesResponse,
  AiSettingsResponse,
  AiSseFrame,
  AiStatusResponse,
  AnalysisEstimateRequest,
  AnalysisEstimateResponse,
  AnalysisJob,
} from './claudeContract';
import { MAX_TOKENS_BY_PURPOSE } from './claudeContract';

/**
 * Transport for the server's /api/ai routes. The browser never holds a provider
 * key and never names a model: the server picks the model from the request purpose.
 */

const AI_BASE = '/api/ai';
const REQUEST_TIMEOUT_MS = 180_000;

/** Request failure from the Claude routes, carrying the HTTP status and, when sent, the server error code. */
export class AIRequestError extends Error {
  readonly status: number;
  readonly code?: AiErrorCode | string;
  readonly retryAfterMs?: number;
  readonly isRateLimit: boolean;

  constructor(message: string, status: number, retryAfterMs?: number, code?: string) {
    super(message);
    this.name = 'AIRequestError';
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
    this.isRateLimit = status === 429;
  }
}

/** Parses Retry-After (retry-after-ms, then seconds, then HTTP date). */
export function parseRetryAfterMs(response: Response): number | undefined {
  const msHeader = response.headers.get('retry-after-ms');
  if (msHeader) {
    const v = Number(msHeader);
    if (Number.isFinite(v) && v > 0) return Math.round(v);
  }
  const secHeader = response.headers.get('retry-after');
  if (secHeader) {
    const v = Number(secHeader);
    if (Number.isFinite(v) && v > 0) return Math.round(v * 1000);
    const parsed = Date.parse(secHeader);
    if (!Number.isNaN(parsed)) {
      const remaining = parsed - Date.now();
      if (remaining > 0) return remaining;
    }
  }
  return undefined;
}

async function toRequestError(response: Response): Promise<AIRequestError> {
  let code: string | undefined;
  let detail = '';
  try {
    const data = await response.json() as { error?: unknown; code?: unknown; message?: unknown };
    if (typeof data.code === 'string') code = data.code;
    if (typeof data.error === 'string') detail = data.error;
    else if (typeof data.message === 'string') detail = data.message;
  } catch { /* body not JSON */ }
  if (response.status === 401 && code === 'UNAUTHORIZED') notifySessionExpired();
  const message = `Claude API error: ${response.status}${detail ? ` - ${detail}` : ''}`;
  return new AIRequestError(message, response.status, parseRetryAfterMs(response), code);
}

/** Chains the caller's signal with a request timeout. */
function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    done: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

async function requestJson<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
  const timeout = withTimeout(init.signal, init.timeoutMs ?? REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${AI_BASE}${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: init.body === undefined ? { Accept: 'application/json' } : { 'Content-Type': 'application/json', Accept: 'application/json' },
      credentials: 'same-origin',
      redirect: 'error',
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: timeout.signal,
    });
    if (!response.ok) throw await toRequestError(response);
    return await response.json() as T;
  } finally {
    timeout.done();
  }
}

/** Reads an SSE byte stream, handing each data payload to onData. */
export async function consumeSseStream(body: ReadableStream<Uint8Array>, onData: (payload: string) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let dataLines: string[] = [];
  const flush = () => {
    if (dataLines.length > 0) {
      onData(dataLines.join('\n'));
      dataLines = [];
    }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let separatorIndex: number;
      // SSE line separators: CRLF, LF or a bare CR.
      while ((separatorIndex = buffer.search(/[\r\n]/)) >= 0) {
        // A trailing CR may pair with an LF in the next chunk, so wait for more data.
        if (buffer[separatorIndex] === '\r' && separatorIndex === buffer.length - 1) break;
        const separatorLength = buffer[separatorIndex] === '\r' && buffer[separatorIndex + 1] === '\n' ? 2 : 1;
        const line = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(separatorIndex + separatorLength);
        if (line === '') {
          flush();
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).replace(/^ /, ''));
        }
        // event:, id: and comment lines are not needed.
      }
    }
    // Flush the decoder and split what is left by the same rules.
    buffer += decoder.decode();
    const residualLines = buffer.split(/\r\n|\r|\n/);
    buffer = '';
    for (const line of residualLines) {
      if (line === '') {
        flush();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).replace(/^ /, ''));
      }
    }
    flush();
  } catch (error) {
    // The callback threw (for example on an error frame): cancel the stream so the connection is not left hanging.
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function clampRequest(request: AiMessagesRequest): AiMessagesRequest {
  const cap = MAX_TOKENS_BY_PURPOSE[request.purpose];
  return request.maxTokens > cap ? { ...request, maxTokens: cap } : request;
}

/** POST /api/ai/messages, JSON reply. */
export function postMessages(request: AiMessagesRequest, signal?: AbortSignal): Promise<AiMessagesResponse> {
  return requestJson<AiMessagesResponse>('/messages', { body: clampRequest(request), signal });
}

export type StreamDone = Extract<AiSseFrame, { type: 'done' }>;

/** POST /api/ai/messages with stream:true. Calls onDelta per text frame and resolves with the done frame. */
export async function streamMessages(
  request: AiMessagesRequest,
  onDelta: (text: string) => void,
  signal?: AbortSignal,
): Promise<StreamDone> {
  const timeout = withTimeout(signal, REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${AI_BASE}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      credentials: 'same-origin',
      redirect: 'error',
      body: JSON.stringify({ ...clampRequest(request), stream: true }),
      signal: timeout.signal,
    });
    if (!response.ok) throw await toRequestError(response);
    if (!response.body || !(response.headers.get('content-type') ?? '').includes('text/event-stream')) {
      throw new AIRequestError('Claude stream is not available', 502, undefined, 'AI_UPSTREAM_ERROR');
    }
    let done: StreamDone | null = null;
    await consumeSseStream(response.body, (payload) => {
      let frame: AiSseFrame;
      try {
        frame = JSON.parse(payload) as AiSseFrame;
      } catch {
        return;
      }
      if (frame.type === 'delta') {
        if (frame.text) onDelta(frame.text);
      } else if (frame.type === 'done') {
        done = frame;
      } else if (frame.type === 'error') {
        throw new AIRequestError(frame.message || 'Claude stream error', frame.code === 'AI_RATE_LIMITED' ? 429 : 502, undefined, frame.code);
      }
    });
    if (!done) throw new AIRequestError('Claude stream ended without a result', 502, undefined, 'AI_UPSTREAM_ERROR');
    return done;
  } finally {
    timeout.done();
  }
}

export const fetchAiStatus = (signal?: AbortSignal): Promise<AiStatusResponse> =>
  requestJson<AiStatusResponse>('/status', { signal, timeoutMs: 15_000 });

export const fetchAiSettings = (signal?: AbortSignal): Promise<AiSettingsResponse> =>
  requestJson<AiSettingsResponse>('/settings', { signal, timeoutMs: 15_000 });

export const saveAiSettings = (customAnalysisPrompt: string, signal?: AbortSignal): Promise<AiSettingsResponse> =>
  requestJson<AiSettingsResponse>('/settings', { method: 'PUT', body: { customAnalysisPrompt }, signal, timeoutMs: 15_000 });

export const estimateAnalysis = (request: AnalysisEstimateRequest, signal?: AbortSignal): Promise<AnalysisEstimateResponse> =>
  requestJson<AnalysisEstimateResponse>('/analysis/estimate', { body: request, signal, timeoutMs: 60_000 });

export const createAnalysisJob = async (estimateId: string, confirmed: boolean, signal?: AbortSignal): Promise<AnalysisJob> =>
  (await requestJson<{ job: AnalysisJob }>('/analysis/jobs', {
    body: confirmed ? { estimateId, confirmed: true } : { estimateId },
    signal,
    timeoutMs: 60_000,
  })).job;

export const fetchAnalysisJob = async (jobId: string, signal?: AbortSignal): Promise<AnalysisJob> =>
  (await requestJson<{ job: AnalysisJob }>(`/analysis/jobs/${encodeURIComponent(jobId)}`, { signal, timeoutMs: 30_000 })).job;

export const cancelAnalysisJob = async (jobId: string, signal?: AbortSignal): Promise<AnalysisJob> =>
  (await requestJson<{ job: AnalysisJob }>(`/analysis/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST', body: {}, signal, timeoutMs: 30_000 })).job;
