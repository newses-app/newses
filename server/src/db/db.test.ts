import { eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../test/database.ts';
import { createDb, type Db } from './client.ts';
import { runMigrations } from './migrate.ts';
import { categories, entries, feedSources, subscriptions, userEntries, users } from './schema.ts';

let database: TestDatabase;
let pool: pg.Pool;
let db: Db;

function first<T>(rows: T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error('expected a row');
  return row;
}

async function appliedMigrations(target: pg.Pool): Promise<number> {
  const result = await target.query<{ n: string }>(
    'SELECT count(*) AS n FROM drizzle.__drizzle_migrations',
  );
  return Number(first(result.rows).n);
}

let seq = 0;
async function createUser(login = `user${String(++seq)}`) {
  return first(await db.insert(users).values({ login, passwordHash: 'x' }).returning());
}

async function createFeedSource() {
  return first(
    await db
      .insert(feedSources)
      .values({ url: `https://example.com/${String(++seq)}.xml` })
      .returning(),
  );
}

beforeAll(async () => {
  database = await createTestDatabase();
  pool = database.pool;
  db = createDb(pool);
});

afterAll(async () => {
  await database.drop();
});

describe('migrations', () => {
  it('can be re-run without changes', async () => {
    const before = await appliedMigrations(pool);
    await runMigrations(pool);
    expect(await appliedMigrations(pool)).toBe(before);
  });

  it('serialise concurrent runs on an empty database', async () => {
    const empty = await createTestDatabase({ migrate: false });
    const pools = [1, 2, 3].map(() => new pg.Pool({ connectionString: empty.url }));
    try {
      await Promise.all(pools.map((p) => runMigrations(p)));
      expect(await appliedMigrations(first(pools))).toBe(await appliedMigrations(pool));
    } finally {
      await Promise.all(pools.map((p) => p.end()));
      await empty.drop();
    }
  }, 30_000);
});

describe('schema', () => {
  it('bumps updated_at on raw SQL updates', async () => {
    const user = await createUser();
    await pool.query(`UPDATE users SET role = 'admin' WHERE id = $1`, [user.id]);
    const updated = first(await db.select().from(users).where(eq(users.id, user.id)));
    expect(updated.updatedAt.getTime()).toBeGreaterThan(user.updatedAt.getTime());
  });

  it('indexes entry text without markup or entities', async () => {
    const source = await createFeedSource();
    const entry = first(
      await db
        .insert(entries)
        .values({
          feedSourceId: source.id,
          guid: 'g1',
          title: 'Greeting',
          content: '<p class="intro">Hello &amp; <b>world</b></p>',
          contentHash: 'h',
        })
        .returning(),
    );
    const matches = async (term: string) =>
      first(
        await db
          .select({ hit: sql<boolean>`${entries.search} @@ to_tsquery('simple', ${term})` })
          .from(entries)
          .where(eq(entries.id, entry.id)),
      ).hit;
    expect(await matches('world')).toBe(true);
    expect(await matches('greeting')).toBe(true);
    expect(await matches('amp')).toBe(false);
    expect(await matches('intro')).toBe(false);
  });

  it('rejects duplicate GUIDs within a feed source', async () => {
    const source = await createFeedSource();
    const values = { feedSourceId: source.id, guid: 'same', contentHash: 'h' };
    await db.insert(entries).values(values);
    await expect(db.insert(entries).values(values)).rejects.toThrow();
  });

  it('treats logins case-insensitively', async () => {
    await createUser('Alice');
    await expect(createUser('alice')).rejects.toThrow();
  });

  it('cascades feed source deletion and detaches deleted categories', async () => {
    const user = await createUser();
    const parent = first(
      await db.insert(categories).values({ userId: user.id, title: 'Parent' }).returning(),
    );
    const child = first(
      await db
        .insert(categories)
        .values({ userId: user.id, parentId: parent.id, title: 'Child' })
        .returning(),
    );
    const source = await createFeedSource();
    const subscription = first(
      await db
        .insert(subscriptions)
        .values({ userId: user.id, feedSourceId: source.id, categoryId: child.id })
        .returning(),
    );
    const entry = first(
      await db
        .insert(entries)
        .values({ feedSourceId: source.id, guid: 'g', contentHash: 'h' })
        .returning(),
    );
    await db.insert(userEntries).values({
      userId: user.id,
      entryId: entry.id,
      subscriptionId: subscription.id,
      sortAt: new Date(),
    });

    await db.delete(categories).where(eq(categories.id, parent.id));
    expect(
      first(await db.select().from(categories).where(eq(categories.id, child.id))).parentId,
    ).toBeNull();

    await db.delete(categories).where(eq(categories.id, child.id));
    expect(
      first(await db.select().from(subscriptions).where(eq(subscriptions.id, subscription.id)))
        .categoryId,
    ).toBeNull();

    await db.delete(feedSources).where(eq(feedSources.id, source.id));
    expect(await db.select().from(entries).where(eq(entries.feedSourceId, source.id))).toHaveLength(
      0,
    );
    expect(await db.select().from(userEntries).where(eq(userEntries.userId, user.id))).toHaveLength(
      0,
    );
    expect(
      await db.select().from(subscriptions).where(eq(subscriptions.userId, user.id)),
    ).toHaveLength(0);
  });
});
