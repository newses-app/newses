import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserService } from '../../core/auth/users.ts';
import type { AppConfig } from '../../core/config.ts';
import type { Logger } from '../../core/ports.ts';
import { createMigrateHandler, type MigrateDeps } from './migrate-handler.ts';

const PARAMETERS: Record<string, string> = {
  DB_MASTER_PASSWORD_PARAMETER: 'master-secret',
  DB_PASSWORD_PARAMETER: 'stage-secret',
};

function setup(overrides: Partial<MigrateDeps> = {}) {
  const steps: string[] = [];
  const users = {
    bootstrapAdmin: vi.fn((login: string) => {
      steps.push(`bootstrap ${login}`);
      return Promise.resolve(true);
    }),
    reservedAdminLogins: () => Promise.resolve([]),
    reissueAdmin: vi.fn<(login: string, password: string) => Promise<void>>(() =>
      Promise.resolve(),
    ),
  };
  const logger = { info: vi.fn(), warn: vi.fn() };
  const provisionDatabase = vi.fn((url: string, target: { name: string; password: string }) => {
    steps.push(`provision ${target.name}`);
    return Promise.resolve();
  });
  const deps = {
    config: { bootstrapAdmin: { login: 'admin', password: 'from-ssm' } } as AppConfig,
    logger: logger as unknown as Logger,
    users: users as unknown as UserService,
    migrate: vi.fn(() => {
      steps.push('migrate');
      return Promise.resolve();
    }),
    provisionDatabase,
    readParameter: (envName: string) => Promise.resolve(PARAMETERS[envName] ?? ''),
    writeParameter: vi.fn<(envName: string, value: string) => Promise<void>>(() =>
      Promise.resolve(),
    ),
    ...overrides,
  };
  return { deps, steps, users, logger, provisionDatabase, handler: createMigrateHandler(deps) };
}

beforeEach(() => {
  vi.stubEnv('DB_MASTER_PASSWORD_PARAMETER', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('createMigrateHandler', () => {
  it('applies the migrations, then creates the first admin with its generated password', async () => {
    const { handler, steps, users, provisionDatabase } = setup();
    await handler();
    expect(steps).toEqual(['migrate', 'bootstrap admin']);
    expect(users.bootstrapAdmin).toHaveBeenCalledWith('admin', 'from-ssm', true);
    expect(provisionDatabase).not.toHaveBeenCalled();
  });

  it("first creates the stage's role and database on a shared instance", async () => {
    vi.stubEnv('DB_MASTER_PASSWORD_PARAMETER', '/newses/rds-master');
    vi.stubEnv('DB_MASTER_USER', 'master');
    vi.stubEnv('DB_NAME', 'newses_dev');
    vi.stubEnv('DB_HOST', 'db.internal');
    vi.stubEnv('DB_PORT', '5432');
    const { handler, provisionDatabase, steps } = setup();
    await handler();
    expect(steps).toEqual(['provision newses_dev', 'migrate', 'bootstrap admin']);
    const [adminUrl = '', target] = provisionDatabase.mock.calls[0] ?? [];
    const url = new URL(adminUrl);
    expect([url.username, url.password, url.host, url.pathname, url.search]).toEqual([
      'master',
      'master-secret',
      'db.internal:5432',
      '/postgres',
      '?sslmode=verify-full',
    ]);
    expect(target).toEqual({ name: 'newses_dev', password: 'stage-secret' });
  });

  it('gives the first admin a new password, kept in SSM, without migrating', async () => {
    vi.stubEnv('ADMIN_LOGIN', 'admin');
    const { handler, deps, users, logger } = setup();
    await handler({ task: 'reissue-admin' });
    const password = users.reissueAdmin.mock.calls[0]?.[1] ?? '';
    expect(users.reissueAdmin).toHaveBeenCalledWith('admin', password);
    expect(password).toMatch(/^[A-Za-z0-9]{24}$/);
    expect(deps.writeParameter).toHaveBeenCalledWith('ADMIN_PASSWORD_PARAMETER', password);
    expect(logger.warn).toHaveBeenCalledWith(
      { security: 'admin_reissued', login: 'admin' },
      expect.any(String),
    );
    expect(deps.migrate).not.toHaveBeenCalled();
  });

  it('refuses to reissue without the admin login', async () => {
    vi.stubEnv('ADMIN_LOGIN', '');
    const { handler, deps } = setup({ newPassword: () => 'x' });
    await expect(handler({ task: 'reissue-admin' })).rejects.toThrow('ADMIN_LOGIN is not set');
    expect(deps.writeParameter).not.toHaveBeenCalled();
  });
});
