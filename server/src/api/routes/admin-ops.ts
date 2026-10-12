import {
  auditPageSchema,
  auditQuerySchema,
  opsAlertSchema,
  opsHostsResponseSchema,
  opsJobsResponseSchema,
  opsSummarySchema,
  opsUserSchema,
  opsWindowSchema,
} from '@rss-reader/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { OpsServices } from '../../core/ops/index.ts';
import { requireAdmin } from '../auth.ts';

const windowQuery = z.object({ window: opsWindowSchema.default('24h') });
const HOURS = { '24h': 24, '7d': 7 * 24 } as const;
const iso = (date: Date | null) => date?.toISOString() ?? null;

/** Read-only operations reporting for admins: activity, remote hosts, jobs, alerts, audit. */
export const adminOpsRoutes: FastifyPluginAsyncZod<{ ops: OpsServices }> = (app, { ops }) => {
  app.addHook('preHandler', requireAdmin);

  app.get('/admin/ops/summary', { schema: { response: { 200: opsSummarySchema } } }, async () => {
    const summary = await ops.reports.summary();
    return { ...summary, checkedAt: iso(summary.checkedAt) };
  });

  app.get(
    '/admin/ops/hosts',
    { schema: { querystring: windowQuery, response: { 200: opsHostsResponseSchema } } },
    async (request) => {
      const { hosts, hourly } = await ops.reports.hosts(HOURS[request.query.window]);
      return {
        hourlyBudget: ops.reports.hostHourlyBudget,
        hosts: hosts.map((host) => ({ ...host, blockedUntil: iso(host.blockedUntil) })),
        hourly: hourly.map((bucket) => ({ ...bucket, hour: bucket.hour.toISOString() })),
      };
    },
  );

  app.get(
    '/admin/ops/jobs',
    { schema: { querystring: windowQuery, response: { 200: opsJobsResponseSchema } } },
    async (request) => {
      const { jobs, hourly } = await ops.reports.jobs(HOURS[request.query.window]);
      return {
        jobs,
        hourly: hourly.map((bucket) => ({ ...bucket, hour: bucket.hour.toISOString() })),
      };
    },
  );

  app.get('/admin/ops/users', { schema: { response: { 200: z.array(opsUserSchema) } } }, async () =>
    (await ops.reports.users()).map((user) => ({ ...user, lastSeenAt: iso(user.lastSeenAt) })),
  );

  app.get(
    '/admin/ops/alerts',
    { schema: { response: { 200: z.array(opsAlertSchema) } } },
    async () =>
      (await ops.reports.alerts()).map((alert) => ({
        ...alert,
        severity: alert.severity === 'critical' ? ('critical' as const) : ('warning' as const),
        summary: typeof alert.details.summary === 'string' ? alert.details.summary : alert.rule,
        openedAt: alert.openedAt.toISOString(),
        lastSeenAt: alert.lastSeenAt.toISOString(),
        resolvedAt: iso(alert.resolvedAt),
      })),
  );

  app.get(
    '/admin/ops/audit',
    { schema: { querystring: auditQuerySchema, response: { 200: auditPageSchema } } },
    async (request) => {
      const { limit, ...filters } = request.query;
      const events = await ops.audit.list({ ...filters, limit: limit + 1 });
      const page = events.slice(0, limit);
      return {
        events: page.map((event) => ({ ...event, at: event.at.toISOString() })),
        nextBefore: events.length > limit ? (page.at(-1)?.id ?? null) : null,
      };
    },
  );
  return Promise.resolve();
};
