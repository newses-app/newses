import { eq } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../db/client.ts';
import { digestState } from '../db/schema.ts';
import { createTestDatabase, type TestDatabase } from '../test/database.ts';
import { FakeFetcher } from '../test/fake-fetcher.ts';
import { RecordingMailer } from '../test/fakes.ts';
import { createTestServices } from '../test/services.ts';
import { type ApiServices, buildApp } from './app.ts';

let database: TestDatabase;
let db: Db;
let services: ApiServices;
let app: ReturnType<typeof buildApp>;
let pat = 0;

const stateOf = async () =>
  (await db.select().from(digestState).where(eq(digestState.userId, pat)))[0];

async function patchPrefs(payload: object) {
  const { token, session } = await services.sessions.create(pat, 'cookie', null);
  return app.inject({
    method: 'PATCH',
    url: '/api/v1/prefs',
    headers: { cookie: `rss_session=${token}`, 'x-csrf-token': session.csrfToken ?? '' },
    payload,
  });
}

beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb(database.pool);
  services = createTestServices(db, new FakeFetcher(), { mailer: new RecordingMailer() });
  pat = (await services.users.create('pat', 'pat password')).id;
  app = buildApp({ logger: pino({ level: 'silent' }), healthChecks: {}, services });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await database.drop();
});

beforeEach(async () => {
  await services.prefs.update(pat, { digestFrequency: 'off', language: null, timeZone: null });
  await db.delete(digestState);
});

describe('digest preferences', () => {
  it('says the server sends digests', async () => {
    const info = await app.inject({ method: 'GET', url: '/api/v1/server' });
    expect(info.json()).toMatchObject({ mail: true, digest: true });
  });

  it('schedules the next digest when its preferences change', async () => {
    const changed = await patchPrefs({
      digestFrequency: 'weekly',
      digestWeekday: 5,
      digestHour: 18,
      timeZone: 'Asia/Tokyo',
    });
    expect(changed.statusCode).toBe(200);
    const due = (await stateOf())?.nextDueAt;
    expect(due?.getUTCDay()).toBe(5);
    expect(due?.getUTCHours()).toBe(9);
    await patchPrefs({ digestFrequency: 'off' });
    expect(await stateOf()).toBeUndefined();
  });

  it('refuses a time zone that is not one', async () => {
    expect((await patchPrefs({ timeZone: 'Mars/Olympus' })).statusCode).toBe(400);
  });
});

describe('unsubscribe links', () => {
  const url = () => `/public/unsubscribe/${services.mail.digest.unsubscribeToken(pat)}`;

  beforeEach(async () => {
    await patchPrefs({ digestFrequency: 'daily' });
  });

  it('ask before turning digests off, in the viewer’s language', async () => {
    const page = await app.inject({
      method: 'GET',
      url: url(),
      headers: { 'accept-language': 'de' },
    });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-security-policy']).toContain("form-action 'self'");
    expect(page.body).toContain('<form method="post"><button type="submit">Übersichten beenden');
    expect((await services.prefs.get(pat)).digestFrequency).toBe('daily');
  });

  it('turn digests off with one click from the mail client', async () => {
    const done = await app.inject({
      method: 'POST',
      url: url(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'List-Unsubscribe=One-Click',
    });
    expect(done.statusCode).toBe(200);
    expect(done.body).toContain('Digests stopped');
    expect((await services.prefs.get(pat)).digestFrequency).toBe('off');
    expect(await stateOf()).toBeUndefined();
  });

  it("turn digests off from the page's button", async () => {
    const done = await app.inject({
      method: 'POST',
      url: url(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: '',
    });
    expect(done.statusCode).toBe(200);
    expect((await services.prefs.get(pat)).digestFrequency).toBe('off');
  });

  it('are refused when not signed by this server', async () => {
    const forged = `/public/unsubscribe/${String(pat)}.forged`;
    expect((await app.inject({ method: 'GET', url: forged })).statusCode).toBe(404);
    const refused = await app.inject({ method: 'POST', url: forged });
    expect(refused.statusCode).toBe(404);
    expect(refused.body).toMatch(/This unsubscribe link isn(&#39;|&#x27;)t valid\./);
    expect((await services.prefs.get(pat)).digestFrequency).toBe('daily');
  });
});
