import { createAuthServices } from '../../core/auth/index.ts';
import { SyncService } from '../../core/entries/sync.ts';
import { createFeedServices } from '../../core/feeds/index.ts';
import { createLambdaRuntime } from './runtime.ts';

const { config, logger, db, feedDeps } = await createLambdaRuntime('tick');
const feeds = createFeedServices(feedDeps);
const { sessions, throttle } = createAuthServices(db, config.appSecret);
const sync = new SyncService(db);

/** Scheduled work, one task per EventBridge schedule, timed to coincide with dispatch. */
export type TickEvent = { task: 'dispatch' } | { task: 'purge' } | { task: 'auth.prune' };

export async function handler(event: TickEvent): Promise<void> {
  switch (event.task) {
    case 'dispatch': {
      const dispatched = await feeds.updater.dispatchDue();
      logger.info({ dispatched }, 'Dispatched feed fetches');
      return;
    }
    case 'purge':
      logger.info(await feeds.purger.purge(), 'Purged old entries');
      await sync.pruneTombstones();
      return;
    case 'auth.prune':
      await sessions.pruneExpired();
      await throttle.prune();
      return;
  }
}
