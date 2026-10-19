import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { appFilePath, externalUrl, isAppUrl } from './urls.ts';

const WEB = '/opt/newses/web';

describe('appFilePath', () => {
  it('serves bundled files', () => {
    expect(appFilePath(WEB, 'app://newses/assets/index-abc.js')).toBe(
      join(WEB, 'assets/index-abc.js'),
    );
    expect(appFilePath(WEB, 'app://newses/favicon.svg?v=1')).toBe(join(WEB, 'favicon.svg'));
  });

  it('serves index.html for the root and client-side routes', () => {
    expect(appFilePath(WEB, 'app://newses/')).toBe(join(WEB, 'index.html'));
    expect(appFilePath(WEB, 'app://newses/f12/345')).toBe(join(WEB, 'index.html'));
    expect(appFilePath(WEB, 'app://newses/settings/feeds?x=1')).toBe(join(WEB, 'index.html'));
  });

  it('refuses paths outside the bundle and other hosts', () => {
    expect(appFilePath(WEB, 'app://newses/..%2F..%2Fetc%2Fpasswd.txt')).toBeNull();
    expect(appFilePath(WEB, 'app://newses/%E0%A4%A.js')).toBeNull();
    expect(appFilePath(WEB, 'app://other/index.html')).toBeNull();
    expect(appFilePath(WEB, 'https://newses/index.html')).toBeNull();
  });
});

describe('isAppUrl', () => {
  it('accepts only the app origin', () => {
    expect(isAppUrl('app://newses/all')).toBe(true);
    expect(isAppUrl('app://newses')).toBe(true);
    expect(isAppUrl('app://newses.evil/')).toBe(false);
    expect(isAppUrl('https://newses/')).toBe(false);
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
