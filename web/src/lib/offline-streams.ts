import type { Category, Entry, EntryListResponse, Stream, Subscription } from '@newses/shared';

/** Recently read lists entries read within this many days, as on the server. */
const RECENTLY_READ_DAYS = 7;
const HOUR_MS = 3_600_000;

/** What deciding stream membership needs beyond the entries: the tree and two preferences. */
export interface StreamContext {
  categories: readonly Pick<Category, 'id' | 'parentId'>[];
  /** `hideFromAll` is missing in snapshots from servers before API 1.4. */
  subscriptions: readonly (Pick<Subscription, 'id' | 'categoryId'> &
    Partial<Pick<Subscription, 'hideFromAll'>>)[];
  scoreHideBelow: number;
  freshMaxAgeHours: number;
  now: number;
}

export interface LocalListQuery {
  stream: Stream;
  view: 'all' | 'unread' | 'adaptive';
  order: 'newest' | 'oldest' | 'title';
  cursor?: string | undefined;
  limit: number;
}

/** A category and every category under it. */
function subtree(categories: StreamContext['categories'], root: number): Set<number> {
  const ids = new Set([root]);
  for (let grew = true; grew;) {
    grew = false;
    for (const c of categories)
      if (c.parentId !== null && ids.has(c.parentId) && !ids.has(c.id)) {
        ids.add(c.id);
        grew = true;
      }
  }
  return ids;
}

/** The test for entries not from a subscription hidden from All articles and Fresh. */
export function notHiddenFromAll(
  context: StreamContext,
): (entry: Pick<Entry, 'subscriptionId'>) => boolean {
  const hidden = new Set(context.subscriptions.filter((s) => s.hideFromAll).map((s) => s.id));
  return (e) => e.subscriptionId === null || !hidden.has(e.subscriptionId);
}

/** The test for entries in `stream`, as `streamCondition` on the server. */
export function streamFilter(stream: Stream, context: StreamContext): (entry: Entry) => boolean {
  const inSubscriptions = (categoryIds: Set<number> | null) => {
    const ids = new Set(
      context.subscriptions
        .filter((s) =>
          categoryIds === null ? s.categoryId === null : categoryIds.has(s.categoryId ?? -1),
        )
        .map((s) => s.id),
    );
    return (e: Entry) => e.subscriptionId !== null && ids.has(e.subscriptionId);
  };
  if (stream.subscriptionId !== undefined) return (e) => e.subscriptionId === stream.subscriptionId;
  if (stream.categoryId === 0) return inSubscriptions(null);
  if (stream.labelId !== undefined) {
    const { labelId } = stream;
    return (e) => e.labels.includes(labelId);
  }
  if (stream.tag !== undefined) {
    const { tag } = stream;
    return (e) => e.tags.includes(tag);
  }
  if (stream.categoryId !== undefined)
    return inSubscriptions(subtree(context.categories, stream.categoryId));
  switch (stream.special) {
    case undefined:
    case 'all':
      return notHiddenFromAll(context);
    case 'fresh': {
      const shown = notHiddenFromAll(context);
      const since = new Date(context.now - context.freshMaxAgeHours * HOUR_MS).toISOString();
      return (e) => e.unread && e.sortAt > since && shown(e);
    }
    case 'starred':
      return (e) => e.starred;
    case 'published':
      return (e) => e.published;
    case 'recentlyRead': {
      const since = new Date(context.now - RECENTLY_READ_DAYS * 24 * HOUR_MS).toISOString();
      return (e) => e.readAt !== null && e.readAt > since;
    }
  }
}

/** Subscriptions, categories, All, and Fresh hide low scores; the picked-out streams show them. */
const hidesLowScores = (stream: Stream) =>
  stream.labelId === undefined &&
  stream.tag === undefined &&
  (stream.special === undefined || stream.special === 'all' || stream.special === 'fresh');

const OFFSET_PREFIX = 'local:';

function compare(order: LocalListQuery['order'], stream: Stream) {
  if (order === 'title') {
    const key = (e: Entry) => (e.title ?? '').toLowerCase();
    return (a: Entry, b: Entry) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : a.id - b.id);
  }
  // Recently read lists in reading order.
  const time = (e: Entry) => (stream.special === 'recentlyRead' ? (e.readAt ?? '') : e.sortAt);
  const sign = order === 'oldest' ? 1 : -1;
  return (a: Entry, b: Entry) =>
    time(a) === time(b) ? sign * (a.id - b.id) : time(a) < time(b) ? -sign : sign;
}

/**
 * One page of a stream from stored entries, in the API's shape. Pages continue by offset, so a
 * cursor from the server (a list loaded online) has no local continuation.
 */
export function localPage(
  entries: readonly Entry[],
  query: LocalListQuery,
  context: StreamContext,
): EntryListResponse {
  const inStream = streamFilter(query.stream, context);
  const hide = hidesLowScores(query.stream);
  const shown = entries.filter((e) => inStream(e) && (!hide || e.score >= context.scoreHideBelow));
  const view =
    query.view === 'adaptive' ? (shown.some((e) => e.unread) ? 'unread' : 'all') : query.view;
  if (query.cursor && !query.cursor.startsWith(OFFSET_PREFIX))
    return { entries: [], cursor: null, view };
  const offset = query.cursor ? Number(query.cursor.slice(OFFSET_PREFIX.length)) : 0;
  const listed = (view === 'unread' ? shown.filter((e) => e.unread) : shown).sort(
    compare(query.order, query.stream),
  );
  const page = listed.slice(offset, offset + query.limit);
  const next = offset + page.length;
  return {
    entries: page,
    cursor: next < listed.length ? `${OFFSET_PREFIX}${String(next)}` : null,
    view,
  };
}
