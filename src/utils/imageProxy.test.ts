import { describe, expect, it } from 'vitest';
import { githubBlobToRaw, imageProxySrc, isGitHubImageUrl } from './imageProxy';

describe('isGitHubImageUrl', () => {
  it.each([
    'https://avatars.githubusercontent.com/u/1?v=4',
    'https://raw.githubusercontent.com/o/r/main/img/a.png',
    'https://user-images.githubusercontent.com/1/a.png',
    'https://private-user-images.githubusercontent.com/1/a.png?jwt=x',
    'https://repository-images.githubusercontent.com/1/a',
    'https://github.com/o/r/raw/main/a.png',
    'https://github.com/o/r/blob/main/a.png?raw=true',
    'https://github.com/user-attachments/assets/0a1b2c3d-4e5f',
    'https://github.com/octocat.png',
  ])('allows %s', (url) => {
    expect(isGitHubImageUrl(url)).toBe(true);
  });

  it.each([
    'http://avatars.githubusercontent.com/u/1',
    'https://example.com/a.png',
    'https://camo.githubusercontent.com/abc/def',
    'https://gist.githubusercontent.com/o/id/raw/a.png',
    'https://github.com/o/r/blob/main/a.png',
    'https://github.com/o/r/raw/../../x',
    'https://user:pw@avatars.githubusercontent.com/u/1',
    'https://avatars.githubusercontent.com:8443/u/1',
    'https://avatars.githubusercontent.com.evil.test/u/1',
    'javascript:alert(1)',
    '/relative/a.png',
    '',
    null,
    undefined,
  ])('rejects %s', (url) => {
    expect(isGitHubImageUrl(url as string | null | undefined)).toBe(false);
  });
});

describe('imageProxySrc', () => {
  it('routes allowed GitHub images through the same-origin proxy', () => {
    const url = 'https://avatars.githubusercontent.com/u/1?v=4&s=64';
    expect(imageProxySrc(url)).toBe(`/api/img?url=${encodeURIComponent(url)}`);
  });

  it('never returns a third-party URL', () => {
    expect(imageProxySrc('https://example.com/a.png')).toBeUndefined();
    expect(imageProxySrc(undefined)).toBeUndefined();
    expect(imageProxySrc(null)).toBeUndefined();
  });

  it('passes inline data images through unchanged', () => {
    expect(imageProxySrc('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
  });
});

describe('blob links', () => {
  it('rewrites absolute github.com blob image links to /raw/ before proxying', () => {
    expect(githubBlobToRaw('https://github.com/o/r/blob/main/docs/a.png')).toBe('https://github.com/o/r/raw/main/docs/a.png');
    expect(githubBlobToRaw('https://github.com/o/r/blob/main/a.png?raw=true')).toBe('https://github.com/o/r/raw/main/a.png');
    expect(imageProxySrc('https://github.com/o/r/blob/main/docs/a.png'))
      .toBe(`/api/img?url=${encodeURIComponent('https://github.com/o/r/raw/main/docs/a.png')}`);
  });

  it('leaves other URLs alone', () => {
    expect(githubBlobToRaw('https://example.com/o/r/blob/main/a.png')).toBe('https://example.com/o/r/blob/main/a.png');
    expect(githubBlobToRaw('https://github.com/o/r/issues/1')).toBe('https://github.com/o/r/issues/1');
  });
});
