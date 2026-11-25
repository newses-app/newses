import { createAuthServices } from '../../core/auth/index.ts';
import { runMigrations } from '../../db/migrate.ts';
import { createMigrateHandler } from './migrate-handler.ts';
import { provisionDatabase } from './provision.ts';
import { createLambdaBase, readParameter, writeParameter } from './runtime.ts';

// Not the full runtime: loading plugins writes to tables that the migrations may not have made yet.
const { config, logger, pool, db } = await createLambdaBase('migrate');

export const handler = createMigrateHandler({
  config,
  logger,
  users: createAuthServices(db, config.appSecret).users,
  migrate: () => runMigrations(pool),
  provisionDatabase,
  readParameter,
  writeParameter,
});
