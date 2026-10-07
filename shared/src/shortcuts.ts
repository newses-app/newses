// Keyboard shortcut actions, shared so the server can validate the bindings preference. No Zod,
// so browsers can import it; default bindings live in the web app.

export const SHORTCUT_ACTIONS = [
  'nextFeed',
  'prevFeed',
  'nextArticle',
  'prevArticle',
  'pageDown',
  'pageUp',
  'toggleStar',
  'togglePublished',
  'toggleUnread',
  'openOriginal',
  'editNote',
  'editLabels',
  'editTags',
  'closeArticle',
  'search',
  'help',
  'refreshFeed',
  'toggleHideRead',
  'subscribe',
  'editFeed',
  'catchUpFeed',
  'catchUpAll',
  'reverseOrder',
  'toggleCombined',
  'toggleCategory',
  'gotoAll',
  'gotoFresh',
  'gotoStarred',
  'gotoPublished',
  'gotoRecentlyRead',
  'gotoSettings',
  'gotoTags',
] as const;

export type ShortcutAction = (typeof SHORTCUT_ACTIONS)[number];

export const MAX_BINDINGS_PER_ACTION = 4;

/**
 * Whether `sequence` is one `KeyboardEvent.key` value, or two separated by a space (a chord).
 * Space itself cannot be bound.
 */
export function isKeySequence(sequence: string): boolean {
  const keys = sequence.split(' ');
  return keys.length <= 2 && keys.every((key) => key.length > 0 && key.length <= 20);
}
