import {
  DEFAULT_REPOSITORY_CARD_ACTIONS,
  REPOSITORY_CARD_ACTION_IDS,
  type RepositoryCardActionId,
  type RepositoryCardActionPreference,
} from '../types/repositoryCardActions';

/**
 * Keep the saved order, discard unknown/duplicate IDs (including retired
 * docs and plugin:* entries from older snapshots), and add new actions at the end.
 */
export const normalizeRepositoryCardActions = (
  value: unknown,
): RepositoryCardActionPreference[] => {
  const allowed = new Set<string>(REPOSITORY_CARD_ACTION_IDS);
  const seen = new Set<string>();
  const result: RepositoryCardActionPreference[] = [];

  if (Array.isArray(value)) {
    for (const item of value) {
      if (!item || typeof item !== 'object') continue;
      const { id, visible } = item as Record<string, unknown>;
      if (typeof id !== 'string' || seen.has(id) || !allowed.has(id)) continue;
      seen.add(id);
      result.push({
        id: id as RepositoryCardActionId,
        visible: typeof visible === 'boolean' ? visible : true,
      });
    }
  }

  for (const item of DEFAULT_REPOSITORY_CARD_ACTIONS) {
    if (!seen.has(item.id)) {
      seen.add(item.id);
      result.push({ ...item });
    }
  }

  return result;
};
