import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb } from '../../db/client.ts';
import { users as usersTable } from '../../db/schema.ts';
import { createTestDatabase, type TestDatabase } from '../../test/database.ts';
import { TEST_APP_SECRET } from '../../test/fakes.ts';
import { createAuthServices, type AuthServices } from './index.ts';
import { verifyPassword } from './passwords.ts';

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
    expect(await services.users.bootstrapAdmin('root', 'password1', true)).toBe(true);
    expect(await services.users.bootstrapAdmin('other', 'password1')).toBe(false);
    expect(
      (await services.users.list()).map((u) => [u.login, u.role, u.passwordChangeRequired]),
    ).toEqual([['root', 'admin', true]]);
    const root = await services.users.findByLogin('root');
    await services.users.setPassword(root?.id ?? 0, 'a chosen password');
    expect((await services.users.findByLogin('root'))?.passwordChangeRequired).toBe(false);
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
