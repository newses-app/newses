import { describe, expect, it } from 'vitest';
import { webBridge } from './bridge.ts';
import { createShares, firstUrl } from './share.ts';

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

describe('createShares', () => {
  it('keeps the shared URL until it is taken', () => {
    let share: (text: string) => void = () => undefined;
    const shares = createShares({
      ...webBridge,
      onShare: (handler) => {
        share = handler;
      },
    });
    share('Title https://example.com/');
    expect(shares.pending.value).toBe('https://example.com/');
    expect(shares.take()).toBe('https://example.com/');
    expect(shares.take()).toBeNull();
    share('nothing to subscribe to');
    expect(shares.pending.value).toBeNull();
  });
});
