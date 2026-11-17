// The background work of each host: the worker's queue jobs and interval tasks (worker.ts), and
// the tick Lambda's tasks, one per EventBridge schedule (lambda/tick.ts). Each run is tracked in
// the ops statistics.
import { writeFile } from 'node:fs/promises';
import type { AuthServices } from '../core/auth/index.ts';
import type { SyncService } from '../core/entries/sync.ts';
import type { FeedServices } from '../core/feeds/index.ts';
import type { Jobs } from '../core/jobs.ts';
import type { DigestService } from '../core/mail/digest-service.ts';
import type { OpsServices } from '../core/ops/index.ts';
import type { PluginEventService } from '../core/plugins/events.ts';
import type { PluginStorageService } from '../core/plugins/storage.ts';
import type { ArchiveReader, JobQueue, Logger, Scheduler } from '../core/ports.ts';
import { setOpenAlerts } from '../telemetry/index.ts';
import { trackRun } from './tracking.ts';

/** What the jobs and tasks use of the services. */
export interface TaskDeps {
  feeds: {
    updater: Pick<FeedServices['updater'], 'dispatchDue' | 'updateMany'>;
    favicons: Pick<FeedServices['favicons'], 'refresh'>;
    fullText: Pick<FeedServices['fullText'], 'runJob'>;
    push: Pick<FeedServices['push'], 'flush'>;
    images: Pick<FeedServices['images'], 'keep' | 'purge'>;
    purger: Pick<FeedServices['purger'], 'purge'>;
    rateLimits: Pick<FeedServices['rateLimits'], 'prune'>;
  };
  sessions: Pick<AuthServices['sessions'], 'pruneExpired'>;
  throttle: Pick<AuthServices['throttle'], 'prune'>;
  sync: Pick<SyncService, 'pruneTombstones'>;
  digest: Pick<DigestService, 'sendDue'>;
  ops: {
    recorder: Pick<OpsServices['recorder'], 'recordJob' | 'flush'>;
    checker: Pick<OpsServices['checker'], 'run'>;
    prune: OpsServices['prune'];
  };
  plugins: {
    storage: Pick<PluginStorageService, 'prune'>;
    events: Pick<PluginEventService, 'dispatch'>;
    /** Queues a wake for the next due delivery where nothing polls (AWS). */
    wake?: () => Promise<void>;
  };
  archive: Pick<ArchiveReader, 'compact'> | null;
  logger: Logger;
}

/** How often the worker runs plugins' due deliveries, and how long one run may take. */
const PLUGIN_DISPATCH_SECONDS = 30;
const PLUGIN_DISPATCH_BUDGET_MS = 25_000;
/** How long the tick spends on plugins' deliveries; the plugin function does the rest. */
const TICK_PLUGIN_BUDGET_MS = 60_000;

/** How long one run may spend keeping kept entries' images. */
const IMAGES_KEEP_BUDGET_MS = 2 * 60 * 1000;
/** How long the worker's daily archive compaction may run; the rest waits for the next day. */
export const WORKER_COMPACT_BUDGET_MS = 10 * 60 * 1000;
/** Compaction stops starting months after this, within the tick's 5-minute timeout. */
export const TICK_COMPACT_BUDGET_MS = 3 * 60 * 1000;

async function purge({ feeds, sync, ops, plugins, logger }: TaskDeps): Promise<void> {
  logger.info(await feeds.purger.purge(), 'Purged old entries');
  logger.info({ images: await feeds.images.purge() }, 'Purged cached images');
  await sync.pruneTombstones();
  logger.info(await ops.prune(), 'Pruned operations data');
  logger.info({ values: await plugins.storage.prune() }, 'Pruned expired plugin data');
}

async function pruneAuth({ feeds, sessions, throttle }: TaskDeps): Promise<void> {
  await sessions.pruneExpired();
  await throttle.prune();
  await feeds.rateLimits.prune();
}

/** The worker's queue jobs. */
export async function workJobs(
  queue: Pick<JobQueue<Jobs>, 'work'>,
  { feeds, ops }: TaskDeps,
): Promise<void> {
  // Jobs queued before host batching carry `feedSourceId` instead; their claims lapse and a later
  // dispatch picks the sources up again.
  await queue.work(
    'feed.fetch',
    (data) =>
      trackRun(ops.recorder, 'feed.fetch', () =>
        feeds.updater.updateMany((data as Partial<typeof data>).feedSourceIds ?? []),
      ),
    { concurrency: 8 },
  );
  await queue.work(
    'feed.favicon',
    ({ feedSourceId }) =>
      trackRun(ops.recorder, 'feed.favicon', () => feeds.favicons.refresh(feedSourceId)),
    { concurrency: 2 },
  );
  await queue.work(
    'entry.extract',
    (data) => trackRun(ops.recorder, 'entry.extract', () => feeds.fullText.runJob(data)),
    { concurrency: 2 },
  );
}

/**
 * The worker's interval tasks. `heartbeatFile` is written after each successful feed dispatch,
 * so it goes stale when the scheduler or the database stalls; `newses worker-health`
 * (`docker/entrypoint.sh`) checks its age for Compose.
 */
export function scheduleWorkerTasks(
  scheduler: Pick<Scheduler, 'every'>,
  deps: TaskDeps,
  heartbeatFile: string,
): void {
  const { feeds, digest, ops, archive, logger } = deps;
  const task = (name: string, intervalSeconds: number, run: () => Promise<void>) => {
    scheduler.every(name, intervalSeconds, () =>
      trackRun(ops.recorder, name, run, { kind: 'task' }),
    );
  };
  task('feeds.dispatch', 60, async () => {
    const dispatched = await feeds.updater.dispatchDue();
    if (dispatched > 0) logger.debug({ dispatched }, 'Dispatched feed fetches');
    await writeFile(heartbeatFile, new Date().toISOString()).catch((err: unknown) => {
      logger.warn({ err }, 'Could not write the worker heartbeat');
    });
  });
  // New entries that waited for a user's push window to end.
  task('push.flush', 5 * 60, async () => {
    const pushed = await feeds.push.flush();
    if (pushed > 0) logger.debug({ pushed }, 'Pushed new entries');
  });
  // Plugins' deliveries whose debounce window or retry delay has passed.
  task('plugins.dispatch', PLUGIN_DISPATCH_SECONDS, async () => {
    const ran = await deps.plugins.events.dispatch(Date.now() + PLUGIN_DISPATCH_BUDGET_MS);
    if (ran > 0) logger.debug({ ran }, 'Ran plugin deliveries');
  });
  // Digests are due on the hour; a run every 5 minutes sends them within that.
  task('digest.send', 5 * 60, async () => {
    const sent = await digest.sendDue();
    if (sent > 0) logger.debug({ sent }, 'Sent digests');
  });
  task('images.keep', 5 * 60, async () => {
    const kept = await feeds.images.keep(IMAGES_KEEP_BUDGET_MS);
    if (kept.indexed + kept.fetched > 0) logger.debug(kept, 'Kept images of kept entries');
  });
  task('feeds.purge', 6 * 60 * 60, () => purge(deps));
  task('auth.prune', 60 * 60, () => pruneAuth(deps));
  // Statistics are flushed first, so the rules see the latest counts.
  task('ops.check', 5 * 60, async () => {
    await ops.recorder.flush();
    const { open } = await ops.checker.run();
    setOpenAlerts(open);
  });
  if (archive)
    task('archive.compact', 24 * 60 * 60, async () => {
      const months = await archive.compact(Date.now() + WORKER_COMPACT_BUDGET_MS);
      if (months > 0) logger.info({ months }, 'Compacted the archive');
    });
}

/** Scheduled work, one task per EventBridge schedule, timed to coincide with dispatch. */
export type TickEvent =
  { task: 'dispatch' } | { task: 'purge' } | { task: 'auth.prune' } | { task: 'archive.compact' };

const TICK_TASKS = {
  dispatch: 'feeds.dispatch',
  purge: 'feeds.purge',
  'auth.prune': 'auth.prune',
  'archive.compact': 'archive.compact',
} as const;

/** The tick Lambda's handler: runs the event's task, then writes the run's statistics. */
export function createTickHandler(deps: TaskDeps): (event: TickEvent) => Promise<void> {
  const { feeds, digest, ops, archive, logger } = deps;
  const tracked = (name: string, run: () => Promise<unknown>) =>
    trackRun(ops.recorder, name, run, { kind: 'task' });

  async function run(event: TickEvent): Promise<void> {
    switch (event.task) {
      case 'dispatch': {
        const dispatched = await feeds.updater.dispatchDue();
        logger.info({ dispatched }, 'Dispatched feed fetches');
        // New entries from the last cycle's fetches that waited for a user's push window to end.
        await tracked('push.flush', async () => {
          logger.info({ pushed: await feeds.push.flush() }, 'Pushed new entries');
        });
        // Digests are due on the hour; dispatch runs at :00 and :30.
        await tracked('digest.send', async () => {
          logger.info({ sent: await digest.sendDue() }, 'Sent digests');
        });
        // Deliveries a wake missed; then a wake for what is left.
        await tracked('plugins.dispatch', async () => {
          const ran = await deps.plugins.events.dispatch(Date.now() + TICK_PLUGIN_BUDGET_MS);
          logger.info({ ran }, 'Ran plugin deliveries');
          await deps.plugins.wake?.();
        });
        // Rides the dispatch schedule rather than a schedule of its own.
        await ops.recorder.flush();
        await tracked('ops.check', () => ops.checker.run());
        await tracked('images.keep', async () => {
          logger.info(
            await feeds.images.keep(IMAGES_KEEP_BUDGET_MS),
            'Kept images of kept entries',
          );
        });
        return;
      }
      case 'purge':
        return purge(deps);
      case 'auth.prune':
        return pruneAuth(deps);
      case 'archive.compact': {
        const months = (await archive?.compact(Date.now() + TICK_COMPACT_BUDGET_MS)) ?? 0;
        logger.info({ months }, 'Compacted the archive');
        return;
      }
    }
  }

  return async (event) => {
    try {
      await tracked(TICK_TASKS[event.task], () => run(event));
    } finally {
      await ops.recorder.flush();
    }
  };
}
