import type {
  ProxyConfig,
  Repository,
  Category,
  EmbeddingConfig,
  McpServiceConfig,
  Release,
} from '../types';
import type { ElectronPluginAPI } from '../plugins/types';
import type { LogEntry } from './logger';

/** Alias of persisted MCP prefs — keep identical to McpServiceConfig to avoid drift. */
export type McpLocalConfig = McpServiceConfig;

/** Renderer → main diagnostics payload; entries are already sanitized. */
export interface DiagnosticsIpcPayload {
  /** Renderer debug flag piggybacked so main-process capture level follows the same switch. */
  debugMode: boolean;
  entries: LogEntry[];
}

/** Network/time window options for reading the main-process journal. */
export interface DiagnosticsReadOptions {
  since?: string;
  limit?: number;
}

export interface DiagnosticsReadResult {
  success: boolean;
  main: LogEntry[];
  plugins: LogEntry[];
  error?: string;
}

export interface DiagnosticsExportPayload {
  /** null = all history; otherwise hours back (1..168). */
  windowHours: number | null;
  frontendLogs: LogEntry[];
  backendLogs: LogEntry[];
  networkEntries: LogEntry[];
  environment?: Record<string, unknown>;
  sanitizationNote?: string;
}

export interface DiagnosticsExportResult {
  success: boolean;
  canceled?: boolean;
  filePath?: string;
  error?: string;
}

export interface DiagnosticsElectronAPI {
  append: (payload: DiagnosticsIpcPayload) => Promise<{ success: boolean; accepted?: number; error?: string }>;
  /** One-way send (ipcRenderer.send) used on pagehide/beforeunload. */
  flush: (payload: DiagnosticsIpcPayload) => void;
  read: (options?: DiagnosticsReadOptions) => Promise<DiagnosticsReadResult>;
  exportBundle: (payload: DiagnosticsExportPayload) => Promise<DiagnosticsExportResult>;
}

/** Secrets stay in main-process memory only (IPC snapshot); not written to disk by MCP server. */
export interface McpVectorRuntimeConfig {
  enabled: boolean;
  workerUrl: string;
  authToken: string;
  searchThreshold?: number;
  searchTopK?: number;
  embedding: Pick<
    EmbeddingConfig,
    'apiType' | 'baseUrl' | 'apiKey' | 'model' | 'dimensions'
  > | null;
}

export interface McpDataSnapshot {
  repositories: Repository[];
  customCategories: Category[];
  releases: Release[];
  vectorSearchConfig: McpVectorRuntimeConfig;
  snapshotAt: string;
}

export interface McpElectronAPI {
  setConfig: (config: McpLocalConfig) => Promise<{ success: boolean; error?: string }>;
  getConfig: () => Promise<McpLocalConfig | null>;
  pushSnapshot: (snapshot: McpDataSnapshot) => Promise<{ success: boolean }>;
  start: () => Promise<{ success: boolean; error?: string; url?: string }>;
  stop: () => Promise<{ success: boolean }>;
  getStatus: () => Promise<{ running: boolean; url?: string; error?: string }>;
}

/** Desktop client prefs: auto-launch + tray behavior (#345). Electron only. */
export interface DesktopPrefs {
  autoLaunch: boolean;
  closeToTray: boolean;
  minimizeToTray: boolean;
}

export type DesktopPrefsResult = { success: boolean; prefs?: DesktopPrefs; error?: string };

export interface DesktopElectronAPI {
  getPrefs: () => Promise<DesktopPrefs>;
  setAutoLaunch: (enabled: boolean) => Promise<DesktopPrefsResult>;
  setCloseToTray: (enabled: boolean) => Promise<DesktopPrefsResult>;
  setMinimizeToTray: (enabled: boolean) => Promise<DesktopPrefsResult>;
  show: () => Promise<{ success: boolean }>;
}

interface ElectronAPI {
  setProxy: (config: ProxyConfig) => Promise<{ success: boolean }>;
  getProxy: () => Promise<ProxyConfig>;
  testProxy: (config: ProxyConfig) => Promise<{ success: boolean; error?: string }>;
  desktop?: DesktopElectronAPI;
  mcp?: McpElectronAPI;
  /** Diagnostics bridge (desktop only; absent in web builds). */
  diagnostics?: DiagnosticsElectronAPI;
  plugins?: ElectronPluginAPI & {
    registry?: { load: () => Promise<import('./pluginRegistryService').PluginRegistryLoadResult> };
    marketplace?: import('./pluginMarketplaceService').MarketplaceElectronAPI;
  };
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

export const isElectron = (): boolean => {
  return typeof window !== 'undefined' && !!window.electronAPI;
};

export const electronProxy = {
  async setProxy(config: ProxyConfig): Promise<void> {
    if (window.electronAPI) {
      await window.electronAPI.setProxy(config);
    }
  },

  async getProxy(): Promise<ProxyConfig | null> {
    return window.electronAPI?.getProxy() ?? null;
  },

  async testProxy(config: ProxyConfig): Promise<{ success: boolean; error?: string }> {
    if (!window.electronAPI) {
      return { success: false, error: 'Not running in Electron' };
    }
    return window.electronAPI.testProxy(config);
  },
};

/** Default prefs mirror the main-process defaults; used before IPC resolves. */
export const DEFAULT_DESKTOP_PREFS: DesktopPrefs = {
  autoLaunch: false,
  closeToTray: true,
  minimizeToTray: true,
};

/** Desktop (auto-launch + tray) bridge. No-op when not in the Electron client. */
export const desktopBridge = {
  isSupported(): boolean {
    return isElectron() && !!window.electronAPI?.desktop;
  },

  async getPrefs(): Promise<DesktopPrefs> {
    if (!window.electronAPI?.desktop) return { ...DEFAULT_DESKTOP_PREFS };
    try {
      return await window.electronAPI.desktop.getPrefs();
    } catch {
      return { ...DEFAULT_DESKTOP_PREFS };
    }
  },

  async setAutoLaunch(enabled: boolean): Promise<DesktopPrefsResult> {
    if (!window.electronAPI?.desktop) {
      return { success: false, error: 'Not running in Electron' };
    }
    return window.electronAPI.desktop.setAutoLaunch(enabled);
  },

  async setCloseToTray(enabled: boolean): Promise<DesktopPrefsResult> {
    if (!window.electronAPI?.desktop) {
      return { success: false, error: 'Not running in Electron' };
    }
    return window.electronAPI.desktop.setCloseToTray(enabled);
  },

  async setMinimizeToTray(enabled: boolean): Promise<DesktopPrefsResult> {
    if (!window.electronAPI?.desktop) {
      return { success: false, error: 'Not running in Electron' };
    }
    return window.electronAPI.desktop.setMinimizeToTray(enabled);
  },

  async show(): Promise<{ success: boolean }> {
    if (!window.electronAPI?.desktop) {
      return { success: false };
    }
    return window.electronAPI.desktop.show();
  },
};
