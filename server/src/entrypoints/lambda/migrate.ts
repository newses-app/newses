import { createAuthServices } from '../../core/auth/index.ts';
import { runMigrations } from '../../db/migrate.ts';
import { createLambdaRuntime, readParameter } from './runtime.ts';

const { logger, pool, db } = await createLambdaRuntime('migrate');

/**
 * Applies migrations before each deployment, then creates the first admin, ADMIN_LOGIN with the
 * password parameter named by ADMIN_PASSWORD_PARAMETER, while the database has no users.
 */
export async function handler(): Promise<void> {
  await runMigrations(pool);
  logger.info('Migrations applied');
  const login = process.env.ADMIN_LOGIN;
  if (!login) return;
  const password = await readParameter('ADMIN_PASSWORD_PARAMETER');
  if (await createAuthServices(db).users.bootstrapAdmin(login, password)) {
    logger.info({ login }, 'Created initial admin user');
  }
}
