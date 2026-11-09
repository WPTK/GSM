import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  tokens: [] as string[],
  setBackendUrl: vi.fn(),
}));

vi.mock('./githubApi', () => ({
  GitHubApiService: class {
    constructor(token: string) { mocks.tokens.push(token); }
  },
}));

import { SERVER_HELD_TOKEN, createGitHubApiService } from './githubApiFactory';

describe('githubApiFactory', () => {
  it('the browser-side GitHub token is only ever the server-held placeholder', () => {
    mocks.tokens.length = 0;
    createGitHubApiService();
    expect(SERVER_HELD_TOKEN).toBe('server');
    expect(mocks.tokens).toEqual(['server']);
  });
});
