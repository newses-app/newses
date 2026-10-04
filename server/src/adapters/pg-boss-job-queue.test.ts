import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../test/database.ts';
import { PgBossJobQueue } from './pg-boss-job-queue.ts';

type Jobs = {
  'test.echo': { n: number };
  'test.unique': { id: number };
  'test.flaky': { n: number };
};

let database: TestDatabase;
let boss: PgBoss;
let queue: PgBossJobQueue<Jobs>;

beforeAll(async () => {
  database = await createTestDatabase({ migrate: false });
  boss = new PgBoss({ connectionString: database.url });
  await boss.start();
  queue = new PgBossJobQueue<Jobs>(boss, {
    'test.echo': {},
    'test.unique': { dedupeByKey: true },
    'test.flaky': { retryLimit: 2, retryDelaySeconds: 1 },
  });
});

afterAll(async () => {
  await boss.stop({ graceful: false });
  await database.drop();
});

describe('PgBossJobQueue', () => {
  it('delivers payloads to workers', async () => {
    const received = new Promise<{ n: number }>((resolve) => {
      void queue.work('test.echo', (data) => {
        resolve(data);
        return Promise.resolve();
      });
    });
    expect(await queue.enqueue('test.echo', { n: 42 })).toBe(true);
    expect(await received).toEqual({ n: 42 });
  }, 15_000);

  it('drops duplicate queued jobs with the same key', async () => {
    expect(await queue.enqueue('test.unique', { id: 1 }, { key: 'feed-1' })).toBe(true);
    expect(await queue.enqueue('test.unique', { id: 1 }, { key: 'feed-1' })).toBe(false);
    expect(await queue.enqueue('test.unique', { id: 2 }, { key: 'feed-2' })).toBe(true);
  });

  it('requires a key for deduplicating jobs', async () => {
    await expect(queue.enqueue('test.unique', { id: 3 })).rejects.toThrow(/needs a key/);
  });

  it('retries failed jobs', async () => {
    let attempts = 0;
    const succeeded = new Promise<void>((resolve) => {
      void queue.work('test.flaky', () => {
        attempts++;
        if (attempts === 1) return Promise.reject(new Error('transient'));
        resolve();
        return Promise.resolve();
      });
    });
    await queue.enqueue('test.flaky', { n: 1 });
    await succeeded;
    expect(attempts).toBe(2);
  }, 20_000);
});
