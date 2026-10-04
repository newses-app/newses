import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../../db/client.ts';
import { createTestDatabase, type TestDatabase } from '../../test/database.ts';
import { createAuthServices, type AuthServices } from './index.ts';

let database: TestDatabase;
let now = new Date('2026-10-04T12:00:00Z');
let services: AuthServices;

const DAY = 24 * 60 * 60 * 1000;
const advance = (ms: number) => {
  now = new Date(now.getTime() + ms);
};

beforeAll(async () => {
  database = await createTestDatabase();
  services = createAuthServices(createDb(database.pool), () => now);
});

afterAll(async () => {
  await database.drop();
});

let seq = 0;
const newUser = () => services.users.create(`sess${String(++seq)}`, 'password1');

describe('SessionService', () => {
  it('validates tokens and stores only their hash', async () => {
    const user = await newUser();
    const { token, session } = await services.sessions.create(user.id, 'cookie', 'UA');
    expect(session.tokenHash).not.toContain(token);
    expect(session.csrfToken).toBeTruthy();
    expect((await services.sessions.validate(token))?.user.id).toBe(user.id);
    expect(await services.sessions.validate('wrong')).toBeNull();
  });

  it('gives bearer sessions no CSRF token', async () => {
    const user = await newUser();
    expect((await services.sessions.create(user.id, 'bearer', null)).session.csrfToken).toBeNull();
  });

  it('slides expiry on use and expires idle sessions', async () => {
    const user = await newUser();
    const { token, session } = await services.sessions.create(user.id, 'cookie', null);
    advance(20 * DAY);
    const used = await services.sessions.validate(token);
    expect(used?.refreshed).toBe(true);
    expect(used?.session.expiresAt.getTime()).toBeGreaterThan(session.expiresAt.getTime());
    advance(31 * DAY);
    expect(await services.sessions.validate(token)).toBeNull();
  });

  it('rejects sessions of disabled users', async () => {
    const user = await newUser();
    await services.users.create(`admin${String(++seq)}`, 'password1', 'admin');
    const { token } = await services.sessions.create(user.id, 'cookie', null);
    await services.users.update(user.id, { disabled: true });
    expect(await services.sessions.validate(token)).toBeNull();
  });

  it('only revokes sessions owned by the user', async () => {
    const alice = await newUser();
    const bob = await newUser();
    const { session } = await services.sessions.create(alice.id, 'cookie', null);
    await expect(services.sessions.revoke(bob.id, session.id)).rejects.toMatchObject({
      code: 'not_found',
    });
    await services.sessions.revoke(alice.id, session.id);
    expect(await services.sessions.list(alice.id)).toHaveLength(0);
  });
});
