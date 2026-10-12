import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../db/client.ts';
import {
  feedSources,
  hostFetchStatsHourly,
  jobStatsHourly,
  opsAlerts,
  opsState,
  requestStatsHourly,
  subscriptions,
  users,
} from '../../db/schema.ts';
import { createTestDatabase, type TestDatabase } from '../../test/database.ts';
import { silentLogger, TEST_OPS_SETTINGS } from '../../test/fakes.ts';
import type { AlertNotice, Notifier } from '../ports.ts';
import { describeNotices, OpsChecker, type QueueBacklog } from './check.ts';

let database: TestDatabase;
let db: Db;
let notices: AlertNotice[][];
let backlog: QueueBacklog[];
let checker: OpsChecker;

const notifier: Notifier = {
  notify(batch) {
    notices.push(batch);
    return Promise.resolve();
  },
};

const thisHour = sql`date_trunc('hour', now())`;

async function fetches(host: string, outcome: string, requests: number) {
  await db.insert(hostFetchStatsHourly).values({
    hour: thisHour,
    host,
    purpose: 'feed',
    outcome,
    requests,
  });
}

beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb(database.pool);
});

beforeEach(async () => {
  for (const table of [
    hostFetchStatsHourly,
    jobStatsHourly,
    requestStatsHourly,
    opsAlerts,
    opsState,
    feedSources,
    users,
  ])
    await db.delete(table);
  notices = [];
  backlog = [];
  checker = new OpsChecker({
    db,
    logger: silentLogger,
    notifier,
    settings: { ...TEST_OPS_SETTINGS, hostHourlyBudget: 50 },
    backlog: () => Promise.resolve(backlog),
  });
});

afterAll(async () => {
  await database.drop();
});

describe('OpsChecker', () => {
  it('finds nothing in a quiet system', async () => {
    await fetches('quiet.example', 'not_modified', 5);
    expect(await checker.run()).toEqual({ open: 0, opened: 0, resolved: 0 });
    expect(notices).toEqual([]);
    expect(await db.select().from(opsState)).toHaveLength(1);
  });

  it('flags hosts that rate limit, exceed the budget, or keep failing', async () => {
    await fetches('limited.example', 'rate_limited', 1);
    await fetches('busy.example', 'ok', 51);
    await fetches('broken.example', 'server_error', 8);
    await fetches('broken.example', 'ok', 2);

    const findings = await checker.evaluate();
    expect(findings.map((f) => `${f.rule} ${f.subject}`).sort()).toEqual([
      'host.failing broken.example',
      'host.over_budget busy.example',
      'host.rate_limited limited.example',
    ]);
  });

  it('flags failing jobs, backlogs, and API errors', async () => {
    await db
      .insert(jobStatsHourly)
      .values({ hour: thisHour, job: 'feed.fetch', runs: 5, failures: 2 });
    await db
      .insert(jobStatsHourly)
      .values({ hour: thisHour, job: 'feed.favicon', runs: 5, failures: 1 });
    await db.insert(requestStatsHourly).values([
      { hour: thisHour, client: 'web', statusClass: '2xx', requests: 18 },
      { hour: thisHour, client: 'web', statusClass: '5xx', requests: 2 },
    ]);
    backlog = [
      { queue: 'feed.fetch', ready: 100 },
      { queue: 'feed.favicon', ready: 3 },
    ];

    const findings = await checker.evaluate();
    expect(findings.map((f) => `${f.rule} ${f.subject} ${f.severity}`).sort()).toEqual([
      'api.errors all critical',
      'jobs.backlog feed.fetch warning',
      'jobs.failing feed.fetch critical',
    ]);
  });

  it('flags feeds long overdue as stalled ingestion', async () => {
    const [user] = await db.insert(users).values({ login: 'alice', passwordHash: 'x' }).returning();
    const [overdue, idle] = await db
      .insert(feedSources)
      .values([
        { url: 'https://a.example/feed', nextFetchAt: sql`now() - interval '3 hours'` },
        { url: 'https://b.example/feed', nextFetchAt: sql`now() - interval '3 hours'` },
      ])
      .returning();
    // Only subscribed feeds are fetched.
    await db
      .insert(subscriptions)
      .values({ userId: user?.id ?? 0, feedSourceId: overdue?.id ?? 0 });
    expect(idle).toBeDefined();

    const findings = await checker.evaluate();
    expect(findings.map((f) => [f.rule, f.details.overdue])).toEqual([['ingest.stale', 1]]);
  });

  it('opens alerts once, keeps them while they hold, and resolves them after', async () => {
    await fetches('limited.example', 'rate_limited', 1);
    expect(await checker.run()).toEqual({ open: 1, opened: 1, resolved: 0 });
    expect(await checker.run()).toEqual({ open: 1, opened: 0, resolved: 0 });
    expect(notices).toEqual([
      [
        expect.objectContaining({
          change: 'opened',
          rule: 'host.rate_limited',
          subject: 'limited.example',
        }),
      ],
    ]);

    await db.delete(hostFetchStatsHourly);
    expect(await checker.run()).toEqual({ open: 0, opened: 0, resolved: 1 });
    expect(notices[1]).toEqual([
      expect.objectContaining({
        change: 'resolved',
        rule: 'host.rate_limited',
        summary: expect.stringContaining('limited.example') as unknown,
      }),
    ]);
    const alerts = await db.select().from(opsAlerts);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.resolvedAt).toBeInstanceOf(Date);

    // A new occurrence opens a new alert.
    await fetches('limited.example', 'rate_limited', 1);
    expect(await checker.run()).toEqual({ open: 1, opened: 1, resolved: 0 });
    expect(await db.select().from(opsAlerts)).toHaveLength(2);
  });
});

describe('describeNotices', () => {
  it('summarises opened and resolved alerts with a link', () => {
    const { subject, text } = describeNotices(
      [
        {
          change: 'opened',
          rule: 'ingest.stale',
          subject: 'all',
          severity: 'critical',
          summary: 'Stalled',
        },
        {
          change: 'resolved',
          rule: 'host.failing',
          subject: 'a.example',
          severity: 'warning',
          summary: 'Failing',
        },
      ],
      'https://reader.example',
    );
    expect(subject).toBe('[Newses] CRITICAL: alerts 1 opened, 1 resolved');
    expect(text).toBe(
      'Opened:\n- [critical] ingest.stale (all): Stalled\n\n' +
        'Resolved:\n- [warning] host.failing (a.example): Failing\n\n' +
        'Operations: https://reader.example/settings/operations\n',
    );
  });
});
