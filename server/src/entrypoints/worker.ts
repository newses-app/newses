import { PgBoss } from 'pg-boss';
import { IntervalScheduler } from '../adapters/interval-scheduler.ts';
import { createAuthServices } from '../core/auth/index.ts';
import { createDb } from '../db/client.ts';
import { createRuntime } from './runtime.ts';

const { config, logger, pool, onShutdown } = createRuntime('worker');
const db = createDb(pool);

const boss = new PgBoss({ connectionString: config.databaseUrl });
boss.on('error', (err) => {
  logger.error({ err }, 'Job queue error');
});
await boss.start();
onShutdown(() => boss.stop({ graceful: true }));

const { sessions, throttle } = createAuthServices(db);

const scheduler = new IntervalScheduler(logger);
scheduler.every('auth.prune', 60 * 60, async () => {
  await sessions.pruneExpired();
  await throttle.prune();
});
scheduler.start();
onShutdown(() => scheduler.stop());

logger.info('Worker started');
