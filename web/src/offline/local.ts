import type { Category, Entry, EntryListResponse, Prefs, Subscription } from '@newses/shared';
import { DEFAULT_PREFS } from '@newses/shared/client';
import { proxiedHtml } from '../lib/offline-content.ts';
import { type LocalListQuery, localPage } from '../lib/offline-streams.ts';
import { connectivity } from './connectivity.ts';
import { fromStoredEntry, type OfflineDb, type StoredContent } from './db.ts';
import { readQuery, type SnapshotQuery } from './snapshot.ts';
import { currentStore } from './store.ts';

/** Queries with a stored answer run even offline, so they can fall back to it instead of pausing. */
export const storeNetworkMode = (): 'always' | 'online' => (currentStore() ? 'always' : 'online');

/**
 * The server's answer, or the store's when the server cannot be reached and the store has one.
 * Without a network the server is not asked at all.
 */
export async function networkOrStore<T>(
  remote: () => Promise<T>,
  local: (db: OfflineDb) => Promise<T | undefined>,
): Promise<T> {
  const db = currentStore();
  if (db && connectivity.value === 'offline') {
    const stored = await local(db).catch(() => undefined);
    if (stored !== undefined) return stored;
  }
  try {
    return await remote();
  } catch (error) {
    if (db && connectivity.value !== 'online') {
      const stored = await local(db).catch(() => undefined);
      if (stored !== undefined) return stored;
    }
    throw error;
  }
}

/** Query options for a snapshot query: the server's answer, or the stored one when it cannot be reached. */
export function storedQuery<T>(name: SnapshotQuery, remote: () => Promise<T>) {
  return {
    queryFn: () => networkOrStore(remote, (db) => readQuery<T>(db, name)),
    networkMode: storeNetworkMode(),
  };
}

async function storedPrefs(db: OfflineDb): Promise<Prefs> {
  return { ...DEFAULT_PREFS, ...(await readQuery<Partial<Prefs>>(db, 'prefs')) };
}

/**
 * An entry with its stored content as the server would serve it: images at their proxy paths
 * for readers who proxy them. `content` is null when none is stored.
 */
function withContent(
  entry: Entry,
  content: StoredContent | undefined,
  proxyImages: boolean,
): Entry {
  if (!content) return { ...entry, content: null, fullContent: null, enclosures: [] };
  const serve = (html: string | null) =>
    html && proxyImages
      ? proxiedHtml(html, new Map(content.images.map((i) => [i.url, i.proxy])))
      : html;
  return {
    ...entry,
    content: serve(content.content),
    fullContent: serve(content.fullContent),
    enclosures: content.enclosures,
  };
}

/** One page of a stream from the store, with content when asked for. */
export async function localList(
  db: OfflineDb,
  query: LocalListQuery & { content: boolean },
): Promise<EntryListResponse> {
  const [categories, subscriptions, prefs, stored] = await Promise.all([
    readQuery<Category[]>(db, 'categories'),
    readQuery<Subscription[]>(db, 'subscriptions'),
    storedPrefs(db),
    db.entries.toArray(),
  ]);
  const page = localPage(stored.map(fromStoredEntry), query, {
    categories: categories ?? [],
    subscriptions: subscriptions ?? [],
    scoreHideBelow: prefs.scoreHideBelow,
    freshMaxAgeHours: prefs.freshMaxAgeHours,
    now: Date.now(),
  });
  if (!query.content) return page;
  const contents = await db.contents.bulkGet(page.entries.map((e) => e.id));
  return {
    ...page,
    entries: page.entries.map((e, i) => withContent(e, contents[i], prefs.proxyImages)),
  };
}

/**
 * A stored entry with its content. With `current`, only when the stored content is the entry's
 * latest version, so it can be shown without asking the server.
 */
export async function localEntry(
  db: OfflineDb,
  id: number,
  current = false,
): Promise<Entry | undefined> {
  const [entry, content, prefs] = await Promise.all([
    db.entries.get(id),
    db.contents.get(id),
    storedPrefs(db),
  ]);
  if (!entry) return undefined;
  if (current && content?.contentVersion !== entry.contentVersion) return undefined;
  return withContent(fromStoredEntry(entry), content, prefs.proxyImages);
}
