import { hostRuleSchema, setHostRuleRequestSchema } from '@newses/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { HostRuleRow, HostRuleService } from '../../core/feeds/host-rules.ts';
import { requireAdmin, requireAuth } from '../auth.ts';
import { logSecurity } from '../security-log.ts';

const hostParams = z.object({ host: z.string().min(1).max(300) });

const toHostRule = (row: HostRuleRow) => ({
  host: row.host,
  minIntervalMinutes: Math.round(row.minIntervalSeconds / 60),
  updatedAt: row.updatedAt.toISOString(),
});

/** Admins' minimum intervals between feed checks of a site. */
export const adminSiteRoutes: FastifyPluginAsyncZod<{ hostRules: HostRuleService }> = (
  app,
  { hostRules },
) => {
  app.addHook('preHandler', requireAdmin);

  app.get(
    '/admin/sites/rules',
    { schema: { response: { 200: z.array(hostRuleSchema) } } },
    async () => (await hostRules.list()).map(toHostRule),
  );

  app.put(
    '/admin/sites/rules/:host',
    {
      schema: {
        params: hostParams,
        body: setHostRuleRequestSchema,
        response: { 200: hostRuleSchema },
      },
    },
    async (request) => {
      const { minIntervalMinutes } = request.body;
      const row = await hostRules.set(
        request.params.host,
        minIntervalMinutes * 60,
        requireAuth(request).user.id,
      );
      logSecurity(request, 'site_interval_set', { host: row.host, minIntervalMinutes });
      return toHostRule(row);
    },
  );

  app.delete(
    '/admin/sites/rules/:host',
    { schema: { params: hostParams } },
    async (request, reply) => {
      const host = await hostRules.clear(request.params.host);
      logSecurity(request, 'site_interval_cleared', { host });
      return reply.code(204).send();
    },
  );

  return Promise.resolve();
};
