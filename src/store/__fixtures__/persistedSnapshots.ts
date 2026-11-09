export type PersistedSnapshot = Record<string, unknown>;

/**
 * Produces the stable, JSON-serializable shell shared by historical Zustand
 * snapshots. Individual tests override only the fields that define the
 * migration or hydration contract being exercised.
 */
export const buildPersistedSnapshot = (
  overrides: PersistedSnapshot = {},
): PersistedSnapshot => ({
  repositories: [],
  gists: [],
  releases: [],
  releaseSubscriptions: [],
  readReleases: [],
  readForks: [],
  releaseExpandedRepositories: [],
  forkExpandedRepositories: [],
  ...overrides,
});

/**
 * Creates the six-channel shape used by legacy discovery snapshots. The
 * values are intentionally non-default so reset behavior is observable.
 */
export const buildTransientDiscoverySnapshot = (): PersistedSnapshot => ({
  discoveryRepos: {
    'hot-release': [],
    'most-popular': [],
    topic: [],
    search: [],
    'code-search': [],
  },
  discoveryIsLoading: {
    'hot-release': true,
    'most-popular': true,
    topic: true,
    search: true,
    'code-search': true,
  },
  discoveryLastRefresh: {
    'hot-release': '2026-02-02T00:00:00.000Z',
    'most-popular': '2026-02-03T00:00:00.000Z',
    topic: '2026-02-04T00:00:00.000Z',
    search: '2026-02-05T00:00:00.000Z',
    'code-search': '2026-02-06T00:00:00.000Z',
  },
  discoveryTotalCount: {
    'hot-release': 80,
    'most-popular': 60,
    topic: 40,
    search: 20,
    'code-search': 10,
  },
  discoveryHasMore: {
    'hot-release': true,
    'most-popular': true,
    topic: true,
    search: true,
    'code-search': true,
  },
  discoveryNextPage: {
    'hot-release': 5,
    'most-popular': 4,
    topic: 3,
    search: 2,
    'code-search': 2,
  },
  discoveryScrollPositions: {
    'hot-release': 80,
    'most-popular': 40,
    topic: 20,
    search: 10,
    'code-search': 5,
  },
});

export const buildExpectedResetDiscoveryState = () => ({
  discoveryRepos: {
    'hot-release': [],
    'most-popular': [],
    topic: [],
    search: [],
    'code-search': [],
  },
  discoveryLastRefresh: {
    'hot-release': null,
    'most-popular': null,
    topic: null,
    search: null,
    'code-search': null,
  },
  discoveryTotalCount: {
    'hot-release': 0,
    'most-popular': 0,
    topic: 0,
    search: 0,
    'code-search': 0,
  },
  discoveryHasMore: {
    'hot-release': false,
    'most-popular': false,
    topic: false,
    search: false,
    'code-search': false,
  },
  discoveryNextPage: {
    'hot-release': 1,
    'most-popular': 1,
    topic: 1,
    search: 1,
    'code-search': 1,
  },
  discoveryIsLoading: {
    'hot-release': false,
    'most-popular': false,
    topic: false,
    search: false,
    'code-search': false,
  },
  discoveryScrollPositions: {
    'hot-release': 0,
    'most-popular': 0,
    topic: 0,
    search: 0,
    'code-search': 0,
  },
});
