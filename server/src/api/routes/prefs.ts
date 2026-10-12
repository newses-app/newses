import { prefsSchema, updatePrefsRequestSchema } from '@newses/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { PrefsService } from '../../core/prefs.ts';
import { requireAuth, requireUser } from '../auth.ts';

export const prefsRoutes: FastifyPluginAsyncZod<{ prefs: PrefsService }> = (app, { prefs }) => {
  app.addHook('preHandler', requireUser);

  app.get('/prefs', { schema: { response: { 200: prefsSchema } } }, async (request) =>
    prefs.get(requireAuth(request).user.id),
  );

  app.patch(
    '/prefs',
    { schema: { body: updatePrefsRequestSchema, response: { 200: prefsSchema } } },
    async (request) => prefs.update(requireAuth(request).user.id, request.body),
  );

  return Promise.resolve();
};
