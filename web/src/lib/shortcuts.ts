/** Actions bound to keys, after TTRSS's defaults. */
export type ShortcutAction =
  | 'nextFeed'
  | 'prevFeed'
  | 'nextArticle'
  | 'prevArticle'
  | 'pageDown'
  | 'pageUp'
  | 'toggleStar'
  | 'togglePublished'
  | 'toggleUnread'
  | 'openOriginal'
  | 'editNote'
  | 'editLabels'
  | 'closeArticle'
  | 'search'
  | 'help'
  | 'refreshFeed'
  | 'toggleHideRead'
  | 'subscribe'
  | 'editFeed'
  | 'catchUpFeed'
  | 'catchUpAll'
  | 'reverseOrder'
  | 'toggleCombined'
  | 'toggleCategory'
  | 'gotoAll'
  | 'gotoFresh'
  | 'gotoStarred'
  | 'gotoPublished'
  | 'gotoRecentlyRead'
  | 'gotoSettings';

/** Key sequences (space-separated chords) and their actions, grouped for the help overlay. */
export const SHORTCUT_GROUPS: { group: string; bindings: [string, ShortcutAction][] }[] = [
  {
    group: 'navigation',
    bindings: [
      ['j', 'nextFeed'],
      ['k', 'prevFeed'],
      ['n', 'nextArticle'],
      ['p', 'prevArticle'],
      ['ArrowDown', 'nextArticle'],
      ['ArrowUp', 'prevArticle'],
      ['N', 'pageDown'],
      ['P', 'pageUp'],
      ['Escape', 'closeArticle'],
      ['/', 'search'],
      ['x', 'toggleCategory'],
    ],
  },
  {
    group: 'article',
    bindings: [
      ['s', 'toggleStar'],
      ['S', 'togglePublished'],
      ['u', 'toggleUnread'],
      ['o', 'openOriginal'],
      ['a n', 'editNote'],
      ['a l', 'editLabels'],
      ['a q', 'closeArticle'],
    ],
  },
  {
    group: 'feed',
    bindings: [
      ['f r', 'refreshFeed'],
      ['f a', 'toggleHideRead'],
      ['f s', 'subscribe'],
      ['f e', 'editFeed'],
      ['f q', 'catchUpFeed'],
      ['f x', 'reverseOrder'],
      ['f C', 'toggleCombined'],
      ['Q', 'catchUpAll'],
    ],
  },
  {
    group: 'goTo',
    bindings: [
      ['g a', 'gotoAll'],
      ['g f', 'gotoFresh'],
      ['g s', 'gotoStarred'],
      ['g p', 'gotoPublished'],
      ['g r', 'gotoRecentlyRead'],
      ['g P', 'gotoSettings'],
      ['?', 'help'],
    ],
  },
];

const BINDINGS = new Map(SHORTCUT_GROUPS.flatMap((g) => g.bindings));
const PREFIXES = new Set(
  [...BINDINGS.keys()].filter((k) => k.includes(' ')).map((k) => k.split(' ')[0]),
);

/** Milliseconds a chord prefix (e.g. `g`) waits for its second key. */
export const CHORD_TIMEOUT_MS = 1500;

/**
 * Turns key presses into actions, handling two-key chords. `press` returns the action, or null
 * while waiting for a chord's second key or when nothing is bound.
 */
export class ShortcutMatcher {
  #prefix: string | null = null;
  #prefixAt = 0;

  press(key: string, now = Date.now()): ShortcutAction | null {
    const prefix = this.#prefix && now - this.#prefixAt <= CHORD_TIMEOUT_MS ? this.#prefix : null;
    this.#prefix = null;
    if (prefix) {
      const action = BINDINGS.get(`${prefix} ${key}`);
      if (action) return action;
    }
    if (PREFIXES.has(key)) {
      this.#prefix = key;
      this.#prefixAt = now;
      return null;
    }
    return BINDINGS.get(key) ?? null;
  }
}

/** Whether a key event comes from a text field, where shortcuts must not fire. */
export function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

const ARROW_WIDGETS = '[role=menu], [role=listbox], [role=tablist], [role=radiogroup], .v-list';

/** Whether a key event comes from a widget that moves focus with the arrow keys itself. */
export function usesArrowKeys(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(ARROW_WIDGETS) !== null;
}
