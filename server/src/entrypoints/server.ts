import { PgBoss } from 'pg-boss';
import { PgNotifyRealtime } from '../adapters/pg-notify-realtime.ts';
import { buildApp } from '../api/app.ts';
import { createAuthServices } from '../core/auth/index.ts';
import { HttpFetcher } from '../core/feeds/http.ts';
import { createFeedServices } from '../core/feeds/index.ts';
import { createDb } from '../db/client.ts';
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

const fetcher = new HttpFetcher({ allowPrivateNetworks: config.fetchAllowPrivateNetworks });
onShutdown(() => fetcher.close());
const services = { ...createAuthServices(db), feeds: createFeedServices(db, fetcher) };
if (config.bootstrapAdmin) {
  const { login, password } = config.bootstrapAdmin;
  if (await services.users.bootstrapAdmin(login, password)) {
    logger.info({ login }, 'Created initial admin user');
  }
}

const app = buildApp({
  logger,
  trustProxy: config.http.trustProxy,
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
