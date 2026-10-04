import { PgBoss } from 'pg-boss';
import { PgNotifyRealtime } from '../adapters/pg-notify-realtime.ts';
import { buildApp } from '../api/app.ts';
import { createRuntime } from './runtime.ts';

const { config, logger, pool, onShutdown } = createRuntime('server');

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

const app = buildApp({
  logger,
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
