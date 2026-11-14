// What the reader shows and where its keys move, apart from the view (views/ReaderView.vue).
import type {
  Category,
  Counters,
  Entry,
  EntryState,
  Label,
  Stream,
  Subscription,
} from '@newses/shared';
import { type StreamKey, subscriptionKey } from './streams.ts';
import type { ShortcutAction } from './shortcuts.ts';

/** A stream's unread count; the recently read feed has none. */
export function streamUnread(counters: Counters | undefined, stream: Stream): number {
  const { special, subscriptionId, categoryId, labelId } = stream;
  if (!counters) return 0;
  if (labelId !== undefined) return counters.labels.find((l) => l.id === labelId)?.unread ?? 0;
  if (special && special !== 'recentlyRead') return counters.special[special];
  if (subscriptionId !== undefined)
    return counters.subscriptions.find((s) => s.id === subscriptionId)?.unread ?? 0;
  if (categoryId !== undefined)
    return counters.categories.find((c) => c.id === categoryId)?.unread ?? 0;
  return 0;
}

/** What the reader calls a stream, with `t` naming special feeds, tags, and uncategorised. */
export function streamTitle(
  key: StreamKey,
  stream: Stream,
  data: {
    subscription: Pick<Subscription, 'title'> | undefined;
    labels: readonly Pick<Label, 'id' | 'caption'>[] | undefined;
    categories: readonly Pick<Category, 'id' | 'title'>[] | undefined;
  },
  t: (key: string, params?: Record<string, string>) => string,
): string {
  const { special, categoryId, labelId, tag } = stream;
  if (special) return t(`special.${key}`);
  if (tag !== undefined) return t('tags.stream', { tag });
  if (labelId !== undefined) return data.labels?.find((l) => l.id === labelId)?.caption ?? '';
  if (data.subscription) return data.subscription.title;
  if (categoryId === 0) return t('tree.uncategorised');
  return data.categories?.find((c) => c.id === categoryId)?.title ?? '';
}

/** The archive a stream browses: the subscription's, or every feed's from All articles. */
export function archiveStream(
  key: StreamKey,
  subscription: Pick<Subscription, 'id'> | undefined,
): StreamKey | null {
  if (subscription) return subscriptionKey(subscription.id);
  return key === 'all' ? 'all' : null;
}

/**
 * The index of the article a step opens: the next or previous one, or with none open the first
 * (forward) or last (back, -1 counting from the end).
 */
export function stepIndex(ids: readonly number[], openId: number | null, delta: 1 | -1): number {
  const index = ids.findIndex((id) => id === openId);
  if (index === -1) return delta === 1 ? 0 : -1;
  return index + delta;
}

/** The stream after or before `current` in the feed list's order; undefined at either end. */
export const adjacentStream = (
  keys: readonly StreamKey[],
  current: StreamKey,
  delta: 1 | -1,
): StreamKey | undefined => keys[keys.indexOf(current) + delta];

/**
 * Which panes show: below tablet width one at a time, the list or the open article; the combined
 * layout has the articles in the list.
 */
export function readerPanes(options: { singlePane: boolean; combined: boolean; open: boolean }): {
  list: boolean;
  article: boolean;
} {
  const { singlePane, combined, open } = options;
  return {
    list: !singlePane || !open || combined,
    article: !combined && (!singlePane || open),
  };
}

/** The change a toggle shortcut makes to an article; null for any other action. */
export function toggledState(action: ShortcutAction, entry: Entry): EntryState | null {
  switch (action) {
    case 'toggleStar':
      return { starred: !entry.starred };
    case 'togglePublished':
      return { published: !entry.published };
    case 'toggleUnread':
      return { unread: !entry.unread };
    default:
      return null;
  }
}

/** The document title: the open article's, then the stream's. */
export const readerTitle = (streamTitle: string, articleTitle: string | null | undefined) =>
  articleTitle ? `${articleTitle} – ${streamTitle}` : streamTitle;
