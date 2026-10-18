import { describe, expect, it } from 'vitest';
import { webBridge } from './bridge.ts';
import { createShares, firstUrl, sharedLink } from './share.ts';

describe('firstUrl', () => {
  it('finds the first web address in shared text', () => {
    expect(firstUrl('https://example.com/feed.xml')).toBe('https://example.com/feed.xml');
    expect(firstUrl('A good read https://example.com/post?id=1. Via someone')).toBe(
      'https://example.com/post?id=1',
    );
    expect(firstUrl('(see http://example.com/a)')).toBe('http://example.com/a');
  });

  it('ignores text without one', () => {
    expect(firstUrl('no links here')).toBeNull();
    expect(firstUrl('ftp://example.com/file')).toBeNull();
  });
});

describe('sharedLink', () => {
  it('titles the page by the subject, else by the rest of the text', () => {
    expect(sharedLink('https://example.com/post', 'A good read')).toEqual({
      url: 'https://example.com/post',
      title: 'A good read',
    });
    expect(sharedLink('A good read — https://example.com/post', null)).toEqual({
      url: 'https://example.com/post',
      title: 'A good read',
    });
    expect(sharedLink('https://example.com/post', 'https://example.com/post')).toEqual({
      url: 'https://example.com/post',
      title: null,
    });
    expect(sharedLink('no address', 'https://example.com/x')?.url).toBe('https://example.com/x');
    expect(sharedLink('no address', 'none either')).toBeNull();
  });
});

describe('createShares', () => {
  it('keeps the shared page until it is taken', () => {
    let share: (text: string, subject: string | null) => void = () => undefined;
    const shares = createShares({
      ...webBridge,
      onShare: (handler) => {
        share = handler;
      },
    });
    share('Title https://example.com/', null);
    expect(shares.pending.value).toEqual({ url: 'https://example.com/', title: 'Title' });
    expect(shares.take()).toEqual({ url: 'https://example.com/', title: 'Title' });
    expect(shares.take()).toBeNull();
    share('nothing to subscribe to', null);
    expect(shares.pending.value).toBeNull();
    shares.offer({ url: 'https://example.com/b', title: null });
    expect(shares.take()?.url).toBe('https://example.com/b');
  });
});
