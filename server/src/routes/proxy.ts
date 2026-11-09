import { Router } from 'express';
import { getDb } from '../db/connection.js';
import { decrypt } from '../services/crypto.js';
import { config } from '../config.js';
import { proxyRequest, validateUrl, isPrivateOrLoopback } from '../services/proxyService.js';
import { getGithubToken } from '../services/githubToken.js';
import { logger } from '../services/logger.js';

const router = Router();

// 透传上游与限流相关的响应头，供前端（含直连模式）统一识别 Retry-After 与剩余配额。
const UPSTREAM_RATE_LIMIT_HEADERS = new Set([
  'retry-after',
  'retry-after-ms',
  'x-ratelimit-remaining-requests',
  'x-ratelimit-remaining-tokens',
  'x-ratelimit-reset-requests',
  'x-ratelimit-reset-tokens',
  'x-ratelimit-limit-requests',
  'x-ratelimit-limit-tokens',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
  'x-ratelimit-limit',
  'ratelimit-remaining',
  'ratelimit-reset',
  'ratelimit-limit',
  'anthropic-ratelimit-requests-remaining',
  'anthropic-ratelimit-requests-reset',
  'anthropic-ratelimit-input-tokens-remaining',
  'anthropic-ratelimit-input-tokens-reset',
  'anthropic-ratelimit-output-tokens-remaining',
  'anthropic-ratelimit-output-tokens-reset',
  'x-should-retry',
]);

function relayRateLimitHeaders(res: import('express').Response, headers: Record<string, string> | undefined): void {
  if (!headers) return;
  for (const [key, value] of Object.entries(headers)) {
    if (UPSTREAM_RATE_LIMIT_HEADERS.has(key.toLowerCase()) && typeof value === 'string' && value) {
      try {
        res.setHeader(key, value);
      } catch { /* ignore invalid header name */ }
    }
  }
}

// Helper: build API URL handling base already ending in version prefix
function buildApiUrl(baseUrl: string, pathWithVersion: string): string {
  const baseUrlWithSlash = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const versionPrefix = pathWithVersion.split('/')[0] || '';

  try {
    const base = new URL(baseUrlWithSlash);
    const basePath = base.pathname.replace(/\/$/, '');

    // 检测 baseUrl 是否已经以任何版本号结尾（v1, v2, v3, v1beta, v1alpha 等）
    // 这样可以兼容火山引擎（/v3）、OpenAI（/v1）、Gemini（/v1beta）等不同版本号
    const anyVersionPattern = /\/v\d+(?:beta|alpha)?$/;
    const hasVersionInBase = anyVersionPattern.test(basePath);

    if (hasVersionInBase) {
      // baseUrl 已包含版本号，只补全端点路径（去掉版本号部分）
      const endpointPath = pathWithVersion.includes('/')
        ? pathWithVersion.split('/').slice(1).join('/')
        : pathWithVersion;
      return new URL(endpointPath, baseUrlWithSlash).toString();
    }

    if (versionPrefix) {
      if (basePath.endsWith(`/${versionPrefix}`) && pathWithVersion.startsWith(`${versionPrefix}/`)) {
        const rest = pathWithVersion.slice(versionPrefix.length + 1);
        return new URL(rest, baseUrlWithSlash).toString();
      }
    }

    return new URL(pathWithVersion, baseUrlWithSlash).toString();
  } catch {
    return `${baseUrlWithSlash}${pathWithVersion}`;
  }
}

// openai-compatible 与前端 buildFinalApiUrl 保持同一补全规则：仅当 baseUrl
// 正好是版本根地址（https://host/v1）时补全 /chat/completions，更长路径视为
// 完整端点保持原样，避免直连与代理请求不同地址。
function completeOpenAiCompatibleUrl(baseUrl: string): string {
  // `/\/+$/` 这类带量词的正则会被 CodeQL 判为对不可控输入的多项式回溯。
  let trimmed = baseUrl;
  while (trimmed.endsWith('/')) trimmed = trimmed.slice(0, -1);
  try {
    const url = new URL(trimmed);
    const pathname = url.pathname.replace(/\/$/, '');
    if (/^\/v\d+(?:beta|alpha)?$/i.test(pathname)) {
      url.pathname = `${pathname}/chat/completions`;
      return url.toString();
    }
  } catch {
    // 非 URL 形式保持原样，由请求阶段报错。
  }
  return trimmed;
}

// POST /api/proxy/github/*
router.post(/^\/api\/proxy\/github\/(.*)/, async (req, res) => {
  try {
    const rawPath = (req.params as Record<string, string>)[0];
    const githubPath = Array.isArray(rawPath) ? rawPath.join('/') : (rawPath ?? '');

    // Prevent path traversal
    if (typeof githubPath !== 'string' || githubPath.includes('..') || githubPath.includes('\\')) {
      res.status(400).json({ error: 'Invalid target path', code: 'INVALID_TARGET_PATH' });
      return;
    }
    
    const token = getGithubToken();
    if (!token) {
      res.status(400).json({ error: 'GitHub token not configured', code: 'GITHUB_TOKEN_NOT_CONFIGURED' });
      return;
    }

    const cleanPath = githubPath.replace(/^\/+/, '');
    const safeSegments = cleanPath.split('/').map(seg => encodeURIComponent(seg)).join('/');

    const searchParams = new URL(req.url, 'http://localhost').searchParams;
    const safeSearchParams = new URLSearchParams();
    for (const [key, value] of searchParams.entries()) {
      // URLSearchParams already decoded the incoming values; set them raw so
      // toString() performs exactly one round of encoding.
      safeSearchParams.set(key, value);
    }
    const safeQuery = safeSearchParams.toString() ? `?${safeSearchParams.toString()}` : '';

    const targetUrl = `https://api.github.com/${safeSegments}${safeQuery}`;

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(targetUrl);
    } catch {
      res.status(400).json({ error: 'Invalid target path', code: 'INVALID_TARGET_PATH' });
      return;
    }

    if (parsedUrl.protocol !== 'https:' || parsedUrl.hostname !== 'api.github.com') {
      res.status(400).json({ error: 'Host not allowed', code: 'HOST_NOT_ALLOWED' });
      return;
    }
    validateUrl(targetUrl);

    const body = req.body as { method?: string; headers?: Record<string, string>; body?: string | object };
    const method = body.method || 'GET';
    
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${token}`,
      'Accept': body.headers?.Accept || 'application/vnd.github.v3+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'GithubStarsManager-Backend',
    };
    const contentType = body.headers?.['Content-Type'] || body.headers?.['content-type'];
    if (contentType) {
      headers['Content-Type'] = contentType;
    }

    const result = await proxyRequest({ url: targetUrl, method, headers, body: body.body });
    relayRateLimitHeaders(res, result.headers);
    res.status(result.status).json(result.data);
  } catch (err) {
    logger.errorFromError('proxy.github', 'GitHub proxy error', err);
    res.status(500).json({ error: 'GitHub proxy failed', code: 'GITHUB_PROXY_FAILED' });
  }
});

function normalizeReasoningEffort(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return value === 'minimal' ? 'low' : value;
}

// POST /api/proxy/ai
// Accepts either { configId, body } (lookup from DB) or { config, body } (inline config for one-time requests)
router.post('/api/proxy/ai', async (req, res) => {
  try {
    const db = getDb();
    const { configId, config: inlineConfig, body: requestBody } = req.body as {
      configId?: string;
      config?: { apiType?: string; baseUrl: string; apiKey: string; model: string; reasoningEffort?: string };
      body: Record<string, unknown>;
    };

    let apiKey: string;
    let apiType: string;
    let baseUrl: string;
    let model: string;
    let reasoningEffort: string | null;

    if (inlineConfig && !configId) {
      // Inline config path (for form tests without a saved config ID)
      apiKey = inlineConfig.apiKey;
      apiType = inlineConfig.apiType || 'openai';
      baseUrl = inlineConfig.baseUrl;
      model = inlineConfig.model;
      reasoningEffort = normalizeReasoningEffort(inlineConfig.reasoningEffort);
      if (!baseUrl || !apiKey || !model) {
        res.status(400).json({ error: 'baseUrl, apiKey, and model are required', code: 'INVALID_REQUEST' });
        return;
      }
      // Warn if API key is transmitted over non-HTTPS connection
      try {
        const parsed = new URL(baseUrl);
        if (parsed.protocol !== 'https:' && !isPrivateOrLoopback(parsed.hostname)) {
          logger.warn('proxy.ai', `AI API key transmitted over ${parsed.protocol} (not HTTPS). Consider using HTTPS for security.`);
        }
      } catch { /* invalid URL, will be caught by validateUrl later */ }
    } else if (configId) {
      // DB lookup path (for saved configs)
      const aiConfig = db.prepare('SELECT * FROM ai_configs WHERE id = ?').get(configId) as Record<string, unknown> | undefined;
      if (!aiConfig) {
        res.status(404).json({ error: 'AI config not found', code: 'AI_CONFIG_NOT_FOUND' });
        return;
      }
      apiKey = decrypt(aiConfig.api_key_encrypted as string, config.encryptionKey);
      apiType = (aiConfig.api_type as string) || 'openai';
      baseUrl = aiConfig.base_url as string;
      model = aiConfig.model as string;
      reasoningEffort = normalizeReasoningEffort(aiConfig.reasoning_effort);
      try {
        const parsed = new URL(baseUrl);
        if (parsed.protocol !== 'https:' && !isPrivateOrLoopback(parsed.hostname)) {
          logger.warn('proxy.ai', `AI API key transmitted over ${parsed.protocol} (not HTTPS). Consider using HTTPS for security.`);
        }
      } catch { /* invalid URL, will be caught by validateUrl later */ }
    } else {
      res.status(400).json({ error: 'configId or config required', code: 'CONFIG_ID_REQUIRED' });
      return;
    }

    let targetUrl: string;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };

    if (apiType === 'openai' || apiType === 'openai-responses' || apiType === 'openai-compatible' || apiType === 'deepseek' || apiType === 'mimo') {
      // openai-compatible 类型与前端使用同一套版本根地址补全规则
      targetUrl = apiType === 'openai-compatible'
        ? completeOpenAiCompatibleUrl(baseUrl)
        : buildApiUrl(baseUrl, apiType === 'openai-responses' ? 'v1/responses' : 'v1/chat/completions');
      headers['Authorization'] = `Bearer ${apiKey}`;
    } else if (apiType === 'claude') {
      targetUrl = buildApiUrl(baseUrl, 'v1/messages');
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2023-06-01';
    } else {
      // gemini
      const rawModel = model.trim();
      const modelName = rawModel.startsWith('models/') ? rawModel.slice('models/'.length) : rawModel;
      const path = `v1beta/models/${encodeURIComponent(modelName)}:generateContent`;
      targetUrl = buildApiUrl(baseUrl, path);
      const urlObj = new URL(targetUrl);
      urlObj.searchParams.set('key', apiKey);
      targetUrl = urlObj.toString();
    }

    // DeepSeek Reasoner does not support the reasoning parameter
    const isDeepSeekReasoner = model.trim() === 'deepseek-reasoner';
    const effectiveRequestBody = (
      reasoningEffort
      && !isDeepSeekReasoner
      && typeof requestBody === 'object'
      && requestBody !== null
      && (apiType === 'openai' || apiType === 'openai-responses' || apiType === 'openai-compatible' || apiType === 'deepseek' || apiType === 'mimo')
      && !('reasoning' in requestBody)
    )
      ? { ...requestBody, reasoning: { effort: reasoningEffort } }
      : requestBody;

    const timeout = apiType === 'openai-responses' || !!reasoningEffort ? 600000 : 60000;

    // 宽松档（放行回环/私有网段）只用于「用户已保存的 AI 配置」(configId)。
    // 内联 config 路径（任意客户端均可携带目标地址）保持严格档，避免 SSRF 放宽被滥用。
    const allowPrivate = Boolean(configId);

    const result = await proxyRequest({
      url: targetUrl,
      method: 'POST',
      headers,
      body: effectiveRequestBody,
      timeout,
      allowPrivate,
    });

    relayRateLimitHeaders(res, result.headers);
    res.status(result.status).json(result.data);
  } catch (err) {
    logger.errorFromError('proxy.ai', 'AI proxy error', err);
    res.status(500).json({ error: 'AI proxy failed', code: 'AI_PROXY_FAILED' });
  }
});

// POST /api/proxy/github/search/repositories
router.post('/api/proxy/github/search/repositories', async (req, res) => {
  try {
    const githubPath = 'search/repositories';
    const { query_params } = req.body as { query_params?: Record<string, string> };

    const token = getGithubToken();
    if (!token) {
      res.status(400).json({ error: 'GitHub token not configured', code: 'GITHUB_TOKEN_NOT_CONFIGURED' });
      return;
    }

    const queryString = query_params ? '?' + new URLSearchParams(query_params).toString() : '';
    const targetUrl = `https://api.github.com/${githubPath}${queryString}`;

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github.v3+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'GithubStarsManager-Backend',
    };

    const result = await proxyRequest({ url: targetUrl, method: 'GET', headers });
    relayRateLimitHeaders(res, result.headers);
    res.status(result.status).json(result.data);
  } catch (err) {
    logger.errorFromError('proxy.github.search', 'GitHub search repositories proxy error', err);
    res.status(500).json({ error: 'GitHub search proxy failed', code: 'GITHUB_SEARCH_PROXY_FAILED' });
  }
});

// POST /api/proxy/github/search/users
router.post('/api/proxy/github/search/users', async (req, res) => {
  try {
    const githubPath = 'search/users';
    const { query_params } = req.body as { query_params?: Record<string, string> };

    const token = getGithubToken();
    if (!token) {
      res.status(400).json({ error: 'GitHub token not configured', code: 'GITHUB_TOKEN_NOT_CONFIGURED' });
      return;
    }

    const queryString = query_params ? '?' + new URLSearchParams(query_params).toString() : '';
    const targetUrl = `https://api.github.com/${githubPath}${queryString}`;

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github.v3+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'GithubStarsManager-Backend',
    };

    const result = await proxyRequest({ url: targetUrl, method: 'GET', headers });
    relayRateLimitHeaders(res, result.headers);
    res.status(result.status).json(result.data);
  } catch (err) {
    logger.errorFromError('proxy.github.search', 'GitHub search users proxy error', err);
    res.status(500).json({ error: 'GitHub search proxy failed', code: 'GITHUB_SEARCH_PROXY_FAILED' });
  }
});

export default router;
