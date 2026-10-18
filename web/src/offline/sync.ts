import type {
  ApiClient,
  Entry,
  EntryListQuery,
  ServerInfo,
  Subscription,
  SyncResponse,
} from '@newses/shared';
import { API_VERSION, ApiError } from '@newses/shared/client';
import Dexie from 'dexie';
import {
  DEFAULT_KEEP,
  type KeepLimits,
  keeps,
  readCutoff,
  upsertById,
} from '../lib/offline-keep.ts';
import { type OfflineDb, type StoredImage, toStoredEntry } from './db.ts';
import { withPending } from './outbox.ts';
import { readQuery, type SnapshotQuery, writeQuery } from './snapshot.ts';

/** The API minor that added what the store needs: sync tokens, read times, content versions. */
const OFFLINE_API_MINOR = 1;
const PAGE_LIMIT = 200;
const SYNC_LIMIT = 1000;
const TOKEN_KEY = 'syncToken';

/** The API minor that made replayed changes compare-and-set, and labels and tags merge. */
const CONFLICTS_API_MINOR = 2;
const RELOAD_KEY = 'reload';

export const supportsOffline = ({ apiVersion }: ServerInfo) =>
  apiVersion.major === API_VERSION.major && apiVersion.minor >= OFFLINE_API_MINOR;

export const detectsConflicts = ({ apiVersion }: ServerInfo) =>
  apiVersion.major === API_VERSION.major && apiVersion.minor >= CONFLICTS_API_MINOR;

/** Has the next sync load everything again, as after keeping more unread entries. */
export async function reloadStore(db: OfflineDb): Promise<void> {
  await db.meta.put({ key: RELOAD_KEY, value: true });
}

export interface SyncOptions {
  api: ApiClient;
  db: OfflineDb;
  limits?: KeepLimits;
  now?: () => number;
  /** Before loading everything again after the server forgot deletions: send queued changes. */
  beforeResync?: () => Promise<void>;
  /** Each page of changes once stored, to patch what is on screen. */
  onChanges?: (changes: SyncResponse) => void;
}

/**
 * Puts the entries the store keeps and removes the others, for sync and for lists loaded online,
 * with the changes still waiting in the outbox applied; returns them so. Content stays only with
 * its entry.
 */
export async function storeEntries(
  db: OfflineDb,
  entries: readonly Entry[],
  now: number,
  limits: KeepLimits = DEFAULT_KEEP,
): Promise<Entry[]> {
  return db.transaction('rw', db.entries, db.contents, db.images, db.outbox, async () => {
    const current = await withPending(db, entries);
    const kept = current.filter((e) => keeps(e, now, limits));
    const dropped = current.filter((e) => !keeps(e, now, limits)).map((e) => e.id);
    await db.entries.bulkPut(kept.map(toStoredEntry));
    await removeEntries(db, dropped);
    return current;
  });
}

/** Removes entries with their content, and images no other stored entry shows. */
async function removeEntries(db: OfflineDb, ids: readonly number[]): Promise<void> {
  if (ids.length === 0) return;
  await db.entries.bulkDelete([...ids]);
  await db.contents.bulkDelete([...ids]);
  const gone = new Set(ids);
  const shown: StoredImage[] = [];
  const unused: string[] = [];
  for (const image of await db.images
    .where('entryIds')
    .anyOf([...ids])
    .toArray()) {
    const entryIds = image.entryIds.filter((id) => !gone.has(id));
    if (entryIds.length > 0) shown.push({ ...image, entryIds });
    else unused.push(image.url);
  }
  await db.images.bulkDelete(unused);
  await db.images.bulkPut(shown);
}

/**
 * Brings the store up to date: everything kept the first time, and again when the server has
 * forgotten deletions since the last sync; otherwise only what changed.
 */
export async function syncStore(options: SyncOptions): Promise<'bootstrap' | 'changes'> {
  const token = (await options.db.meta.get(TOKEN_KEY))?.value;
  const reload = (await options.db.meta.get(RELOAD_KEY))?.value === true;
  if (typeof token === 'string' && !reload) {
    try {
      await followChanges(options, token);
      return 'changes';
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 410)) throw error;
      await options.beforeResync?.();
    }
  }
  await bootstrap(options);
  return 'bootstrap';
}

async function bootstrap(options: SyncOptions): Promise<void> {
  const { api, db } = options;
  const limits = options.limits ?? DEFAULT_KEEP;
  const now = (options.now ?? Date.now)();
  // First, so changes made while the lists load arrive afterwards.
  const { next } = await api.syncToken();
  await db.transaction('rw', db.entries, db.contents, db.images, db.meta, async () => {
    await db.entries.clear();
    await db.meta.bulkDelete([TOKEN_KEY, RELOAD_KEY]);
  });
  // Before the headlines, so even a first sync cut short leaves enough to start offline.
  const snapshots: [SnapshotQuery, () => Promise<unknown>][] = [
    ['session', () => api.auth.session()],
    ['prefs', () => api.prefs.get()],
    ['subscriptions', () => api.subscriptions.list()],
    ['categories', () => api.categories.list()],
    ['labels', () => api.labels.list()],
    ['themes', () => api.themes.list()],
    ['counters', () => api.counters()],
    ['tags', () => api.tags()],
  ];
  const results = await Promise.all(snapshots.map(([, load]) => load()));
  await Promise.all(snapshots.map(([name], i) => writeQuery(db, name, results[i])));
  /** Stores up to `cap` entries of the list; returns how many it stored. */
  const load = async (query: EntryListQuery, cap: number) => {
    let cursor: string | null = null;
    let loaded = 0;
    while (loaded < cap) {
      const page = await api.entries.list({
        ...query,
        limit: Math.min(PAGE_LIMIT, cap - loaded),
        ...(cursor && { cursor }),
      });
      await storeEntries(db, page.entries, now, limits);
      loaded += page.entries.length;
      cursor = page.cursor;
      if (!cursor) break;
    }
    return loaded;
  };
  // All leaves out subscriptions hidden from it, so their unread load after it, within its cap.
  const listed = results[snapshots.findIndex(([name]) => name === 'subscriptions')];
  const hidden = ((listed ?? []) as Subscription[]).filter((s) => s.hideFromAll);
  let unread = await load({ special: 'all', view: 'unread' }, limits.unread);
  for (const s of hidden)
    unread += await load({ subscriptionId: s.id, view: 'unread' }, limits.unread - unread);
  await load({ special: 'starred', view: 'all' }, limits.starred);
  await load({ special: 'recentlyRead', view: 'all' }, limits.read);
  await db.meta.put({ key: TOKEN_KEY, value: next });
  await followChanges(options, next);
}

async function followChanges(options: SyncOptions, token: string): Promise<void> {
  const { api, db } = options;
  const limits = options.limits ?? DEFAULT_KEEP;
  const now = (options.now ?? Date.now)();
  let since = token;
  for (;;) {
    const changes = await applyChanges(db, await api.sync(since, SYNC_LIMIT), now, limits);
    options.onChanges?.(changes);
    since = changes.next;
    if (!changes.more) return;
  }
}

/** The token the store's sync stands at; null before the first sync. */
export async function storedSyncToken(db: OfflineDb): Promise<string | null> {
  const token = (await db.meta.get(TOKEN_KEY))?.value;
  return typeof token === 'string' ? token : null;
}

/**
 * Stores one page of changes and moves the store's token on to its `next`; returns the page with
 * the changes still waiting applied to its entries, to patch what is on screen.
 */
export async function applyChanges(
  db: OfflineDb,
  changes: SyncResponse,
  now: number,
  limits: KeepLimits = DEFAULT_KEEP,
): Promise<SyncResponse> {
  const tables = [db.entries, db.contents, db.images, db.meta, db.outbox];
  const entries = await db.transaction('rw', tables, async () => {
    const current = await storeEntries(db, changes.entries, now, limits);
    await removeEntries(db, changes.deleted.entries);
    await patchList(db, 'subscriptions', changes.subscriptions, changes.deleted.subscriptions);
    await patchList(db, 'categories', changes.categories, changes.deleted.categories);
    await patchList(db, 'labels', changes.labels, changes.deleted.labels);
    await db.meta.put({ key: TOKEN_KEY, value: changes.next });
    return current;
  });
  return { ...changes, entries };
}

async function patchList(
  db: OfflineDb,
  name: SnapshotQuery,
  changed: readonly { id: number }[],
  deleted: readonly number[],
): Promise<void> {
  if (changed.length === 0 && deleted.length === 0) return;
  const list = await readQuery<{ id: number }[]>(db, name);
  if (list) await writeQuery(db, name, upsertById(list, changed, deleted));
}

/**
 * Removes what the store no longer keeps: entries read too long ago, and the oldest past each
 * limit (unread entries that are also starred count as starred). Returns how many went.
 */
export async function pruneStore(
  db: OfflineDb,
  now: number,
  limits: KeepLimits = DEFAULT_KEEP,
): Promise<number> {
  const all = (index: '[unread+sortAt]' | '[starred+sortAt]') =>
    db.entries.where(index).between([1, Dexie.minKey], [1, Dexie.maxKey]);
  const overflow = (ids: number[], cap: number) => ids.slice(0, Math.max(0, ids.length - cap));
  const notKept = (e: { unread: number; starred: number }) => e.unread === 0 && e.starred === 0;
  const [stale, unread, starred, read] = await Promise.all([
    db.entries.where('readAt').below(readCutoff(now, limits)).filter(notKept).primaryKeys(),
    all('[unread+sortAt]')
      .filter((e) => e.starred === 0)
      .primaryKeys(),
    all('[starred+sortAt]').primaryKeys(),
    db.entries.orderBy('readAt').filter(notKept).primaryKeys(),
  ]);
  const gone = new Set([
    ...stale,
    ...overflow(unread, limits.unread),
    ...overflow(starred, limits.starred),
    ...overflow(read, limits.read),
  ]);
  await db.transaction('rw', db.entries, db.contents, db.images, () =>
    removeEntries(db, [...gone]),
  );
  return gone.size;
}
