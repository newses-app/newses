import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../db/client.ts';
import { pluginStorage, users } from '../../db/schema.ts';
import { createTestDatabase, type TestDatabase } from '../../test/database.ts';
import { PluginStorageService, STORE_LIMITS } from './storage.ts';

let database: TestDatabase;
let db: Db;
let storage: PluginStorageService;
let alice: number;

beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb(database.pool);
  storage = new PluginStorageService(db);
});

beforeEach(async () => {
  await db.delete(pluginStorage);
  await db.delete(users);
  const [user] = await db.insert(users).values({ login: 'alice', passwordHash: 'x' }).returning();
  alice = user?.id ?? 0;
});

afterAll(async () => {
  await database.drop();
});

describe('PluginStorageService', () => {
  it('keeps JSON values per plugin, for the instance and for each user', async () => {
    const instance = storage.store('summary', null);
    const user = storage.store('summary', alice);
    const other = storage.store('webhook', null);
    await instance.set('k', { overview: 'Three posts', n: [1, 2] });
    await user.set('k', 'mine');
    await other.set('k', 42);
    expect(await instance.get('k')).toEqual({ overview: 'Three posts', n: [1, 2] });
    expect(await user.get('k')).toBe('mine');
    expect(await other.get('k')).toBe(42);
    await instance.set('k', null);
    expect(await instance.get('k')).toBeNull();
    expect(await instance.get('missing')).toBeUndefined();
    expect(await user.delete('k')).toBe(true);
    expect(await user.delete('k')).toBe(false);
    expect(await instance.get('k')).toBeNull();
  });

  it('lists entries by prefix, in key order, a page at a time', async () => {
    const store = storage.store('summary', null);
    for (const key of ['sum:b', 'sum:a', 'sum:c', 'su%:x', 'other']) await store.set(key, key);
    expect(await store.list('sum:')).toEqual([
      { key: 'sum:a', value: 'sum:a' },
      { key: 'sum:b', value: 'sum:b' },
      { key: 'sum:c', value: 'sum:c' },
    ]);
    expect((await store.list('su%')).map((e) => e.key)).toEqual(['su%:x']);
    expect((await store.list('sum:', { after: 'sum:a', limit: 1 })).map((e) => e.key)).toEqual([
      'sum:b',
    ]);
    expect(await store.list('', { limit: 0 })).toHaveLength(1);
    expect(await store.list()).toHaveLength(5);
  });

  it('forgets values once they expire, and prunes them', async () => {
    const store = storage.store('summary', null);
    await store.set('short', 1, { ttlSeconds: 60 });
    await store.set('kept', 2);
    await db
      .update(pluginStorage)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(sql`${pluginStorage.key} = 'short'`);
    expect(await store.get('short')).toBeUndefined();
    expect((await store.list()).map((e) => e.key)).toEqual(['kept']);
    expect(await store.delete('short')).toBe(false);
    await store.set('short', 3, { ttlSeconds: 60 });
    expect(await store.get('short')).toBe(3);
    await store.set('short', 4);
    await db.update(pluginStorage).set({ expiresAt: sql`now() - interval '1 second'` });
    expect(await storage.prune()).toBe(2);
    expect(await db.select().from(pluginStorage)).toEqual([]);
  });

  it('refuses keys, values, and lifetimes it cannot keep', async () => {
    const store = storage.store('summary', null);
    await expect(store.set('', 1)).rejects.toThrow(TypeError);
    await expect(store.get('k'.repeat(STORE_LIMITS.keyLength + 1))).rejects.toThrow(TypeError);
    await expect(store.set('k', undefined)).rejects.toThrow('Stored values must be JSON');
    await expect(store.set('k', () => 1)).rejects.toThrow('Stored values must be JSON');
    await expect(store.set('k', 'x'.repeat(STORE_LIMITS.valueBytes))).rejects.toThrow(RangeError);
    for (const ttlSeconds of [0, 1.5, -1, 400 * 24 * 60 * 60])
      await expect(store.set('k', 1, { ttlSeconds })).rejects.toThrow(TypeError);
    expect(await store.list()).toEqual([]);
  });

  it('holds at most so many keys and bytes in one store', async () => {
    await db.execute(sql`
      INSERT INTO plugin_storage (plugin_id, user_id, key, value, size)
      SELECT 'summary', NULL, 'k' || n, '1', 1 FROM generate_series(1, ${STORE_LIMITS.keys}) n`);
    const store = storage.store('summary', null);
    await expect(store.set('new', 1)).rejects.toThrow(
      `A store holds at most ${String(STORE_LIMITS.keys)} keys`,
    );
    await store.set('k1', 2);
    expect(await store.get('k1')).toBe(2);
    await storage.store('summary', alice).set('new', 1);

    await db.delete(pluginStorage);
    await db.insert(pluginStorage).values({
      pluginId: 'summary',
      key: 'big',
      value: 1,
      size: STORE_LIMITS.bytes - 4,
    });
    await expect(store.set('more', 'abcd')).rejects.toThrow(RangeError);
    await store.set('more', 'ab');
  });
});
