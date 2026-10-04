import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../db/client.ts';
import { feedSources } from '../../db/schema.ts';
import { FakeFetcher } from '../../test/fake-fetcher.ts';
import { createTestDatabase, type TestDatabase } from '../../test/database.ts';
import { MemoryBlobStore, silentLogger } from '../../test/fakes.ts';
import { FaviconService, iconCandidates } from './favicons.ts';
import { HostLimiter } from './host-limiter.ts';

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
    const service = new FaviconService(db, fetcher, blobs, silentLogger, new HostLimiter(2));
    const [source] = await db
      .insert(feedSources)
      .values({ url: 'https://site.example/rss', siteUrl: 'https://site.example/' })
      .returning();

    await service.refresh(source?.id ?? 0);
    const icon = await service.get(source?.id ?? 0);
    expect(icon?.contentType).toBe('image/png');
    expect([...(icon?.data ?? [])]).toEqual([...PNG]);
  });

  it('falls back to /favicon.ico and records the check when nothing is found', async () => {
    const fetcher = new FakeFetcher().set('https://plain.example/favicon.ico', {
      body: new Uint8Array([0, 0, 1, 0, 1]),
      contentType: 'application/octet-stream',
    });
    const service = new FaviconService(
      db,
      fetcher,
      new MemoryBlobStore(),
      silentLogger,
      new HostLimiter(2),
    );
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

  it('reuses a recent icon of another feed from the same site without fetching', async () => {
    const fetcher = new FakeFetcher().set('https://shared.example/favicon.ico', {
      body: PNG,
      contentType: 'image/png',
    });
    const service = new FaviconService(
      db,
      fetcher,
      new MemoryBlobStore(),
      silentLogger,
      new HostLimiter(2),
    );
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
  });
});
