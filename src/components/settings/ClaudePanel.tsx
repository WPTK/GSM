import React from 'react';
import { Bot, Languages } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { TranslateFn } from '../../i18n/useT';
import { i18n } from '../../i18n';
import { Textarea } from '../ui/textarea';
import { Input } from '../ui/input';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import type { TranslationEngine } from '../../types';
import type { RepositoryChatTaskDepth } from '../../types/repositoryChat';
import { useAppStore } from '../../store/useAppStore';
import { useClaudeStatus } from '../../hooks/useClaudeStatus';
import { useClaudePanelActions } from '../../features/settings/hooks/useClaudePanelActions';
import { MAX_CUSTOM_ANALYSIS_PROMPT_CHARS } from '../../services/claudeContract';

interface ClaudePanelProps {
  t: TranslateFn;
}

/**
 * Claude is configured on the server (key and models); this panel shows the verified
 * status, the one setting the owner can edit (the analysis prompt) and the local
 * repository-chat and translation preferences. The browser never holds a provider key.
 */
export const ClaudePanel: React.FC<ClaudePanelProps> = ({ t }) => {
  const {
    language,
    translationEngine,
    autoTranslateRepoDescription,
    repositoryChatSettings,
    setTranslationEngine,
    setAutoTranslateRepoDescription,
    setRepositoryChatSettings,
  } = useAppStore(useShallow((state) => ({
    language: state.language,
    translationEngine: state.translationEngine,
    autoTranslateRepoDescription: state.autoTranslateRepoDescription,
    repositoryChatSettings: state.repositoryChatSettings,
    setTranslationEngine: state.setTranslationEngine,
    setAutoTranslateRepoDescription: state.setAutoTranslateRepoDescription,
    setRepositoryChatSettings: state.setRepositoryChatSettings,
  })));
  const tChat = i18n.getFixedT(language, 'chat');
  const { connected, status, loading } = useClaudeStatus();
  const prompt = useClaudePanelActions();

  return (
    <div className="space-y-6">
      <div className="flex items-center space-x-3">
        <Bot className="w-6 h-6 text-muted-foreground" />
        <h3 className="text-lg font-semibold text-foreground">{t('claudePanel.title')}</h3>
      </div>

      <section className="rounded-lg border border-border bg-background p-4 dark:bg-muted/40" aria-labelledby="claude-status-heading">
        <h4 id="claude-status-heading" className="text-sm font-medium text-foreground">
          {loading
            ? t('claudePanel.checking')
            : connected
              ? t('claudePanel.connected')
              : t('claudePanel.not-connected')}
        </h4>
        {connected && status && (
          <dl className="mt-2 space-y-1 text-sm text-muted-foreground">
            {status.keySuffix && <dd>{t('claudePanel.key-suffix', { suffix: status.keySuffix })}</dd>}
            <dd>{t('claudePanel.chat-model', { model: status.models.chat })}</dd>
            <dd>{t('claudePanel.bulk-model', { model: status.models.bulk })}</dd>
            {status.cache?.cache === 'skipped' && (
              <dd role="note">{t('claudePanel.cache-skipped', { prefix: status.cache.prefixTokens, min: status.cache.minTokens })}</dd>
            )}
          </dl>
        )}
      </section>

      <section className="rounded-lg border border-border bg-background p-4 dark:bg-muted/40" aria-labelledby="claude-prompt-heading">
        <h4 id="claude-prompt-heading" className="text-sm font-medium text-foreground">{t('claudePanel.prompt-label')}</h4>
        <p className="mt-1 text-xs text-muted-foreground">{t('claudePanel.prompt-help')}</p>
        <Textarea
          aria-labelledby="claude-prompt-heading"
          value={prompt.value}
          maxLength={MAX_CUSTOM_ANALYSIS_PROMPT_CHARS}
          rows={8}
          disabled={prompt.loading || prompt.loadFailed}
          onChange={(event) => prompt.setValue(event.target.value)}
          className="mt-3 w-full font-mono text-sm"
        />
        {prompt.loadFailed && (
          <div role="alert" className="mt-3 flex items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            <span>{t('claudePanel.prompt-load-failed')}</span>
            <Button variant="outline" size="sm" onClick={prompt.retry}>{t('claudePanel.prompt-retry')}</Button>
          </div>
        )}
        <div className="mt-3 flex items-center justify-between gap-3">
          <span className="text-xs text-muted-foreground">{prompt.value.length}/{MAX_CUSTOM_ANALYSIS_PROMPT_CHARS}</span>
          <Button onClick={() => { void prompt.save(); }} disabled={!prompt.dirty || prompt.saving || prompt.loading || prompt.loadFailed}>
            {t('claudePanel.prompt-save')}
          </Button>
        </div>
      </section>

      <section className="mt-6 rounded-lg border border-border bg-background p-4 dark:border-border dark:bg-muted/40" aria-labelledby="repository-chat-settings-heading">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h4 id="repository-chat-settings-heading" className="text-sm font-medium text-foreground">{t('claudePanel.repository-chat')}</h4>
            <p className="mt-1 text-xs text-muted-foreground">{t('claudePanel.reads-pinned-source-on-demand-and-keeps-local-co')}</p>
          </div>
          <label htmlFor="repository-chat-enabled" className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
            <Checkbox id="repository-chat-enabled" checked={repositoryChatSettings.enabled} onCheckedChange={(checked) => setRepositoryChatSettings({ enabled: checked === true })} />
            {t('claudePanel.enable-repository-chat')}
          </label>
        </div>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <div>
            <label htmlFor="repository-chat-retention-days" className="mb-1 block text-sm font-medium text-foreground">{t('claudePanel.retain-local-conversations-days')}</label>
            <Input id="repository-chat-retention-days" type="number" min={1} max={365} value={repositoryChatSettings.retainSessionDays} onChange={(event) => {
              const parsed = Number(event.target.value);
              setRepositoryChatSettings({ retainSessionDays: Number.isFinite(parsed) ? Math.min(365, Math.max(1, parsed)) : 90 });
            }} />
            <p className="mt-1 text-xs text-muted-foreground">{t('claudePanel.deleting-an-individual-conversation-always-takes')}</p>
          </div>
          <div>
            <label id="repository-chat-task-depth-label" className="mb-1 block text-sm font-medium text-foreground">{tChat('repositoryChatSheet.task-depth')}</label>
            <Select value={repositoryChatSettings.taskDepth} onValueChange={(value) => setRepositoryChatSettings({ taskDepth: value as RepositoryChatTaskDepth })}>
              <SelectTrigger aria-labelledby="repository-chat-task-depth-label" className="h-10 w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="quick">{tChat('repositoryChatSheet.depth-quick')}</SelectItem>
                <SelectItem value="default">{tChat('repositoryChatSheet.depth-default')}</SelectItem>
                <SelectItem value="deep">{tChat('repositoryChatSheet.depth-deep')}</SelectItem>
                <SelectItem value="unlimited">{tChat('repositoryChatSheet.depth-unlimited')}</SelectItem>
              </SelectContent>
            </Select>
            <p className="mt-1 text-xs text-muted-foreground">{tChat('repositoryChatSheet.task-depth-controls-retrieval-rounds-and-read-sc')}</p>
          </div>
        </div>
        <details className="mt-4 rounded-md border border-border px-3 py-2">
          <summary className="cursor-pointer text-sm font-medium text-foreground">{t('claudePanel.advanced-settings')}<span className="ml-2 text-xs font-normal text-muted-foreground">{t('claudePanel.used-by-the-chat-window-when-task-depth-is-defau')}</span></summary>
          <div className="mt-3 grid gap-4 md:grid-cols-2">
            <label htmlFor="repository-chat-web-tools" className="flex cursor-pointer items-start gap-2 text-sm text-foreground"><Checkbox id="repository-chat-web-tools" checked={repositoryChatSettings.enableWebTools} onCheckedChange={(checked) => setRepositoryChatSettings({ enableWebTools: checked === true })} /><span>{t('claudePanel.external-web-search-and-fetch')}<span className="mt-1 block text-xs text-muted-foreground">{t('claudePanel.disabled-by-default-the-current-version-does-not')}</span></span></label>
            <label htmlFor="repository-chat-agent-loop" className="flex cursor-pointer items-start gap-2 text-sm text-foreground"><Checkbox id="repository-chat-agent-loop" checked={repositoryChatSettings.enableAgentToolLoop} onCheckedChange={(checked) => setRepositoryChatSettings({ enableAgentToolLoop: checked === true })} /><span>{t('claudePanel.tool-loop-mode-experimental')}<span className="mt-1 block text-xs text-muted-foreground">{t('claudePanel.evidence-gathering-is-driven-by-native-function')}</span></span></label>
            <label htmlFor="repository-chat-fast-path" className="flex cursor-pointer items-start gap-2 text-sm text-foreground"><Checkbox id="repository-chat-fast-path" checked={repositoryChatSettings.fastPath} onCheckedChange={(checked) => setRepositoryChatSettings({ fastPath: checked === true })} /><span>{t('claudePanel.readme-fast-path')}<span className="mt-1 block text-xs text-muted-foreground">{t('claudePanel.for-simple-usage-overview-or-deployment-questions-ans')}</span></span></label>
            <div>
              <label id="repository-chat-streaming-label" className="mb-1 block text-sm font-medium text-foreground">{t('claudePanel.streaming-answers')}</label>
              <Select value={repositoryChatSettings.streamingMode} onValueChange={(value) => setRepositoryChatSettings({ streamingMode: value === 'off' ? 'off' : 'auto' })}>
                <SelectTrigger aria-labelledby="repository-chat-streaming-label" className="h-10 w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">{t('claudePanel.auto-falls-back-to-full-response-when-unsupporte')}</SelectItem>
                  <SelectItem value="off">{t('claudePanel.off')}</SelectItem>
                </SelectContent>
              </Select>
              <p className="mt-1 text-xs text-muted-foreground">{t('claudePanel.applies-to-the-final-answer-only-retrieval-still')}</p>
            </div>
            <div>
              <label htmlFor="repository-chat-tool-limit" className="mb-1 block text-sm font-medium text-foreground">{t('claudePanel.maximum-tool-calls-per-turn')}</label>
              <Input id="repository-chat-tool-limit" type="number" min={1} max={48} value={repositoryChatSettings.agentBudget.maxToolCalls} onChange={(event) => {
                const parsed = Number(event.target.value);
                const maxToolCalls = Number.isFinite(parsed) ? Math.min(48, Math.max(1, Math.trunc(parsed))) : 20;
                setRepositoryChatSettings({ maxToolsPerTurn: maxToolCalls, agentBudget: { ...repositoryChatSettings.agentBudget, maxToolCalls } });
              }} />
              <p className="mt-1 text-xs text-muted-foreground">{t('claudePanel.limits-all-read-only-tool-calls-to-prevent-unbou')}</p>
            </div>
            <div>
              <label htmlFor="repository-chat-turn-limit" className="mb-1 block text-sm font-medium text-foreground">{t('claudePanel.maximum-evidence-rounds')}</label>
              <Input id="repository-chat-turn-limit" type="number" min={1} max={8} value={repositoryChatSettings.agentBudget.maxTurns} onChange={(event) => {
                const parsed = Number(event.target.value);
                const maxTurns = Number.isFinite(parsed) ? Math.min(8, Math.max(1, Math.trunc(parsed))) : 4;
                setRepositoryChatSettings({ agentBudget: { ...repositoryChatSettings.agentBudget, maxTurns } });
              }} />
            </div>
            <div>
              <label htmlFor="repository-chat-no-progress-limit" className="mb-1 block text-sm font-medium text-foreground">{t('claudePanel.maximum-consecutive-no-progress-rounds')}</label>
              <Input id="repository-chat-no-progress-limit" type="number" min={1} max={4} value={repositoryChatSettings.agentBudget.maxNoProgressRounds} onChange={(event) => {
                const parsed = Number(event.target.value);
                const maxNoProgressRounds = Number.isFinite(parsed) ? Math.min(4, Math.max(1, Math.trunc(parsed))) : 2;
                setRepositoryChatSettings({ agentBudget: { ...repositoryChatSettings.agentBudget, maxNoProgressRounds } });
              }} />
              <p className="mt-1 text-xs text-muted-foreground">{t('claudePanel.stops-repeated-retrieval-after-consecutive-round')}</p>
            </div>
            <div>
              <label htmlFor="repository-chat-read-limit" className="mb-1 block text-sm font-medium text-foreground">{t('claudePanel.maximum-files-read')}</label>
              <Input id="repository-chat-read-limit" type="number" min={1} max={16} value={repositoryChatSettings.agentBudget.maxReadFiles} onChange={(event) => {
                const parsed = Number(event.target.value);
                const maxReadFiles = Number.isFinite(parsed) ? Math.min(16, Math.max(1, Math.trunc(parsed))) : 6;
                setRepositoryChatSettings({ agentBudget: { ...repositoryChatSettings.agentBudget, maxReadFiles, maxCodeReads: Math.min(repositoryChatSettings.agentBudget.maxCodeReads, maxReadFiles) } });
              }} />
            </div>
            <div>
              <label htmlFor="repository-chat-code-read-limit" className="mb-1 block text-sm font-medium text-foreground">{t('claudePanel.maximum-code-files-read')}</label>
              <Input id="repository-chat-code-read-limit" type="number" min={0} max={12} value={repositoryChatSettings.agentBudget.maxCodeReads} onChange={(event) => {
                const parsed = Number(event.target.value);
                const maxCodeReads = Number.isFinite(parsed) ? Math.min(repositoryChatSettings.agentBudget.maxReadFiles, Math.min(12, Math.max(0, Math.trunc(parsed)))) : 3;
                setRepositoryChatSettings({ agentBudget: { ...repositoryChatSettings.agentBudget, maxCodeReads } });
              }} />
              <p className="mt-1 text-xs text-muted-foreground">{t('claudePanel.code-is-read-only-when-documentation-evidence-is')}</p>
            </div>
            <div>
              <label htmlFor="repository-chat-duration-limit" className="mb-1 block text-sm font-medium text-foreground">{t('claudePanel.maximum-execution-time-seconds')}</label>
              <Input id="repository-chat-duration-limit" type="number" min={15} max={300} value={Math.round(repositoryChatSettings.agentBudget.maxDurationMs / 1000)} onChange={(event) => {
                const parsed = Number(event.target.value);
                const maxDurationMs = (Number.isFinite(parsed) ? Math.min(300, Math.max(15, Math.trunc(parsed))) : 90) * 1000;
                setRepositoryChatSettings({ agentBudget: { ...repositoryChatSettings.agentBudget, maxDurationMs } });
              }} />
            </div>
          </div>
        </details>
      </section>

      <div className="mt-6 p-4 bg-background dark:bg-muted/40 rounded-lg border border-border dark:border-border">
        <div className="flex items-center space-x-2 mb-3">
          <Languages className="w-4 h-4 text-muted-foreground dark:text-muted-foreground" />
          <h4 className="text-sm font-medium text-foreground dark:text-foreground">
            {t('claudePanel.translation-engine')}
          </h4>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label id="translation-engine-label" className="block text-sm font-medium text-foreground dark:text-muted-foreground mb-1">
              {t('claudePanel.engine-used-for-readme-document-translation')}
            </label>
            <Select value={translationEngine} onValueChange={(value) => setTranslationEngine(value as TranslationEngine)}>
              <SelectTrigger aria-labelledby="translation-engine-label" className="h-10 w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="microsoft">{t('claudePanel.microsoft-translate-free')}</SelectItem>
                <SelectItem value="google">{t('claudePanel.google-translate-free')}</SelectItem>
                <SelectItem value="ai">{t('claudePanel.translation-claude')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <p className="text-xs text-muted-foreground dark:text-muted-foreground self-end pb-1">
            {translationEngine === 'ai'
              ? t('claudePanel.translation-claude-help')
              : translationEngine === 'google'
                ? t('claudePanel.free-google-endpoint-no-configuration-needed-may')
                : t('claudePanel.free-microsoft-edge-endpoint-no-configuration-ne')}
          </p>
        </div>
        <label htmlFor="auto-translate-repo-descriptions" className="mt-4 flex cursor-pointer items-start gap-2 text-sm text-foreground dark:text-foreground">
          <Checkbox
            id="auto-translate-repo-descriptions"
            checked={autoTranslateRepoDescription}
            onCheckedChange={(checked) => setAutoTranslateRepoDescription(checked === true)}
            className="mt-0.5"
          />
          <span>
            {t('claudePanel.auto-translate-repo-descriptions')}
            <span className="mt-1 block text-xs text-muted-foreground dark:text-muted-foreground">
              {t('claudePanel.when-enabled-card-repository-description')}
            </span>
          </span>
        </label>
      </div>
    </div>
  );
};
