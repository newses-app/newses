import type {
  Category,
  Entry,
  EntryListResponse,
  MarkReadRequest,
  Prefs,
  Subscription,
} from '@newses/shared';
import { DEFAULT_PREFS } from '@newses/shared/client';
import Dexie from 'dexie';
import { proxiedHtml } from '../lib/offline-content.ts';
import {
  type LocalListQuery,
  localPage,
  type StreamContext,
  streamFilter,
} from '../lib/offline-streams.ts';
import { connectivity } from './connectivity.ts';
import { fromStoredEntry, type OfflineDb, type StoredContent, toStoredEntry } from './db.ts';
import { withChange } from './outbox.ts';
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

/** The tree and preferences that stream membership and counters depend on, as stored. */
export async function storedStreamContext(db: OfflineDb, now = Date.now()) {
  const [categories, subscriptions, prefs] = await Promise.all([
    readQuery<Category[]>(db, 'categories'),
    readQuery<Subscription[]>(db, 'subscriptions'),
    storedPrefs(db),
  ]);
  const context: StreamContext = {
    categories: categories ?? [],
    subscriptions: subscriptions ?? [],
    scoreHideBelow: prefs.scoreHideBelow,
    freshMaxAgeHours: prefs.freshMaxAgeHours,
    now,
  };
  return { context, prefs };
}

/** One page of a stream from the store, with content when asked for. */
export async function localList(
  db: OfflineDb,
  query: LocalListQuery & { content: boolean },
): Promise<EntryListResponse> {
  const [{ context, prefs }, stored] = await Promise.all([
    storedStreamContext(db),
    db.entries.toArray(),
  ]);
  const page = localPage(stored.map(fromStoredEntry), query, context);
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

/** The highest entry id the store has, the newest the device knows of. */
export async function newestStoredId(db: OfflineDb): Promise<number | undefined> {
  return (await db.entries.orderBy(':id').lastKey()) as number | undefined;
}

/**
 * Catch-up on the stored entries, as the server will apply it: the stream's unread entries, older
 * than `olderThanDays` and up to `maxId` when given. Returns the entries as they were.
 */
export async function localCatchUp(
  db: OfflineDb,
  request: MarkReadRequest,
  now = Date.now(),
): Promise<Entry[]> {
  const { context } = await storedStreamContext(db, now);
  const inStream = streamFilter(request, context);
  const before =
    request.olderThanDays === undefined
      ? null
      : new Date(now - request.olderThanDays * 86_400_000).toISOString();
  return db.transaction('rw', db.entries, async () => {
    const caught = (
      await db.entries
        .where('[unread+sortAt]')
        .between([1, Dexie.minKey], [1, Dexie.maxKey])
        .toArray()
    )
      .map(fromStoredEntry)
      .filter(
        (e) =>
          inStream(e) &&
          (before === null || e.sortAt < before) &&
          (request.maxId === undefined || e.id <= request.maxId),
      );
    await db.entries.bulkPut(
      caught.map((e) => toStoredEntry(withChange(e, { unread: false }, now))),
    );
    return caught;
  });
}

/** Applies a change made on this device to the stored copies of entries; returns them as they were. */
export async function changeStored(
  db: OfflineDb,
  ids: readonly number[],
  patch: Partial<Entry>,
  now = Date.now(),
): Promise<Entry[]> {
  return db.transaction('rw', db.entries, async () => {
    const before = (await db.entries.bulkGet([...ids]))
      .filter((e) => e !== undefined)
      .map(fromStoredEntry);
    await db.entries.bulkPut(before.map((e) => toStoredEntry(withChange(e, patch, now))));
    return before;
  });
}
