import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, type Db } from '../db/client.ts';
import { rateLimits } from '../db/schema.ts';
import { createTestDatabase, type TestDatabase } from '../test/database.ts';
import { ThrottledError } from './errors.ts';
import { RATE_LIMITS, UserRateLimiter } from './rate-limit.ts';

let database: TestDatabase;
let db: Db;
let limits: UserRateLimiter;

beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb(database.pool);
  limits = new UserRateLimiter(db);
});

beforeEach(async () => {
  await db.delete(rateLimits);
});

afterAll(async () => {
  await database.drop();
});

describe('UserRateLimiter', () => {
  it('allows each action its limit per user per minute, then says how long to wait', async () => {
    for (let n = 0; n < RATE_LIMITS.subscribe; n++) await limits.take(1, 'subscribe');
    const refused = await limits.take(1, 'subscribe').catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(ThrottledError);
    const wait = (refused as ThrottledError).retryAfterSeconds;
    expect(wait).toBeGreaterThanOrEqual(1);
    expect(wait).toBeLessThanOrEqual(60);
    // Other users and other actions are counted apart.
    await limits.take(2, 'subscribe');
    await limits.take(1, 'fulltext');
    expect(await limits.tryTake(1, 'subscribe')).toBe(false);
  });

  it('starts counting again in the next window', async () => {
    for (let n = 0; n < RATE_LIMITS.debug; n++) await limits.take(1, 'debug');
    expect(await limits.tryTake(1, 'debug')).toBe(false);
    await db.update(rateLimits).set({ windowStart: sql`window_start - interval '1 minute'` });
    expect(await limits.tryTake(1, 'debug')).toBe(true);
  });

  it('prunes windows that ended over an hour ago', async () => {
    await limits.take(1, 'page');
    await limits.take(2, 'page');
    await db
      .update(rateLimits)
      .set({ windowStart: sql`now() - interval '2 hours'` })
      .where(sql`key = 'page:1'`);
    await limits.prune();
    expect((await db.select({ key: rateLimits.key }).from(rateLimits)).map((r) => r.key)).toEqual([
      'page:2',
    ]);
  });
});
