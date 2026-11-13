import { SHORTCUT_ACTIONS, type ShortcutAction } from '@newses/shared/client';

export type { ShortcutAction };

/** Key sequences per action; a sequence is one `KeyboardEvent.key` or a space-separated chord. */
export type Bindings = Record<ShortcutAction, string[]>;

/** The user's changes: each listed action's sequences replace its defaults. */
export type BindingOverrides = Partial<Bindings>;

/** Actions grouped for the help overlay and settings, in display order. */
export const ACTION_GROUPS: { group: string; actions: ShortcutAction[] }[] = [
  {
    group: 'navigation',
    actions: [
      'nextFeed',
      'prevFeed',
      'nextArticle',
      'prevArticle',
      'pageDown',
      'pageUp',
      'closeArticle',
      'search',
      'toggleCategory',
      'expandAllCategories',
      'collapseAllCategories',
    ],
  },
  {
    group: 'article',
    actions: [
      'toggleStar',
      'togglePublished',
      'toggleUnread',
      'openOriginal',
      'editNote',
      'editLabels',
      'editTags',
    ],
  },
  {
    group: 'feed',
    actions: [
      'reloadList',
      'refreshFeed',
      'toggleHideRead',
      'subscribe',
      'editFeed',
      'catchUpFeed',
      'reverseOrder',
      'toggleCombined',
      'catchUpAll',
    ],
  },
  {
    group: 'goTo',
    actions: [
      'gotoAll',
      'gotoFresh',
      'gotoStarred',
      'gotoPublished',
      'gotoRecentlyRead',
      'gotoSettings',
      'gotoTags',
      'help',
    ],
  },
];

/** TTRSS's default bindings, and `r` to reload the list from the server. */
export const DEFAULT_BINDINGS: Bindings = {
  nextFeed: ['j'],
  prevFeed: ['k'],
  nextArticle: ['n', 'ArrowDown'],
  prevArticle: ['p', 'ArrowUp'],
  pageDown: ['N'],
  pageUp: ['P'],
  closeArticle: ['Escape', 'a q'],
  search: ['/'],
  toggleCategory: ['x'],
  expandAllCategories: ['c e'],
  collapseAllCategories: ['c c'],
  toggleStar: ['s'],
  togglePublished: ['S'],
  toggleUnread: ['u'],
  openOriginal: ['o'],
  editNote: ['a n'],
  editLabels: ['a l'],
  editTags: ['T'],
  reloadList: ['r'],
  refreshFeed: ['f r'],
  toggleHideRead: ['f a'],
  subscribe: ['f s'],
  editFeed: ['f e'],
  catchUpFeed: ['f q'],
  reverseOrder: ['f x'],
  toggleCombined: ['f C'],
  catchUpAll: ['Q'],
  gotoAll: ['g a'],
  gotoFresh: ['g f'],
  gotoStarred: ['g s'],
  gotoPublished: ['g p'],
  gotoRecentlyRead: ['g r'],
  gotoSettings: ['g P'],
  gotoTags: ['g t'],
  help: ['?'],
};

/**
 * The defaults with the user's overrides applied. A default that clashes with a sequence the user
 * bound gives way, so a default added later never takes a key from the user.
 */
export function effectiveBindings(overrides: BindingOverrides = {}): Bindings {
  const chosen = Object.values(overrides).flat();
  const defaults = Object.fromEntries(
    SHORTCUT_ACTIONS.map((action) => [
      action,
      DEFAULT_BINDINGS[action].filter((s) => !chosen.some((c) => sequencesClash(c, s))),
    ]),
  ) as Bindings;
  return { ...defaults, ...overrides };
}

/**
 * Overrides for `action` set to `sequences`, dropping the override when it matches the default,
 * so changed defaults reach users who never touched that action.
 */
export function withOverride(
  overrides: BindingOverrides,
  action: ShortcutAction,
  sequences: string[],
): BindingOverrides {
  const rest: BindingOverrides = Object.fromEntries(
    Object.entries(overrides).filter(([key]) => key !== action),
  );
  const same =
    sequences.length === DEFAULT_BINDINGS[action].length &&
    sequences.every((s, i) => s === DEFAULT_BINDINGS[action][i]);
  return same ? rest : { ...rest, [action]: sequences };
}

/** Whether two sequences cannot both be bound: equal, or one is the other's chord prefix. */
export function sequencesClash(a: string, b: string): boolean {
  return a === b || b.startsWith(`${a} `) || a.startsWith(`${b} `);
}

/** Actions other than `action` whose bindings clash with `sequence`. */
export function clashingActions(
  bindings: Bindings,
  sequence: string,
  action?: ShortcutAction,
): ShortcutAction[] {
  return SHORTCUT_ACTIONS.filter(
    (other) => other !== action && bindings[other].some((s) => sequencesClash(s, sequence)),
  );
}

/** Every sequence that clashes with another action's, for warnings. */
export function findConflicts(
  bindings: Bindings,
): { sequence: string; actions: ShortcutAction[] }[] {
  const conflicts: { sequence: string; actions: ShortcutAction[] }[] = [];
  for (const action of SHORTCUT_ACTIONS)
    for (const sequence of bindings[action]) {
      const others = clashingActions(bindings, sequence, action);
      if (others.length > 0) conflicts.push({ sequence, actions: [action, ...others] });
    }
  return conflicts;
}

/** Milliseconds a chord prefix (e.g. `g`) waits for its second key. */
export const CHORD_TIMEOUT_MS = 1500;

/**
 * Turns key presses into actions, handling two-key chords. `press` returns the action, or null
 * while waiting for a chord's second key or when nothing is bound.
 */
export class ShortcutMatcher {
  readonly #bindings = new Map<string, ShortcutAction>();
  readonly #prefixes = new Set<string>();
  #prefix: string | null = null;
  #prefixAt = 0;

  constructor(bindings: Bindings = DEFAULT_BINDINGS) {
    for (const action of SHORTCUT_ACTIONS)
      for (const sequence of bindings[action]) {
        this.#bindings.set(sequence, action);
        const [first, second] = sequence.split(' ');
        if (first && second) this.#prefixes.add(first);
      }
  }

  /** Whether `key` is part of any binding. */
  binds(key: string): boolean {
    if (this.#prefixes.has(key)) return true;
    for (const sequence of this.#bindings.keys())
      if (sequence.split(' ').includes(key)) return true;
    return false;
  }

  press(key: string, now = Date.now()): ShortcutAction | null {
    const prefix = this.#prefix && now - this.#prefixAt <= CHORD_TIMEOUT_MS ? this.#prefix : null;
    this.#prefix = null;
    if (prefix) {
      const action = this.#bindings.get(`${prefix} ${key}`);
      if (action) return action;
    }
    if (this.#prefixes.has(key)) {
      this.#prefix = key;
      this.#prefixAt = now;
      return null;
    }
    return this.#bindings.get(key) ?? null;
  }
}

/**
 * The key an event presses for the matcher: `event.key`, or on a non-Latin layout, where that is
 * another script's letter, the Latin letter at the same place unless the key itself is bound.
 */
export function shortcutKey(
  event: Pick<KeyboardEvent, 'key' | 'code' | 'shiftKey'>,
  matcher: ShortcutMatcher,
): string {
  const letter = /^Key([A-Z])$/.exec(event.code)?.[1];
  // eslint-disable-next-line no-control-regex
  if (!letter || /^[\x00-\x7f]+$/.test(event.key) || matcher.binds(event.key)) return event.key;
  return event.shiftKey ? letter : letter.toLowerCase();
}

/** Whether Ctrl, Alt, or Meta is held; AltGr, which Windows reports as Ctrl and Alt, only types. */
export const hasCommandModifier = (
  event: Pick<KeyboardEvent, 'ctrlKey' | 'altKey' | 'metaKey' | 'getModifierState'>,
) => (event.ctrlKey || event.altKey || event.metaKey) && !event.getModifierState('AltGraph');

/** Keys shown by symbol or short name rather than their `KeyboardEvent.key` value. */
const KEY_NAMES: Record<string, string> = {
  ArrowDown: '↓',
  ArrowUp: '↑',
  ArrowLeft: '←',
  ArrowRight: '→',
  Escape: 'Esc',
};

/** The keys of a sequence as displayed. */
export const displayKeys = (sequence: string) =>
  sequence.split(' ').map((key) => KEY_NAMES[key] ?? key);

const UNBINDABLE = new Set([
  ' ',
  'Tab',
  'Shift',
  'Control',
  'Alt',
  'AltGraph',
  'Meta',
  'CapsLock',
  'Dead',
  'Process',
  'Unidentified',
]);

/**
 * The key a recorded key press binds, or null for presses shortcuts never see (with Ctrl, Alt,
 * or Meta), modifier-only keys, Space (the sequence separator), and Tab (which moves focus).
 */
export function bindableKey(
  event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'altKey' | 'metaKey' | 'getModifierState'>,
) {
  if (hasCommandModifier(event) || UNBINDABLE.has(event.key)) return null;
  return event.key.length <= 20 ? event.key : null;
}

/** Whether a key event comes from a text field, where shortcuts must not fire. */
export function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

// Media players seek and change volume with the arrow keys.
const ARROW_WIDGETS =
  '[role=menu], [role=listbox], [role=tablist], [role=radiogroup], .v-list, audio, video';

/** Whether a key event comes from a widget that uses the arrow keys itself. */
export function usesArrowKeys(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(ARROW_WIDGETS) !== null;
}
