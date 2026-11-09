import axios, { AxiosRequestConfig } from 'axios';
import { BlockList, isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import type { LookupAddress, LookupOptions } from 'node:dns';
import { Agent as HttpAgent, type AgentOptions as HttpAgentOptions } from 'node:http';
import { Agent as HttpsAgent, type AgentOptions as HttpsAgentOptions } from 'node:https';
import { logger } from './logger.js';

/**
 * Default outbound allowlist (exact hostnames). Override with the
 * OUTBOUND_ALLOWLIST environment variable (comma separated). Every server-side
 * outbound request goes through proxyRequest(), which checks this list for the
 * initial URL and for every redirect hop.
 */
export const DEFAULT_OUTBOUND_ALLOWLIST = [
  'api.github.com',
  'github.com',
  'raw.githubusercontent.com',
  'avatars.githubusercontent.com',
  'user-images.githubusercontent.com',
  'private-user-images.githubusercontent.com',
  'repository-images.githubusercontent.com',
  'api.anthropic.com',
  'edge.microsoft.com',
  'clients5.google.com',
  'grep.app',
] as const;

/** Thrown for a request that must not be sent; mapped to an HTTP status by proxyRequest. */
export class RequestRejectedError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'RequestRejectedError';
  }
}

let allowlistCache: Set<string> | null = null;

function parseAllowlist(raw: string | undefined): Set<string> {
  const entries = (raw ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase().replace(/\.$/, ''))
    .filter(Boolean);
  return new Set(entries.length > 0 ? entries : DEFAULT_OUTBOUND_ALLOWLIST);
}

/** The allowlist is read from the environment once and then cached. */
export function getOutboundAllowlist(): ReadonlySet<string> {
  if (!allowlistCache) {
    allowlistCache = parseAllowlist(process.env.OUTBOUND_ALLOWLIST);
  }
  return allowlistCache;
}

/** Test hook: forget the cached allowlist so the next call re-reads the environment. */
export function resetOutboundAllowlistForTests(): void {
  allowlistCache = null;
}

/**
 * Throws a 403 EGRESS_BLOCKED error unless the URL's host is on the allowlist.
 * Logs the host only, never the path, query string or credentials.
 */
export function assertOutboundAllowed(rawUrl: string | URL): void {
  let parsed: URL;
  try {
    parsed = rawUrl instanceof URL ? rawUrl : new URL(rawUrl);
  } catch {
    throw new RequestRejectedError('Blocked outbound request: invalid URL', 400, 'INVALID_URL');
  }
  const hostname = parsed.hostname;
  if (parsed.protocol !== 'https:' || (parsed.port !== '' && parsed.port !== '443')) {
    logger.warn('egress.blocked', `host=${hostname.toLowerCase()} reason=scheme-or-port`);
    throw new RequestRejectedError('Outbound requests must use https on the default port', 403, 'EGRESS_BLOCKED');
  }
  const host = hostname.toLowerCase().replace(/\.$/, '').replace(/^\[(.+)\]$/, '$1');
  if (!getOutboundAllowlist().has(host)) {
    logger.warn('egress.blocked', `host=${host}`);
    throw new RequestRejectedError('Outbound host is not on the allowlist', 403, 'EGRESS_BLOCKED');
  }
}

/** URL for logs: origin and path only. Query strings can carry secrets. */
export function safeUrlForLog(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    return `${u.origin}${u.pathname}`;
  } catch {
    return '[invalid-url]';
  }
}

export interface ProxyRequestOptions {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string | object;
  timeout?: number;
  /**
   * 'json' (default): parse JSON when possible, otherwise return the text.
   * 'text': return the body untouched as a string.
   * 'buffer': return the body as a Buffer.
   */
  responseType?: 'json' | 'text' | 'buffer';
  /** Abort and answer 413 RESPONSE_TOO_LARGE once the response body exceeds this many bytes. */
  maxBytes?: number;
  /** Extra per-URL check, run for the initial URL and again for every redirect hop. Throw RequestRejectedError to refuse. */
  checkUrl?: (url: URL) => void;
  /** Allow loopback/private ranges (only for URLs that come from the owner's own configuration). */
  allowPrivate?: boolean;
}

export interface ProxyResponse {
  status: number;
  headers: Record<string, string>;
  data: unknown;
}

const BLOCKED_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', '169.254.169.254']);

/** Ranges that are never valid outbound targets (loopback, private, CGNAT, link-local, multicast). */
const BLOCKED_RANGES = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.168.0.0', 16], ['224.0.0.0', 4],
] as const) BLOCKED_RANGES.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const) {
  BLOCKED_RANGES.addSubnet(net, prefix, 'ipv6');
}

/** True for an IP literal inside a blocked range. Hostnames return false. */
function isBlockedIpLiteral(host: string): boolean {
  const family = isIP(host);
  if (family === 0) return false;
  return BLOCKED_RANGES.check(host, family === 4 ? 'ipv4' : 'ipv6');
}

// 无论严格/宽松档，DNS 解析结果或 IP 字面量命中一律拒绝：云元数据（IMDS 的
// v4/v6 端点）与未指定地址不可能是合法业务目标。宽松档（allowPrivate）仅
// 豁免私网/回环段。
const ALWAYS_BLOCKED_RESOLVED_IPS = new Set(['169.254.169.254', 'fd00:ec2::254', '0.0.0.0', '::']);

// axios 自动跟随重定向时不会重跑目标校验，改为手动逐跳处理（见 proxyRequest）。
const MAX_REDIRECT_HOPS = 5;
const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_REQUEST_BODY_BYTES = 64 * 1024 * 1024;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
// Headers that survive a cross-origin redirect hop. Everything else (Authorization, Cookie,
// x-api-key, anthropic-*, ...) is dropped so credentials never follow a redirect to another origin.
const CROSS_ORIGIN_SAFE_HEADERS = new Set(['accept', 'user-agent', 'content-type']);

/** 过滤出策略允许的解析结果：IMDS/未指定地址任何档位拒绝，严格档额外拒绝私网/回环段。 */
function filterAllowedAddresses(allowPrivate: boolean, addresses: LookupAddress[]): LookupAddress[] {
  return addresses.filter(({ address }) => {
    const normalized = normalizeHostname(address);
    if (ALWAYS_BLOCKED_RESOLVED_IPS.has(normalized)) return false;
    if (!allowPrivate && isPrivateOrLoopback(normalized)) return false;
    return true;
  });
}

type SafeLookupCallback = (err: Error | null, address?: string | LookupAddress[], family?: number) => void;
type SafeLookup = (hostname: string, options: LookupOptions, callback: SafeLookupCallback) => void;

/** 连接级固定：自定义 lookup 在解析时即执行策略校验，Node 直接连接校验通过的
 *  IP，消除「校验通过后、实际连接前被 DNS 重绑定」的窗口。校验失败的候选被
 *  剔除；若全部候选都被拒绝则整个解析失败（连接不发起）。 */
export function createSafeLookup(allowPrivate: boolean): SafeLookup {
  return (hostname, options, callback) => {
    lookup(hostname, { all: true, verbatim: true })
      .then((all) => {
        const valid = filterAllowedAddresses(allowPrivate, all);
        if (!valid.length) {
          callback(new Error(`Blocked proxy request: hostname '${hostname}' has no allowed resolved address`));
          return;
        }
        if (options.all) {
          callback(null, valid);
          return;
        }
        if (options.family === 4 || options.family === 6) {
          const match = valid.find((a) => a.family === options.family);
          if (!match) {
            const err = new Error(`No IPv${options.family} record for '${hostname}' passed policy`) as NodeJS.ErrnoException;
            err.code = 'ENOTFOUND';
            callback(err);
            return;
          }
          callback(null, match.address, match.family);
          return;
        }
        callback(null, valid[0].address, valid[0].family);
      })
      .catch((err: Error) => callback(err));
  };
}

// 直连 Agent 按 allowPrivate 两档缓存（默认无 keepAlive，socket 用完即断，无泄漏）
const directAgentCache = new Map<boolean, { httpAgent: HttpAgent; httpsAgent: HttpsAgent }>();
function getDirectAgents(allowPrivate: boolean): { httpAgent: HttpAgent; httpsAgent: HttpsAgent } {
  let cached = directAgentCache.get(allowPrivate);
  if (!cached) {
    const safeLookup = createSafeLookup(allowPrivate) as unknown as HttpAgentOptions['lookup'];
    cached = {
      httpAgent: new HttpAgent({ lookup: safeLookup } as HttpAgentOptions),
      httpsAgent: new HttpsAgent({ lookup: safeLookup } as unknown as HttpsAgentOptions),
    };
    directAgentCache.set(allowPrivate, cached);
  }
  return cached;
}

export interface ValidateUrlOptions {
  /** 宽松模式：放行回环地址与私有网段。仅用于「用户主动提供的自有配置」所来源的 URL
   *  （已保存的 AI 配置），
   *  不应作用于任意或半可信的输入（如 AI 内联 config）。 */
  allowPrivate?: boolean;
}

/** 归一化 hostname：去掉 IPv6 方括号、去掉结尾点号（防 `localhost.`/`127.0.0.1.` 绕过），
 *  并把 IPv4 映射型 IPv6（如 [::ffff:169.254.169.254]）还原为对应的 IPv4 字符串，
 *  使 SSRF 过滤看到真实的目标地址。 */
function normalizeHostname(hostname: string): string {
  // Strip trailing dot first to prevent SSRF bypasses (e.g. "localhost." or "127.0.0.1.")
  const h = hostname.replace(/\.$/, '').replace(/^\[(.+)\]$/, '$1').toLowerCase();
  // Handle hybrid IPv4-mapped IPv6 written with dotted decimals (::ffff:169.254.169.254)
  if (h.startsWith('::ffff:') && h.includes('.')) {
    return h.slice(7);
  }
  // Handle IPv4-mapped IPv6 written in hex form (::ffff:a9fe:a9fe)
  const mapped = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mapped) {
    const octets = [mapped[1], mapped[2]].flatMap((hex) => {
      const v = parseInt(hex, 16);
      return [(v >>> 8) & 0xff, v & 0xff];
    });
    return octets.join('.');
  }
  return h;
}

/** IPv6 私有/本地网段前缀：唯一本地地址 fc00::/7、链路本地 fe80::/10、组播 ff00::/8 */
function isPrivateOrLocalIpv6(h: string): boolean {
  if (!h.includes(':')) return false;
  return (
    h.startsWith('fc') || h.startsWith('fd') ||
    h.startsWith('fe8') || h.startsWith('fe9') ||
    h.startsWith('fea') || h.startsWith('feb') ||
    h.startsWith('ff')
  );
}

function isLocalOrLanHostname(h: string): boolean {
  return (
    h.endsWith('.local') ||
    h.endsWith('.lan') ||
    h.endsWith('.home') ||
    h.endsWith('.internal') ||
    h.endsWith('.corp') ||
    h.endsWith('.home.arpa')
  );
}

/** 判断 hostname 是否为回环地址或私有网段（含 IPv6 私有/本地网段）。 */
export function isPrivateOrLoopback(hostname: string): boolean {
  const h = normalizeHostname(hostname);
  if (BLOCKED_HOSTS.has(h)) return true;
  if (isLocalOrLanHostname(h)) return true;
  if (isBlockedIpLiteral(h)) return true;
  if (isPrivateOrLocalIpv6(h)) return true;
  return false;
}

export function validateUrl(rawUrl: string, opts: ValidateUrlOptions = {}): void {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Blocked proxy request: unsupported protocol '${parsed.protocol}'`);
  }

  // 始终拦截 URL 内嵌的用户名/密码（防止凭证泄露到日志）
  if (parsed.username || parsed.password) {
    throw new Error(`Blocked proxy request: URL containing credentials is not allowed`);
  }

  // 归一化后可同时覆盖明文 169.254.169.254 与 [::ffff:a9fe:a9fe] 等 IPv4 映射型写法。
  const hostname = normalizeHostname(parsed.hostname);

  if (opts.allowPrivate) {
    // 宽松模式：仍死守云元数据 IMDS 地址（v4/v6 端点）与未指定地址——最高危的 SSRF 目标（云厂商密钥）。
    if (ALWAYS_BLOCKED_RESOLVED_IPS.has(hostname)) {
      throw new Error(`Blocked proxy request: protected address '${hostname}' is not allowed`);
    }
    return;
  }

  // 严格模式（默认）：拦截回环地址与私有网段（含 IPv6 私有/本地网段及局域网主机名）。
  if (BLOCKED_HOSTS.has(hostname)) {
    throw new Error(`Blocked proxy request: hostname '${hostname}' is not allowed`);
  }
  if (isLocalOrLanHostname(hostname)) {
    throw new Error(`Blocked proxy request: LAN hostname '${hostname}' is not allowed`);
  }
  if (isBlockedIpLiteral(hostname)) {
    throw new Error(hostname.includes(':')
      ? `Blocked proxy request: private IPv6 address '${hostname}' is not allowed`
      : `Blocked proxy request: private IP '${hostname}' is not allowed`);
  }
  if (isPrivateOrLocalIpv6(hostname)) {
    throw new Error(`Blocked proxy request: private IPv6 address '${hostname}' is not allowed`);
  }
}

export async function proxyRequest(options: ProxyRequestOptions): Promise<ProxyResponse> {
  const {
    url,
    method,
    headers = {},
    body,
    timeout = 30000,
    responseType = 'json',
    maxBytes = DEFAULT_MAX_RESPONSE_BYTES,
  } = options;

  try {
    // Every hop (the first URL and each redirect target) runs the same checks:
    // protocol/private-range policy, the egress allowlist, then the caller's own rule.
    const checkHop = (hopUrl: string): void => {
      validateUrl(hopUrl, { allowPrivate: options.allowPrivate });
      assertOutboundAllowed(hopUrl);
      options.checkUrl?.(new URL(hopUrl));
    };
    checkHop(url);
    logger.info('proxy.request', `${method} ${safeUrlForLog(url)}`);

    // Direct connections only: the custom lookup pins the connection to a
    // validated IP, so DNS rebinding after validation cannot reach a private range.
    // proxy:false stops axios from falling back to HTTP_PROXY/HTTPS_PROXY.
    const direct = getDirectAgents(Boolean(options.allowPrivate));

    // axios redirects are disabled; follow them by hand so each hop is re-checked.
    let currentUrl = url;
    let currentMethod = method;
    let currentBody = body;
    let currentHeaders = headers;

    for (let hop = 0; ; hop++) {
      const axiosConfig: AxiosRequestConfig = {
        url: currentUrl,
        method: currentMethod.toLowerCase() as AxiosRequestConfig['method'],
        headers: currentHeaders,
        timeout,
        maxRedirects: 0,
        maxContentLength: maxBytes,
        maxBodyLength: MAX_REQUEST_BODY_BYTES,
        proxy: false,
        httpAgent: direct.httpAgent,
        httpsAgent: direct.httpsAgent,
        validateStatus: () => true, // do not throw on HTTP error statuses
      };
      if (responseType === 'buffer') {
        axiosConfig.responseType = 'arraybuffer';
      } else {
        // Keep the body as raw text; JSON parsing (if wanted) happens below.
        axiosConfig.responseType = 'text';
        axiosConfig.transformResponse = [(data) => data];
      }

      if (currentBody && currentMethod !== 'GET' && currentMethod !== 'HEAD') {
        axiosConfig.data = currentBody;
        const hasContentType = Object.keys(currentHeaders).some(
          k => k.toLowerCase() === 'content-type'
        );
        if (!hasContentType && typeof currentBody === 'object') {
          axiosConfig.headers = { ...axiosConfig.headers, 'Content-Type': 'application/json' };
        }
      }

      // codeql[js/request-forgery] The URL passed checkHop above: protocol policy, IMDS block,
      // private-range policy, the egress allowlist and DNS-pinned connections, on every hop.
      const response = await axios(axiosConfig);

      if (REDIRECT_STATUSES.has(response.status) && hop < MAX_REDIRECT_HOPS) {
        const location = response.headers?.location;
        if (typeof location === 'string' && location) {
          const nextUrl = new URL(location, currentUrl).toString();
          // A cross-origin (or https->http) hop keeps only the safe header allowlist.
          if (new URL(nextUrl).origin !== new URL(currentUrl).origin) {
            currentHeaders = Object.fromEntries(
              Object.entries(currentHeaders).filter(([k]) => CROSS_ORIGIN_SAFE_HEADERS.has(k.toLowerCase())),
            );
          }
          // 303 always becomes GET; 301/302 turn POST into GET; 307/308 keep method and body.
          if (response.status === 303
            || ((response.status === 301 || response.status === 302) && currentMethod.toUpperCase() === 'POST')) {
            currentMethod = 'GET';
            currentBody = undefined;
          }
          currentUrl = nextUrl;
          checkHop(currentUrl);
          logger.info('proxy.redirect', `${response.status} -> ${safeUrlForLog(currentUrl)}`);
          continue;
        }
      }

      logger.info('proxy.response', `${currentMethod} ${safeUrlForLog(currentUrl)} -> ${response.status}`);

      const responseHeaders: Record<string, string> = {};
      if (response.headers) {
        for (const [key, value] of Object.entries(response.headers)) {
          responseHeaders[key] = String(value);
        }
      }

      let data: unknown;
      if (responseType === 'buffer') {
        data = Buffer.from(response.data as ArrayBuffer);
      } else {
        if (typeof response.data !== 'string') {
          data = response.data;
        } else if (responseType === 'text') {
          data = response.data;
        } else {
          try {
            data = JSON.parse(response.data);
          } catch {
            data = response.data;
          }
        }
      }

      return { status: response.status, headers: responseHeaders, data };
    }
  } catch (error) {
    if (error instanceof RequestRejectedError) {
      return { status: error.status, headers: {}, data: { error: error.message, code: error.code } };
    }
    if (axios.isAxiosError(error)) {
      if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
        return { status: 504, headers: {}, data: { error: 'Gateway Timeout', code: 'GATEWAY_TIMEOUT' } };
      }
      if (error.message.includes('maxContentLength')) {
        return { status: 413, headers: {}, data: { error: 'Response too large', code: 'RESPONSE_TOO_LARGE' } };
      }
      if (error.code === 'ECONNREFUSED') {
        logger.warn('proxy.error', 'upstream connection refused');
        return { status: 502, headers: {}, data: { error: 'Proxy connection refused', code: 'PROXY_CONNECTION_REFUSED' } };
      }
      if (error.code === 'ETIMEDOUT') {
        logger.warn('proxy.error', 'upstream connection timed out');
        return { status: 504, headers: {}, data: { error: 'Proxy connection timeout', code: 'PROXY_TIMEOUT' } };
      }
      if (error.response) {
        return {
          status: error.response.status,
          headers: {},
          data: error.response.data || { error: 'Upstream error' }
        };
      }
    }
    logger.errorFromError('proxy.error', 'Proxy request failed', error);
    return { status: 502, headers: {}, data: { error: 'Bad Gateway', code: 'BAD_GATEWAY' } };
  }
}
