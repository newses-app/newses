import { createAuthServices } from '../../core/auth/index.ts';
import { SyncService } from '../../core/entries/sync.ts';
import { createFeedServices } from '../../core/feeds/index.ts';
import { createLambdaRuntime } from './runtime.ts';

const { config, logger, db, feedDeps, archive } = await createLambdaRuntime('tick');
const feeds = createFeedServices(feedDeps);
const { sessions, throttle } = createAuthServices(db, config.appSecret);
const sync = new SyncService(db);

/** Scheduled work, one task per EventBridge schedule, timed to coincide with dispatch. */
export type TickEvent =
  { task: 'dispatch' } | { task: 'purge' } | { task: 'auth.prune' } | { task: 'archive.compact' };

/** Compaction stops starting months after this, within the function's 5-minute timeout. */
const ARCHIVE_COMPACT_BUDGET_MS = 3 * 60 * 1000;

export async function handler(event: TickEvent): Promise<void> {
  switch (event.task) {
    case 'dispatch': {
      const dispatched = await feeds.updater.dispatchDue();
      logger.info({ dispatched }, 'Dispatched feed fetches');
      return;
    }
    case 'purge':
      logger.info(await feeds.purger.purge(), 'Purged old entries');
      logger.info({ images: await feeds.images.purge() }, 'Purged cached images');
      await sync.pruneTombstones();
      return;
    case 'auth.prune':
      await sessions.pruneExpired();
      await throttle.prune();
      return;
    case 'archive.compact': {
      const months = (await archive?.compact(Date.now() + ARCHIVE_COMPACT_BUDGET_MS)) ?? 0;
      logger.info({ months }, 'Compacted the archive');
      return;
    }
  }
}
