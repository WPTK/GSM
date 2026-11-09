import { describe, expect, it, vi } from 'vitest';
import type { Repository } from '../../types';
import { initialSearchFilters } from '../schema';
import { createRepositorySlice } from './repositorySlice';

vi.mock('../../services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), errorFromError: vi.fn() },
}));

function makeRepo(overrides: Partial<Repository> = {}): Repository {
  return {
    id: 1,
    name: 'my-cli-app',
    full_name: 'owner/my-cli-app',
    description: null,
    html_url: 'https://github.com/owner/my-cli-app',
    stargazers_count: 1,
    forks_count: 0,
    forks: 0,
    language: null,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    pushed_at: '2024-01-01T00:00:00Z',
    owner: { login: 'owner', avatar_url: '' },
    topics: ['cli'],
    ...overrides,
  };
}

describe('similar repository view sorting', () => {
  it('preserves the user sort while clearing filters when entering and exiting similar view', () => {
    const state: Record<string, unknown> = {
      searchFilters: {
        ...initialSearchFilters,
        query: 'react',
        languages: ['TypeScript'],
        sortBy: 'updated',
        sortOrder: 'asc',
      },
      searchResults: [makeRepo({ id: 2 })],
      similarView: null,
    };
    const set = (partial: unknown) => {
      const next = typeof partial === 'function'
        ? (partial as (current: Record<string, unknown>) => Record<string, unknown>)(state)
        : partial as Record<string, unknown>;
      Object.assign(state, next);
    };
    const slice = createRepositorySlice(set as never, (() => state) as never);

    slice.enterSimilarView([makeRepo()], makeRepo());

    expect(state.searchFilters).toMatchObject({
      query: '',
      languages: [],
      sortBy: 'updated',
      sortOrder: 'asc',
    });

    slice.exitSimilarView();

    expect(state.searchFilters).toMatchObject({
      sortBy: 'updated',
      sortOrder: 'asc',
    });
  });
});
