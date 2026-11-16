import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PgBoss } from 'pg-boss';
import { IntervalScheduler } from '../adapters/interval-scheduler.ts';
import { PgNotifyRealtime } from '../adapters/pg-notify-realtime.ts';
import { createAuthServices } from '../core/auth/index.ts';
import { EntryService } from '../core/entries/entries.ts';
import { SyncService } from '../core/entries/sync.ts';
import { createFeedServices } from '../core/feeds/index.ts';
import { DigestService } from '../core/mail/digest-service.ts';
import { createOpsServices } from '../core/ops/index.ts';
import { PluginStorageService } from '../core/plugins/storage.ts';
import { PrefsService } from '../core/prefs.ts';
import { createDb } from '../db/client.ts';
import {
  createArchiveReader,
  createFeedDeps,
  createNotifier,
  PG_BOSS_TELEMETRY,
} from './feed-deps.ts';
import { createRuntime } from './runtime.ts';
import { scheduleWorkerTasks, workJobs } from './scheduled-tasks.ts';
import { scheduleOpsFlush } from './tracking.ts';

/** Its age tells `newses worker-health` (`docker/entrypoint.sh`) whether dispatch still runs. */
const HEARTBEAT_FILE = join(tmpdir(), 'newses-worker-heartbeat');

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
onShutdown(() => deps.push.close());
const feeds = createFeedServices(deps);
const { sessions, throttle } = createAuthServices(db, config.appSecret);
const sync = new SyncService(db);

const tasks = {
  feeds,
  sessions,
  throttle,
  sync,
  digest: new DigestService({
    db,
    mailer: deps.mailer,
    prefs: new PrefsService(db),
    entries: new EntryService(db, deps.realtime),
    publicUrl: config.publicUrl,
    unsubscribeKey: deps.keys['digest-unsubscribe'],
    logger,
  }),
  ops,
  plugins: { storage: new PluginStorageService(db) },
  archive: createArchiveReader(config, deps.blobs),
  logger,
};
await workJobs(deps.queue, tasks);
const scheduler = new IntervalScheduler(logger);
scheduleWorkerTasks(scheduler, tasks, HEARTBEAT_FILE);
scheduler.start();
onShutdown(() => scheduler.stop());

logger.info('Worker started');
