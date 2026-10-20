import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb } from '../../db/client.ts';
import { users as usersTable } from '../../db/schema.ts';
import { createTestDatabase, type TestDatabase } from '../../test/database.ts';
import { TEST_APP_SECRET } from '../../test/fakes.ts';
import { createAuthServices, type AuthServices } from './index.ts';
import { verifyPassword } from './passwords.ts';
import { GENERATED_PASSWORD_DAYS } from './users.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

let database: TestDatabase;
let services: AuthServices;

beforeAll(async () => {
  database = await createTestDatabase();
  services = createAuthServices(createDb(database.pool), TEST_APP_SECRET);
});

beforeEach(async () => {
  await createDb(database.pool).delete(usersTable);
});

afterAll(async () => {
  await database.drop();
});

describe('UserService', () => {
  it('stores Argon2id hashes', async () => {
    const user = await services.users.create('alice', 'correct horse');
    expect(user.passwordHash).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword(user.passwordHash, 'correct horse')).toBe(true);
    expect(await verifyPassword(user.passwordHash, 'wrong')).toBe(false);
  });

  it('rejects logins differing only in case', async () => {
    await services.users.create('Alice', 'password1');
    await expect(services.users.create('alice', 'password1')).rejects.toMatchObject({
      code: 'conflict',
    });
    expect((await services.users.findByLogin(' ALICE '))?.login).toBe('Alice');
  });

  it('bootstraps an admin only into an empty database', async () => {
    expect(await services.users.bootstrapAdmin('pat', 'password1', true)).toBe(true);
    expect(await services.users.bootstrapAdmin('other', 'password1')).toBe(false);
    expect(
      (await services.users.list()).map((u) => [u.login, u.role, u.passwordChangeRequired]),
    ).toEqual([['pat', 'admin', true]]);
    const pat = await services.users.findByLogin('pat');
    const expiresIn = (pat?.passwordExpiresAt?.getTime() ?? 0) - Date.now();
    expect(expiresIn).toBeGreaterThan(GENERATED_PASSWORD_DAYS * DAY_MS - 60_000);
    expect(expiresIn).toBeLessThanOrEqual(GENERATED_PASSWORD_DAYS * DAY_MS);
    await services.users.setPassword(pat?.id ?? 0, 'a chosen password');
    expect(await services.users.findByLogin('pat')).toMatchObject({
      passwordChangeRequired: false,
      passwordExpiresAt: null,
    });
  });

  it('refuses a well-known login for the first admin, but not once users exist', async () => {
    await expect(services.users.bootstrapAdmin('Admin', 'password1', true)).rejects.toMatchObject({
      code: 'invalid_input',
    });
    expect(await services.users.list()).toEqual([]);
    await services.users.create('admin', 'password1', 'admin');
    expect(await services.users.bootstrapAdmin('admin', 'password1')).toBe(false);
    expect(await services.users.reservedAdminLogins()).toEqual(['admin']);
  });

  it('reissues the first admin a password only while no other admin is active', async () => {
    const first = await services.users.create('pat', 'password1', 'admin', true);
    const session = await services.sessions.create(first.id, 'cookie', null);
    await services.users.reissueAdmin('PAT', 'a new generated password');
    const pat = await services.users.findByLogin('pat');
    expect(await verifyPassword(pat?.passwordHash ?? '', 'a new generated password')).toBe(true);
    expect(pat).toMatchObject({
      passwordChangeRequired: true,
      passwordExpiresAt: expect.any(Date) as Date,
    });
    expect(await services.sessions.validate(session.token)).toBeNull();

    await services.users.create('lee', 'password1', 'admin');
    await expect(services.users.reissueAdmin('pat', 'another password')).rejects.toMatchObject({
      code: 'conflict',
    });
    await expect(services.users.reissueAdmin('nobody', 'another password')).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('keeps at least one active admin', async () => {
    const admin = await services.users.create('admin', 'password1', 'admin');
    for (const change of [{ role: 'user' as const }, { disabled: true }]) {
      await expect(services.users.update(admin.id, change)).rejects.toMatchObject({
        code: 'last_admin',
      });
    }
    await expect(services.users.delete(admin.id)).rejects.toMatchObject({ code: 'last_admin' });

    await services.users.create('admin2', 'password1', 'admin');
    expect((await services.users.update(admin.id, { role: 'user' })).role).toBe('user');
  });

  it('revokes sessions on password change, keeping the caller', async () => {
    const user = await services.users.create('bob', 'password1');
    const keep = await services.sessions.create(user.id, 'cookie', null);
    const other = await services.sessions.create(user.id, 'bearer', null);
    await services.users.setPassword(user.id, 'new password', keep.session.id);
    expect(await services.sessions.validate(keep.token)).not.toBeNull();
    expect(await services.sessions.validate(other.token)).toBeNull();
  });
});
