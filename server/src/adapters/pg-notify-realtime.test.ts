import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Logger, RealtimeEvent } from '../core/ports.ts';
import { createTestDatabase, type TestDatabase } from '../test/database.ts';
import { PgNotifyRealtime } from './pg-notify-realtime.ts';

const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

let database: TestDatabase;
let publisherPool: pg.Pool;
let publisher: PgNotifyRealtime;
let subscriber: PgNotifyRealtime;

beforeAll(async () => {
  database = await createTestDatabase({ migrate: false });
  // Separate pools stand in for the worker (publisher) and server (subscriber) processes.
  publisherPool = new pg.Pool({ connectionString: database.url });
  publisher = new PgNotifyRealtime(publisherPool, logger);
  subscriber = new PgNotifyRealtime(database.pool, logger);
  await subscriber.start();
});

afterAll(async () => {
  await subscriber.stop();
  await publisherPool.end();
  await database.drop();
});

describe('PgNotifyRealtime', () => {
  it('delivers events across connections to the right user only', async () => {
    const alice: RealtimeEvent[] = [];
    const bob: RealtimeEvent[] = [];
    const unsubscribeAlice = subscriber.subscribe(1, (e) => alice.push(e));
    const unsubscribeBob = subscriber.subscribe(2, (e) => bob.push(e));

    await publisher.publish(1, { type: 'counters' });
    await vi.waitFor(() => {
      expect(alice).toEqual([{ type: 'counters' }]);
    });
    expect(bob).toEqual([]);

    unsubscribeAlice();
    await publisher.publish(1, { type: 'counters' });
    await publisher.publish(2, { type: 'counters' });
    await vi.waitFor(() => {
      expect(bob).toHaveLength(1);
    });
    expect(alice).toHaveLength(1);
    unsubscribeBob();
  });
});
