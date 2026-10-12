import { createAuthServices } from '../../core/auth/index.ts';
import { runMigrations } from '../../db/migrate.ts';
import { provisionDatabase } from './provision.ts';
import { createLambdaRuntime, databaseUrl, readParameter, requireEnv } from './runtime.ts';

const { config, logger, pool, db } = await createLambdaRuntime('migrate');

/**
 * Applies migrations before each deployment, then creates the first admin from ADMIN_LOGIN and
 * the password parameter named by ADMIN_PASSWORD_PARAMETER while the database has no users.
 * With DB_MASTER_USER and DB_MASTER_PASSWORD_PARAMETER, it first creates the stage's role and
 * database on the shared instance.
 */
export async function handler(): Promise<void> {
  if (process.env.DB_MASTER_PASSWORD_PARAMETER) {
    const master = await readParameter('DB_MASTER_PASSWORD_PARAMETER');
    const name = requireEnv('DB_NAME');
    await provisionDatabase(databaseUrl(requireEnv('DB_MASTER_USER'), master, 'postgres'), {
      name,
      password: await readParameter('DB_PASSWORD_PARAMETER'),
    });
    logger.info({ database: name }, 'Database provisioned');
  }
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
