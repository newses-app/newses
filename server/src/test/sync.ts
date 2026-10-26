import { setTimeout } from 'node:timers/promises';
import type { Entry } from '@newses/shared';
import type { SyncResult, SyncService } from '../core/entries/sync.ts';

/** How long a just-written row may be held back from sync. */
const SYNC_WAIT_MS = 3000;

/**
 * Follows a user's changes from `since` until entry `id` arrives; returns it, the call that
 * brought it, and the token after. Each call returns changes below a watermark, the oldest
 * transaction still writing in the database; while one is open, a row written after it waits for
 * a later call, as clients expect.
 */
export async function syncedEntry(
  sync: SyncService,
  userId: number,
  id: number,
  since: string | undefined,
): Promise<{ entry: Entry; result: SyncResult; next: string }> {
  const deadline = Date.now() + SYNC_WAIT_MS;
  let next = since;
  for (;;) {
    const result = await sync.changes(userId, next, 100);
    next = result.next;
    const entry = result.entries.find((e) => e.id === id);
    if (entry) return { entry, result, next };
    if (Date.now() > deadline) throw new Error(`Entry ${String(id)} was never synced`);
    await setTimeout(50);
  }
}
