import { randomInt } from 'node:crypto';
import type { UserService } from '../../core/auth/users.ts';
import type { AppConfig } from '../../core/config.ts';
import type { Logger } from '../../core/ports.ts';
import { bootstrapAdmin } from '../runtime.ts';
import { databaseUrl, requireEnv } from './runtime.ts';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export interface MigrateDeps {
  config: AppConfig;
  logger: Logger;
  users: UserService;
  /** Applies the migrations to the stage's database. */
  migrate: () => Promise<void>;
  /** `provision.ts`: the stage's role and database on the shared instance. */
  provisionDatabase: (
    adminUrl: string,
    target: { name: string; password: string },
  ) => Promise<void>;
  /** The SSM parameter named by the environment variable `envName` (`runtime.ts`). */
  readParameter: (envName: string) => Promise<string>;
  writeParameter: (envName: string, value: string) => Promise<void>;
  /** A new password for the first admin; 24 letters and digits unless given. */
  newPassword?: () => string;
}

const randomPassword = () =>
  Array.from({ length: 24 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');

/**
 * The migrate function's handler. It applies migrations before each deployment, then creates the
 * first admin from ADMIN_LOGIN and the password parameter named by ADMIN_PASSWORD_PARAMETER while
 * the database has no users. With DB_MASTER_USER and DB_MASTER_PASSWORD_PARAMETER, it first
 * creates the stage's role and database on the shared instance. `{ "task": "reissue-admin" }`
 * instead gives that admin a new password in the parameter, while no other active admin exists.
 */
export function createMigrateHandler(deps: MigrateDeps) {
  const { config, logger, users } = deps;

  /** For a stage whose only admin is the first one, with its generated password expired. */
  async function reissueAdmin(): Promise<void> {
    const login = requireEnv('ADMIN_LOGIN');
    const password = (deps.newPassword ?? randomPassword)();
    await users.reissueAdmin(login, password);
    await deps.writeParameter('ADMIN_PASSWORD_PARAMETER', password);
    logger.warn(
      { security: 'admin_reissued', login },
      "Security: reissued the first admin's password",
    );
  }

  return async (event?: { task?: string }): Promise<void> => {
    if (event?.task === 'reissue-admin') return reissueAdmin();
    if (process.env.DB_MASTER_PASSWORD_PARAMETER) {
      const master = await deps.readParameter('DB_MASTER_PASSWORD_PARAMETER');
      const name = requireEnv('DB_NAME');
      await deps.provisionDatabase(databaseUrl(requireEnv('DB_MASTER_USER'), master, 'postgres'), {
        name,
        password: await deps.readParameter('DB_PASSWORD_PARAMETER'),
      });
      logger.info({ database: name }, 'Database provisioned');
    }
    await deps.migrate();
    logger.info('Migrations applied');
    // The password is generated into SSM, so it only gets the admin as far as choosing a new one.
    await bootstrapAdmin(users, config, logger, true);
  };
}
