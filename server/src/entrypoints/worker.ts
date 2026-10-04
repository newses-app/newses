import { PgBoss } from 'pg-boss';
import { IntervalScheduler } from '../adapters/interval-scheduler.ts';
import { createRuntime } from './runtime.ts';

const { config, logger, onShutdown } = createRuntime('worker');

const boss = new PgBoss({ connectionString: config.databaseUrl });
boss.on('error', (err) => {
  logger.error({ err }, 'Job queue error');
});
await boss.start();
onShutdown(() => boss.stop({ graceful: true }));

// Job handlers and scheduled tasks are registered here as features land.
const scheduler = new IntervalScheduler(logger);
scheduler.start();
onShutdown(() => scheduler.stop());

logger.info('Worker started');
