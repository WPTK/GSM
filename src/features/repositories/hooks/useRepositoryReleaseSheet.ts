



import { useT } from '../../../i18n/useT';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Release, ReleaseAsset, Repository } from '../../../types';
import { backend } from '../../../services/backendAdapter';
import { useDialog } from '../../../hooks/useDialog';
import { computeDownloadKey, useReleaseArtifactActions } from '../../../hooks/useReleaseArtifactActions';
import type { ReleaseDownloadLink } from '../../../utils/releaseDownloadLinks';

const REMOTE_RELEASE_PAGE_SIZE = 100;
const MAX_LIVE_RELEASES = 200;

const isAbortError = (error: unknown): boolean => (
  error instanceof DOMException && error.name === 'AbortError'
) || (
  error instanceof Error && error.name === 'AbortError'
);

const asString = (value: unknown): string | null => typeof value === 'string' ? value : null;
const asNumber = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;

const mapBackendAsset = (value: unknown): ReleaseAsset | null => {
  if (!value || typeof value !== 'object') return null;
  const asset = value as Record<string, unknown>;
  const id = asNumber(asset.id);
  const name = asString(asset.name);
  const size = asNumber(asset.size);
  const browserDownloadUrl = asString(asset.browser_download_url);
  if (id === null || name === null || size === null || browserDownloadUrl === null) return null;

  return {
    id,
    name,
    size,
    browser_download_url: browserDownloadUrl,
    download_count: asNumber(asset.download_count) ?? 0,
    content_type: asString(asset.content_type) ?? '',
    created_at: asString(asset.created_at) ?? '',
    updated_at: asString(asset.updated_at) ?? '',
  };
};

const mapBackendRelease = (value: Record<string, unknown>, repository: Repository): Release => {
  const id = asNumber(value.id);
  const tagName = asString(value.tag_name);
  const publishedAt = asString(value.published_at);
  const htmlUrl = asString(value.html_url);
  if (id === null || tagName === null || publishedAt === null || htmlUrl === null) {
    throw new Error('Backend proxy returned an invalid release');
  }

  const rawAssets = Array.isArray(value.assets) ? value.assets : [];
  return {
    id,
    tag_name: tagName,
    name: asString(value.name),
    body: asString(value.body),
    published_at: publishedAt,
    html_url: htmlUrl,
    assets: rawAssets.map(mapBackendAsset).filter((asset): asset is ReleaseAsset => asset !== null),
    zipball_url: asString(value.zipball_url) ?? undefined,
    tarball_url: asString(value.tarball_url) ?? undefined,
    prerelease: value.prerelease === true,
    repository: {
      id: repository.id,
      full_name: repository.full_name,
      name: repository.name,
    },
  };
};

const withRepositoryIdentity = (release: Release, repository: Repository): Release => ({
  ...release,
  repository: {
    id: repository.id,
    full_name: repository.full_name,
    name: repository.name,
  },
});

const getRepositoryCoordinates = (fullName: string): { owner: string; name: string } => {
  const [owner, ...nameParts] = fullName.split('/');
  const name = nameParts.join('/');
  if (!owner || !name) throw new Error('Invalid repository full name');
  return { owner, name };
};

const getErrorMessage = (error: unknown): string => (
  error instanceof Error ? error.message : String(error)
);

const isPublishedReleaseRecord = (value: Record<string, unknown>): boolean => (
  value.draft !== true && typeof value.published_at === 'string'
);

const downloadBrowserBlob = (blob: Blob, fileName: string) => {
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = fileName;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(objectUrl);
};

export const useRepositoryReleaseSheet = (repository: Repository) => {
  const { toast } = useDialog();
  // AI 总结动作委托共享 hook（避免第三份拷贝）；summaries/downloadStates
  // 的对外形状由 hook 供给，downloadStates 的 key 已版本化为 computeDownloadKey(link)。
  const artifactActions = useReleaseArtifactActions();
  // 共享 hook 返回的 artifactActions 对象随 summaries 状态更新换引用——依赖只能
  // 挂它解构出的引用稳定成员（useCallback 零依赖或仅依赖 store 值），否则每次状态
  // 更新都会连带换 cancel effect / loadReleases 的身份。
  const { cancelSummaryRequests, reset: resetArtifactStates } = artifactActions;
  const [releases, setReleases] = useState<Release[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 下载按钮的行内 sending 状态，使用版本化 key。
  const [browserDownloadStates, setBrowserDownloadStates] = useState<Record<string, 'idle' | 'sending'>>({});
  const fetchAbortRef = useRef<AbortController | null>(null);
  const t = useT('repositories');

  const cancelPendingRequests = useCallback(() => {
    fetchAbortRef.current?.abort();
    fetchAbortRef.current = null;
    cancelSummaryRequests();
  }, [cancelSummaryRequests]);

  useEffect(() => cancelPendingRequests, [cancelPendingRequests]);

  const fetchAllPages = useCallback(async (
    getPage: (page: number, signal: AbortSignal) => Promise<{ releases: Release[]; hasMore: boolean }>,
    signal: AbortSignal,
  ): Promise<Release[]> => {
    const collected: Release[] = [];
    let page = 1;

    while (collected.length < MAX_LIVE_RELEASES) {
      const { releases, hasMore } = await getPage(page, signal);
      collected.push(...releases.slice(0, MAX_LIVE_RELEASES - collected.length));
      if (!hasMore || collected.length >= MAX_LIVE_RELEASES) break;
      page += 1;
    }

    return collected;
  }, []);

  const loadReleases = useCallback(async () => {
    fetchAbortRef.current?.abort();
    const controller = new AbortController();
    fetchAbortRef.current = controller;
    setIsLoading(true);
    setError(null);
    setBrowserDownloadStates({});
    resetArtifactStates();

    try {
      const { owner, name } = getRepositoryCoordinates(repository.full_name);
      const liveReleases = await fetchAllPages(async (page, signal) => {
        const records = await backend.getRepositoryReleases(owner, name, page, REMOTE_RELEASE_PAGE_SIZE, signal);
        return {
          releases: records
            .filter(isPublishedReleaseRecord)
            .map((record) => mapBackendRelease(record, repository)),
          hasMore: records.length === REMOTE_RELEASE_PAGE_SIZE,
        };
      }, controller.signal);
      if (controller.signal.aborted) return;
      setReleases(liveReleases.map((release) => withRepositoryIdentity(release, repository)));
    } catch (requestError) {
      if (isAbortError(requestError) || controller.signal.aborted) return;
      setReleases([]);
      setError(getErrorMessage(requestError));
    } finally {
      if (fetchAbortRef.current === controller) {
        fetchAbortRef.current = null;
        setIsLoading(false);
      }
    }
  }, [resetArtifactStates, fetchAllPages, repository]);

  const downloadAsset = useCallback(async (link: ReleaseDownloadLink) => {
    const downloadKey = computeDownloadKey(link);
    if (browserDownloadStates[downloadKey] === 'sending') return;
    setBrowserDownloadStates((previous) => ({ ...previous, [downloadKey]: 'sending' }));

    try {
      let blob: Blob;
      if (link.authenticatedPath) {
        blob = await backend.downloadGitHubResource(link.authenticatedPath);
      } else {
        window.open(link.url, '_blank', 'noopener,noreferrer');
        setBrowserDownloadStates((previous) => ({ ...previous, [downloadKey]: 'idle' }));
        return;
      }
      downloadBrowserBlob(blob, link.name);
      setBrowserDownloadStates((previous) => ({ ...previous, [downloadKey]: 'idle' }));
    } catch (downloadError) {
      setBrowserDownloadStates((previous) => ({ ...previous, [downloadKey]: 'idle' }));
      toast(`${t('useRepositoryReleaseSheet.download-failed')}: ${getErrorMessage(downloadError)}`, 'error');
    }
  }, [browserDownloadStates, t, toast]);

  const generateSummary = artifactActions.generateSummary;

  return {
    releases,
    isLoading,
    error,
    summaries: artifactActions.summaries,
    downloadStates: browserDownloadStates,
    loadReleases,
    downloadAsset,
    generateSummary,
    cancelPendingRequests,
  };
};
