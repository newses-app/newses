import { prefsSchema, updatePrefsRequestSchema } from '@newses/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FeedUpdater } from '../../core/feeds/updater.ts';
import type { PrefsService } from '../../core/prefs.ts';
import { requireAuth, requireUser } from '../auth.ts';

export const prefsRoutes: FastifyPluginAsyncZod<{ prefs: PrefsService; updater: FeedUpdater }> = (
  app,
  { prefs, updater },
) => {
  app.addHook('preHandler', requireUser);

  app.get('/prefs', { schema: { response: { 200: prefsSchema } } }, async (request) =>
    prefs.get(requireAuth(request).user.id),
  );

  app.patch(
    '/prefs',
    { schema: { body: updatePrefsRequestSchema, response: { 200: prefsSchema } } },
    async (request) => {
      const userId = requireAuth(request).user.id;
      const updated = await prefs.update(userId, request.body);
      // A new default interval applies to the user's feeds now, not after their next check.
      if (request.body.updateIntervalMinutes !== undefined) await updater.rescheduleUser(userId);
      return updated;
    },
  );

  return Promise.resolve();
};
