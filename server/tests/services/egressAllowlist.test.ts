import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import axios from 'axios';
import { lookup as dnsLookup } from 'node:dns/promises';

vi.mock('axios', () => {
  const fn = vi.fn();
  fn.isAxiosError = (e: unknown): boolean => Boolean(e && (e as { isAxiosError?: boolean }).isAxiosError);
  return { default: fn };
});
vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }));

const loggerWarn = vi.hoisted(() => vi.fn());
vi.mock('../../src/services/logger.js', () => ({
  logger: { info: vi.fn(), warn: loggerWarn, error: vi.fn(), errorFromError: vi.fn() },
}));

const {
  DEFAULT_OUTBOUND_ALLOWLIST,
  RequestRejectedError,
  assertOutboundAllowed,
  getOutboundAllowlist,
  proxyRequest,
  resetOutboundAllowlistForTests,
} = await import('../../src/services/proxyService.js');

const axiosMock = axios as unknown as Mock;
const dnsLookupMock = dnsLookup as unknown as Mock;

describe('outbound allowlist', () => {
  beforeEach(() => {
    delete process.env.OUTBOUND_ALLOWLIST;
    resetOutboundAllowlistForTests();
    axiosMock.mockReset();
    loggerWarn.mockReset();
    dnsLookupMock.mockReset().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  });

  afterEach(() => {
    delete process.env.OUTBOUND_ALLOWLIST;
    resetOutboundAllowlistForTests();
  });

  it('defaults to the documented host list', () => {
    expect([...getOutboundAllowlist()].sort()).toEqual([...DEFAULT_OUTBOUND_ALLOWLIST].sort());
    expect(getOutboundAllowlist().has('api.anthropic.com')).toBe(true);
    expect(getOutboundAllowlist().has('grep.app')).toBe(true);
  });

  it('reads OUTBOUND_ALLOWLIST once, as an exact, case-insensitive host list', () => {
    process.env.OUTBOUND_ALLOWLIST = ' Api.GitHub.com , example.org ';
    resetOutboundAllowlistForTests();
    expect([...getOutboundAllowlist()].sort()).toEqual(['api.github.com', 'example.org']);

    // Changing the variable after the first read has no effect.
    process.env.OUTBOUND_ALLOWLIST = 'other.example';
    expect(getOutboundAllowlist().has('other.example')).toBe(false);
    expect(getOutboundAllowlist().has('example.org')).toBe(true);
  });

  it('matches hosts exactly: no subdomain or suffix matching', () => {
    expect(() => assertOutboundAllowed('https://api.github.com/user')).not.toThrow();
    expect(() => assertOutboundAllowed('https://API.GITHUB.COM./user')).not.toThrow();
    expect(() => assertOutboundAllowed('https://evil.api.github.com/user')).toThrow(RequestRejectedError);
    expect(() => assertOutboundAllowed('https://api.github.com.evil.example/user')).toThrow(RequestRejectedError);
    expect(() => assertOutboundAllowed('https://example.com/')).toThrow(RequestRejectedError);
  });

  it('blocks a disallowed first URL with 403 EGRESS_BLOCKED and never calls axios', async () => {
    const result = await proxyRequest({ url: 'https://evil.example.net/steal?token=abc123', method: 'GET' });
    expect(result.status).toBe(403);
    expect(result.data).toMatchObject({ code: 'EGRESS_BLOCKED' });
    expect(axiosMock).not.toHaveBeenCalled();
  });

  it('logs egress.blocked with the host only, never the path or query string', async () => {
    await proxyRequest({
      url: 'https://evil.example.net/secret/path?token=abc123&key=sk-verysecretvalue',
      method: 'GET',
    });
    expect(loggerWarn).toHaveBeenCalledTimes(1);
    const [module, message, ...rest] = loggerWarn.mock.calls[0];
    expect(module).toBe('egress.blocked');
    expect(message).toBe('host=evil.example.net');
    expect(rest).toEqual([]);
    expect(JSON.stringify(loggerWarn.mock.calls)).not.toMatch(/abc123|sk-verysecretvalue|secret\/path/);
  });

  it('re-checks the allowlist on every redirect hop', async () => {
    axiosMock.mockResolvedValueOnce({
      status: 302,
      headers: { location: 'https://evil.example.net/landing?x=1' },
      data: '',
    });
    const result = await proxyRequest({ url: 'https://api.github.com/start', method: 'GET' });
    expect(result.status).toBe(403);
    expect(result.data).toMatchObject({ code: 'EGRESS_BLOCKED' });
    expect(axiosMock).toHaveBeenCalledTimes(1); // the second hop was never sent
    expect(loggerWarn.mock.calls[0]).toEqual(['egress.blocked', 'host=evil.example.net']);
  });

  it('allows a redirect between two allowlisted hosts', async () => {
    axiosMock
      .mockResolvedValueOnce({ status: 302, headers: { location: 'https://raw.githubusercontent.com/o/r/main/x' }, data: '' })
      .mockResolvedValueOnce({ status: 200, headers: { 'content-type': 'text/plain' }, data: 'hello' });
    const result = await proxyRequest({ url: 'https://github.com/o/r/raw/main/x', method: 'GET', responseType: 'text' });
    expect(result.status).toBe(200);
    expect(result.data).toBe('hello');
    expect(axiosMock).toHaveBeenCalledTimes(2);
  });

  it('runs the caller checkUrl on the first URL and on every hop', async () => {
    const checkUrl = vi.fn();
    axiosMock
      .mockResolvedValueOnce({ status: 301, headers: { location: 'https://raw.githubusercontent.com/x.png' }, data: '' })
      .mockResolvedValueOnce({ status: 200, headers: { 'content-type': 'image/png' }, data: new ArrayBuffer(3) });
    const result = await proxyRequest({
      url: 'https://github.com/o/r/raw/main/x.png',
      method: 'GET',
      responseType: 'buffer',
      checkUrl,
    });
    expect(result.status).toBe(200);
    expect(Buffer.isBuffer(result.data)).toBe(true);
    expect(checkUrl.mock.calls.map(([u]) => (u as URL).hostname)).toEqual(['github.com', 'raw.githubusercontent.com']);
  });

  it('maps a RequestRejectedError from checkUrl on a redirect hop to its status and code', async () => {
    axiosMock.mockResolvedValueOnce({ status: 302, headers: { location: 'https://api.github.com/elsewhere' }, data: '' });
    const result = await proxyRequest({
      url: 'https://github.com/o/r/raw/main/x.png',
      method: 'GET',
      checkUrl: (url) => {
        if (url.hostname === 'api.github.com') throw new RequestRejectedError('no', 403, 'IMAGE_HOST_NOT_ALLOWED');
      },
    });
    expect(result.status).toBe(403);
    expect(result.data).toMatchObject({ code: 'IMAGE_HOST_NOT_ALLOWED' });
    expect(axiosMock).toHaveBeenCalledTimes(1);
  });

  it('never logs the query string of an allowed request', async () => {
    const infoCalls: string[] = [];
    const { logger } = await import('../../src/services/logger.js');
    (logger.info as unknown as Mock).mockImplementation((_m: string, msg: string) => infoCalls.push(msg));
    axiosMock.mockResolvedValueOnce({ status: 200, headers: {}, data: '{}' });
    await proxyRequest({ url: 'https://api.github.com/search/repositories?q=topsecretterm', method: 'GET' });
    expect(infoCalls.length).toBeGreaterThan(0);
    expect(infoCalls.join('\n')).not.toContain('topsecretterm');
  });

  it('returns 413 RESPONSE_TOO_LARGE when the response exceeds maxBytes', async () => {
    axiosMock.mockRejectedValueOnce({
      isAxiosError: true,
      code: 'ERR_BAD_RESPONSE',
      message: 'maxContentLength size of 10 exceeded',
    });
    const result = await proxyRequest({ url: 'https://api.github.com/big', method: 'GET', maxBytes: 10 });
    expect(result.status).toBe(413);
    expect(result.data).toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
    expect(axiosMock.mock.calls[0][0].maxContentLength).toBe(10);
  });

  it('honours responseType: text keeps the raw string, json parses, buffer returns a Buffer', async () => {
    axiosMock.mockResolvedValueOnce({ status: 200, headers: {}, data: '{"a":1}' });
    const asText = await proxyRequest({ url: 'https://api.github.com/x', method: 'GET', responseType: 'text' });
    expect(asText.data).toBe('{"a":1}');
    expect(axiosMock.mock.calls[0][0].responseType).toBe('text');

    axiosMock.mockResolvedValueOnce({ status: 200, headers: {}, data: '{"a":1}' });
    const asJson = await proxyRequest({ url: 'https://api.github.com/x', method: 'GET' });
    expect(asJson.data).toEqual({ a: 1 });

    axiosMock.mockResolvedValueOnce({ status: 200, headers: {}, data: Uint8Array.from([1, 2, 3]).buffer });
    const asBuffer = await proxyRequest({ url: 'https://api.github.com/x', method: 'GET', responseType: 'buffer' });
    expect(axiosMock.mock.calls[2][0].responseType).toBe('arraybuffer');
    expect(asBuffer.data).toEqual(Buffer.from([1, 2, 3]));
  });
  it('requires https and the default port', () => {
    expect(() => assertOutboundAllowed('http://api.github.com/user')).toThrow(RequestRejectedError);
    expect(() => assertOutboundAllowed('https://api.github.com:8443/user')).toThrow(RequestRejectedError);
    expect(() => assertOutboundAllowed('https://api.github.com:443/user')).not.toThrow();
    expect(() => assertOutboundAllowed('wss://api.github.com/x')).toThrow(RequestRejectedError);
  });

  it('drops every header except Accept, User-Agent and Content-Type on a cross-origin hop', async () => {
    axiosMock
      .mockResolvedValueOnce({ status: 302, headers: { location: 'https://raw.githubusercontent.com/x' }, data: '' })
      .mockResolvedValueOnce({ status: 200, headers: {}, data: 'ok' });
    await proxyRequest({
      url: 'https://api.github.com/start',
      method: 'GET',
      responseType: 'text',
      headers: {
        Accept: 'text/plain',
        'User-Agent': 'ua',
        'Content-Type': 'application/json',
        Authorization: 'Bearer secret',
        'x-api-key': 'secret',
        'anthropic-version': '2023-06-01',
        Cookie: 'a=b',
      },
    });
    const second = axiosMock.mock.calls[1][0].headers as Record<string, string>;
    expect(Object.keys(second).map((k) => k.toLowerCase()).sort()).toEqual(['accept', 'content-type', 'user-agent']);
  });

  it('keeps all headers on a same-origin hop', async () => {
    axiosMock
      .mockResolvedValueOnce({ status: 302, headers: { location: '/other' }, data: '' })
      .mockResolvedValueOnce({ status: 200, headers: {}, data: 'ok' });
    await proxyRequest({ url: 'https://api.github.com/start', method: 'GET', responseType: 'text', headers: { 'x-api-key': 'k' } });
    expect(axiosMock.mock.calls[1][0].headers['x-api-key']).toBe('k');
  });

  it('never puts upstream error text in the client body', async () => {
    axiosMock.mockRejectedValueOnce({ isAxiosError: true, code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 10.1.2.3:443 /secret?token=abc' });
    const refused = await proxyRequest({ url: 'https://api.github.com/x', method: 'GET' });
    expect(JSON.stringify(refused.data)).not.toMatch(/10\.1\.2\.3|token=abc|details/);
    axiosMock.mockRejectedValueOnce(new Error('internal failure token=abc'));
    const bad = await proxyRequest({ url: 'https://api.github.com/x', method: 'GET' });
    expect(bad.status).toBe(502);
    expect(JSON.stringify(bad.data)).not.toMatch(/token=abc|details/);
  });

  it('blocks private, CGNAT, loopback and link-local IP literals by CIDR', async () => {
    const { isPrivateOrLoopback } = await import('../../src/services/proxyService.js');
    for (const h of ['100.64.0.1', '100.127.255.254', '127.5.5.5', '169.254.10.10', '10.9.9.9', '172.31.0.1', '192.168.1.1', '::1', 'fc00::1', 'fdab::1', 'fe80::1', 'febf::1', '::ffff:100.64.0.1']) {
      expect(isPrivateOrLoopback(h), h).toBe(true);
    }
    for (const h of ['100.63.255.255', '100.128.0.0', '8.8.8.8', '172.32.0.1', '2606:4700::1111']) {
      expect(isPrivateOrLoopback(h), h).toBe(false);
    }
  });
});
