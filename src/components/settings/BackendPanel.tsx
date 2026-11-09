
import { TranslateFn } from '../../i18n/useT';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import React from 'react';
import { Server, Plug, RefreshCw, Upload, Download, CheckCircle, AlertCircle, LogOut } from 'lucide-react';
import { useBackendSettingsActions } from '../../features/settings/hooks/useBackendSettingsActions';

interface BackendPanelProps {
  t: TranslateFn;
}

export const BackendPanel: React.FC<BackendPanelProps> = ({ t }) => {
  const {
    status,
    health,
    githubConfigured,
    backendAvailable,
    isSyncingToBackend,
    isSyncingFromBackend,
    testConnection: handleTestConnection,
    logout: handleLogout,
    syncToBackend: handleSyncToBackend,
    syncFromBackend: handleSyncFromBackend,
  } = useBackendSettingsActions();
  const getStatusIcon = () => {
    switch (status) {
      case 'connected':
        return <CheckCircle className="w-5 h-5" />;
      case 'checking':
        return <RefreshCw className="w-5 h-5 animate-spin" />;
      default:
        return <AlertCircle className="w-5 h-5" />;
    }
  };

  const getStatusText = () => {
    switch (status) {
      case 'connected':
        return t('backendPanel.connected');
      case 'checking':
        return t('backendPanel.checking');
      default:
        return t('backendPanel.not-connected');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-3">
          <Server className="w-6 h-6 text-muted-foreground dark:text-muted-foreground " />
          <h3 className="text-lg font-semibold text-foreground dark:text-foreground">
            {t('backendPanel.backend-server')}
          </h3>
        </div>
        <Badge
          variant={status === 'connected' ? 'default' : status === 'checking' ? 'secondary' : 'destructive'}
          className="gap-2 px-3 py-1 text-sm"
        >
          {getStatusIcon()}
          <span>{getStatusText()}</span>
        </Badge>
      </div>

      {health && (
        <div className="p-4 bg-background dark:bg-muted/40 rounded-lg border border-border dark:border-border">
          <div className="flex items-center space-x-2 mb-2">
            <CheckCircle className="w-5 h-5 text-muted-foreground dark:text-muted-foreground" />
            <span className="font-medium text-foreground dark:text-foreground">
              {t('backendPanel.connection-ok')}
            </span>
          </div>
          <p className="text-sm text-muted-foreground dark:text-muted-foreground">
            {t('backendPanel.version')}: {health.version}
          </p>
        </div>
      )}

      <div className="p-4 bg-background dark:bg-muted/40 rounded-lg border border-border dark:border-border">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <p className="text-sm text-foreground dark:text-foreground">
            {githubConfigured === false
              ? t('backendPanel.github-not-configured')
              : githubConfigured === true
                ? t('backendPanel.github-connected')
                : null}
          </p>
          <div className="flex space-x-3">
            <Button
              onClick={handleTestConnection}
              disabled={status === 'checking'}
              className="flex items-center justify-center space-x-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50"
            >
              {status === 'checking' ? (
                <RefreshCw className="w-4 h-4 animate-spin" />
              ) : (
                <Plug className="w-4 h-4" />
              )}
              <span>{t('backendPanel.test-connection')}</span>
            </Button>
            <Button variant="outline" onClick={handleLogout} className="flex items-center space-x-2">
              <LogOut className="w-4 h-4" />
              <span>{t('header.logout')}</span>
            </Button>
          </div>
        </div>
      </div>

      {backendAvailable && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="p-6 bg-background dark:bg-muted/40 rounded-lg border border-border dark:border-border">
            <div className="flex items-center space-x-3 mb-4">
              <Upload className="w-8 h-8 text-muted-foreground dark:text-muted-foreground" />
              <div>
                <h4 className="font-medium text-foreground dark:text-foreground">
                  {t('backendPanel.sync-to-backend')}
                </h4>
                <p className="text-sm text-muted-foreground dark:text-muted-foreground">
                  {t('backendPanel.upload-local-data-to-backend')}
                </p>
              </div>
            </div>
            <Button
              onClick={handleSyncToBackend}
              disabled={isSyncingToBackend}
              className="h-auto w-full flex items-center justify-center space-x-2 px-4 py-3 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isSyncingToBackend ? (
                <RefreshCw className="w-5 h-5 animate-spin" />
              ) : (
                <Upload className="w-5 h-5" />
              )}
              <span>{isSyncingToBackend ? t('backendPanel.syncing') : t('backendPanel.start-sync')}</span>
            </Button>
          </div>

          <div className="p-6 bg-background dark:bg-muted/40 rounded-lg border border-border dark:border-border">
            <div className="flex items-center space-x-3 mb-4">
              <Download className="w-8 h-8 text-muted-foreground dark:text-muted-foreground" />
              <div>
                <h4 className="font-medium text-foreground dark:text-foreground">
                  {t('backendPanel.sync-from-backend')}
                </h4>
                <p className="text-sm text-muted-foreground dark:text-muted-foreground">
                  {t('backendPanel.download-data-from-backend-to-local')}
                </p>
              </div>
            </div>
            <Button
              onClick={handleSyncFromBackend}
              disabled={isSyncingFromBackend}
              className="h-auto w-full flex items-center justify-center space-x-2 px-4 py-3 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isSyncingFromBackend ? (
                <RefreshCw className="w-5 h-5 animate-spin" />
              ) : (
                <Download className="w-5 h-5" />
              )}
              <span>{isSyncingFromBackend ? t('backendPanel.syncing') : t('backendPanel.start-sync')}</span>
            </Button>
          </div>
        </div>
      )}

      <div className="p-4 bg-background dark:bg-muted/40 rounded-lg">
        <h4 className="font-medium text-foreground dark:text-foreground mb-2">
          {t('backendPanel.sync-includes')}
        </h4>
        <ul className="text-sm text-muted-foreground dark:text-muted-foreground space-y-1">
          <li>• {t('backendPanel.github-stars-repository-list')}</li>
          <li>• {t('backendPanel.release-information')}</li>
          <li>• {t('backendPanel.ai-service-configurations')}</li>
          <li>• {t('backendPanel.category-visibility-settings')}</li>
        </ul>
      </div>
    </div>
  );
};
