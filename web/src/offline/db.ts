import type { Enclosure, EntryContent, Entry } from '@newses/shared';
import Dexie, { type EntityTable } from 'dexie';

/** IndexedDB cannot index booleans, so stored flags are 0 or 1. */
export type Flag = 0 | 1;

/** A headline as stored: the API's entry without content, its flags as numbers. */
export interface StoredEntry extends Omit<
  Entry,
  'unread' | 'starred' | 'published' | 'content' | 'fullContent' | 'enclosures'
> {
  unread: Flag;
  starred: Flag;
  published: Flag;
}

/** An entry's content as `POST /entries/contents` returned it, and its size. */
export interface StoredContent {
  id: number;
  contentVersion: EntryContent['contentVersion'];
  content: string | null;
  fullContent: string | null;
  enclosures: Enclosure[];
  images: EntryContent['images'];
  /** UTF-8 bytes of content and full text, toward the storage limit. */
  bytes: number;
}

/** An image of stored entries, keyed by its URL in their content. */
export interface StoredImage {
  url: string;
  blob: Blob;
  bytes: number;
  /** Entries whose content shows it; the image goes when the last one does. */
  entryIds: number[];
  fetchedAt: number;
}

/** Snapshots and state by key: session, preferences, lists, counters, the sync token. */
export interface MetaRow {
  key: string;
  value: unknown;
}

/** A change made offline, waiting to be sent, in the order made. */
export interface OutboxRow {
  seq?: number;
  kind: string;
  payload: unknown;
  queuedAt: number;
}

export type OfflineDb = Dexie & {
  entries: EntityTable<StoredEntry, 'id'>;
  contents: EntityTable<StoredContent, 'id'>;
  images: EntityTable<StoredImage, 'url'>;
  meta: EntityTable<MetaRow, 'key'>;
  outbox: EntityTable<OutboxRow, 'seq'>;
};

export const toStoredEntry = ({
  content,
  fullContent,
  enclosures,
  unread,
  starred,
  published,
  ...entry
}: Entry): StoredEntry => ({
  ...entry,
  unread: unread ? 1 : 0,
  starred: starred ? 1 : 0,
  published: published ? 1 : 0,
});

export const fromStoredEntry = ({ unread, starred, published, ...entry }: StoredEntry): Entry => ({
  ...entry,
  unread: unread === 1,
  starred: starred === 1,
  published: published === 1,
});

/**
 * Opens one account's store. `onReplaced` runs when another tab (after an update) needs a newer
 * schema: this connection closes so the upgrade can proceed, and the page should offer a reload.
 */
export function openOfflineDb(name: string, onReplaced: () => void = () => undefined): OfflineDb {
  const db = new Dexie(name) as OfflineDb;
  db.version(1).stores({
    entries:
      'id, [subscriptionId+sortAt], [unread+sortAt], [starred+sortAt], [published+sortAt], readAt, *labels, *tags',
    contents: 'id',
    images: 'url, *entryIds',
    meta: 'key',
    outbox: '++seq',
  });
  // Versions and sizes read from the indexes alone, without loading content or images.
  db.version(2).stores({
    contents: 'id, contentVersion, bytes',
    images: 'url, *entryIds, bytes',
  });
  db.on('versionchange', () => {
    db.close();
    onReplaced();
    return false;
  });
  return db;
}

/** Missing outside secure contexts and in some older browsers, whatever the DOM typings say. */
const storage = () => navigator.storage as StorageManager | undefined;

/**
 * Asks the browser to keep the store under storage pressure. Call it from a click: Firefox asks the
 * user, and Safari counts the interaction. Installed apps and the shells are usually granted it.
 */
export async function requestPersistence(): Promise<boolean> {
  try {
    return (await storage()?.persist()) ?? false;
  } catch {
    return false;
  }
}

/** Whether the browser keeps the store under storage pressure. */
export async function persisted(): Promise<boolean> {
  try {
    return (await storage()?.persisted()) ?? false;
  } catch {
    return false;
  }
}

export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  try {
    const estimate = await storage()?.estimate();
    return estimate ? { usage: estimate.usage ?? 0, quota: estimate.quota ?? 0 } : null;
  } catch {
    return null;
  }
}

/**
 * Runs `task` unless another tab of this app is already running it under the same name; returns
 * whether it ran. Without Web Locks every tab runs it.
 */
export async function exclusively(name: string, task: () => Promise<void>): Promise<boolean> {
  const locks = (navigator as { locks?: LockManager }).locks;
  if (!locks) {
    await task();
    return true;
  }
  return locks.request(`newses-${name}`, { ifAvailable: true }, async (lock) => {
    if (!lock) return false;
    await task();
    return true;
  });
}
