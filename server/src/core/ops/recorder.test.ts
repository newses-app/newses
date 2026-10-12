import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../db/client.ts';
import {
  hostFetchStatsHourly,
  jobStatsHourly,
  requestStatsHourly,
  userActivityDaily,
  users,
} from '../../db/schema.ts';
import { createTestDatabase, type TestDatabase } from '../../test/database.ts';
import { silentLogger } from '../../test/fakes.ts';
import { OpsRecorder } from './recorder.ts';

let database: TestDatabase;
let db: Db;
let userId: number;

const NOW = Date.UTC(2026, 9, 12, 14, 25);

beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb(database.pool);
});

beforeEach(async () => {
  await db.delete(requestStatsHourly);
  await db.delete(hostFetchStatsHourly);
  await db.delete(jobStatsHourly);
  await db.delete(users);
  const [user] = await db.insert(users).values({ login: 'alice', passwordHash: 'x' }).returning();
  userId = user?.id ?? 0;
});

afterAll(async () => {
  await database.drop();
});

describe('OpsRecorder', () => {
  it('adds each flush to the hourly and daily buckets', async () => {
    const recorder = new OpsRecorder(db, silentLogger, () => NOW);
    recorder.recordRequest({ client: 'web', status: 200, durationMs: 40, userId });
    recorder.recordRequest({ client: 'web', status: 204, durationMs: 2500, userId });
    recorder.recordRequest({ client: 'greader', status: 500, durationMs: 10, userId: null });
    await recorder.flush();
    recorder.recordRequest({ client: 'web', status: 200, durationMs: 60, userId });
    await recorder.flush();

    const requests = await db.select().from(requestStatsHourly).orderBy(requestStatsHourly.client);
    expect(requests).toEqual([
      {
        hour: new Date(Date.UTC(2026, 9, 12, 14)),
        client: 'greader',
        statusClass: '5xx',
        requests: 1,
        slow: 0,
        totalMs: 10,
        maxMs: 10,
      },
      {
        hour: new Date(Date.UTC(2026, 9, 12, 14)),
        client: 'web',
        statusClass: '2xx',
        requests: 3,
        slow: 1,
        totalMs: 2600,
        maxMs: 2500,
      },
    ]);
    expect(await db.select().from(userActivityDaily)).toEqual([
      { userId, day: '2026-10-12', client: 'web', requests: 3, lastSeenAt: new Date(NOW) },
    ]);
  });

  it('counts fetches by host, purpose, and outcome', async () => {
    const recorder = new OpsRecorder(db, silentLogger, () => NOW);
    recorder.recordFetch({
      host: 'a.example',
      purpose: 'feed',
      outcome: 'ok',
      bytes: 100,
      durationMs: 20,
    });
    recorder.recordFetch({
      host: 'a.example',
      purpose: 'feed',
      outcome: 'ok',
      bytes: 50,
      durationMs: 30,
    });
    recorder.recordFetch({
      host: 'a.example',
      purpose: 'feed',
      outcome: 'rate_limited',
      bytes: 0,
      durationMs: 5,
    });
    await recorder.flush();
    recorder.recordFetch({
      host: 'a.example',
      purpose: 'feed',
      outcome: 'ok',
      bytes: 10,
      durationMs: 10,
    });
    await recorder.flush();

    const rows = await db.select().from(hostFetchStatsHourly).orderBy(hostFetchStatsHourly.outcome);
    expect(
      rows.map(({ outcome, requests, bytes, totalMs }) => ({ outcome, requests, bytes, totalMs })),
    ).toEqual([
      { outcome: 'ok', requests: 3, bytes: 160, totalMs: 60 },
      { outcome: 'rate_limited', requests: 1, bytes: 0, totalMs: 5 },
    ]);
  });

  it('counts job runs and failures', async () => {
    const recorder = new OpsRecorder(db, silentLogger, () => NOW);
    recorder.recordJob({ job: 'feed.fetch', ok: true, durationMs: 100 });
    recorder.recordJob({ job: 'feed.fetch', ok: false, durationMs: 300 });
    await recorder.flush();

    expect(await db.select().from(jobStatsHourly)).toEqual([
      {
        hour: new Date(Date.UTC(2026, 9, 12, 14)),
        job: 'feed.fetch',
        runs: 2,
        failures: 1,
        totalMs: 400,
        maxMs: 300,
      },
    ]);
  });

  it('skips activity of users deleted before the flush', async () => {
    const recorder = new OpsRecorder(db, silentLogger, () => NOW);
    recorder.recordRequest({ client: 'mobile', status: 200, durationMs: 5, userId });
    await db.delete(users);
    await recorder.flush();

    expect(await db.select().from(userActivityDaily)).toEqual([]);
    expect(await db.select().from(requestStatsHourly)).toHaveLength(1);
  });
});
