
import { TranslateFn } from '../../i18n/useT';
import React from 'react';
import { ExternalLink, Mail, Monitor, Package } from 'lucide-react';
import { Github } from '../ui/brand-icons';
import { version } from '../../../package.json';
import { PROJECT_REPO_URL } from '../../constants/project';
import { Button } from '../ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Switch } from '../ui/switch';
import { useDesktopActions } from '../../features/settings/hooks/useDesktopActions';

interface GeneralPanelProps {
  t: TranslateFn;
}

export const GeneralPanel: React.FC<GeneralPanelProps> = ({ t }) => {
  const desktop = useDesktopActions();

  return (
    <div className="space-y-6">
      <div className="flex items-center space-x-3">
        <Package className="h-6 w-6 text-muted-foreground dark:text-muted-foreground" />
        <h3 className="text-lg font-semibold text-foreground dark:text-foreground">{t('generalPanel.general-settings')}</h3>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center space-x-3">
            <Package className="h-5 w-5 text-muted-foreground dark:text-muted-foreground" />
            <CardTitle>{t('generalPanel.check-for-updates')}</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="mb-1 text-sm text-muted-foreground dark:text-muted-foreground">{t('generalPanel.current-version-v-version', { version: version })}</p>
          </div>
        </CardContent>
      </Card>

      {desktop.supported && (
        <Card>
          <CardHeader>
            <div className="flex items-center space-x-3">
              <Monitor className="h-5 w-5 text-muted-foreground dark:text-muted-foreground" />
              <CardTitle>{t('generalPanel.desktop')}</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium text-foreground dark:text-foreground">{t('generalPanel.launch-at-startup')}</p>
                <p className="mt-1 text-xs text-muted-foreground dark:text-muted-foreground">{t('generalPanel.start-the-client-automatically-after-login-off-b')}</p>
              </div>
              <Switch
                aria-label={t('generalPanel.launch-at-startup')}
                checked={desktop.prefs.autoLaunch}
                disabled={desktop.loading || desktop.saving}
                onCheckedChange={(checked) => { void desktop.toggleAutoLaunch(checked); }}
              />
            </div>
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium text-foreground dark:text-foreground">{t('generalPanel.minimize-to-tray-on-close')}</p>
                <p className="mt-1 text-xs text-muted-foreground dark:text-muted-foreground">{t('generalPanel.keep-running-in-the-tray-after-closing-right-cli')}</p>
              </div>
              <Switch
                aria-label={t('generalPanel.minimize-to-tray-on-close')}
                checked={desktop.prefs.closeToTray}
                disabled={desktop.loading || desktop.saving}
                onCheckedChange={(checked) => { void desktop.toggleCloseToTray(checked); }}
              />
            </div>
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium text-foreground dark:text-foreground">{t('generalPanel.hide-to-tray-on-minimize')}</p>
                <p className="mt-1 text-xs text-muted-foreground dark:text-muted-foreground">{t('generalPanel.hide-to-the-tray-when-minimizing-on-by-default')}</p>
              </div>
              <Switch
                aria-label={t('generalPanel.hide-to-tray-on-minimize')}
                checked={desktop.prefs.minimizeToTray}
                disabled={desktop.loading || desktop.saving}
                onCheckedChange={(checked) => { void desktop.toggleMinimizeToTray(checked); }}
              />
            </div>
            {desktop.error && (
              <p role="alert" className="text-xs text-destructive dark:text-destructive">{desktop.error}</p>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <div className="flex items-center space-x-3">
            <Mail className="h-5 w-5 text-muted-foreground dark:text-muted-foreground" />
            <CardTitle>{t('generalPanel.contact-information')}</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <p className="mb-4 text-sm text-muted-foreground dark:text-muted-foreground">{t('generalPanel.if-you-encounter-any-issues-or-have-suggestions')}</p>
          <div className="flex flex-col gap-3 sm:flex-row">
            <Button type="button" variant="outline" onClick={() => { const newWindow = window.open(PROJECT_REPO_URL, '_blank', 'noopener,noreferrer'); if (newWindow) newWindow.opener = null; }} className="gap-2">
              <Github className="h-5 w-5" />
              <span>{t('generalPanel.github')}</span>
              <ExternalLink className="h-4 w-4" />
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};
