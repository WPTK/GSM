export type BuiltinRepositoryCardActionId =
  | 'analyze'
  | 'ask'
  | 'subscribe'
  | 'edit'
  | 'releases'
  | 'github';

export type RepositoryCardActionId = BuiltinRepositoryCardActionId;

export interface RepositoryCardActionPreference {
  id: RepositoryCardActionId;
  /** False moves the action into the More actions menu. */
  visible: boolean;
}

export const REPOSITORY_CARD_ACTION_IDS: readonly BuiltinRepositoryCardActionId[] = [
  'analyze',
  'ask',
  'subscribe',
  'edit',
  'releases',
  'github',
];

export const DEFAULT_REPOSITORY_CARD_ACTIONS: RepositoryCardActionPreference[] =
  REPOSITORY_CARD_ACTION_IDS.map((id) => ({ id, visible: true }));
