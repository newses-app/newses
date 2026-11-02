import { describe, expect, it } from 'vitest';
import { SHORTCUT_ACTIONS } from '@newses/shared/client';
import {
  ACTION_GROUPS,
  bindableKey,
  CHORD_TIMEOUT_MS,
  clashingActions,
  DEFAULT_BINDINGS,
  effectiveBindings,
  findConflicts,
  hasCommandModifier,
  isTyping,
  ShortcutMatcher,
  shortcutKey,
  usesArrowKeys,
  withOverride,
} from './shortcuts.ts';

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

  it('uses the user’s bindings', () => {
    const matcher = new ShortcutMatcher(
      effectiveBindings({ nextFeed: ['J'], help: ['h', 'z z'], toggleStar: [] }),
    );
    expect(matcher.press('J', 0)).toBe('nextFeed');
    expect(matcher.press('j', 0)).toBeNull();
    expect(matcher.press('s', 0)).toBeNull();
    expect(matcher.press('h', 0)).toBe('help');
    expect(matcher.press('z', 0)).toBeNull();
    expect(matcher.press('z', 10)).toBe('help');
  });
});

describe('bindings', () => {
  it('defaults have no clashes and every action appears in one group', () => {
    expect(findConflicts(DEFAULT_BINDINGS)).toEqual([]);
    expect(ACTION_GROUPS.flatMap((g) => g.actions).sort()).toEqual([...SHORTCUT_ACTIONS].sort());
  });

  it('finds equal sequences and chord-prefix clashes', () => {
    expect(clashingActions(DEFAULT_BINDINGS, 's', 'help')).toEqual(['toggleStar']);
    // `g` alone would swallow every `g …` chord.
    expect(clashingActions(DEFAULT_BINDINGS, 'g')).toContain('gotoAll');
    // `s x` needs `s` as a chord prefix, which is bound alone.
    expect(clashingActions(DEFAULT_BINDINGS, 's x')).toEqual(['toggleStar']);
    expect(clashingActions(DEFAULT_BINDINGS, 'z')).toEqual([]);
    expect(findConflicts(effectiveBindings({ help: ['s'] }))).toEqual([
      { sequence: 's', actions: ['toggleStar', 'help'] },
      { sequence: 's', actions: ['help', 'toggleStar'] },
    ]);
  });

  it('keeps overrides minimal', () => {
    expect(withOverride({}, 'help', ['h'])).toEqual({ help: ['h'] });
    expect(withOverride({ help: ['h'] }, 'help', ['?'])).toEqual({});
    expect(withOverride({ help: ['h'] }, 'toggleStar', [])).toEqual({
      help: ['h'],
      toggleStar: [],
    });
  });

  it('records bindable keys only', () => {
    const key = (k: string, mods: Partial<KeyboardEvent> = {}) =>
      bindableKey({
        key: k,
        ctrlKey: false,
        altKey: false,
        metaKey: false,
        getModifierState: () => false,
        ...mods,
      });
    expect(key('j')).toBe('j');
    expect(key('ArrowDown')).toBe('ArrowDown');
    expect(key('j', { ctrlKey: true })).toBeNull();
    expect(key('Shift')).toBeNull();
    expect(key(' ')).toBeNull();
    expect(key('Tab')).toBeNull();
  });
});

describe('shortcutKey', () => {
  const key = (key: string, code: string, shiftKey = false) => ({ key, code, shiftKey });

  it('uses the Latin letter of a non-Latin layout, chords included', () => {
    const matcher = new ShortcutMatcher();
    expect(matcher.press(shortcutKey(key('מ', 'KeyN'), matcher), 0)).toBe('nextArticle');
    expect(matcher.press(shortcutKey(key('Т', 'KeyN', true), matcher), 0)).toBe('pageDown');
    expect(matcher.press(shortcutKey(key('п', 'KeyG'), matcher), 0)).toBeNull();
    expect(matcher.press(shortcutKey(key('ф', 'KeyA'), matcher), 10)).toBe('gotoAll');
  });

  it('leaves ASCII keys, keys outside the letters, and bound keys alone', () => {
    const matcher = new ShortcutMatcher(effectiveBindings({ gotoAll: ['й'] }));
    expect(shortcutKey(key('/', 'Digit7', true), matcher)).toBe('/');
    expect(shortcutKey(key('n', 'KeyB'), matcher)).toBe('n');
    expect(shortcutKey(key('ñ', 'Semicolon'), matcher)).toBe('ñ');
    expect(shortcutKey(key('й', 'KeyQ'), matcher)).toBe('й');
    expect(shortcutKey(key('ArrowDown', 'ArrowDown'), matcher)).toBe('ArrowDown');
  });
});

describe('hasCommandModifier', () => {
  const held = (mods: Partial<KeyboardEvent>, altGraph = false) =>
    hasCommandModifier({
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      getModifierState: () => altGraph,
      ...mods,
    });

  it('counts Ctrl, Alt, and Meta, but not AltGr reported as Ctrl and Alt', () => {
    expect(held({})).toBe(false);
    expect(held({ ctrlKey: true })).toBe(true);
    expect(held({ altKey: true })).toBe(true);
    expect(held({ metaKey: true })).toBe(true);
    expect(held({ ctrlKey: true, altKey: true }, true)).toBe(false);
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

describe('usesArrowKeys', () => {
  it('detects widgets that move focus with the arrow keys', () => {
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    const item = document.createElement('div');
    menu.append(item);
    const list = document.createElement('div');
    list.className = 'v-list';
    const link = document.createElement('a');
    list.append(link);
    expect(usesArrowKeys(item)).toBe(true);
    expect(usesArrowKeys(link)).toBe(true);
    expect(usesArrowKeys(document.body)).toBe(false);
    expect(usesArrowKeys(null)).toBe(false);
  });

  it('leaves the arrow keys to media players', () => {
    expect(usesArrowKeys(document.createElement('audio'))).toBe(true);
    expect(usesArrowKeys(document.createElement('video'))).toBe(true);
  });
});
