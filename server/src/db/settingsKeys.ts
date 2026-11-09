/** Legacy settings rows from removed features. Never served, exported or imported. */
export const LEGACY_SETTING_KEYS = ['proxy_config', 'rpc_download_config'] as const;

/** Owner-editable extra instructions for repository analysis (part of the cached prompt prefix). */
export const CUSTOM_ANALYSIS_PROMPT_KEY = 'ai.customAnalysisPrompt';

/** Server-owned AI state (credit_low flag and probe time). Never served, exported or imported. */
export const AI_STATE_SETTING_KEY = 'ai.state';

/** Settings keys that are server-side configuration and never leave through the API. */
export const EXCLUDED_SETTING_KEYS: ReadonlySet<string> = new Set([
  'github_token',
  AI_STATE_SETTING_KEY,
  ...LEGACY_SETTING_KEYS,
]);
