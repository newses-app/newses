import { describe, expect, it } from 'vitest';
import { CHORD_TIMEOUT_MS, isTyping, SHORTCUT_GROUPS, ShortcutMatcher } from './shortcuts.ts';

describe('ShortcutMatcher', () => {
  it('maps single keys and two-key chords', () => {
    const matcher = new ShortcutMatcher();
    expect(matcher.press('j', 0)).toBe('nextFeed');
    expect(matcher.press('S', 0)).toBe('togglePublished');
    expect(matcher.press('g', 0)).toBeNull();
    expect(matcher.press('a', 100)).toBe('gotoAll');
    expect(matcher.press('f', 200)).toBeNull();
    expect(matcher.press('a', 300)).toBe('toggleHideRead');
  });

  it('drops a chord prefix after the timeout or an unbound second key', () => {
    const matcher = new ShortcutMatcher();
    matcher.press('g', 0);
    expect(matcher.press('a', CHORD_TIMEOUT_MS + 1)).toBeNull();
    matcher.press('g', 0);
    expect(matcher.press('z', 10)).toBeNull();
    expect(matcher.press('n', 20)).toBe('nextArticle');
  });

  it('binds each key sequence once', () => {
    const sequences = SHORTCUT_GROUPS.flatMap((g) => g.bindings.map(([s]) => s));
    expect(new Set(sequences).size).toBe(sequences.length);
  });
});

describe('isTyping', () => {
  it('detects text fields', () => {
    expect(isTyping(document.createElement('input'))).toBe(true);
    expect(isTyping(document.createElement('textarea'))).toBe(true);
    expect(isTyping(document.createElement('div'))).toBe(false);
    expect(isTyping(null)).toBe(false);
  });
});
