
import type { AppStoreSlice } from '../types';

export const createDiscoverySlice: AppStoreSlice<Pick<import('../types').AppActions,
  | 'setSelectedDiscoveryChannel'
  | 'setDiscoveryLoading'
  | 'setDiscoveryLoadingMore'
  | 'setDiscoveryLoadMoreError'
  | 'setDiscoveryRepos'
  | 'setDiscoveryLastRefresh'
  | 'updateDiscoveryRepo'
  | 'toggleDiscoveryChannel'
  | 'setDiscoveryPlatform'
  | 'setDiscoveryLanguage'
  | 'setDiscoverySortBy'
  | 'setDiscoverySortOrder'
  | 'setDiscoverySearchQuery'
  | 'setDiscoverySearchMode'
  | 'setDiscoverySearchPhase'
  | 'setDiscoverySearchPhaseDetail'
  | 'setDiscoverySearchEmptyReason'
  | 'setDiscoverySelectedTopic'
  | 'setDiscoveryHasMore'
  | 'setDiscoveryNextPage'
  | 'setDiscoveryTotalCount'
  | 'setDiscoveryScrollPosition'
  | 'setWeeklyOnlyCollected'
  | 'setWeeklySyncStatus'
  | 'appendDiscoveryRepos'
>> = (set) => ({
    // Discovery actions
    setSelectedDiscoveryChannel: (selectedDiscoveryChannel) => set((state) => ({
      selectedDiscoveryChannel,
      discoveryRepos: {
        ...state.discoveryRepos,
        [selectedDiscoveryChannel]: []
      },
      discoveryNextPage: {
        ...state.discoveryNextPage,
        [selectedDiscoveryChannel]: 1
      },
      discoveryHasMore: {
        ...state.discoveryHasMore,
        [selectedDiscoveryChannel]: false
      },
      discoveryTotalCount: {
        ...state.discoveryTotalCount,
        [selectedDiscoveryChannel]: 0
      },
      discoveryIsLoadingMore: {
        ...state.discoveryIsLoadingMore,
        [selectedDiscoveryChannel]: false
      },
      discoveryLoadMoreError: {
        ...state.discoveryLoadMoreError,
        [selectedDiscoveryChannel]: null
      }
    })),
    setDiscoveryLoading: (channel, loading) => set((state) => ({
      discoveryIsLoading: { ...state.discoveryIsLoading, [channel]: loading },
    })),
    setDiscoveryLoadingMore: (channel, loading) => set((state) => ({
      discoveryIsLoadingMore: { ...state.discoveryIsLoadingMore, [channel]: loading },
    })),
    setDiscoveryLoadMoreError: (channel, error) => set((state) => ({
      discoveryLoadMoreError: { ...state.discoveryLoadMoreError, [channel]: error },
    })),
    setDiscoveryRepos: (channel, repos, append = false) => set((state) => ({
      discoveryRepos: {
        ...state.discoveryRepos,
        [channel]: append ? [...(state.discoveryRepos[channel] || []), ...repos] : repos
      },
    })),
    setDiscoveryLastRefresh: (channel, timestamp) => set((state) => ({
      discoveryLastRefresh: { ...state.discoveryLastRefresh, [channel]: timestamp },
    })),
    updateDiscoveryRepo: (repo) => set((state) => {
      const channel = repo.channel;
      const channelRepos = state.discoveryRepos[channel] || [];
      return {
        discoveryRepos: {
          ...state.discoveryRepos,
          [channel]: channelRepos.map(r => r.id === repo.id ? repo : r),
        },
      };
    }),
    toggleDiscoveryChannel: (channelId) => set((state) => {
      const channel = state.discoveryChannels.find(ch => ch.id === channelId);
      // 至少保留一个启用的频道
      const enabledCount = state.discoveryChannels.filter(ch => ch.enabled).length;
      if (!channel || (channel.enabled && enabledCount === 1)) {
        return state;
      }

      const discoveryChannels = state.discoveryChannels.map(ch =>
        ch.id === channelId ? { ...ch, enabled: !ch.enabled } : ch
      );
      const selectedChannelEnabled = discoveryChannels.some(
        ch => ch.id === state.selectedDiscoveryChannel && ch.enabled
      );
      return {
        discoveryChannels,
        selectedDiscoveryChannel: selectedChannelEnabled
          ? state.selectedDiscoveryChannel
          : discoveryChannels.find(ch => ch.enabled)?.id ?? state.selectedDiscoveryChannel,
      };
    }),
    setDiscoveryPlatform: (discoveryPlatform) => set({ discoveryPlatform }),
    setDiscoveryLanguage: (discoveryLanguage) => set({ discoveryLanguage }),
    setDiscoverySortBy: (discoverySortBy) => set({ discoverySortBy }),
    setDiscoverySortOrder: (discoverySortOrder) => set({ discoverySortOrder }),
    setDiscoverySearchQuery: (discoverySearchQuery) => set({ discoverySearchQuery }),
    setDiscoverySearchMode: (discoverySearchMode) => set({ discoverySearchMode }),
    // phase/detail 与 emptyReason 是会话级状态（不持久化），语义搜索开始/结束由 hook 负责清空
    setDiscoverySearchPhase: (discoverySearchPhase) => set({ discoverySearchPhase }),
    setDiscoverySearchPhaseDetail: (discoverySearchPhaseDetail) => set({ discoverySearchPhaseDetail }),
    setDiscoverySearchEmptyReason: (discoverySearchEmptyReason) => set({ discoverySearchEmptyReason }),
    setDiscoverySelectedTopic: (discoverySelectedTopic) => set({ discoverySelectedTopic }),
    setDiscoveryHasMore: (channel, hasMore) => set((state) => ({
      discoveryHasMore: { ...state.discoveryHasMore, [channel]: hasMore },
    })),
    setDiscoveryNextPage: (channel, page) => set((state) => ({
      discoveryNextPage: { ...state.discoveryNextPage, [channel]: page },
    })),
    setDiscoveryTotalCount: (channel, count) => set((state) => ({
      discoveryTotalCount: { ...state.discoveryTotalCount, [channel]: count },
    })),
    setWeeklyOnlyCollected: (only) => set({ weeklyOnlyCollected: only }),
    setWeeklySyncStatus: (status) => set({ weeklySyncStatus: status }),
  setDiscoveryScrollPosition: (channel, position) => set((state) => ({
      discoveryScrollPositions: { ...state.discoveryScrollPositions, [channel]: position },
    })),
    appendDiscoveryRepos: (channel, repos) => set((state) => ({
      discoveryRepos: {
        ...state.discoveryRepos,
        [channel]: [...(state.discoveryRepos[channel] || []), ...repos]
      },
    })),
});
