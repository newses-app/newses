import { pushSubscriptionRequestSchema } from '@newses/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { PushService } from '../../core/push/push-service.ts';
import { requireAuth, requireUser } from '../auth.ts';

/** Where the calling session's device receives push messages; it ends with the session. */
export const pushRoutes: FastifyPluginAsyncZod<{ push: PushService }> = (app, { push }) => {
  app.addHook('preHandler', requireUser);

  app.put(
    '/push/subscription',
    { schema: { body: pushSubscriptionRequestSchema } },
    async (request, reply) => {
      const { user, session } = requireAuth(request);
      await push.subscribe(user.id, session.id, request.body);
      return reply.code(204).send();
    },
  );

  app.delete('/push/subscription', async (request, reply) => {
    await push.unsubscribe(requireAuth(request).session.id);
    return reply.code(204).send();
  });
  return Promise.resolve();
};
