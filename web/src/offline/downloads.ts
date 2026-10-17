import type { ApiClient, EntryContent } from '@newses/shared';
import { MAX_CONTENTS_IDS } from '@newses/shared/client';
import Dexie from 'dexie';
import type { OfflineDb, StoredContent } from './db.ts';

/** Content and images kept on the device, in bytes, until there is a setting for it. */
export const DEFAULT_STORAGE_LIMIT = 1024 * 1024 * 1024;
/** The proxy serves nothing larger. */
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
/** A failed image is not asked for again for this long. */
const IMAGE_RETRY_MS = 24 * 3_600_000;
/** At most this many image downloads at once, and one per image host, as the server fetches politely. */
const IMAGE_CONCURRENCY = 2;
const FAILURES_KEY = 'imageFailures';

export interface DownloadOptions {
  api: ApiClient;
  db: OfflineDb;
  /** The server's origin for its relative proxy paths: the apps' server, '' in the browser. */
  server: string;
  limitBytes?: number;
  /** False to keep to text, such as on mobile data. */
  images: boolean;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

const contentBytes = (c: Pick<EntryContent, 'content' | 'fullContent'>) => {
  const encoder = new TextEncoder();
  return encoder.encode(c.content ?? '').length + encoder.encode(c.fullContent ?? '').length;
};

/** Bytes of stored content and images, summed from their indexes. */
export async function storedBytes(db: OfflineDb): Promise<number> {
  let total = 0;
  await db.contents.orderBy('bytes').eachKey((bytes) => {
    total += Number(bytes);
  });
  await db.images.orderBy('bytes').eachKey((bytes) => {
    total += Number(bytes);
  });
  return total;
}

/** Stored entries by priority: unread newest first, then starred, then recently read. */
async function byPriority(db: OfflineDb): Promise<{ id: number; contentVersion: string }[]> {
  const newest = (index: '[unread+sortAt]' | '[starred+sortAt]') =>
    db.entries.where(index).between([1, Dexie.minKey], [1, Dexie.maxKey]).reverse().toArray();
  const [unread, starred, read] = await Promise.all([
    newest('[unread+sortAt]'),
    newest('[starred+sortAt]'),
    db.entries.orderBy('readAt').reverse().toArray(),
  ]);
  const seen = new Set<number>();
  return [...unread, ...starred, ...read].filter((e) => !seen.has(e.id) && seen.add(e.id));
}

/**
 * Downloads the content of stored entries that have none, or an older version, in priority order
 * and within the storage limit. Returns how many entries got content.
 */
export async function downloadContents(options: DownloadOptions): Promise<number> {
  const { api, db } = options;
  const limit = options.limitBytes ?? DEFAULT_STORAGE_LIMIT;
  const versions = new Map<number, string>();
  await db.contents.orderBy('contentVersion').eachKey((version, cursor) => {
    versions.set(cursor.primaryKey, version as string);
  });
  const queue = (await byPriority(db))
    .filter((e) => versions.get(e.id) !== e.contentVersion)
    .map((e) => e.id);
  let total = await storedBytes(db);
  let stored = 0;
  while (queue.length > 0 && total < limit) {
    const batch = queue.splice(0, MAX_CONTENTS_IDS);
    const { entries, deferred } = await api.entries.contents(batch);
    if (entries.length === 0) break;
    const rows: StoredContent[] = entries.map((e) => ({ ...e, bytes: contentBytes(e) }));
    // Only for entries still stored: sync may have removed some meanwhile.
    const present = new Set(
      (await db.entries.bulkGet(rows.map((r) => r.id))).flatMap((e) => (e ? [e.id] : [])),
    );
    await db.contents.bulkPut(rows.filter((r) => present.has(r.id)));
    stored += present.size;
    total += rows.reduce((sum, r) => sum + r.bytes, 0);
    queue.unshift(...deferred);
  }
  return stored;
}

interface ImageTask {
  url: string;
  proxy: string;
  host: string;
  entryIds: number[];
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/**
 * Downloads the images of stored content through the server's image proxy, in the content's
 * priority order and within the storage limit. Returns how many were stored.
 */
export async function downloadImages(options: DownloadOptions): Promise<number> {
  if (!options.images) return 0;
  const { db } = options;
  const fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const now = (options.now ?? Date.now)();
  const limit = options.limitBytes ?? DEFAULT_STORAGE_LIMIT;
  const failures = new Map(
    Object.entries(
      ((await db.meta.get(FAILURES_KEY))?.value ?? {}) as Record<string, number>,
    ).filter(([, at]) => now - at <= IMAGE_RETRY_MS),
  );

  const have = new Set((await db.images.toCollection().primaryKeys()).map(String));
  const tasks = new Map<string, ImageTask>();
  const ids = (await byPriority(db)).map((e) => e.id);
  for (const content of await db.contents.bulkGet(ids)) {
    if (!content) continue;
    for (const { url, proxy } of content.images) {
      if (failures.has(url)) continue;
      if (have.has(url)) {
        // Shown by another entry too: keep it while either is stored.
        await db.images
          .where('url')
          .equals(url)
          .modify((image) => {
            if (!image.entryIds.includes(content.id)) image.entryIds.push(content.id);
          });
        continue;
      }
      const task = tasks.get(url);
      if (task) task.entryIds.push(content.id);
      else tasks.set(url, { url, proxy, host: hostOf(url), entryIds: [content.id] });
    }
  }

  let total = await storedBytes(db);
  let stored = 0;
  const pending = [...tasks.values()];
  const busy = new Set<string>();
  const download = async (task: ImageTask) => {
    try {
      const response = await fetch(`${options.server}${task.proxy}`, { credentials: 'omit' });
      const type = response.headers.get('content-type') ?? '';
      if (!response.ok || !type.startsWith('image/')) throw new Error(String(response.status));
      const blob = await response.blob();
      if (blob.size > MAX_IMAGE_BYTES) throw new Error('Too large');
      await db.images.put({
        url: task.url,
        blob,
        bytes: blob.size,
        entryIds: task.entryIds,
        fetchedAt: now,
      });
      total += blob.size;
      stored++;
    } catch {
      failures.set(task.url, now);
    }
  };
  const worker = async () => {
    for (;;) {
      if (total >= limit) return;
      const index = pending.findIndex((t) => !busy.has(t.host));
      // Every remaining host is busy: wait for this worker's turn on one, or stop when none remain.
      if (index < 0) {
        if (pending.length === 0) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
        continue;
      }
      const [task] = pending.splice(index, 1);
      if (!task) return;
      busy.add(task.host);
      await download(task);
      busy.delete(task.host);
    }
  };
  await Promise.all(Array.from({ length: IMAGE_CONCURRENCY }, worker));
  await db.meta.put({ key: FAILURES_KEY, value: Object.fromEntries(failures) });
  return stored;
}
