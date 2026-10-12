import type { AuditPage, OpsSummary, OpsUser } from '@newses/shared';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../db/client.ts';
import { FakeFetcher } from '../test/fake-fetcher.ts';
import { createTestServices } from '../test/services.ts';
import { createTestDatabase, type TestDatabase } from '../test/database.ts';
import { recordSpans, spanText } from '../test/tracing.ts';
import { type ApiServices, buildApp } from './app.ts';

let database: TestDatabase;
let services: ApiServices;
let app: ReturnType<typeof buildApp>;
let tracing: ReturnType<typeof recordSpans>;
let admin: Record<string, string>;
let user: Record<string, string>;

async function login(name: string, password: string): Promise<Record<string, string>> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { login: name, password },
  });
  const cookie = response.cookies.find((c) => c.name === 'rss_session')?.value ?? '';
  return {
    cookie: `rss_session=${cookie}`,
    'x-csrf-token': response.json<{ csrfToken: string }>().csrfToken,
  };
}

beforeAll(async () => {
  tracing = recordSpans();
  database = await createTestDatabase();
  services = createTestServices(createDb(database.pool), new FakeFetcher());
  await services.users.create('root', 'root password', 'admin');
  await services.users.create('bob', 'bob password');
  app = buildApp({
    logger: pino({ level: 'silent' }),
    healthChecks: {},
    services,
    tracing: true,
  });
  admin = await login('root', 'root password');
  user = await login('bob', 'bob password');
});

afterAll(async () => {
  await app.close();
  await database.drop();
  tracing.stop();
});

describe('admin ops API', () => {
  it('is for admins only', async () => {
    expect((await app.inject({ url: '/api/v1/admin/ops/summary' })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/v1/admin/ops/summary', headers: user })).statusCode).toBe(
      403,
    );
  });

  it('reports request counts and per-user activity by client', async () => {
    for (let i = 0; i < 3; i++)
      await app.inject({
        url: '/api/v1/subscriptions',
        headers: { ...user, 'x-rss-client': 'mobile' },
      });
    await services.ops.recorder.flush();

    const summary = await app.inject({ url: '/api/v1/admin/ops/summary', headers: admin });
    expect(summary.statusCode).toBe(200);
    expect(summary.json<OpsSummary>()).toMatchObject({ checkedAt: null, openAlerts: 0 });
    expect(summary.json<OpsSummary>().requests).toBeGreaterThanOrEqual(3);

    const users = (await app.inject({ url: '/api/v1/admin/ops/users', headers: admin })).json<
      OpsUser[]
    >();
    // Bob's refused request to the admin API counts too, from an unnamed client.
    expect(users.find((u) => u.login === 'bob')).toMatchObject({
      requests7d: 4,
      clients: { mobile: 3, other: 1 },
      read7d: 0,
    });
  });

  it('keeps security events in the audit log, newest first, in pages', async () => {
    await services.ops.audit.settle();
    const first = await app.inject({
      url: '/api/v1/admin/ops/audit?event=login&limit=1',
      headers: admin,
    });
    expect(first.statusCode).toBe(200);
    const page = first.json<AuditPage>();
    expect(page.events).toEqual([
      expect.objectContaining({ event: 'login', userLogin: 'bob', actorUserId: null }),
    ]);
    expect(page.nextBefore).toBe(page.events[0]?.id);

    const second = (
      await app.inject({
        url: `/api/v1/admin/ops/audit?event=login&limit=1&before=${String(page.nextBefore)}`,
        headers: admin,
      })
    ).json<AuditPage>();
    expect(second.events).toEqual([expect.objectContaining({ event: 'login', userLogin: 'root' })]);
    expect(second.nextBefore).toBeNull();
  });

  it('records the admin who acted on another account', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/users',
      headers: admin,
      payload: { login: 'carol', password: 'carol password' },
    });
    const carol = created.json<{ id: number }>().id;
    await app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/users/${String(carol)}`,
      headers: admin,
    });
    await services.ops.audit.settle();

    const { events } = (
      await app.inject({ url: '/api/v1/admin/ops/audit?event=user_deleted', headers: admin })
    ).json<AuditPage>();
    // The deleted account is gone, so only its id remains, in the details.
    expect(events).toEqual([
      expect.objectContaining({
        userId: null,
        actorLogin: 'root',
        details: { userId: carol },
      }),
    ]);
  });

  it('lists hosts, jobs, and alerts', async () => {
    for (const path of ['hosts?window=7d', 'jobs', 'alerts']) {
      const response = await app.inject({ url: `/api/v1/admin/ops/${path}`, headers: admin });
      expect(response.statusCode).toBe(200);
    }
    expect(
      (await app.inject({ url: '/api/v1/admin/ops/hosts?window=1y', headers: admin })).statusCode,
    ).toBe(400);
  });
});

describe('request traces', () => {
  it('name spans by route and never record URLs, query strings, or credentials', async () => {
    tracing.reset();
    await app.inject({
      url: '/api/v1/subscriptions?token=s3cret-query',
      headers: { ...user, authorization: 'Bearer s3cret-bearer' },
    });
    const spans = tracing.spans();
    expect(spans.map((span) => span.name)).toContain('GET /api/v1/subscriptions');
    const text = spanText(spans);
    for (const secret of ['s3cret', 'rss_session', user['x-csrf-token'] ?? 'csrf'])
      expect(text).not.toContain(secret);
  });

  it('skip health checks', async () => {
    tracing.reset();
    await app.inject({ url: '/healthz' });
    expect(tracing.spans()).toEqual([]);
  });
});
