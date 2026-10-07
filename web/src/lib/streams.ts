import type { SpecialFeed, Stream } from '@rss-reader/shared';

/**
 * A stream as a route segment: special feeds by name (`read` for recently read), `f<id>` for a
 * subscription, `c<id>` for a category (`c0` uncategorised), `l<id>` for a label, `t<tag>` for
 * a tag. Tags are free text, so links to streams go through `streamPath`.
 */
export type StreamKey = string;

const SPECIAL_KEYS: Record<string, SpecialFeed> = {
  all: 'all',
  fresh: 'fresh',
  starred: 'starred',
  published: 'published',
  read: 'recentlyRead',
};

export const SPECIAL_FEEDS: { key: StreamKey; special: SpecialFeed }[] = Object.entries(
  SPECIAL_KEYS,
).map(([key, special]) => ({ key, special }));

/** Route pattern accepting every stream key. */
export const STREAM_PATTERN = `${Object.keys(SPECIAL_KEYS).join('|')}|f\\d+|c\\d+|l\\d+|t[^/]+`;

export function parseStream(key: StreamKey): Stream {
  const special = SPECIAL_KEYS[key];
  if (special) return { special };
  const id = Number(key.slice(1));
  if (key.startsWith('f') && Number.isInteger(id)) return { subscriptionId: id };
  if (key.startsWith('c') && Number.isInteger(id)) return { categoryId: id };
  if (key.startsWith('l') && Number.isInteger(id)) return { labelId: id };
  if (key.startsWith('t') && key.length > 1) return { tag: key.slice(1) };
  return { special: 'all' };
}

export const subscriptionKey = (id: number): StreamKey => `f${String(id)}`;
export const categoryKey = (id: number): StreamKey => `c${String(id)}`;
export const labelKey = (id: number): StreamKey => `l${String(id)}`;
export const tagKey = (tag: string): StreamKey => `t${tag}`;

/** The route path of a stream; the router decodes it back to the key. */
export const streamPath = (key: StreamKey) => `/${encodeURIComponent(key)}`;
