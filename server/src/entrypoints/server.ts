import { PgBoss } from 'pg-boss';
import { PgNotifyRealtime } from '../adapters/pg-notify-realtime.ts';
import { buildApp } from '../api/app.ts';
import { createAuthServices } from '../core/auth/index.ts';
import { createEntryServices } from '../core/entries/index.ts';
import { createFeedServices } from '../core/feeds/index.ts';
import { PrefsService } from '../core/prefs.ts';
import { createDb } from '../db/client.ts';
import { createFeedDeps } from './feed-deps.ts';
import { createRuntime } from './runtime.ts';

const { config, logger, pool, onShutdown } = createRuntime('server');
const db = createDb(pool);

// The server only enqueues jobs; the worker runs pg-boss maintenance and scheduling.
const boss = new PgBoss({
  connectionString: config.databaseUrl,
  supervise: false,
  schedule: false,
});
boss.on('error', (err) => {
  logger.error({ err }, 'Job queue error');
});
await boss.start();
onShutdown(() => boss.stop({ graceful: true }));

const realtime = new PgNotifyRealtime(pool, logger);
await realtime.start();
onShutdown(() => realtime.stop());

const feedDeps = createFeedDeps({ config, db, boss, realtime, logger });
onShutdown(() => feedDeps.fetcher.close());
const services = {
  ...createAuthServices(db),
  feeds: createFeedServices(feedDeps),
  entries: createEntryServices(db, realtime),
  prefs: new PrefsService(db),
  realtime,
};
if (config.bootstrapAdmin) {
  const { login, password } = config.bootstrapAdmin;
  if (await services.users.bootstrapAdmin(login, password)) {
    logger.info({ login }, 'Created initial admin user');
  }
}

const app = buildApp({
  logger,
  trustProxy: config.http.trustProxy,
  webDir: config.webDir,
  services,
  healthChecks: {
    db: async () => {
      await pool.query('SELECT 1');
    },
    queue: async () => {
      if (!(await boss.isInstalled())) throw new Error('pg-boss schema missing');
    },
  },
});
await app.listen({ host: config.http.host, port: config.http.port });
onShutdown(() => app.close());
