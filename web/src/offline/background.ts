import type { CreateThemeRequest } from '@newses/shared';
import { createApiClient } from '@newses/shared/client';
import { DEFAULT_KEEP } from '../lib/offline-keep.ts';
import { exclusively, type OfflineDb, openOfflineDb } from './db.ts';
import { downloadContents, indexStoredContents, trimToLimit } from './downloads.ts';
import { type FlushResult, flushOutbox, type NoteConflict } from './outbox.ts';
import {
  detectsConflicts,
  pruneStore,
  storedSyncToken,
  supportsOffline,
  syncStore,
} from './sync.ts';
import { readWorkerConfig } from './worker-config.ts';

/**
 * What the service worker did that the reader should hear about, kept in the store until a page
 * shows it: changes refused or overridden, notes to settle, themes kept as drafts, and whether
 * objects created offline changed ids.
 */
export interface WorkerReport {
  refused: { kind: string; code: string; message: string; url?: string }[];
  overridden: number;
  noteConflicts: NoteConflict[];
  themeDrafts: CreateThemeRequest[];
  renumbered: boolean;
}

const REPORT_KEY = 'workerReport';
const STATUS_KEY = 'syncStatus';

const emptyReport = (): WorkerReport => ({
  refused: [],
  overridden: 0,
  noteConflicts: [],
  themeDrafts: [],
  renumbered: false,
});

/** What sending changes did, as the reader hears of it. */
export function reportOf(result: FlushResult): WorkerReport {
  return {
    refused: result.refused.map(({ op, code, message }) => ({
      kind: op.kind,
      code,
      message,
      ...(op.kind === 'subscription.create' && { url: op.body.url }),
    })),
    overridden: result.overridden,
    noteConflicts: result.noteConflicts,
    themeDrafts: result.themeDrafts,
    renumbered: result.created.length > 0 || result.dropped.length > 0,
  };
}

async function keepReport(db: OfflineDb, result: FlushResult): Promise<void> {
  const kept =
    ((await db.meta.get(REPORT_KEY))?.value as WorkerReport | undefined) ?? emptyReport();
  const report = reportOf(result);
  await db.meta.put({
    key: REPORT_KEY,
    value: {
      refused: [...kept.refused, ...report.refused],
      overridden: kept.overridden + report.overridden,
      noteConflicts: [...kept.noteConflicts, ...report.noteConflicts],
      themeDrafts: [...kept.themeDrafts, ...report.themeDrafts],
      renumbered: kept.renumbered || report.renumbered,
    } satisfies WorkerReport,
  });
}

/** The service worker's report, removed as it is taken; null when there is none. */
export async function takeWorkerReport(db: OfflineDb): Promise<WorkerReport | null> {
  const report = (await db.meta.get(REPORT_KEY))?.value as WorkerReport | undefined;
  if (!report) return null;
  await db.meta.delete(REPORT_KEY);
  return report;
}

/**
 * Runs with no tab open, in the service worker: sends the changes kept offline, and for `sync`
 * also follows the server's changes and downloads text (images wait for the app, which knows the
 * network). Tabs that are open run the same work under the same locks, so only one does it.
 */
export async function runInBackground(
  work: 'sync' | 'outbox',
  fetch: typeof globalThis.fetch = globalThis.fetch.bind(globalThis),
): Promise<void> {
  const config = await readWorkerConfig();
  if (!config) return;
  const db = openOfflineDb(config.dbName);
  try {
    const api = createApiClient({ client: 'web', fetch });
    const info = await api.serverInfo();
    if (!supportsOffline(info)) return;
    // Confirms the session is still there, and gives the CSRF token changes need.
    await api.auth.session();
    await exclusively('outbox', async () => {
      await keepReport(db, await flushOutbox(api, db, { conflicts: detectsConflicts(info) }));
    });
    // A store never filled waits for the app's first sync, which loads everything.
    if (work !== 'sync' || (await storedSyncToken(db)) === null) return;
    const limits = { ...DEFAULT_KEEP, unread: config.unread };
    await exclusively('sync', async () => {
      await syncStore({ api, db, limits });
      await pruneStore(db, Date.now(), limits);
      await indexStoredContents(db);
      await trimToLimit(db, config.limitBytes);
      await downloadContents({ api, db, server: '', limitBytes: config.limitBytes, images: false });
      const status = (await db.meta.get(STATUS_KEY))?.value as object | undefined;
      await db.meta.put({
        key: STATUS_KEY,
        value: { ...status, lastSyncedAt: Date.now(), lastError: null },
      });
    });
  } finally {
    db.close();
  }
}
