import { createAuthServices } from '../../core/auth/index.ts';
import { SyncService } from '../../core/entries/sync.ts';
import { createFeedServices } from '../../core/feeds/index.ts';
import { trackRun } from '../tracking.ts';
import { createLambdaRuntime } from './runtime.ts';

const { config, logger, db, feedDeps, ops, archive } = await createLambdaRuntime('tick');
const feeds = createFeedServices(feedDeps);
const { sessions, throttle } = createAuthServices(db, config.appSecret);
const sync = new SyncService(db);

/** Scheduled work, one task per EventBridge schedule, timed to coincide with dispatch. */
export type TickEvent =
  { task: 'dispatch' } | { task: 'purge' } | { task: 'auth.prune' } | { task: 'archive.compact' };

/** Compaction stops starting months after this, within the function's 5-minute timeout. */
const ARCHIVE_COMPACT_BUDGET_MS = 3 * 60 * 1000;
/** Kept entries' images, within the dispatch tick's 5-minute timeout. */
const IMAGES_KEEP_BUDGET_MS = 2 * 60 * 1000;

const TASK_NAMES = {
  dispatch: 'feeds.dispatch',
  purge: 'feeds.purge',
  'auth.prune': 'auth.prune',
  'archive.compact': 'archive.compact',
} as const;

export async function handler(event: TickEvent): Promise<void> {
  try {
    await trackRun(ops.recorder, TASK_NAMES[event.task], () => run(event), { kind: 'task' });
  } finally {
    await ops.recorder.flush();
  }
}

async function run(event: TickEvent): Promise<void> {
  switch (event.task) {
    case 'dispatch': {
      const dispatched = await feeds.updater.dispatchDue();
      logger.info({ dispatched }, 'Dispatched feed fetches');
      // Rides the dispatch schedule rather than a schedule of its own.
      await ops.recorder.flush();
      await trackRun(ops.recorder, 'ops.check', () => ops.checker.run(), { kind: 'task' });
      await trackRun(
        ops.recorder,
        'images.keep',
        async () => {
          logger.info(
            await feeds.images.keep(IMAGES_KEEP_BUDGET_MS),
            'Kept images of kept entries',
          );
        },
        { kind: 'task' },
      );
      return;
    }
    case 'purge':
      logger.info(await feeds.purger.purge(), 'Purged old entries');
      logger.info({ images: await feeds.images.purge() }, 'Purged cached images');
      await sync.pruneTombstones();
      logger.info(await ops.prune(), 'Pruned operations data');
      return;
    case 'auth.prune':
      await sessions.pruneExpired();
      await throttle.prune();
      await feeds.rateLimits.prune();
      return;
    case 'archive.compact': {
      const months = (await archive?.compact(Date.now() + ARCHIVE_COMPACT_BUDGET_MS)) ?? 0;
      logger.info({ months }, 'Compacted the archive');
      return;
    }
  }
}
