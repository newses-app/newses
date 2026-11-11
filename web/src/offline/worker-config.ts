import type { NotificationStrings } from '@newses/shared';
import Dexie, { type EntityTable } from 'dexie';

/** Periodic Background Sync's tag: a delta sync and text downloads. */
export const SYNC_TAG = 'newses-sync';
/** Background Sync's tag: sends changes kept offline once the connection returns. */
export const OUTBOX_TAG = 'newses-outbox';
/** The one notification of new entries, which each push message replaces with the running total. */
export const NEW_ENTRIES_TAG = 'newses-new-entries';
/** What the service worker posts to a page to open a clicked notification's stream. */
export const NAVIGATE_MESSAGE = 'newses-navigate';

/**
 * What the service worker needs to sync with no tab open, which it cannot read from
 * `localStorage`: the signed-in account's store and this device's choices. Absent while offline
 * reading is off or nobody is signed in.
 */
export interface WorkerConfig {
  dbName: string;
  unread: number;
  limitBytes: number;
}

/**
 * Whose push messages this browser's subscription receives, and the wording for them, in the
 * app's language. Absent while the browser's notifications of new entries are off.
 */
export interface PushConfig {
  userId: number;
  strings: NotificationStrings;
}

interface Row extends WorkerConfig {
  key: 'current';
}

interface PushRow extends PushConfig {
  key: 'current';
}

type ConfigDb = Dexie & {
  config: EntityTable<Row, 'key'>;
  push: EntityTable<PushRow, 'key'>;
};

function open(): ConfigDb {
  const db = new Dexie('newses-worker') as ConfigDb;
  db.version(1).stores({ config: 'key' });
  db.version(2).stores({ push: 'key' });
  return db;
}

async function withConfigDb<T>(task: (db: ConfigDb) => Promise<T>): Promise<T> {
  const db = open();
  try {
    return await task(db);
  } finally {
    db.close();
  }
}

export const readWorkerConfig = (): Promise<WorkerConfig | undefined> =>
  withConfigDb((db) => db.config.get('current'));

export const writeWorkerConfig = (config: WorkerConfig | null): Promise<void> =>
  withConfigDb(async (db) => {
    if (config) await db.config.put({ key: 'current', ...config });
    else await db.config.delete('current');
  });

export const readPushConfig = (): Promise<PushConfig | undefined> =>
  withConfigDb((db) => db.push.get('current'));

export const writePushConfig = (config: PushConfig | null): Promise<void> =>
  withConfigDb(async (db) => {
    if (config) await db.push.put({ key: 'current', ...config });
    else await db.push.delete('current');
  });
