import { PgBoss } from 'pg-boss';
import { IntervalScheduler } from '../adapters/interval-scheduler.ts';
import { PgNotifyRealtime } from '../adapters/pg-notify-realtime.ts';
import { createAuthServices } from '../core/auth/index.ts';
import { SyncService } from '../core/entries/sync.ts';
import { createFeedServices } from '../core/feeds/index.ts';
import { createOpsServices } from '../core/ops/index.ts';
import { createDb } from '../db/client.ts';
import { setOpenAlerts } from '../telemetry/index.ts';
import {
  createArchiveReader,
  createFeedDeps,
  createNotifier,
  PG_BOSS_TELEMETRY,
} from './feed-deps.ts';
import { createRuntime } from './runtime.ts';
import { scheduleOpsFlush, trackRun } from './tracking.ts';

/** How long one daily archive compaction may run; the rest waits for the next day. */
const ARCHIVE_COMPACT_BUDGET_MS = 10 * 60 * 1000;
/** How long one run may spend keeping kept entries' images. */
const IMAGES_KEEP_BUDGET_MS = 2 * 60 * 1000;

const { config, logger, pool, onShutdown } = createRuntime('worker');
const db = createDb(pool);

const boss = new PgBoss({ connectionString: config.databaseUrl, openTelemetry: PG_BOSS_TELEMETRY });
boss.on('error', (err) => {
  logger.error({ err }, 'Job queue error');
});
await boss.start();

const ops = createOpsServices({
  db,
  logger,
  settings: config.ops,
  notifier: createNotifier(config),
  backlog: async () =>
    (await boss.getQueues()).map((queue) => ({ queue: queue.name, ready: queue.readyCount })),
});
// Registered before the other steps, so the last statistics are written after jobs finish.
scheduleOpsFlush(ops.recorder, onShutdown);
onShutdown(() => boss.stop({ graceful: true }));

// The worker only publishes realtime events, so the listener is never started.
const deps = createFeedDeps({
  config,
  db,
  boss,
  realtime: new PgNotifyRealtime(pool, logger),
  logger,
  ops: ops.recorder,
});
onShutdown(() => deps.fetcher.close());
const feeds = createFeedServices(deps);
const { sessions, throttle } = createAuthServices(db, config.appSecret);
const sync = new SyncService(db);

// Jobs queued before host batching carry `feedSourceId` instead; their claims lapse and a later
// dispatch picks the sources up again.
await deps.queue.work(
  'feed.fetch',
  (data) =>
    trackRun(ops.recorder, 'feed.fetch', () =>
      feeds.updater.updateMany((data as Partial<typeof data>).feedSourceIds ?? []),
    ),
  { concurrency: 8 },
);
await deps.queue.work(
  'feed.favicon',
  ({ feedSourceId }) =>
    trackRun(ops.recorder, 'feed.favicon', () => feeds.favicons.refresh(feedSourceId)),
  { concurrency: 2 },
);
await deps.queue.work(
  'entry.extract',
  (data) => trackRun(ops.recorder, 'entry.extract', () => feeds.fullText.runJob(data)),
  { concurrency: 2 },
);

const scheduler = new IntervalScheduler(logger);
const task = (name: string, intervalSeconds: number, run: () => Promise<void>) => {
  scheduler.every(name, intervalSeconds, () => trackRun(ops.recorder, name, run, { kind: 'task' }));
};
task('feeds.dispatch', 60, async () => {
  const dispatched = await feeds.updater.dispatchDue();
  if (dispatched > 0) logger.debug({ dispatched }, 'Dispatched feed fetches');
});
task('images.keep', 5 * 60, async () => {
  const kept = await feeds.images.keep(IMAGES_KEEP_BUDGET_MS);
  if (kept.indexed + kept.fetched > 0) logger.debug(kept, 'Kept images of kept entries');
});
task('feeds.purge', 6 * 60 * 60, async () => {
  logger.info(await feeds.purger.purge(), 'Purged old entries');
  logger.info({ images: await feeds.images.purge() }, 'Purged cached images');
  await sync.pruneTombstones();
  logger.info(await ops.prune(), 'Pruned operations data');
});
task('auth.prune', 60 * 60, async () => {
  await sessions.pruneExpired();
  await throttle.prune();
  await feeds.rateLimits.prune();
});
// Statistics are flushed first, so the rules see the latest counts.
task('ops.check', 5 * 60, async () => {
  await ops.recorder.flush();
  const { open } = await ops.checker.run();
  setOpenAlerts(open);
});
const archive = createArchiveReader(config, deps.blobs);
if (archive)
  task('archive.compact', 24 * 60 * 60, async () => {
    const months = await archive.compact(Date.now() + ARCHIVE_COMPACT_BUDGET_MS);
    if (months > 0) logger.info({ months }, 'Compacted the archive');
  });
scheduler.start();
onShutdown(() => scheduler.stop());

logger.info('Worker started');
