import type {
  AccountWorkspace,
  Category,
  GitHubUser,
  Release,
  ReleaseSourceSettings,
  Repository,
} from '../../types';
import { defaultReleaseSourceSettings } from '../../types';
import { normalizeReleaseSourceSettings } from '../../utils/releaseSources';

export type { AccountWorkspace };

export interface AccountWorkspaceRuntime {
  repositories: Repository[];
  lastSync: string | null;
  searchResults: Repository[];
  similarView: null;
  analyzingRepositoryIds: Set<number>;
  releases: Release[];
  releaseSubscriptions: Set<number>;
  releaseSourceSettings: ReleaseSourceSettings;
  readReleases: Set<number>;
  customCategories: Category[];
  hiddenDefaultCategoryIds: string[];
  categoryOrder: string[];
  defaultCategoryOverrides: Record<string, Partial<Category>>;
}

export interface AccountWorkspaceSource {
  repositories: Repository[];
  lastSync: string | null;
  releases: Release[];
  releaseSubscriptions: Set<number>;
  releaseSourceSettings: ReleaseSourceSettings;
  readReleases: Set<number>;
  customCategories: Category[];
  hiddenDefaultCategoryIds: string[];
  categoryOrder: string[];
  defaultCategoryOverrides: Record<string, Partial<Category>>;
}

const numberSetToArray = (value: Set<number> | unknown): number[] => (
  value instanceof Set
    ? Array.from(value)
    : Array.isArray(value)
      ? value.filter((item): item is number => typeof item === 'number')
      : []
);

export const shouldPreserveExisting = <T>(
  incoming: T[] | undefined,
  existing: T[],
  allowEmpty = false,
): boolean => incoming !== undefined && incoming.length === 0 && existing.length > 0 && !allowEmpty;

export const accountIdKey = (user: Pick<GitHubUser, 'id'> | number | null | undefined): string | null => {
  const id = typeof user === 'number' ? user : user?.id;
  return typeof id === 'number' && Number.isFinite(id) ? String(id) : null;
};

/**
 * 带引用保留的类型过滤：过滤后长度不变说明所有元素都通过校验且顺序一致
 * （filter 只会按序保留子集），此时直接返回原数组引用。
 * 分片持久化按字段引用判脏——规整化若总是重建数组，每次启动都会把
 * accountWorkspaces 分片误判为已变更而全量重写。
 */
const filterPreservingRef = <T>(value: unknown, predicate: (item: unknown) => item is T): T[] => {
  if (!Array.isArray(value)) return [];
  const filtered = value.filter(predicate);
  return filtered.length === value.length ? (value as T[]) : filtered;
};

export const normalizeAccountWorkspaces = (value: unknown): Record<string, AccountWorkspace> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const empty = emptyAccountWorkspace();
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).flatMap(([key, workspace]) => {
      if (!key || !workspace || typeof workspace !== 'object' || Array.isArray(workspace)) return [];
      const record = workspace as Record<string, unknown>;
      return [[key, {
        ...empty,
        repositories: Array.isArray(record.repositories) ? record.repositories : [],
        lastSync: typeof record.lastSync === 'string' ? record.lastSync : null,
        releases: Array.isArray(record.releases) ? record.releases : [],
        releaseSubscriptions: filterPreservingRef(
          record.releaseSubscriptions,
          (item): item is number => typeof item === 'number',
        ),
        releaseSourceSettings: normalizeReleaseSourceSettings(record.releaseSourceSettings),
        readReleases: filterPreservingRef(
          record.readReleases,
          (item): item is number => typeof item === 'number',
        ),
        customCategories: Array.isArray(record.customCategories) ? record.customCategories : [],
        hiddenDefaultCategoryIds: filterPreservingRef(
          record.hiddenDefaultCategoryIds,
          (item): item is string => typeof item === 'string',
        ),
        categoryOrder: filterPreservingRef(
          record.categoryOrder,
          (item): item is string => typeof item === 'string',
        ),
        defaultCategoryOverrides: record.defaultCategoryOverrides && typeof record.defaultCategoryOverrides === 'object'
          && !Array.isArray(record.defaultCategoryOverrides)
          ? record.defaultCategoryOverrides as AccountWorkspace['defaultCategoryOverrides']
          : {},
      }]];
    }),
  );
};

export const emptyAccountWorkspace = (): AccountWorkspace => ({
  repositories: [],
  lastSync: null,
  releases: [],
  releaseSubscriptions: [],
  releaseSourceSettings: defaultReleaseSourceSettings,
  readReleases: [],
  customCategories: [],
  hiddenDefaultCategoryIds: [],
  categoryOrder: [],
  defaultCategoryOverrides: {},
});

export const captureAccountWorkspace = (state: AccountWorkspaceSource): AccountWorkspace => ({
  repositories: state.repositories,
  lastSync: state.lastSync,
  releases: state.releases,
  releaseSubscriptions: numberSetToArray(state.releaseSubscriptions),
  releaseSourceSettings: state.releaseSourceSettings,
  readReleases: numberSetToArray(state.readReleases),
  customCategories: state.customCategories,
  hiddenDefaultCategoryIds: state.hiddenDefaultCategoryIds,
  categoryOrder: state.categoryOrder,
  defaultCategoryOverrides: state.defaultCategoryOverrides,
});

export const applyAccountWorkspace = (workspace: AccountWorkspace | undefined): AccountWorkspaceRuntime => {
  const snapshot = workspace ?? emptyAccountWorkspace();
  return {
    repositories: snapshot.repositories,
    lastSync: snapshot.lastSync,
    searchResults: snapshot.repositories,
    similarView: null,
    analyzingRepositoryIds: new Set<number>(),
    releases: snapshot.releases,
    releaseSubscriptions: new Set(snapshot.releaseSubscriptions),
    releaseSourceSettings: snapshot.releaseSourceSettings,
    readReleases: new Set(snapshot.readReleases),
    customCategories: snapshot.customCategories,
    hiddenDefaultCategoryIds: snapshot.hiddenDefaultCategoryIds,
    categoryOrder: snapshot.categoryOrder,
    defaultCategoryOverrides: snapshot.defaultCategoryOverrides,
  };
};

export type WorkspaceDataCandidate = Partial<AccountWorkspaceSource | AccountWorkspace>;

/**
 * Predicate checking whether a workspace (live or parked snapshot) holds any
 * persisted user content or user-defined category configuration.
 */
export const workspaceHasData = (workspace: WorkspaceDataCandidate | null | undefined): boolean => {
  if (!workspace) return false;
  return (
    (workspace.repositories?.length ?? 0) > 0
    || (workspace.releases?.length ?? 0) > 0
    || (workspace.customCategories?.length ?? 0) > 0
    || (workspace.categoryOrder?.length ?? 0) > 0
    || (workspace.hiddenDefaultCategoryIds?.length ?? 0) > 0
    || Object.keys(workspace.defaultCategoryOverrides ?? {}).length > 0
  );
};

export const switchAccountWorkspace = (
  current: AccountWorkspaceSource & { accountWorkspaces: Record<string, AccountWorkspace> },
  previousAccountId: string | null,
  nextAccountId: string,
): { accountWorkspaces: Record<string, AccountWorkspace>; workspace: AccountWorkspaceRuntime | null } => {
  const accountWorkspaces = { ...current.accountWorkspaces };
  if (previousAccountId && previousAccountId !== nextAccountId) {
    accountWorkspaces[previousAccountId] = captureAccountWorkspace(current);
  }
  if (previousAccountId === nextAccountId) {
    return { accountWorkspaces, workspace: null };
  }
  // Logged-out login: keep live lists if they already hold data (backend
  // restore wrote first). Otherwise restore a parked snapshot for this id.
  if (!previousAccountId && workspaceHasData(current)) {
    return { accountWorkspaces, workspace: null };
  }
  return {
    accountWorkspaces,
    workspace: applyAccountWorkspace(accountWorkspaces[nextAccountId]),
  };
};

