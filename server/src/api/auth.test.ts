import { API_VERSION } from '@newses/shared';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpFetcher } from '../core/feeds/http.ts';
import { createDb } from '../db/client.ts';
import { createTestServices } from '../test/services.ts';
import { createTestDatabase, type TestDatabase } from '../test/database.ts';
import { buildApp } from './app.ts';

let database: TestDatabase;
let app: ReturnType<typeof buildApp>;
let services: ReturnType<typeof createTestServices>;

beforeAll(async () => {
  database = await createTestDatabase();
  const db = createDb(database.pool);
  services = createTestServices(db, new HttpFetcher());
  await services.users.create('admin', 'admin password', 'admin');
  await services.users.create('alice', 'alice password');
  app = buildApp({ logger: pino({ level: 'silent' }), healthChecks: {}, services });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await database.drop();
});

interface Login {
  cookie: string;
  csrf: string;
}

async function loginWithCookie(login: string, password: string): Promise<Login> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { login, password },
    remoteAddress: `10.0.0.${String(login.length)}`,
  });
  expect(res.statusCode).toBe(200);
  const cookie = res.cookies.find((c) => c.name === 'rss_session');
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.sameSite).toBe('Lax');
  return {
    cookie: `rss_session=${cookie?.value ?? ''}`,
    csrf: res.json<{ csrfToken: string }>().csrfToken,
  };
}

describe('auth API', () => {
  it('rejects bad credentials without revealing which part was wrong', async () => {
    for (const payload of [
      { login: 'alice', password: 'wrong' },
      { login: 'nobody', password: 'wrong' },
    ]) {
      const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({
        error: 'invalid_credentials',
        message: 'Invalid login or password',
      });
    }
  });

  it('refuses form-encoded logins', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'login=alice&password=alice+password',
    });
    expect(res.statusCode).toBe(415);
  });

  it('requires authentication', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/session' })).statusCode).toBe(401);
  });

  it('runs a cookie session with CSRF protection', async () => {
    const { cookie, csrf } = await loginWithCookie('alice', 'alice password');
    const session = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      headers: { cookie },
    });
    expect(session.json()).toMatchObject({
      user: { login: 'alice', role: 'user' },
      csrfToken: csrf,
    });

    const payload = { currentPassword: 'alice password', newPassword: 'alice password 2' };
    const noCsrf = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      headers: { cookie },
      payload,
    });
    expect(noCsrf.statusCode).toBe(403);
    const withCsrf = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      headers: { cookie, 'x-csrf-token': csrf },
      payload,
    });
    expect(withCsrf.statusCode).toBe(204);

    const logout = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie, 'x-csrf-token': csrf },
    });
    expect(logout.statusCode).toBe(204);
    const after = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      headers: { cookie },
    });
    expect(after.statusCode).toBe(401);
  });

  it('issues bearer tokens that need no CSRF token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { login: 'admin', password: 'admin password', tokenType: 'bearer' },
    });
    const { token } = res.json<{ token: string }>();
    expect(res.cookies).toHaveLength(0);
    const authorization = `Bearer ${token}`;

    const sessions = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/sessions',
      headers: { authorization },
    });
    const current = sessions
      .json<{ id: number; kind: string; current: boolean }[]>()
      .find((s) => s.current);
    expect(current?.kind).toBe('bearer');

    const revoke = await app.inject({
      method: 'DELETE',
      url: `/api/v1/auth/sessions/${String(current?.id)}`,
      headers: { authorization },
    });
    expect(revoke.statusCode).toBe(204);
    const after = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      headers: { authorization },
    });
    expect(after.statusCode).toBe(401);
  });

  it('throttles repeated failures with Retry-After', async () => {
    const attempt = () =>
      app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { login: 'victim', password: 'guess' },
        remoteAddress: '192.0.2.1',
      });
    for (let i = 0; i < 5; i++) expect((await attempt()).statusCode).toBe(401);
    const throttled = await attempt();
    expect(throttled.statusCode).toBe(429);
    expect(Number(throttled.headers['retry-after'])).toBeGreaterThan(0);
  });
});

describe('feed icon path', () => {
  it('is given at login and with the session, and serves icons without a session', async () => {
    const iris = await services.users.create('iris', 'iris password');
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { login: 'iris', password: 'iris password', tokenType: 'bearer' },
    });
    expect(login.statusCode, login.body).toBe(200);
    const { token, iconsPath } = login.json<{ token: string; iconsPath: string }>();
    expect(iconsPath).toMatch(/^\/feed-icons\/\d+\.[\w-]+$/);
    const session = await app.inject({
      url: '/api/v1/auth/session',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(session.json<{ iconsPath: string }>().iconsPath).toBe(iconsPath);
    // No such subscription, but the signed path is accepted without a session.
    const icon = await app.inject({ url: `${iconsPath}/999999.ico` });
    expect(icon.statusCode).toBe(404);
    expect(icon.body).toBe('Not found\n');
    await services.users.delete(iris.id);
  });
});

describe('server info', () => {
  it('names the product and versions without a session', async () => {
    const res = await app.inject({ url: '/api/v1/server' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      product: 'newses',
      version: 'dev',
      apiVersion: API_VERSION,
    });
  });

  it('names the instance when the operator set a name', async () => {
    const named = buildApp({
      logger: pino({ level: 'silent' }),
      healthChecks: {},
      services,
      instanceName: 'Home',
    });
    const res = await named.inject({ url: '/api/v1/server' });
    expect(res.json()).toMatchObject({ product: 'newses', name: 'Home' });
    await named.close();
  });

  it('is documented as needing no session', async () => {
    const spec = (await app.inject({ url: '/api/v1/openapi.json' })).json<{
      paths: Record<string, { get?: { security?: unknown[] } }>;
    }>();
    expect(spec.paths['/api/v1/server']?.get?.security).toEqual([]);
  });
});

describe('CORS for apps', () => {
  const preflight = (origin: string) =>
    app.inject({
      method: 'OPTIONS',
      url: '/api/v1/subscriptions',
      headers: {
        origin,
        'access-control-request-method': 'PATCH',
        'access-control-request-headers': 'authorization, content-type',
      },
    });

  it('answers preflights from the app origins', async () => {
    for (const origin of ['app://newses', 'https://localhost']) {
      const res = await preflight(origin);
      expect(res.statusCode).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe(origin);
      expect(res.headers['access-control-allow-methods']).toContain('PATCH');
      expect(res.headers['access-control-allow-headers']).toBe(
        'authorization, content-type, x-rss-client',
      );
      expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    }
  });

  it('refuses other origins', async () => {
    const res = await preflight('https://evil.example');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    const get = await app.inject({
      url: '/api/v1/server',
      headers: { origin: 'https://evil.example' },
    });
    expect(get.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('lets apps read responses, errors, and Retry-After', async () => {
    const headers = { origin: 'https://localhost' };
    const ok = await app.inject({ url: '/api/v1/server', headers });
    expect(ok.headers['access-control-allow-origin']).toBe('https://localhost');
    expect(ok.headers.vary).toContain('Origin');
    const denied = await app.inject({ url: '/api/v1/subscriptions', headers });
    expect(denied.statusCode).toBe(401);
    expect(denied.headers['access-control-allow-origin']).toBe('https://localhost');
    expect(denied.headers['access-control-expose-headers']).toBe('retry-after');
  });

  it('applies to the native API only', async () => {
    const res = await app.inject({ url: '/healthz', headers: { origin: 'app://newses' } });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('session cookie', () => {
  it('uses a __Host- Secure cookie and HSTS over HTTPS', async () => {
    const https = buildApp({
      logger: pino({ level: 'silent' }),
      healthChecks: {},
      services,
      trustProxy: 1,
    });
    const headers = { 'x-forwarded-proto': 'https' };
    const res = await https.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers,
      payload: { login: 'admin', password: 'admin password' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['strict-transport-security']).toBe('max-age=31536000');
    const cookie = res.cookies.find((c) => c.name === '__Host-rss_session');
    expect(cookie).toMatchObject({ secure: true, httpOnly: true, path: '/' });
    const session = await https.inject({
      url: '/api/v1/auth/session',
      headers: { ...headers, cookie: `__Host-rss_session=${cookie?.value ?? ''}` },
    });
    expect(session.statusCode).toBe(200);
    // The unprefixed name is not read over HTTPS.
    const plain = await https.inject({
      url: '/api/v1/auth/session',
      headers: { ...headers, cookie: `rss_session=${cookie?.value ?? ''}` },
    });
    expect(plain.statusCode).toBe(401);
    expect((await app.inject({ url: '/healthz' })).headers['strict-transport-security']).toBe(
      undefined,
    );
    await https.close();
  });

  it('ends the previous session when the client logs in again', async () => {
    const first = await loginWithCookie('admin', 'admin password');
    const again = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { cookie: first.cookie, 'x-csrf-token': first.csrf },
      payload: { login: 'admin', password: 'admin password' },
    });
    expect(again.statusCode).toBe(200);
    const old = await app.inject({
      url: '/api/v1/auth/session',
      headers: { cookie: first.cookie },
    });
    expect(old.statusCode).toBe(401);
  });

  it('keeps the other sessions of a device whose apps sign in several users', async () => {
    const bearerLogin = async (login: string, password: string) =>
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: { login, password, tokenType: 'bearer' },
        })
      ).json<{ token: string }>().token;
    // The password Alice changed to above.
    const alice = await bearerLogin('alice', 'alice password 2');
    await bearerLogin('admin', 'admin password');
    const session = await app.inject({
      url: '/api/v1/auth/session',
      headers: { authorization: `Bearer ${alice}` },
    });
    expect(session.json<{ user: { login: string } }>().user.login).toBe('alice');
  });
});

describe('generated initial password', () => {
  it('allows only changing the password until it is changed', async () => {
    await services.users.create('fresh', 'generated password', 'admin', true);
    const fresh = await loginWithCookie('fresh', 'generated password');
    const auth = { cookie: fresh.cookie, 'x-csrf-token': fresh.csrf };
    const session = await app.inject({ url: '/api/v1/auth/session', headers: auth });
    expect(session.json<{ user: { passwordChangeRequired: boolean } }>().user).toMatchObject({
      passwordChangeRequired: true,
    });
    const blocked = await app.inject({ url: '/api/v1/subscriptions', headers: auth });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json()).toMatchObject({ error: 'password_change_required' });

    const changed = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      headers: auth,
      payload: { currentPassword: 'generated password', newPassword: 'my own password' },
    });
    expect(changed.statusCode).toBe(204);
    expect((await app.inject({ url: '/api/v1/subscriptions', headers: auth })).statusCode).toBe(
      200,
    );
    const user = await services.users.findByLogin('fresh');
    await services.users.delete(user?.id ?? 0);
  });
});

describe('password change', () => {
  it('throttles wrong current passwords on the account', async () => {
    const admin = await loginWithCookie('admin', 'admin password');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/users',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf },
      payload: { login: 'dave', password: 'dave password' },
    });
    expect(res.statusCode).toBe(201);
    const { cookie, csrf } = await loginWithCookie('dave', 'dave password');
    const attempt = () =>
      app.inject({
        method: 'POST',
        url: '/api/v1/auth/password',
        headers: { cookie, 'x-csrf-token': csrf },
        payload: { currentPassword: 'wrong', newPassword: 'dave password 2' },
      });
    for (let i = 0; i < 5; i++) expect((await attempt()).statusCode).toBe(401);
    expect((await attempt()).statusCode).toBe(429);

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/users/${String(res.json<{ id: number }>().id)}`,
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf },
    });
    expect(deleted.statusCode).toBe(204);
  });

  it('rejects common passwords', async () => {
    const { cookie, csrf } = await loginWithCookie('admin', 'admin password');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/users',
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { login: 'erin', password: 'password1' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('admin users API', () => {
  it('forbids non-admins', async () => {
    const { cookie } = await loginWithCookie('alice', 'alice password 2');
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/admin/users', headers: { cookie } }))
        .statusCode,
    ).toBe(403);
  });

  it('creates, updates, resets, and deletes users', async () => {
    const { cookie, csrf } = await loginWithCookie('admin', 'admin password');
    const headers = { cookie, 'x-csrf-token': csrf };

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/users',
      headers,
      payload: { login: 'carol', password: 'carol password' },
    });
    expect(created.statusCode).toBe(201);
    const carol = created.json<{ id: number; role: string }>();
    expect(carol.role).toBe('user');

    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/users',
      headers,
      payload: { login: 'CAROL', password: 'carol password' },
    });
    expect(duplicate.statusCode).toBe(409);

    const invalid = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/users',
      headers,
      payload: { login: 'dave', password: 'short' },
    });
    expect(invalid.statusCode).toBe(400);

    const disabled = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/users/${String(carol.id)}`,
      headers,
      payload: { disabled: true },
    });
    expect(disabled.json()).toMatchObject({ disabled: true });

    const reset = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/users/${String(carol.id)}/password`,
      headers,
      payload: { password: 'new carol password' },
    });
    expect(reset.statusCode).toBe(204);

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/users/${String(carol.id)}`,
      headers,
    });
    expect(removed.statusCode).toBe(204);
    const list = await app.inject({ method: 'GET', url: '/api/v1/admin/users', headers });
    expect(list.json<{ login: string }[]>().map((u) => u.login)).toEqual(['admin', 'alice']);
  });

  it('refuses to demote the last admin', async () => {
    const { cookie, csrf } = await loginWithCookie('admin', 'admin password');
    const users = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/users',
      headers: { cookie },
    });
    const admin = users.json<{ id: number; login: string }[]>().find((u) => u.login === 'admin');
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/users/${String(admin?.id)}`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { role: 'user' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'last_admin' });
  });
});
