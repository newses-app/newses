import { eq } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HttpFetcher } from '../core/feeds/http.ts';
import { createDb, type Db } from '../db/client.ts';
import { sessions, users } from '../db/schema.ts';
import { reader, readerLogin, ttrss, ttrssLogin } from '../test/compat.ts';
import { createTestDatabase, type TestDatabase } from '../test/database.ts';
import { createTestServices } from '../test/services.ts';
import { type ApiServices, buildApp } from './app.ts';

let database: TestDatabase;
let db: Db;
let app: ReturnType<typeof buildApp>;
let services: ApiServices;
let pat = 0;
let appPassword = '';
let appPasswordId = 0;
const logs: Record<string, unknown>[] = [];

beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb(database.pool);
  services = createTestServices(db, new HttpFetcher());
  pat = (await services.users.create('pat', 'pat password')).id;
  const logger = pino(
    { level: 'info' },
    { write: (line: string) => logs.push(JSON.parse(line) as Record<string, unknown>) },
  );
  app = buildApp({ logger, healthChecks: {}, services, compatTrace: true });
  await app.ready();
});

beforeEach(async () => {
  logs.length = 0;
  await services.appPasswords.revokeAll(pat);
  await db.update(users).set({ passwordChangeRequired: false }).where(eq(users.id, pat));
  const created = await services.appPasswords.create(pat, 'Phone');
  appPassword = created.password;
  appPasswordId = created.appPassword.id;
});

afterAll(async () => {
  await app.close();
  await database.drop();
});

const logged = (message: string) => logs.filter((line) => line.msg === message);

describe('TTRSS-compatible API', () => {
  it('logs in with an app password only, answering in the TTRSS envelope', async () => {
    const login = await ttrss(app, { op: 'login', user: 'pat', password: appPassword, seq: 7 });
    expect(login).toMatchObject({
      seq: 7,
      status: 0,
      content: { session_id: expect.any(String) as string, api_level: 20 },
    });
    expect(await ttrss(app, { op: 'login', user: 'pat', password: 'pat password' })).toEqual({
      seq: 0,
      status: 1,
      content: { error: 'LOGIN_ERROR' },
    });
    expect((await ttrss(app, { op: 'login', user: 'pat' })).content).toEqual({
      error: 'LOGIN_ERROR',
    });
    const [session] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.appPasswordId, appPasswordId));
    expect(session).toMatchObject({ kind: 'api', userId: pat, userAgent: 'contract-test' });
  });

  it('accepts the paths and body encodings clients use', async () => {
    const sid = await ttrssLogin(app, 'pat', appPassword);
    expect((await ttrss(app, { op: 'getApiLevel', sid }, '/api/index.php')).content).toEqual({
      level: 20,
    });
    for (const [type, payload] of [
      ['text/plain', JSON.stringify({ op: 'getVersion', sid })],
      ['application/x-www-form-urlencoded', `op=getVersion&sid=${sid}`],
    ] as const) {
      const response = await app.inject({
        method: 'POST',
        url: '/api',
        headers: { 'content-type': type },
        payload,
      });
      expect(response.json()).toMatchObject({
        status: 0,
        content: { version: expect.any(String) as string },
      });
    }
  });

  it('requires a live session, and logs out', async () => {
    expect((await ttrss(app, { op: 'getApiLevel' })).content).toEqual({ error: 'NOT_LOGGED_IN' });
    const sid = await ttrssLogin(app, 'pat', appPassword);
    expect((await ttrss(app, { op: 'isLoggedIn', sid })).content).toEqual({ status: true });
    expect((await ttrss(app, { op: 'logout', sid })).content).toEqual({ status: 'OK' });
    expect((await ttrss(app, { op: 'isLoggedIn', sid })).content).toEqual({ status: false });
    expect((await ttrss(app, { op: 'getVersion', sid })).content).toEqual({
      error: 'NOT_LOGGED_IN',
    });
  });

  it('ends sessions when their app password is revoked', async () => {
    const sid = await ttrssLogin(app, 'pat', appPassword);
    await services.appPasswords.revoke(pat, appPasswordId);
    expect((await ttrss(app, { op: 'getApiLevel', sid })).content).toEqual({
      error: 'NOT_LOGGED_IN',
    });
  });

  it('keeps the ten newest sessions of an app password', async () => {
    const sids = [];
    for (let i = 0; i < 11; i++) sids.push(await ttrssLogin(app, 'pat', appPassword));
    const rows = await db.select().from(sessions).where(eq(sessions.appPasswordId, appPasswordId));
    expect(rows).toHaveLength(10);
    expect((await ttrss(app, { op: 'isLoggedIn', sid: sids[0] })).content).toEqual({
      status: false,
    });
    expect((await ttrss(app, { op: 'isLoggedIn', sid: sids[10] })).content).toEqual({
      status: true,
    });
  });

  it('refuses web and app sessions, and is refused by the native API', async () => {
    const { token } = await services.sessions.create(pat, 'bearer', null);
    expect((await ttrss(app, { op: 'getApiLevel', sid: token })).content).toEqual({
      error: 'NOT_LOGGED_IN',
    });
    const sid = await ttrssLogin(app, 'pat', appPassword);
    const native = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      headers: { authorization: `Bearer ${sid}` },
    });
    expect(native.statusCode).toBe(401);
  });

  it('answers API_DISABLED while the password must be changed', async () => {
    const sid = await ttrssLogin(app, 'pat', appPassword);
    await db.update(users).set({ passwordChangeRequired: true }).where(eq(users.id, pat));
    expect((await ttrss(app, { op: 'getApiLevel', sid })).content).toEqual({
      error: 'API_DISABLED',
    });
    expect((await ttrss(app, { op: 'login', user: 'pat', password: appPassword })).content).toEqual(
      { error: 'API_DISABLED' },
    );
  });

  it('reports unknown ops and malformed bodies, logging what clients asked for', async () => {
    const sid = await ttrssLogin(app, 'pat', appPassword);
    expect((await ttrss(app, { op: 'getMagic', sid })).content).toEqual({
      error: 'UNKNOWN_METHOD',
      method: 'getMagic',
    });
    expect(logged('Unsupported compatibility call')).toMatchObject([
      { compat: 'ttrss', unsupported: 'getMagic', userAgent: 'contract-test' },
    ]);
    const malformed = await app.inject({ method: 'POST', url: '/api/', payload: '{"op":' });
    expect(malformed.json()).toEqual({ seq: 0, status: 1, content: { error: 'INCORRECT_USAGE' } });
  });

  it('traces calls with credentials redacted', async () => {
    await ttrss(app, { op: 'login', user: 'pat', password: appPassword });
    const [trace] = logged('Compatibility call');
    expect(trace).toMatchObject({
      compat: 'ttrss',
      call: 'login',
      params: { op: 'login', user: 'pat', password: '[redacted]' },
    });
    expect(JSON.stringify(logs)).not.toContain(appPassword);
  });
});

describe('Google Reader API', () => {
  it('logs in with ClientLogin at the root and under /api/greader.php', async () => {
    const response = await reader(app, 'POST', '/accounts/ClientLogin', {
      form: { Email: 'pat', Passwd: appPassword },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toMatch(/^SID=(\S+)\nLSID=null\nAuth=\1\n$/);
    const token = await readerLogin(app, 'pat', appPassword, '/api/greader.php');
    const t = await reader(app, 'GET', '/reader/api/0/token', {
      token,
      prefix: '/api/greader.php',
    });
    expect(t.statusCode).toBe(200);
    expect(t.body).toMatch(/^\S{20,}$/);
    expect(t.headers['cache-control']).toBe('no-store');
  });

  it('refuses account passwords, other sessions, and GET logins', async () => {
    const refused = await reader(app, 'POST', '/accounts/ClientLogin', {
      form: { Email: 'pat', Passwd: 'pat password' },
    });
    expect({ status: refused.statusCode, body: refused.body }).toEqual({
      status: 401,
      body: 'Error=BadAuthentication\n',
    });
    const get = await reader(app, 'GET', '/accounts/ClientLogin', {
      query: { Email: 'pat', Passwd: appPassword },
    });
    expect(get.statusCode).toBe(404);
    expect((await reader(app, 'GET', '/reader/api/0/token')).statusCode).toBe(401);
    const { token } = await services.sessions.create(pat, 'bearer', null);
    expect((await reader(app, 'GET', '/reader/api/0/token', { token })).statusCode).toBe(401);
  });

  it('answers 403 while the password must be changed', async () => {
    const token = await readerLogin(app, 'pat', appPassword);
    await db.update(users).set({ passwordChangeRequired: true }).where(eq(users.id, pat));
    expect((await reader(app, 'GET', '/reader/api/0/token', { token })).statusCode).toBe(403);
    const login = await reader(app, 'POST', '/accounts/ClientLogin', {
      form: { Email: 'pat', Passwd: appPassword },
    });
    expect(login.statusCode).toBe(403);
  });

  it('logs unsupported endpoints and traces form parameters', async () => {
    const token = await readerLogin(app, 'pat', appPassword);
    const missing = await reader(app, 'POST', '/reader/api/0/edit-tag', {
      token,
      form: { i: ['1', '2'], a: 'user/-/state/com.google/read', T: 'x' },
    });
    expect(missing.statusCode).toBe(404);
    expect(logged('Unsupported compatibility call')).toMatchObject([
      { compat: 'greader', unsupported: 'POST /reader/api/0/edit-tag' },
    ]);
    expect(logged('Compatibility call').at(-1)).toMatchObject({
      params: { i: ['1', '2'], a: 'user/-/state/com.google/read', T: '[redacted]' },
    });
  });
});
