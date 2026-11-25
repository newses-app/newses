import { MAX_EMAIL_LENGTH, type User } from '@newses/shared';
import { eq } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HttpFetcher } from '../core/feeds/http.ts';
import { createDb, type Db } from '../db/client.ts';
import { Ingester } from '../core/feeds/ingest.ts';
import { digestTests, feedSources, rateLimits, subscriptions, users } from '../db/schema.ts';
import { createTestDatabase, type TestDatabase } from '../test/database.ts';
import { RecordingMailer, RecordingRealtime } from '../test/fakes.ts';
import { createTestServices } from '../test/services.ts';
import { type ApiServices, buildApp } from './app.ts';

const PUBLIC_URL = 'https://reader.example';

let database: TestDatabase;
let db: Db;
let mailer: RecordingMailer;
let services: ApiServices;
let app: ReturnType<typeof buildApp>;
let pat = 0;
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
  method: 'GET' | 'PUT' | 'POST' | 'DELETE',
  url: string,
  auth: Auth | null,
  payload?: object,
  headers: Record<string, string> = {},
) =>
  app.inject({
    method,
    url: `/api/v1${url}`,
    headers: {
      ...(auth && { cookie: auth.cookie, 'x-csrf-token': auth.csrf }),
      ...headers,
    },
    ...(payload && { payload }),
  });

/** The token of the link in the last mail. */
function mailedToken(): string {
  const text = mailer.sent.at(-1)?.text ?? '';
  const match = new RegExp(`${PUBLIC_URL}/confirm-email#([\\w-]+)`).exec(text);
  if (!match?.[1]) throw new Error(`no link in ${text}`);
  return match[1];
}

const user = async (auth: Auth) =>
  (await call('GET', '/auth/session', auth)).json<{ user: User }>().user;

beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb(database.pool);
  mailer = new RecordingMailer();
  services = createTestServices(db, new HttpFetcher(), { mailer });
  pat = (await services.users.create('pat', 'pat password')).id;
  admin = (await services.users.create('ada', 'ada password', 'admin')).id;
  app = buildApp({
    logger: pino({ level: 'silent' }),
    healthChecks: {},
    services,
    publicUrl: PUBLIC_URL,
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await database.drop();
});

beforeEach(async () => {
  mailer.sent.length = 0;
  mailer.failure = null;
  await db.delete(rateLimits);
  await services.mail.account.remove(pat);
  await services.prefs.update(pat, { language: null });
});

describe('account email', () => {
  it('says the server can mail users', async () => {
    const info = await call('GET', '/server', null);
    expect(info.json()).toMatchObject({ mail: true });
  });

  it('mails a link that confirms the address, once', async () => {
    const auth = await sessionFor(pat);
    const requested = await call('PUT', '/account/email', auth, { email: ' pat@example.com ' });
    expect(requested.statusCode).toBe(200);
    expect(requested.json()).toMatchObject({ email: null, pendingEmail: 'pat@example.com' });
    const [mail] = mailer.sent;
    expect(mail).toMatchObject({ to: ['pat@example.com'], subject: 'Confirm your email address' });
    expect(mail?.text).toContain('for the account pat');
    expect(mail?.html).toContain(`href="${PUBLIC_URL}/confirm-email#`);

    // Any browser, signed in or not.
    const token = mailedToken();
    const confirmed = await call('POST', '/account/email/confirm', null, { token });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json()).toEqual({ email: 'pat@example.com' });
    expect(await user(auth)).toMatchObject({ email: 'pat@example.com', pendingEmail: null });

    const again = await call('POST', '/account/email/confirm', null, { token });
    expect(again.statusCode).toBe(400);
    expect(again.json()).toMatchObject({ reason: 'email_link_invalid' });
  });

  it('keeps the confirmed address until a new one is confirmed, with the newest link', async () => {
    const auth = await sessionFor(pat);
    await call('PUT', '/account/email', auth, { email: 'pat@example.com' });
    await call('POST', '/account/email/confirm', null, { token: mailedToken() });
    await call('PUT', '/account/email', auth, { email: 'old@example.com' });
    const replaced = mailedToken();
    await call('PUT', '/account/email', auth, { email: 'new@example.com' });
    expect(await user(auth)).toMatchObject({
      email: 'pat@example.com',
      pendingEmail: 'new@example.com',
    });

    const stale = await call('POST', '/account/email/confirm', null, { token: replaced });
    expect(stale.statusCode).toBe(400);
    await call('POST', '/account/email/confirm', null, { token: mailedToken() });
    expect(await user(auth)).toMatchObject({ email: 'new@example.com', pendingEmail: null });

    // Asking for the confirmed address again only drops a pending one, and mails nothing.
    await call('PUT', '/account/email', auth, { email: 'other@example.com' });
    const sent = mailer.sent.length;
    const same = await call('PUT', '/account/email', auth, { email: 'NEW@example.com' });
    expect(same.json()).toMatchObject({ email: 'new@example.com', pendingEmail: null });
    expect(mailer.sent).toHaveLength(sent);
  });

  it('refuses a link after a day', async () => {
    const auth = await sessionFor(pat);
    await call('PUT', '/account/email', auth, { email: 'pat@example.com' });
    await db
      .update(users)
      .set({ emailTokenExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(users.id, pat));
    const expired = await call('POST', '/account/email/confirm', null, { token: mailedToken() });
    expect(expired.statusCode).toBe(400);
    expect(await user(auth)).toMatchObject({ email: null, pendingEmail: 'pat@example.com' });
  });

  it("refuses a disabled account's link", async () => {
    const other = await services.users.create('dan', 'dan password');
    const auth = await sessionFor(other.id);
    await call('PUT', '/account/email', auth, { email: 'dan@example.com' });
    await services.users.update(other.id, { disabled: true });
    const refused = await call('POST', '/account/email/confirm', null, { token: mailedToken() });
    expect(refused.statusCode).toBe(400);
  });

  it('removes the address and any pending one', async () => {
    const auth = await sessionFor(pat);
    await call('PUT', '/account/email', auth, { email: 'pat@example.com' });
    await call('POST', '/account/email/confirm', null, { token: mailedToken() });
    await call('PUT', '/account/email', auth, { email: 'next@example.com' });
    const pending = mailedToken();
    expect((await call('DELETE', '/account/email', auth)).statusCode).toBe(204);
    expect(await user(auth)).toMatchObject({ email: null, pendingEmail: null });
    expect(
      (await call('POST', '/account/email/confirm', null, { token: pending })).statusCode,
    ).toBe(400);
  });

  it("mails in the user's language, else their device's", async () => {
    const auth = await sessionFor(pat);
    await call(
      'PUT',
      '/account/email',
      auth,
      { email: 'pat@example.com' },
      {
        'accept-language': 'es-MX,en;q=0.5',
      },
    );
    expect(mailer.sent.at(-1)?.subject).toBe('Confirma tu dirección de correo');
    await services.prefs.update(pat, { language: 'de' });
    await call(
      'PUT',
      '/account/email',
      auth,
      { email: 'pat@example.com' },
      {
        'accept-language': 'es',
      },
    );
    expect(mailer.sent.at(-1)?.subject).toBe('Bestätige deine E-Mail-Adresse');
    expect(mailer.sent.at(-1)?.html).toContain('<html lang="de" dir="ltr">');
  });

  it('limits how often links are mailed', async () => {
    const auth = await sessionFor(pat);
    for (const n of [1, 2, 3]) {
      const sent = await call('PUT', '/account/email', auth, {
        email: `pat${String(n)}@example.com`,
      });
      expect(sent.statusCode).toBe(200);
    }
    const throttled = await call('PUT', '/account/email', auth, { email: 'pat4@example.com' });
    expect(throttled.statusCode).toBe(429);
    expect(mailer.sent).toHaveLength(3);
  });

  it('refuses addresses that are not ones, or too long', async () => {
    const auth = await sessionFor(pat);
    const local = 'x'.repeat(MAX_EMAIL_LENGTH - '@example.com'.length + 1);
    for (const email of ['pat', 'pat@', `${local}@example.com`]) {
      expect((await call('PUT', '/account/email', auth, { email })).statusCode, email).toBe(400);
    }
    expect(
      (await call('POST', '/account/email/confirm', null, { token: 'x'.repeat(129) })).statusCode,
    ).toBe(400);
    expect(mailer.sent).toHaveLength(0);
  });

  it('says so when the mail fails, without the reason', async () => {
    const auth = await sessionFor(pat);
    mailer.failure = new Error('530 relay.internal refused');
    const failed = await call('PUT', '/account/email', auth, { email: 'pat@example.com' });
    expect(failed.statusCode).toBe(502);
    expect(failed.json()).toMatchObject({ error: 'mail_failed' });
    expect(failed.body).not.toContain('relay.internal');
  });

  it('needs a session to change the address', async () => {
    expect((await call('PUT', '/account/email', null, { email: 'a@example.com' })).statusCode).toBe(
      401,
    );
    expect((await call('DELETE', '/account/email', null)).statusCode).toBe(401);
  });

  it("shows admins each user's address", async () => {
    const auth = await sessionFor(pat);
    await call('PUT', '/account/email', auth, { email: 'pat@example.com' });
    await call('POST', '/account/email/confirm', null, { token: mailedToken() });
    const list = await call('GET', '/admin/users', await sessionFor(admin));
    expect(list.json<User[]>().find((row) => row.id === pat)).toMatchObject({
      email: 'pat@example.com',
    });
  });
});

describe('account email without mail', () => {
  let bare: ReturnType<typeof buildApp>;
  let bareServices: ApiServices;

  beforeAll(async () => {
    bareServices = createTestServices(db, new HttpFetcher());
    bare = buildApp({
      logger: pino({ level: 'silent' }),
      healthChecks: {},
      services: bareServices,
    });
    await bare.ready();
  });

  afterAll(() => bare.close());

  it('says the server cannot mail users, and refuses addresses', async () => {
    const info = await bare.inject({ method: 'GET', url: '/api/v1/server' });
    expect(info.json()).toMatchObject({ mail: false });
    const { token, session } = await bareServices.sessions.create(pat, 'cookie', null);
    const refused = await bare.inject({
      method: 'PUT',
      url: '/api/v1/account/email',
      headers: { cookie: `rss_session=${token}`, 'x-csrf-token': session.csrfToken ?? '' },
      payload: { email: 'pat@example.com' },
    });
    expect(refused.statusCode).toBe(503);
    expect(refused.json()).toMatchObject({ error: 'mail_unavailable' });
  });
});

describe('test digests', () => {
  it("queues a test digest of the user's unread articles from the last day", async () => {
    const auth = await sessionFor(pat);
    const asked = async () => {
      const response = await call('POST', '/account/digest/test', auth);
      return response.statusCode === 202 ? 'queued' : response.json<{ reason?: string }>().reason;
    };
    expect(await asked()).toBe('email_unconfirmed');
    await call('PUT', '/account/email', auth, { email: 'pat@example.com' });
    await call('POST', '/account/email/confirm', null, { token: mailedToken() });
    expect(await asked()).toBe('digest_test_empty');
    await db.delete(rateLimits);

    const [source] = await db
      .insert(feedSources)
      .values({ url: 'https://news.example/rss', title: 'News' })
      .returning();
    await db.insert(subscriptions).values({ userId: pat, feedSourceId: source?.id ?? 0 });
    await new Ingester(db, new RecordingRealtime(), {
      updateIntervalSeconds: 1800,
      purgeDays: 30,
      disableAfterFailures: 3,
    }).ingest(source?.id ?? 0, null, [
      {
        guid: 'g1',
        link: 'https://news.example/1',
        title: 'Vote',
        author: null,
        content: '<p>About the vote.</p>',
        publishedAt: new Date(),
        updatedAt: null,
        enclosures: [],
        categories: [],
        lang: null,
      },
    ]);
    expect(await asked()).toBe('queued');
    expect(await db.select().from(digestTests)).toMatchObject([{ userId: pat }]);
    expect(await services.mail.digest.sendTests()).toBe(1);
    expect(mailer.sent.at(-1)).toMatchObject({
      to: ['pat@example.com'],
      subject: 'Newses test digest: 1 unread article',
    });

    // Three a minute, refused ones included.
    await db.delete(rateLimits);
    expect(await asked()).toBe('queued');
    expect(await asked()).toBe('queued');
    expect(await asked()).toBe('queued');
    expect((await call('POST', '/account/digest/test', auth)).statusCode).toBe(429);
    await db.delete(feedSources);
  });
});
