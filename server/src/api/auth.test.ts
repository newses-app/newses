import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpFetcher } from '../core/feeds/http.ts';
import { createDb } from '../db/client.ts';
import { createTestServices } from '../test/services.ts';
import { createTestDatabase, type TestDatabase } from '../test/database.ts';
import { buildApp } from './app.ts';

let database: TestDatabase;
let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  database = await createTestDatabase();
  const db = createDb(database.pool);
  const services = createTestServices(db, new HttpFetcher());
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
