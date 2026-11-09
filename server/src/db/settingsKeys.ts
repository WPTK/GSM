/** Legacy settings rows from removed features. Never served, exported or imported. */
export const LEGACY_SETTING_KEYS = ['proxy_config', 'rpc_download_config'] as const;

/** Settings keys that are server-side configuration and never leave through the API. */
export const EXCLUDED_SETTING_KEYS: ReadonlySet<string> = new Set(['github_token', ...LEGACY_SETTING_KEYS]);
