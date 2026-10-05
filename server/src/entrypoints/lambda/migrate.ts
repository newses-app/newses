import { createAuthServices } from '../../core/auth/index.ts';
import { runMigrations } from '../../db/migrate.ts';
import { createLambdaRuntime } from './runtime.ts';

const { config, logger, pool, db } = await createLambdaRuntime('migrate');

/**
 * Applies migrations before each deployment, then creates the first admin from ADMIN_LOGIN and
 * the password parameter named by ADMIN_PASSWORD_PARAMETER while the database has no users.
 */
export async function handler(): Promise<void> {
  await runMigrations(pool);
  logger.info('Migrations applied');
  if (!config.bootstrapAdmin) return;
  const { login, password } = config.bootstrapAdmin;
  if (await createAuthServices(db).users.bootstrapAdmin(login, password)) {
    logger.info({ login }, 'Created initial admin user');
  }
}
