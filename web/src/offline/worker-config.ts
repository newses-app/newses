import Dexie, { type EntityTable } from 'dexie';

/** Periodic Background Sync's tag: a delta sync and text downloads. */
export const SYNC_TAG = 'newses-sync';
/** Background Sync's tag: sends changes kept offline once the connection returns. */
export const OUTBOX_TAG = 'newses-outbox';

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

interface Row extends WorkerConfig {
  key: 'current';
}

type ConfigDb = Dexie & { config: EntityTable<Row, 'key'> };

function open(): ConfigDb {
  const db = new Dexie('newses-worker') as ConfigDb;
  db.version(1).stores({ config: 'key' });
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
