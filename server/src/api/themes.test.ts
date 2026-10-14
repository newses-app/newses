import { MAX_THEME_NAME_LENGTH, type Theme } from '@newses/shared';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpFetcher } from '../core/feeds/http.ts';
import { createDb } from '../db/client.ts';
import { themes } from '../db/schema.ts';
import { createTestDatabase, type TestDatabase } from '../test/database.ts';
import { createTestServices } from '../test/services.ts';
import { type ApiServices, buildApp } from './app.ts';

let database: TestDatabase;
let app: ReturnType<typeof buildApp>;
let services: ApiServices;
let pat = 0;
let other = 0;
let admin = 0;

interface Auth {
  cookie: string;
  csrf: string;
}

async function sessionFor(userId: number): Promise<Auth> {
  const { token, session } = await services.sessions.create(userId, 'cookie', null);
  return { cookie: `rss_session=${token}`, csrf: session.csrfToken ?? '' };
}

const call = (
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  auth: Auth,
  payload?: object,
) =>
  app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { cookie: auth.cookie, 'x-csrf-token': auth.csrf },
    ...(payload && { payload }),
  });

beforeAll(async () => {
  database = await createTestDatabase();
  services = createTestServices(createDb(database.pool), new HttpFetcher());
  pat = (await services.users.create('pat', 'pat password')).id;
  other = (await services.users.create('other', 'other password')).id;
  admin = (await services.users.create('admin', 'admin password', 'admin')).id;
  app = buildApp({ logger: pino({ level: 'silent' }), healthChecks: {}, services });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await database.drop();
});

describe('themes API', () => {
  it('creates, shares, and deletes themes', async () => {
    const auth = await sessionFor(pat);
    const created = await call('POST', '/themes', auth, {
      name: '  Dusk ',
      base: 'original',
      tokens: { palette: { dark: { primary: '#ff8800' } }, effects: { texture: true } },
    });
    expect(created.statusCode).toBe(201);
    const theme = created.json<Theme>();
    expect(theme).toMatchObject({
      name: 'Dusk',
      shared: false,
      mine: true,
      owner: { id: pat, login: 'pat' },
    });

    const otherAuth = await sessionFor(other);
    expect((await call('GET', '/themes', otherAuth)).json()).toEqual([]);
    const shared = await call('PATCH', `/themes/${String(theme.id)}`, auth, { shared: true });
    expect(shared.json<Theme>().shared).toBe(true);
    expect((await call('GET', '/themes', otherAuth)).json<Theme[]>()).toEqual([
      expect.objectContaining({ id: theme.id, mine: false, owner: { id: pat, login: 'pat' } }),
    ]);
    expect((await call('DELETE', `/themes/${String(theme.id)}`, otherAuth)).statusCode).toBe(404);

    expect((await call('DELETE', `/themes/${String(theme.id)}`, auth)).statusCode).toBe(204);
    expect((await call('GET', '/themes', auth)).json()).toEqual([]);
  });

  it('lets only admins unpublish a theme they do not own', async () => {
    const auth = await sessionFor(pat);
    const theme = (
      await call('POST', '/themes', auth, { name: 'Loud', base: 'original', tokens: {} })
    ).json<Theme>();
    await call('PATCH', `/themes/${String(theme.id)}`, auth, { shared: true });
    const url = `/admin/themes/${String(theme.id)}/unpublish`;

    expect((await call('POST', url, await sessionFor(other))).statusCode).toBe(403);
    const adminAuth = await sessionFor(admin);
    expect((await call('GET', '/themes', adminAuth)).json<Theme[]>()).toHaveLength(1);
    expect((await call('POST', url, adminAuth)).statusCode).toBe(204);
    expect((await call('GET', '/themes', adminAuth)).json()).toEqual([]);
    expect((await call('GET', '/themes', auth)).json<Theme[]>()[0]?.shared).toBe(false);
    expect((await call('POST', '/admin/themes/999999/unpublish', adminAuth)).statusCode).toBe(404);
    await call('DELETE', `/themes/${String(theme.id)}`, auth);
  });

  it('validates names, bases, and tokens', async () => {
    const auth = await sessionFor(pat);
    for (const body of [
      { name: '', base: 'original', tokens: {} },
      { name: 'x'.repeat(MAX_THEME_NAME_LENGTH + 1), base: 'original', tokens: {} },
      { name: 'Sepia', base: 'sepia', tokens: {} },
      { name: 'Loud', base: 'original', tokens: { palette: { light: { primary: 'red' } } } },
      { name: 'Css', base: 'original', tokens: { css: 'body{}' } },
    ])
      expect((await call('POST', '/themes', auth, body)).statusCode).toBe(400);
    const theme = (
      await call('POST', '/themes', auth, { name: 'Plain', base: 'original', tokens: {} })
    ).json<Theme>();
    expect(
      (await call('PATCH', `/themes/${String(theme.id)}`, auth, { owner: other })).statusCode,
    ).toBe(400);
  });

  it('serves stored tokens a later version no longer accepts without them', async () => {
    const auth = await sessionFor(pat);
    await createDb(database.pool)
      .insert(themes)
      .values({ ownerId: pat, name: 'Old', base: 'retired', tokens: { glow: true } });
    const listed = (await call('GET', '/themes', auth)).json<Theme[]>();
    expect(listed.find((theme) => theme.name === 'Old')).toMatchObject({
      base: 'original',
      tokens: {},
    });
  });
});
