import { PgBoss } from 'pg-boss';
import { IntervalScheduler } from '../adapters/interval-scheduler.ts';
import { PgNotifyRealtime } from '../adapters/pg-notify-realtime.ts';
import { createAuthServices } from '../core/auth/index.ts';
import { SyncService } from '../core/entries/sync.ts';
import { createFeedServices } from '../core/feeds/index.ts';
import { createDb } from '../db/client.ts';
import { createFeedDeps } from './feed-deps.ts';
import { createRuntime } from './runtime.ts';

const { config, logger, pool, onShutdown } = createRuntime('worker');
const db = createDb(pool);

const boss = new PgBoss({ connectionString: config.databaseUrl });
boss.on('error', (err) => {
  logger.error({ err }, 'Job queue error');
});
await boss.start();
onShutdown(() => boss.stop({ graceful: true }));

// The worker only publishes realtime events, so the listener is never started.
const deps = createFeedDeps({
  config,
  db,
  boss,
  realtime: new PgNotifyRealtime(pool, logger),
  logger,
});
onShutdown(() => deps.fetcher.close());
const feeds = createFeedServices(deps);
const { sessions, throttle } = createAuthServices(db, config.appSecret);
const sync = new SyncService(db);

// Jobs queued before host batching carry `feedSourceId` instead; their claims lapse and a later
// dispatch picks the sources up again.
await deps.queue.work(
  'feed.fetch',
  (data) => feeds.updater.updateMany((data as Partial<typeof data>).feedSourceIds ?? []),
  { concurrency: 8 },
);
await deps.queue.work('feed.favicon', ({ feedSourceId }) => feeds.favicons.refresh(feedSourceId), {
  concurrency: 2,
});

const scheduler = new IntervalScheduler(logger);
scheduler.every('feeds.dispatch', 60, async () => {
  const dispatched = await feeds.updater.dispatchDue();
  if (dispatched > 0) logger.debug({ dispatched }, 'Dispatched feed fetches');
});
scheduler.every('feeds.purge', 6 * 60 * 60, async () => {
  logger.info(await feeds.purger.purge(), 'Purged old entries');
  await sync.pruneTombstones();
});
scheduler.every('auth.prune', 60 * 60, async () => {
  await sessions.pruneExpired();
  await throttle.prune();
});
scheduler.start();
onShutdown(() => scheduler.stop());

logger.info('Worker started');
