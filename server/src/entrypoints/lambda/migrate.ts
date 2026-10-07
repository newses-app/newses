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
  // The password is generated into SSM, so it only gets the admin as far as choosing a new one.
  const users = createAuthServices(db, config.appSecret).users;
  if (await users.bootstrapAdmin(login, password, true)) {
    logger.info({ login }, 'Created initial admin user');
  }
}
