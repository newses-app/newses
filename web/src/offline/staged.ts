import type { EntryContentsResponse, StagedPage, SyncResponse } from '@newses/shared';
import { DEFAULT_KEEP, type KeepLimits } from '../lib/offline-keep.ts';
import type { OfflineDb } from './db.ts';
import { storeContents } from './downloads.ts';
import { applyChanges, storedSyncToken } from './sync.ts';

export interface StagedImport {
  /** The sync pages stored, with the changes still waiting applied, to patch what is on screen. */
  changes: SyncResponse[];
  contents: number;
  /** Where the store's sync now stands, for the background job to carry on from. */
  token: string | null;
}

/**
 * Stores what the Android background job fetched while the app was closed, in the order it was
 * fetched. A sync page is taken only when it carries on from where the store's sync stands: the
 * job may have started from an older token, and older changes must not overwrite newer ones, so
 * the pages from the first gap on are left for the next sync to fetch again. Content is stored for
 * entries the store holds, whatever its token.
 */
export async function importStaged(
  db: OfflineDb,
  pages: readonly StagedPage[],
  { now = Date.now(), limits = DEFAULT_KEEP }: { now?: number; limits?: KeepLimits } = {},
): Promise<StagedImport> {
  let token = await storedSyncToken(db);
  const changes: SyncResponse[] = [];
  let contents = 0;
  let chain = token !== null;
  for (const page of pages) {
    let body: unknown;
    try {
      body = JSON.parse(page.body);
    } catch {
      continue;
    }
    if (page.kind === 'contents') {
      contents += (await storeContents(db, (body as EntryContentsResponse).entries)).length;
      continue;
    }
    if (!chain || page.since !== token) {
      chain = false;
      continue;
    }
    const applied = await applyChanges(db, body as SyncResponse, now, limits);
    changes.push(applied);
    token = applied.next;
  }
  return { changes, contents, token };
}
