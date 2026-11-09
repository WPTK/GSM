import { afterEach, describe, expect, it, vi } from 'vitest';
import { backend } from './backendAdapter';

vi.mock('../store/useAppStore', () => ({
  useAppStore: { getState: () => ({ backendApiSecret: '' }) },
}));

function make429Response(headers: Record<string, string>): Response {
  return {
    ok: false,
    status: 429,
    statusText: 'Too Many Requests',
    json: async () => ({ message: 'rate limited' }),
    headers: {
      get: (name: string) => headers[name] ?? headers[name.toLowerCase()] ?? null,
    },
  } as unknown as Response;
}

type BackendAdapterLike = { _backendUrl: string | null };

describe('backendAdapter 429 Retry-After 解析', () => {
  const adapter = backend as unknown as BackendAdapterLike;

  afterEach(() => {
    vi.mocked(window.fetch).mockReset();
    adapter._backendUrl = null;
  });

  it('解析 retry-after-ms（毫秒，优先于 retry-after）', async () => {
    adapter._backendUrl = 'http://localhost:3000/api';
    vi.mocked(window.fetch).mockResolvedValue(make429Response({ 'retry-after-ms': '60000', 'retry-after': '5' }));

    await expect(backend.checkRateLimit()).rejects.toMatchObject({
      statusCode: 429,
      retryAfterMs: 60000,
    });
  });

  it('解析数值型 retry-after（秒 → 毫秒）', async () => {
    adapter._backendUrl = 'http://localhost:3000/api';
    vi.mocked(window.fetch).mockResolvedValue(make429Response({ 'retry-after': '120' }));

    await expect(backend.checkRateLimit()).rejects.toMatchObject({
      statusCode: 429,
      retryAfterMs: 120000,
    });
  });

  it('解析 HTTP-date 型 retry-after', async () => {
    adapter._backendUrl = 'http://localhost:3000/api';
    const future = new Date(Date.now() + 2 * 60 * 60 * 1000);
    vi.mocked(window.fetch).mockResolvedValue(make429Response({ 'retry-after': future.toUTCString() }));

    const err = (await backend.checkRateLimit().catch((e: Error) => e)) as Error & { statusCode?: number; retryAfterMs?: number };
    expect(err.statusCode).toBe(429);
    expect(typeof err.retryAfterMs).toBe('number');
    expect(err.retryAfterMs!).toBeGreaterThan(0);
    expect(err.retryAfterMs!).toBeLessThanOrEqual(2 * 60 * 60 * 1000);
  });

  it('无法解析的 retry-after 不设置 retryAfterMs', async () => {
    adapter._backendUrl = 'http://localhost:3000/api';
    vi.mocked(window.fetch).mockResolvedValue(make429Response({ 'retry-after': 'bogus-value' }));

    const err = (await backend.checkRateLimit().catch((e: Error) => e)) as Error & { statusCode?: number; retryAfterMs?: number };
    expect(err.statusCode).toBe(429);
    expect(err.retryAfterMs).toBeUndefined();
  });
});

function makeHealthOkResponse(): Response {
  return {
    ok: true,
    json: async () => ({ status: 'ok' }),
  } as unknown as Response;
}

function makeJsonResponse(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
    headers: { forEach: () => {} },
    clone: () => ({ text: async () => '' }),
  } as unknown as Response;
}

describe('backendAdapter settings hydration', () => {
  const adapter = backend as unknown as BackendAdapterLike;

  afterEach(() => {
    vi.mocked(window.fetch).mockReset();
    adapter._backendUrl = null;
  });

  it('parses JSON-serialized object and array settings from SQLite TEXT values', async () => {
    adapter._backendUrl = 'http://localhost:3000/api';
    vi.mocked(window.fetch).mockResolvedValue(makeJsonResponse({
      customCategories: '[{"id":"custom-1","name":"Custom","icon":"folder","keywords":["custom"]}]',
      hiddenDefaultCategoryIds: '["hidden-default"]',
      categoryOrder: '["custom-1","hidden-default"]',
      assetFilters: '[{"id":"zip","name":"Archives","keywords":["zip"]}]',
      releaseSourceSettings: '{"source":"github"}',
      defaultCategoryOverrides: '{"web":{"name":"Web Apps","keywords":["web"]}}',
      collapsedSidebarCategoryCount: '34',
    }));

    await expect(backend.fetchSettings()).resolves.toEqual({
      customCategories: [{ id: 'custom-1', name: 'Custom', icon: 'folder', keywords: ['custom'] }],
      hiddenDefaultCategoryIds: ['hidden-default'],
      categoryOrder: ['custom-1', 'hidden-default'],
      assetFilters: [{ id: 'zip', name: 'Archives', keywords: ['zip'] }],
      releaseSourceSettings: { source: 'github' },
      defaultCategoryOverrides: { web: { name: 'Web Apps', keywords: ['web'] } },
      collapsedSidebarCategoryCount: 34,
    });
  });

  it('keeps already typed settings unchanged', async () => {
    adapter._backendUrl = 'http://localhost:3000/api';
    const customCategories = [{ id: 'custom-1' }];
    const defaultCategoryOverrides = { web: { name: 'Web' } };
    vi.mocked(window.fetch).mockResolvedValue(makeJsonResponse({
      customCategories,
      defaultCategoryOverrides,
      collapsedSidebarCategoryCount: 20,
    }));

    const settings = await backend.fetchSettings();
    expect(settings.customCategories).toBe(customCategories);
    expect(settings.defaultCategoryOverrides).toBe(defaultCategoryOverrides);
    expect(settings.collapsedSidebarCategoryCount).toBe(20);
  });

  it('leaves malformed JSON strings unchanged', async () => {
    adapter._backendUrl = 'http://localhost:3000/api';
    const response = {
      defaultCategoryOverrides: '{not-json',
      customCategories: '[]oops',
      collapsedSidebarCategoryCount: '0',
    };
    vi.mocked(window.fetch).mockResolvedValue(makeJsonResponse(response));

    await expect(backend.fetchSettings()).resolves.toEqual(response);
  });

  it.each([null, [], 'settings', 1])('rejects invalid top-level settings payloads: %j', async payload => {
    adapter._backendUrl = 'http://localhost:3000/api';
    vi.mocked(window.fetch).mockResolvedValue(makeJsonResponse(payload));

    await expect(backend.fetchSettings()).rejects.toThrow('invalid settings response');
  });
});

describe('backendAdapter same-origin transport and cookie auth', () => {
  const adapter = backend as unknown as BackendAdapterLike;

  afterEach(() => {
    vi.mocked(window.fetch).mockReset();
    adapter._backendUrl = null;
  });

  it('probes only its own origin, with same-origin credentials and no redirects', async () => {
    vi.mocked(window.fetch).mockResolvedValue(makeHealthOkResponse());

    await backend.init();

    expect(window.fetch).toHaveBeenCalledTimes(1);
    expect(window.fetch).toHaveBeenCalledWith(
      `${window.location.origin}/api/health`,
      expect.objectContaining({ redirect: 'error', credentials: 'same-origin' })
    );
    expect(backend.isAvailable).toBe(true);
  });

  it('never persists a backend URL or secret', async () => {
    vi.mocked(window.fetch).mockResolvedValue(makeHealthOkResponse());
    await backend.init();
    for (let i = 0; i < localStorage.length; i++) {
      expect(localStorage.key(i)).not.toMatch(/backend-url/);
    }
  });

  it('login posts the secret once in the body and reports success on 204', async () => {
    adapter._backendUrl = '/api';
    vi.mocked(window.fetch).mockResolvedValue({ ok: true, status: 204 } as unknown as Response);

    await expect(backend.login('s3cret')).resolves.toBe(true);

    const [url, init] = vi.mocked(window.fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/auth/session');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('same-origin');
    expect(JSON.parse(String(init.body))).toEqual({ secret: 's3cret' });
    expect(JSON.stringify(init.headers)).not.toContain('s3cret');
  });

  it('login returns false on 401', async () => {
    adapter._backendUrl = '/api';
    vi.mocked(window.fetch).mockResolvedValue({ ok: false, status: 401 } as unknown as Response);
    await expect(backend.login('wrong')).resolves.toBe(false);
  });

  it('authStatus reads the cookie-based session state', async () => {
    adapter._backendUrl = '/api';
    vi.mocked(window.fetch).mockResolvedValue(makeJsonResponse({ authenticated: true, githubConfigured: false }));
    await expect(backend.authStatus()).resolves.toEqual({ authenticated: true, githubConfigured: false });
  });

  it('config requests do not ask the server to decrypt secrets', async () => {
    adapter._backendUrl = '/api';
    vi.mocked(window.fetch).mockResolvedValue(makeJsonResponse([]));
    await backend.fetchAIConfigs();
    expect(String(vi.mocked(window.fetch).mock.calls[0][0])).not.toContain('decrypt');
  });
});

describe('backendAdapter 探测源协议（file:// 桌面端不探测同源 /api）', () => {
  const adapter = backend as unknown as BackendAdapterLike;
  const originalLocation = window.location;

  // jsdom 的 Location 实例属性不可重定义，但 `window.location` 本身可替换。
  const setLocation = (protocol: string, origin: string, hostname: string): void => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: { protocol, origin, hostname },
    });
  };

  afterEach(() => {
    Object.defineProperty(window, 'location', { configurable: true, writable: true, value: originalLocation });
    vi.mocked(window.fetch).mockReset();
    adapter._backendUrl = null;
  });

  it('桌面端 file:// 页面：不发起 file:///api/health 探测', async () => {
    setLocation('file:', 'file://', '');

    await backend.init();

    expect(window.fetch).not.toHaveBeenCalled();
    expect(backend.isAvailable).toBe(false);
  });

  it('HTTP(S) 页面：保留同源 /api 探测', async () => {
    setLocation('https:', 'https://app.example.com', 'app.example.com');
    vi.mocked(window.fetch).mockResolvedValue(makeHealthOkResponse());

    await backend.init();

    expect(window.fetch).toHaveBeenCalledWith(
      'https://app.example.com/api/health',
      expect.objectContaining({ redirect: 'error' })
    );
    expect(backend.isAvailable).toBe(true);
  });
});