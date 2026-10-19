import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../db/client.ts';
import { feedSources, subscriptions, users } from '../../db/schema.ts';
import { FakeFetcher } from '../../test/fake-fetcher.ts';
import { createTestDatabase, type TestDatabase } from '../../test/database.ts';
import { MemoryBlobStore, silentLogger } from '../../test/fakes.ts';
import { FaviconService, faviconKey, iconCandidates } from './favicons.ts';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let database: TestDatabase;
let db: Db;

beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb(database.pool);
});

beforeEach(async () => {
  await db.delete(feedSources);
});

afterAll(async () => {
  await database.drop();
});

describe('iconCandidates', () => {
  it('lists declared icons then /favicon.ico', () => {
    const html =
      '<link rel="apple-touch-icon" href="/touch.png"><link rel="shortcut icon" href="fav.png"><link rel="stylesheet" href="s.css">';
    expect(iconCandidates(html, 'https://site.example/blog/')).toEqual([
      'https://site.example/touch.png',
      'https://site.example/blog/fav.png',
      'https://site.example/favicon.ico',
    ]);
  });
});

describe('FaviconService', () => {
  it('stores the first usable icon and serves it', async () => {
    const fetcher = new FakeFetcher()
      .set('https://site.example/', {
        body: '<link rel="icon" href="/broken.png"><link rel="icon" href="/ok.png">',
        contentType: 'text/html',
      })
      .set('https://site.example/broken.png', {
        body: '<html>not an image</html>',
        contentType: 'text/html',
      })
      .set('https://site.example/ok.png', { body: PNG, contentType: 'image/png' });
    const blobs = new MemoryBlobStore();
    const service = new FaviconService(db, fetcher, blobs, silentLogger);
    const [source] = await db
      .insert(feedSources)
      .values({ url: 'https://site.example/rss', siteUrl: 'https://site.example/' })
      .returning();

    await service.refresh(source?.id ?? 0);
    const icon = await service.get(source?.id ?? 0);
    expect(icon?.contentType).toBe('image/png');
    expect([...(icon?.data ?? [])]).toEqual([...PNG]);
    const key = faviconKey({ data: PNG, contentType: 'image/png' });
    expect(key).toMatch(/^favicons\/[0-9a-f]{64}$/);
    expect([...blobs.blobs.keys()]).toEqual([key]);
    expect(await service.byKey(key)).toEqual(icon);

    const [reader, stranger] = await db
      .insert(users)
      .values([
        { login: 'icon-reader', passwordHash: 'x' },
        { login: 'icon-stranger', passwordHash: 'x' },
      ])
      .returning();
    await db
      .insert(subscriptions)
      .values({ userId: reader?.id ?? 0, feedSourceId: source?.id ?? 0 });
    expect(await service.getForUser(reader?.id ?? 0, source?.id ?? 0)).not.toBeNull();
    expect(await service.getForUser(stranger?.id ?? 0, source?.id ?? 0)).toBeNull();
  });

  it('falls back to /favicon.ico and records the check when nothing is found', async () => {
    const fetcher = new FakeFetcher().set('https://plain.example/favicon.ico', {
      body: new Uint8Array([0, 0, 1, 0, 1]),
      contentType: 'application/octet-stream',
    });
    const service = new FaviconService(db, fetcher, new MemoryBlobStore(), silentLogger);
    const [found] = await db
      .insert(feedSources)
      .values({ url: 'https://plain.example/rss', siteUrl: 'https://plain.example/' })
      .returning();
    const [missing] = await db
      .insert(feedSources)
      .values({ url: 'https://none.example/rss', siteUrl: 'https://none.example/' })
      .returning();

    await service.refresh(found?.id ?? 0);
    await service.refresh(missing?.id ?? 0);
    expect(await service.get(found?.id ?? 0)).not.toBeNull();
    expect(await service.get(missing?.id ?? 0)).toBeNull();
    const rows = await db.select().from(feedSources);
    expect(rows.every((r) => r.faviconCheckedAt !== null)).toBe(true);
  });

  it('shares a recent icon of another feed from the same site without fetching or copying', async () => {
    const fetcher = new FakeFetcher().set('https://shared.example/favicon.ico', {
      body: PNG,
      contentType: 'image/png',
    });
    const blobs = new MemoryBlobStore();
    const service = new FaviconService(db, fetcher, blobs, silentLogger);
    const [first, second] = await db
      .insert(feedSources)
      .values([
        { url: 'https://shared.example/a.xml', siteUrl: 'https://shared.example/' },
        { url: 'https://shared.example/b.xml', siteUrl: 'https://shared.example/blog' },
      ])
      .returning();
    await service.refresh(first?.id ?? 0);
    const requests = fetcher.requested.length;
    await service.refresh(second?.id ?? 0);
    expect(fetcher.requested).toHaveLength(requests);
    expect((await service.get(second?.id ?? 0))?.contentType).toBe('image/png');
    const keys = (await db.select().from(feedSources)).map((s) => s.faviconKey);
    expect(new Set(keys).size).toBe(1);
    expect(blobs.blobs.size).toBe(1);
  });

  it('deletes a replaced icon once no other source shows it', async () => {
    const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
    const old = { data: PNG, contentType: 'image/png' };
    const fetcher = new FakeFetcher().set('https://moved.example/favicon.ico', {
      body: GIF,
      contentType: 'image/gif',
    });
    const blobs = new MemoryBlobStore();
    await blobs.put(faviconKey(old), old);
    await blobs.put('favicons/1', old);
    const service = new FaviconService(db, fetcher, blobs, silentLogger);
    const [moved, other, legacy] = await db
      .insert(feedSources)
      .values([
        {
          url: 'https://moved.example/rss',
          siteUrl: 'https://moved.example/',
          faviconKey: faviconKey(old),
        },
        { url: 'https://other.example/rss', faviconKey: faviconKey(old) },
        { url: 'https://moved.example/legacy.xml', faviconKey: 'favicons/1' },
      ])
      .returning();

    await service.refresh(moved?.id ?? 0);
    expect((await service.get(moved?.id ?? 0))?.contentType).toBe('image/gif');
    expect(await service.get(other?.id ?? 0)).toEqual(old);

    // The legacy source's re-check finds the new icon through its sibling.
    await db
      .update(feedSources)
      .set({ siteUrl: 'https://moved.example/' })
      .where(eq(feedSources.id, legacy?.id ?? 0));
    await service.refresh(legacy?.id ?? 0);
    expect(blobs.blobs.has('favicons/1')).toBe(false);
    expect(blobs.blobs.size).toBe(2);
    expect(await service.byKey('favicons/1')).toBeNull();
  });
});
