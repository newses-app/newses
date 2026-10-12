import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../test/database.ts';
import { trackPoolUse } from './runtime.ts';

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase({ migrate: false });
});

afterAll(async () => {
  await database.drop();
});

describe('trackPoolUse', () => {
  it('reports whether the pool handed out a connection since the last reset', async () => {
    const tracker = trackPoolUse(database.pool);
    expect(tracker.used()).toBe(false);
    await database.pool.query('SELECT 1');
    expect(tracker.used()).toBe(true);
    tracker.reset();
    expect(tracker.used()).toBe(false);
  });
});
