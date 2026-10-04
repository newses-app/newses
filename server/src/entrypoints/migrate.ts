import { runMigrations } from '../db/migrate.ts';
import { createRuntime } from './runtime.ts';

const { logger, pool } = createRuntime('migrate');
try {
  await runMigrations(pool);
  logger.info('Migrations applied');
} finally {
  await pool.end();
}
