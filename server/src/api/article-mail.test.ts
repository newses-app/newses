import { MAX_EMAIL_NOTE_LENGTH } from '@newses/shared';
import { eq } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../db/client.ts';
import { entries, rateLimits, userEntries, users } from '../db/schema.ts';
import { createTestDatabase, type TestDatabase } from '../test/database.ts';
import { RecordingMailer } from '../test/fakes.ts';
import { FakeFetcher, rss } from '../test/fake-fetcher.ts';
import { createTestServices } from '../test/services.ts';
import { type ApiServices, buildApp } from './app.ts';

const PUBLIC_URL = 'https://reader.example';
const FEED = 'https://news.example/rss';

let database: TestDatabase;
let db: Db;
let mailer: RecordingMailer;
let services: ApiServices;
let app: ReturnType<typeof buildApp>;
let pat = 0;
let sam = 0;
let entryId = 0;
let noLinkId = 0;

interface Auth {
  cookie: string;
  csrf: string;
}

async function sessionFor(userId: number): Promise<Auth> {
  const { token, session } = await services.sessions.create(userId, 'cookie', null);
  return { cookie: `rss_session=${token}`, csrf: session.csrfToken ?? '' };
}

const send = async (id: number, payload: object, userId = pat) => {
  const auth = await sessionFor(userId);
  return app.inject({
    method: 'POST',
    url: `/api/v1/entries/${String(id)}/email`,
    headers: { cookie: auth.cookie, 'x-csrf-token': auth.csrf },
    payload,
  });
};

beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb(database.pool);
  mailer = new RecordingMailer();
  const fetcher = new FakeFetcher().set(FEED, {
    body: rss('News & Views', 'https://news.example/', [
      {
        guid: 'a',
        title: 'Big story',
        link: 'https://news.example/a',
        description: '<p>The story, with a picture.</p><img src="https://cdn.example/a.png">',
      },
      { guid: 'b', title: 'No link', description: '<p>Only here.</p>' },
    ]),
  });
  services = createTestServices(db, fetcher, { mailer });
  pat = (await services.users.create('pat', 'pat password')).id;
  sam = (await services.users.create('sam', 'sam password')).id;
  await services.feeds.subscriptions.subscribe(pat, FEED);
  const rows = await db
    .select({ id: userEntries.id, title: entries.title })
    .from(userEntries)
    .innerJoin(entries, eq(entries.id, userEntries.entryId))
    .where(eq(userEntries.userId, pat));
  const idOf = (title: string) => rows.find((row) => row.title === title)?.id ?? 0;
  entryId = idOf('Big story');
  noLinkId = idOf('No link');
  // A guid counts as a permalink, so the article loses its link here.
  await db.update(entries).set({ link: null }).where(eq(entries.title, 'No link'));
  await db.update(users).set({ email: 'pat@example.com' }).where(eq(users.id, pat));
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
  await db.delete(rateLimits);
  await services.prefs.update(pat, { proxyImages: false, language: null });
});

describe('emailing an article', () => {
  it('mails the article from the instance, replies going to the sender', async () => {
    const sent = await send(entryId, {
      to: ['ann@example.com', ' ANN@example.com', 'bo@example.com'],
      note: 'Look <here>\n\nSecond paragraph',
    });
    expect(sent.statusCode).toBe(204);
    const [mail] = mailer.sent;
    expect(mail).toMatchObject({
      to: ['ann@example.com', 'bo@example.com'],
      replyTo: 'pat@example.com',
      subject: 'Big story',
    });
    expect(mail?.html).toContain('pat sent you this article from Newses.');
    expect(mail?.html).toContain('<p>Look &lt;here&gt;</p><p>Second paragraph</p>');
    expect(mail?.html).toContain('<bdi>News &amp; Views</bdi>');
    expect(mail?.html).toContain('<p>The story, with a picture.</p>');
    expect(mail?.html).toContain('src="https://cdn.example/a.png"');
    expect(mail?.text).toContain('The story, with a picture.');
    expect(mail?.text).toContain('Read the original: https://news.example/a');
    expect(mail?.text).toContain('Reply to this email to answer pat.');
  });

  it("points images at the proxy when the sender's preference says so", async () => {
    await services.prefs.update(pat, { proxyImages: true });
    await send(entryId, { to: ['ann@example.com'] });
    expect(mailer.sent[0]?.html).toContain(`src="${PUBLIC_URL}/api/v1/images/`);
    expect(mailer.sent[0]?.html).not.toContain('src="https://cdn.example/a.png"');
  });

  it('sends a link with the excerpt instead of the article, in the language of the sender', async () => {
    await services.prefs.update(pat, { language: 'de' });
    await send(entryId, { to: ['ann@example.com'], include: 'link' });
    const [mail] = mailer.sent;
    expect(mail?.html).not.toContain('<img');
    expect(mail?.html).toContain('The story, with a picture.');
    expect(mail?.html).toContain('pat hat dir diesen Artikel aus Newses gesendet.');
    expect(mail?.html).toContain('<html lang="de" dir="ltr">');
  });

  it('refuses a link to an article without a web address', async () => {
    const refused = await send(noLinkId, { to: ['ann@example.com'], include: 'link' });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ reason: 'article_no_address' });
    expect((await send(noLinkId, { to: ['ann@example.com'] })).statusCode).toBe(204);
  });

  it('needs a confirmed address for replies', async () => {
    await services.feeds.subscriptions.subscribe(sam, FEED);
    const [own] = await db
      .select({ id: userEntries.id })
      .from(userEntries)
      .where(eq(userEntries.userId, sam));
    const refused = await send(own?.id ?? 0, { to: ['ann@example.com'] }, sam);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ reason: 'email_unconfirmed' });
    expect(mailer.sent).toHaveLength(0);
  });

  it("finds no other user's articles", async () => {
    await db.update(users).set({ email: 'sam@example.com' }).where(eq(users.id, sam));
    expect((await send(entryId, { to: ['ann@example.com'] }, sam)).statusCode).toBe(404);
    await db.update(users).set({ email: null }).where(eq(users.id, sam));
  });

  it('limits recipients, notes, and how often articles are mailed', async () => {
    const six = ['a', 'b', 'c', 'd', 'e', 'f'].map((name) => `${name}@example.com`);
    expect((await send(entryId, { to: six })).statusCode).toBe(400);
    expect((await send(entryId, { to: [] })).statusCode).toBe(400);
    expect((await send(entryId, { to: ['nobody'] })).statusCode).toBe(400);
    const long = 'x'.repeat(MAX_EMAIL_NOTE_LENGTH + 1);
    expect((await send(entryId, { to: ['ann@example.com'], note: long })).statusCode).toBe(400);
    for (let n = 0; n < 5; n++) {
      expect((await send(entryId, { to: ['ann@example.com'] })).statusCode).toBe(204);
    }
    expect((await send(entryId, { to: ['ann@example.com'] })).statusCode).toBe(429);
    expect(mailer.sent).toHaveLength(5);
  });

  it('says so when the mail fails', async () => {
    mailer.failure = new Error('relay down');
    const failed = await send(entryId, { to: ['ann@example.com'] });
    mailer.failure = null;
    expect(failed.statusCode).toBe(502);
    expect(failed.json()).toMatchObject({ error: 'mail_failed' });
  });
});
