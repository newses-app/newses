import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { base32Decode, hotp, timeStep } from '../core/auth/totp.ts';
import { HttpFetcher } from '../core/feeds/http.ts';
import { createDb } from '../db/client.ts';
import { createTestDatabase, type TestDatabase } from '../test/database.ts';
import { createTestServices } from '../test/services.ts';
import { type ApiServices, buildApp } from './app.ts';

let database: TestDatabase;
let app: ReturnType<typeof buildApp>;
let services: ApiServices;
let pat = 0;
let other = 0;

interface Auth {
  cookie: string;
  csrf: string;
}

async function sessionFor(userId: number): Promise<Auth> {
  const { token, session } = await services.sessions.create(userId, 'cookie', null);
  return { cookie: `rss_session=${token}`, csrf: session.csrfToken ?? '' };
}

const call = (method: 'GET' | 'POST' | 'DELETE', url: string, auth: Auth, payload?: object) =>
  app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { cookie: auth.cookie, 'x-csrf-token': auth.csrf },
    ...(payload && { payload }),
  });

const authenticate = (login: string, password: string) =>
  services.auth.authenticateAppPassword({ login, password, ip: '198.51.100.1' });

beforeAll(async () => {
  database = await createTestDatabase();
  services = createTestServices(createDb(database.pool), new HttpFetcher());
  pat = (await services.users.create('pat', 'pat password')).id;
  other = (await services.users.create('other', 'other password')).id;
  const setup = await services.twoFactor.begin(await services.users.get(pat));
  await services.twoFactor.enable(pat, hotp(base32Decode(setup.secret), timeStep(new Date())));
  app = buildApp({ logger: pino({ level: 'silent' }), healthChecks: {}, services });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await database.drop();
});

describe('app passwords', () => {
  it('authenticate compatibility clients without TOTP, and only with an app password', async () => {
    const auth = await sessionFor(pat);
    const refused = await call('POST', '/auth/app-passwords', auth, {
      name: 'Reeder',
      password: 'wrong',
    });
    expect(refused.statusCode).toBe(401);

    const created = await call('POST', '/auth/app-passwords', auth, {
      name: 'Reeder',
      password: 'pat password',
    });
    expect(created.statusCode).toBe(201);
    const { password, appPassword } = created.json<{
      password: string;
      appPassword: { id: number; name: string; lastUsedAt: string | null };
    }>();
    expect(password).toMatch(/^[a-z2-7]{4}(-[a-z2-7]{4}){7}$/);
    expect(appPassword).toMatchObject({ name: 'Reeder', lastUsedAt: null });

    // Typed without dashes and in capitals on a phone, and with the login in another case.
    expect((await authenticate('PAT', password.replace(/-/g, '').toUpperCase())).id).toBe(pat);
    const list = await call('GET', '/auth/app-passwords', auth);
    expect(list.json<{ lastUsedAt: string | null }[]>()[0]?.lastUsedAt).not.toBeNull();

    await expect(authenticate('pat', 'pat password')).rejects.toMatchObject({
      code: 'invalid_credentials',
    });
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { login: 'pat', password },
    });
    expect(login.statusCode).toBe(401);

    const theirs = await sessionFor(other);
    expect(
      (await call('DELETE', `/auth/app-passwords/${String(appPassword.id)}`, theirs)).statusCode,
    ).toBe(404);
    await expect(authenticate('other', password)).rejects.toMatchObject({
      code: 'invalid_credentials',
    });

    expect(
      (await call('DELETE', `/auth/app-passwords/${String(appPassword.id)}`, auth)).statusCode,
    ).toBe(204);
    await expect(authenticate('pat', password)).rejects.toMatchObject({
      code: 'invalid_credentials',
    });
  });

  it('stop working when the user is disabled or an admin resets the password', async () => {
    const { password } = await services.appPasswords.create(other, 'NetNewsWire');
    await services.users.update(other, { disabled: true });
    await expect(authenticate('other', password)).rejects.toMatchObject({
      code: 'invalid_credentials',
    });
    await services.users.update(other, { disabled: false });
    expect((await authenticate('other', password)).id).toBe(other);

    await services.auth.resetPassword(other, 'a brand new password');
    expect(await services.appPasswords.list(other)).toEqual([]);
    await expect(authenticate('other', password)).rejects.toMatchObject({
      code: 'invalid_credentials',
    });
  });
});
