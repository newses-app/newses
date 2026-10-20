import { randomInt } from 'node:crypto';
import { createAuthServices } from '../../core/auth/index.ts';
import { runMigrations } from '../../db/migrate.ts';
import { bootstrapAdmin } from '../runtime.ts';
import { provisionDatabase } from './provision.ts';
import {
  createLambdaRuntime,
  databaseUrl,
  readParameter,
  requireEnv,
  writeParameter,
} from './runtime.ts';

const { config, logger, pool, db } = await createLambdaRuntime('migrate');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Applies migrations before each deployment, then creates the first admin from ADMIN_LOGIN and
 * the password parameter named by ADMIN_PASSWORD_PARAMETER while the database has no users.
 * With DB_MASTER_USER and DB_MASTER_PASSWORD_PARAMETER, it first creates the stage's role and
 * database on the shared instance. `{ "task": "reissue-admin" }` instead gives that admin a new
 * password in the parameter, while no other active admin exists.
 */
export async function handler(event?: { task?: string }): Promise<void> {
  if (event?.task === 'reissue-admin') return reissueAdmin();
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
  // The password is generated into SSM, so it only gets the admin as far as choosing a new one.
  await bootstrapAdmin(createAuthServices(db, config.appSecret).users, config, logger, true);
}

/** For a stage whose only admin is the first one, with its generated password expired. */
async function reissueAdmin(): Promise<void> {
  const login = requireEnv('ADMIN_LOGIN');
  const password = Array.from({ length: 24 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  await createAuthServices(db, config.appSecret).users.reissueAdmin(login, password);
  await writeParameter('ADMIN_PASSWORD_PARAMETER', password);
  logger.warn(
    { security: 'admin_reissued', login },
    "Security: reissued the first admin's password",
  );
}
