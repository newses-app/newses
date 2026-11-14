import { createAuthServices } from '../../core/auth/index.ts';
import { runMigrations } from '../../db/migrate.ts';
import { createMigrateHandler } from './migrate-handler.ts';
import { provisionDatabase } from './provision.ts';
import { createLambdaRuntime, readParameter, writeParameter } from './runtime.ts';

const { config, logger, pool, db } = await createLambdaRuntime('migrate');

export const handler = createMigrateHandler({
  config,
  logger,
  users: createAuthServices(db, config.appSecret).users,
  migrate: () => runMigrations(pool),
  provisionDatabase,
  readParameter,
  writeParameter,
});
