import { createAuthServices } from '../../core/auth/index.ts';
import { runMigrations } from '../../db/migrate.ts';
import { createLambdaRuntime, readSecretJson } from './runtime.ts';

const { logger, pool, db } = await createLambdaRuntime('migrate');

/**
 * Applies migrations before each deployment, then creates the first admin from the secret named
 * by ADMIN_SECRET_ARN while the database has no users.
 */
export async function handler(): Promise<void> {
  await runMigrations(pool);
  logger.info('Migrations applied');
  const secretArn = process.env.ADMIN_SECRET_ARN;
  if (!secretArn) return;
  const { login, password } = await readSecretJson<{ login: string; password: string }>(secretArn);
  if (await createAuthServices(db).users.bootstrapAdmin(login, password)) {
    logger.info({ login }, 'Created initial admin user');
  }
}
