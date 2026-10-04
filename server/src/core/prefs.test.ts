import { DEFAULT_PREFS } from '@rss-reader/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../db/client.ts';
import { userPrefs, users } from '../db/schema.ts';
import { createTestDatabase, type TestDatabase } from '../test/database.ts';
import { PrefsService } from './prefs.ts';

let database: TestDatabase;
let db: Db;

beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb(database.pool);
});

afterAll(async () => {
  await database.drop();
});

describe('PrefsService', () => {
  it('merges stored values over defaults, resets with null, and ignores invalid rows', async () => {
    const [user] = await db.insert(users).values({ login: 'alice', passwordHash: 'x' }).returning();
    const userId = user?.id ?? 0;
    const prefs = new PrefsService(db);
    expect(await prefs.get(userId)).toEqual(DEFAULT_PREFS);

    const updated = await prefs.update(userId, { theme: 'dark', purgeDays: 0 });
    expect(updated).toEqual({ ...DEFAULT_PREFS, theme: 'dark', purgeDays: 0 });
    expect(await prefs.update(userId, { purgeDays: null })).toEqual({
      ...DEFAULT_PREFS,
      theme: 'dark',
    });

    await db.insert(userPrefs).values([
      { userId, key: 'freshMaxAgeHours', value: 'not a number' },
      { userId, key: 'retired', value: true },
    ]);
    expect(await prefs.get(userId)).toEqual({ ...DEFAULT_PREFS, theme: 'dark' });
  });
});
