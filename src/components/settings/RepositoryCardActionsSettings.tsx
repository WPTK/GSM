import React, { useMemo } from 'react';
import {
  Bell,
  Bot,
  ChevronDown,
  ChevronUp,
  Edit3,
  ExternalLink,
  MessageSquareText,
  PackageOpen,
  type LucideIcon,
} from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useT } from '../../i18n/useT';
import { useAppStore } from '../../store/useAppStore';
import {
  DEFAULT_REPOSITORY_CARD_ACTIONS,
  type BuiltinRepositoryCardActionId,
  type RepositoryCardActionPreference,
} from '../../types/repositoryCardActions';
import { normalizeRepositoryCardActions } from '../../utils/repositoryCardActions';
import { Button } from '../ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Switch } from '../ui/switch';

const ACTION_LABEL_KEYS: Record<BuiltinRepositoryCardActionId, string> = {
  analyze: 'repositoryCard.analyze-with-ai-2',
  ask: 'repositoryCard.ask-this-repository',
  subscribe: 'repositoryCard.subscribe-to-releases',
  edit: 'repositoryCard.edit-repository-info',
  releases: 'repositoryCard.view-releases',
  github: 'repositoryCard.view-on-github',
};

const BUILTIN_ICONS: Record<BuiltinRepositoryCardActionId, LucideIcon> = {
  analyze: Bot,
  ask: MessageSquareText,
  subscribe: Bell,
  edit: Edit3,
  releases: PackageOpen,
  github: ExternalLink,
};

interface RepositoryCardActionsSettingsProps {
  title: string;
  hint: string;
  resetLabel: string;
  moveUpLabel: (action: string) => string;
  moveDownLabel: (action: string) => string;
  visibilityLabel: (action: string) => string;
}

export const RepositoryCardActionsSettings: React.FC<RepositoryCardActionsSettingsProps> = ({
  title,
  hint,
  resetLabel,
  moveUpLabel,
  moveDownLabel,
  visibilityLabel,
}) => {
  const t = useT('repositories');
  const { actions, setActions } = useAppStore(
    useShallow((state) => ({
      actions: state.repositoryCardActions,
      setActions: state.setRepositoryCardActions,
    })),
  );
  const displayedActions = useMemo(
    () => normalizeRepositoryCardActions(actions),
    [actions],
  );

  const saveWithInactive = (next: typeof displayedActions) => {
    const nextMap = new Map(next.map((a) => [a.id, a]));
    const nextRemaining = [...next];
    const result: RepositoryCardActionPreference[] = [];

    for (const saved of actions) {
      if (nextMap.has(saved.id)) {
        if (nextRemaining.length > 0) {
          result.push(nextRemaining.shift()!);
        }
      } else {
        result.push(saved);
      }
    }

    while (nextRemaining.length > 0) {
      result.push(nextRemaining.shift()!);
    }

    setActions(result);
  };

  const move = (index: number, delta: -1 | 1) => {
    const reordered = [...displayedActions];
    const [item] = reordered.splice(index, 1);
    reordered.splice(index + delta, 0, item);
    saveWithInactive(reordered);
  };

  const handleReset = () => {
    setActions(DEFAULT_REPOSITORY_CARD_ACTIONS.map((item) => ({ ...item })));
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">{hint}</p>
        <div className="space-y-2">
          {displayedActions.map((item, index) => {
            const builtinId = item.id as BuiltinRepositoryCardActionId;
            const label = t(ACTION_LABEL_KEYS[builtinId]);
            const IconComp = BUILTIN_ICONS[builtinId];
            const iconNode = IconComp ? (
              <IconComp className="h-4 w-4 shrink-0 text-muted-foreground" />
            ) : null;

            return (
              <div
                key={item.id}
                className="flex items-center gap-2 rounded-md border border-border px-3 py-2"
              >
                {iconNode}
                <span className="min-w-0 flex-1 truncate text-sm">
                  {label}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  disabled={index === 0}
                  aria-label={moveUpLabel(label)}
                  onClick={() => move(index, -1)}
                >
                  <ChevronUp className="h-4 w-4" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  disabled={index === displayedActions.length - 1}
                  aria-label={moveDownLabel(label)}
                  onClick={() => move(index, 1)}
                >
                  <ChevronDown className="h-4 w-4" />
                </Button>
                <Switch
                  checked={item.visible}
                  aria-label={visibilityLabel(label)}
                  onCheckedChange={(visible) =>
                    saveWithInactive(
                      displayedActions.map((entry) =>
                        entry.id === item.id ? { ...entry, visible } : entry,
                      ),
                    )
                  }
                />
              </div>
            );
          })}
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleReset}
        >
          {resetLabel}
        </Button>
      </CardContent>
    </Card>
  );
};
