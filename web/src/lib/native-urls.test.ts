import { describe, expect, it } from 'vitest';
import { absolute, iconSrc, resolveContentUrls } from './native-urls.ts';

const SERVER = 'https://rr.example.com';

describe('absolute', () => {
  it('resolves server-relative URLs in the apps only', () => {
    expect(absolute('/api/v1/images/s/u', SERVER)).toBe('https://rr.example.com/api/v1/images/s/u');
    expect(absolute('/api/v1/images/s/u', null)).toBe('/api/v1/images/s/u');
    expect(absolute('https://cdn.example/a.png', SERVER)).toBe('https://cdn.example/a.png');
    expect(absolute('//cdn.example/a.png', SERVER)).toBe('//cdn.example/a.png');
  });
});

describe('iconSrc', () => {
  const subscription = { id: 7, iconUrl: '/api/v1/favicons/3' };

  it('uses the API URL in the browser', () => {
    expect(iconSrc(subscription, '/feed-icons/1.abc', null)).toBe('/api/v1/favicons/3');
  });

  it('uses the signed icon path on the server in the apps', () => {
    expect(iconSrc(subscription, '/feed-icons/1.abc', SERVER)).toBe(
      'https://rr.example.com/feed-icons/1.abc/7.ico',
    );
    expect(iconSrc(subscription, undefined, SERVER)).toBeNull();
  });

  it('has no icon when the feed has none', () => {
    expect(iconSrc({ id: 7, iconUrl: null }, '/feed-icons/1.abc', SERVER)).toBeNull();
  });
});

describe('resolveContentUrls', () => {
  it('leaves content alone in the browser', () => {
    const html = '<img src="/api/v1/images/s/u">';
    expect(resolveContentUrls(html, null)).toBe(html);
  });

  it('makes proxied images, srcsets, posters, and links absolute', () => {
    const html = [
      '<p><a href="/public/share/x">share</a> <a href="https://site.example/">site</a></p>',
      '<img src="/api/v1/images/a/b" srcset="/api/v1/images/c/d 2x, https://cdn.example/e.png 3x">',
      '<video poster="/api/v1/images/f/g"></video>',
    ].join('');
    const doc = new DOMParser().parseFromString(resolveContentUrls(html, SERVER), 'text/html');
    const [share, site] = doc.querySelectorAll('a');
    expect(share?.getAttribute('href')).toBe('https://rr.example.com/public/share/x');
    expect(site?.getAttribute('href')).toBe('https://site.example/');
    const img = doc.querySelector('img');
    expect(img?.getAttribute('src')).toBe('https://rr.example.com/api/v1/images/a/b');
    expect(img?.getAttribute('srcset')).toBe(
      'https://rr.example.com/api/v1/images/c/d 2x, https://cdn.example/e.png 3x',
    );
    expect(doc.querySelector('video')?.getAttribute('poster')).toBe(
      'https://rr.example.com/api/v1/images/f/g',
    );
  });
});
