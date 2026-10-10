import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { appFilePath, externalUrl, httpsOrigin, isAppUrl } from './urls.ts';

const WEB = '/opt/rss-reader/web';

describe('appFilePath', () => {
  it('serves bundled files', () => {
    expect(appFilePath(WEB, 'app://rss-reader/assets/index-abc.js')).toBe(
      join(WEB, 'assets/index-abc.js'),
    );
    expect(appFilePath(WEB, 'app://rss-reader/favicon.svg?v=1')).toBe(join(WEB, 'favicon.svg'));
  });

  it('serves index.html for the root and client-side routes', () => {
    expect(appFilePath(WEB, 'app://rss-reader/')).toBe(join(WEB, 'index.html'));
    expect(appFilePath(WEB, 'app://rss-reader/f12/345')).toBe(join(WEB, 'index.html'));
    expect(appFilePath(WEB, 'app://rss-reader/settings/feeds?x=1')).toBe(join(WEB, 'index.html'));
  });

  it('refuses paths outside the bundle and other hosts', () => {
    expect(appFilePath(WEB, 'app://rss-reader/..%2F..%2Fetc%2Fpasswd.txt')).toBeNull();
    expect(appFilePath(WEB, 'app://rss-reader/%E0%A4%A.js')).toBeNull();
    expect(appFilePath(WEB, 'app://other/index.html')).toBeNull();
    expect(appFilePath(WEB, 'https://rss-reader/index.html')).toBeNull();
  });
});

describe('isAppUrl', () => {
  it('accepts only the app origin', () => {
    expect(isAppUrl('app://rss-reader/all')).toBe(true);
    expect(isAppUrl('app://rss-reader')).toBe(true);
    expect(isAppUrl('app://rss-reader.evil/')).toBe(false);
    expect(isAppUrl('https://rss-reader/')).toBe(false);
  });
});

describe('externalUrl', () => {
  it('lets http(s) out and nothing else', () => {
    expect(externalUrl('https://site.example/a b')).toBe('https://site.example/a%20b');
    expect(externalUrl('http://site.example/')).toBe('http://site.example/');
    expect(externalUrl('file:///etc/passwd')).toBeNull();
    expect(externalUrl('javascript:alert(1)')).toBeNull();
    expect(externalUrl('not a url')).toBeNull();
  });
});

describe('httpsOrigin', () => {
  it('accepts HTTPS origins only', () => {
    expect(httpsOrigin('https://rr.example.com')).toBe('https://rr.example.com');
    expect(httpsOrigin('https://rr.example.com/path')).toBeNull();
    expect(httpsOrigin('http://rr.example.com')).toBeNull();
    expect(httpsOrigin(42)).toBeNull();
  });
});
