import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../db/client.ts';
import { feedSources, subscriptions, users } from '../db/schema.ts';
import { createTestDatabase, type TestDatabase } from '../test/database.ts';
import { CategoryService } from './categories.ts';

let database: TestDatabase;
let db: Db;
let service: CategoryService;
let userId: number;

beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb(database.pool);
  service = new CategoryService(db);
});

beforeEach(async () => {
  await db.delete(users);
  const [user] = await db.insert(users).values({ login: 'alice', passwordHash: 'x' }).returning();
  userId = user?.id ?? 0;
});

afterAll(async () => {
  await database.drop();
});

describe('CategoryService', () => {
  it('creates, renames, reorders, and collapses categories', async () => {
    const tech = await service.create(userId, 'Tech');
    const dev = await service.create(userId, 'Dev', tech.id);
    expect(dev.parentId).toBe(tech.id);
    const renamed = await service.update(userId, dev.id, {
      title: 'Development',
      sortOrder: 3,
      collapsed: true,
    });
    expect(renamed).toMatchObject({ title: 'Development', sortOrder: 3, collapsed: true });
  });

  it("expands and collapses all of a user's categories, not other users'", async () => {
    const [bob] = await db.insert(users).values({ login: 'bob', passwordHash: 'x' }).returning();
    await service.create(bob?.id ?? 0, 'Bob');
    const a = await service.create(userId, 'A');
    await service.create(userId, 'B', a.id);
    await service.setAllCollapsed(userId, true);
    expect((await service.list(userId)).map((c) => c.collapsed)).toEqual([true, true]);
    expect((await service.list(bob?.id ?? 0))[0]?.collapsed).toBe(false);
    await service.setAllCollapsed(userId, false);
    expect((await service.list(userId)).map((c) => c.collapsed)).toEqual([false, false]);
  });

  it('rejects duplicate names under the same parent only', async () => {
    const a = await service.create(userId, 'A');
    await service.create(userId, 'Same');
    await service.create(userId, 'Same', a.id);
    await expect(service.create(userId, 'Same')).rejects.toMatchObject({ code: 'conflict' });
  });

  it('prevents cycles', async () => {
    const a = await service.create(userId, 'A');
    const b = await service.create(userId, 'B', a.id);
    const c = await service.create(userId, 'C', b.id);
    await expect(service.update(userId, a.id, { parentId: c.id })).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(service.update(userId, a.id, { parentId: a.id })).rejects.toMatchObject({
      code: 'invalid_input',
    });
    expect((await service.update(userId, c.id, { parentId: null })).parentId).toBeNull();
  });

  it('moves children and feeds up when a category is deleted', async () => {
    const parent = await service.create(userId, 'Parent');
    const middle = await service.create(userId, 'Middle', parent.id);
    const child = await service.create(userId, 'Child', middle.id);
    const [source] = await db
      .insert(feedSources)
      .values({ url: 'https://f.example/rss' })
      .returning();
    const [sub] = await db
      .insert(subscriptions)
      .values({ userId, feedSourceId: source?.id ?? 0, categoryId: middle.id })
      .returning();

    await service.delete(userId, middle.id);
    const all = await service.list(userId);
    expect(all.find((c) => c.id === child.id)?.parentId).toBe(parent.id);
    const [moved] = await db.select().from(subscriptions);
    expect(moved?.id).toBe(sub?.id);
    expect(moved?.categoryId).toBe(parent.id);
  });

  it("hides other users' categories", async () => {
    const [bob] = await db.insert(users).values({ login: 'bob', passwordHash: 'x' }).returning();
    const bobs = await service.create(bob?.id ?? 0, 'Bob');
    await expect(service.update(userId, bobs.id, { title: 'Mine' })).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(service.create(userId, 'Child', bobs.id)).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(await service.list(userId)).toEqual([]);
  });
});
