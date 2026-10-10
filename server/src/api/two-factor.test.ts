import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuthServices } from '../core/auth/index.ts';
import { base32Decode, hotp, timeStep } from '../core/auth/totp.ts';
import { HttpFetcher } from '../core/feeds/http.ts';
import { createDb } from '../db/client.ts';
import { createTestDatabase, type TestDatabase } from '../test/database.ts';
import { TEST_APP_SECRET } from '../test/fakes.ts';
import { createTestServices } from '../test/services.ts';
import { buildApp } from './app.ts';

let database: TestDatabase;
let app: ReturnType<typeof buildApp>;
let now = new Date('2026-10-06T12:00:00Z');
const advance = (seconds: number) => {
  now = new Date(now.getTime() + seconds * 1000);
};

beforeAll(async () => {
  database = await createTestDatabase();
  const db = createDb(database.pool);
  const services = {
    ...createTestServices(db, new HttpFetcher()),
    ...createAuthServices(db, TEST_APP_SECRET, () => now),
  };
  await services.users.create('admin', 'admin password', 'admin');
  await services.users.create('tess', 'tess password');
  app = buildApp({ logger: pino({ level: 'silent' }), healthChecks: {}, services });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await database.drop();
});

interface Auth {
  cookie: string;
  csrf: string;
}

const post = (url: string, payload: object, auth?: Auth) =>
  app.inject({
    method: 'POST',
    url: `/api/v1${url}`,
    payload,
    ...(auth && { headers: { cookie: auth.cookie, 'x-csrf-token': auth.csrf } }),
  });

function cookieAuth(res: Awaited<ReturnType<typeof post>>): Auth {
  const cookie = res.cookies.find((c) => c.name === 'rss_session');
  return {
    cookie: `rss_session=${cookie?.value ?? ''}`,
    csrf: res.json<{ csrfToken: string }>().csrfToken,
  };
}

async function signIn(login: string, password: string): Promise<Auth> {
  const res = await post('/auth/login', { login, password });
  expect(res.statusCode).toBe(200);
  return cookieAuth(res);
}

/** The current code; `ahead` steps later avoids replaying one already accepted. */
const codeFor = (secret: string, ahead = 0) => hotp(base32Decode(secret), timeStep(now) + ahead);

describe('two-factor authentication', () => {
  let secret = '';
  let recoveryCodes: string[] = [];

  it('enrols after re-checking the password and signs out other sessions', async () => {
    const tess = await signIn('tess', 'tess password');
    const bearer = await post('/auth/login', {
      login: 'tess',
      password: 'tess password',
      tokenType: 'bearer',
    });
    const otherToken = bearer.json<{ token: string }>().token;

    expect((await post('/auth/2fa/setup', { password: 'wrong' }, tess)).statusCode).toBe(401);
    const setup = await post('/auth/2fa/setup', { password: 'tess password' }, tess);
    expect(setup.statusCode).toBe(200);
    ({ secret } = setup.json<{ secret: string; uri: string }>());
    expect(setup.json<{ uri: string }>().uri).toMatch(/^otpauth:\/\/totp\/RSS%20Reader:tess\?/);

    expect((await post('/auth/2fa/enable', { code: '000000' }, tess)).statusCode).toBe(401);
    const enabled = await post('/auth/2fa/enable', { code: codeFor(secret) }, tess);
    expect(enabled.statusCode).toBe(200);
    ({ recoveryCodes } = enabled.json<{ recoveryCodes: string[] }>());
    expect(recoveryCodes).toHaveLength(10);
    expect(recoveryCodes[0]).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{4}){3}$/);

    const other = await app.inject({
      url: '/api/v1/auth/session',
      headers: { authorization: `Bearer ${otherToken}` },
    });
    expect(other.statusCode).toBe(401);
    const status = await app.inject({ url: '/api/v1/auth/2fa', headers: { cookie: tess.cookie } });
    expect(status.json()).toEqual({ enabled: true, recoveryCodesLeft: 10 });
    const session = await app.inject({
      url: '/api/v1/auth/session',
      headers: { cookie: tess.cookie },
    });
    expect(session.json<{ user: { twoFactor: boolean } }>().user.twoFactor).toBe(true);
  });

  it('asks for a code after the password and refuses replayed codes', async () => {
    const first = await post('/auth/login', { login: 'tess', password: 'tess password' });
    expect(first.statusCode).toBe(200);
    expect(first.cookies).toHaveLength(0);
    const { challenge, twoFactorRequired } = first.json<{
      challenge: string;
      twoFactorRequired: boolean;
    }>();
    expect(twoFactorRequired).toBe(true);

    // The enrolment code's step was accepted already.
    expect((await post('/auth/login/2fa', { challenge, code: codeFor(secret) })).statusCode).toBe(
      401,
    );
    advance(30);
    const done = await post('/auth/login/2fa', { challenge, code: codeFor(secret) });
    expect(done.statusCode).toBe(200);
    expect(cookieAuth(done).csrf).toBeTruthy();
    expect((await post('/auth/login/2fa', { challenge, code: codeFor(secret) })).statusCode).toBe(
      401,
    );
  });

  it('accepts each recovery code once, for bearer logins too', async () => {
    const login = () =>
      post('/auth/login', { login: 'tess', password: 'tess password', tokenType: 'bearer' });
    const challenge = (await login()).json<{ challenge: string }>().challenge;
    const code = (recoveryCodes[0] ?? '').toLowerCase();
    const done = await post('/auth/login/2fa', { challenge, code });
    expect(done.statusCode).toBe(200);
    expect(done.cookies).toHaveLength(0);
    const { token } = done.json<{ token: string }>();
    const session = await app.inject({
      url: '/api/v1/auth/session',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(session.statusCode).toBe(200);

    const again = (await login()).json<{ challenge: string }>().challenge;
    expect((await post('/auth/login/2fa', { challenge: again, code })).statusCode).toBe(401);
    advance(60);
  });

  it('refuses forged and expired challenges', async () => {
    const { challenge } = (
      await post('/auth/login', { login: 'tess', password: 'tess password' })
    ).json<{ challenge: string }>();
    const [payload, mac] = challenge.split('.');
    const forged = `${Buffer.from('{"u":1,"k":"cookie","e":9999999999999}').toString('base64url')}.${mac ?? ''}`;
    expect((await post('/auth/login/2fa', { challenge: forged, code: '123456' })).statusCode).toBe(
      400,
    );
    expect(payload).toBeTruthy();
    advance(6 * 60);
    const expired = await post('/auth/login/2fa', { challenge, code: codeFor(secret) });
    expect(expired.statusCode).toBe(400);
  });

  it('locks the account after repeated wrong codes', async () => {
    const { challenge } = (
      await post('/auth/login', { login: 'tess', password: 'tess password' })
    ).json<{ challenge: string }>();
    // Failures left over from earlier tests count too; the lock starts by the fifth.
    let attempts = 0;
    while (
      attempts < 10 &&
      (await post('/auth/login/2fa', { challenge, code: '000000' })).statusCode === 401
    ) {
      attempts += 1;
    }
    expect(attempts).toBeLessThanOrEqual(5);
    expect((await post('/auth/login/2fa', { challenge, code: codeFor(secret) })).statusCode).toBe(
      429,
    );
    advance(60);
  });

  it('regenerates recovery codes and turns off with password and code', async () => {
    const { challenge } = (
      await post('/auth/login', { login: 'tess', password: 'tess password' })
    ).json<{ challenge: string }>();
    const tess = cookieAuth(await post('/auth/login/2fa', { challenge, code: codeFor(secret) }));

    advance(30);
    const fresh = await post('/auth/2fa/recovery-codes', { code: codeFor(secret) }, tess);
    expect(fresh.statusCode).toBe(200);
    const newCodes = fresh.json<{ recoveryCodes: string[] }>().recoveryCodes;
    expect(newCodes).not.toContain(recoveryCodes[1]);

    expect(
      (await post('/auth/2fa/disable', { password: 'wrong', code: newCodes[0] ?? '' }, tess))
        .statusCode,
    ).toBe(401);
    advance(60);
    expect(
      (
        await post(
          '/auth/2fa/disable',
          { password: 'tess password', code: newCodes[0] ?? '' },
          tess,
        )
      ).statusCode,
    ).toBe(204);
    const plain = await post('/auth/login', { login: 'tess', password: 'tess password' });
    expect(plain.json<{ user?: unknown }>().user).toBeDefined();
  });

  it('lets an admin reset it', async () => {
    const tess = await signIn('tess', 'tess password');
    const setup = await post('/auth/2fa/setup', { password: 'tess password' }, tess);
    secret = setup.json<{ secret: string }>().secret;
    expect((await post('/auth/2fa/enable', { code: codeFor(secret) }, tess)).statusCode).toBe(200);

    const admin = await signIn('admin', 'admin password');
    const users = await app.inject({
      url: '/api/v1/admin/users',
      headers: { cookie: admin.cookie },
    });
    const target = users
      .json<{ id: number; login: string; twoFactor: boolean }[]>()
      .find((u) => u.login === 'tess');
    expect(target?.twoFactor).toBe(true);
    const reset = await post(`/admin/users/${String(target?.id)}/2fa/reset`, {}, admin);
    expect(reset.statusCode).toBe(204);

    const old = await app.inject({ url: '/api/v1/auth/session', headers: { cookie: tess.cookie } });
    expect(old.statusCode).toBe(401);
    const plain = await post('/auth/login', { login: 'tess', password: 'tess password' });
    expect(plain.json<{ user?: unknown }>().user).toBeDefined();
  });
});
