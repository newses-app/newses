import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { ThemeService } from '../../core/themes.ts';
import { requireAdmin } from '../auth.ts';
import { logSecurity } from '../security-log.ts';

const idParams = z.object({ id: z.coerce.number().int() });

export const adminThemeRoutes: FastifyPluginAsyncZod<{ themes: ThemeService }> = (
  app,
  { themes },
) => {
  app.addHook('preHandler', requireAdmin);

  app.post(
    '/admin/themes/:id/unpublish',
    { schema: { params: idParams } },
    async (request, reply) => {
      const theme = await themes.unpublish(request.params.id);
      logSecurity(request, 'theme_unpublished', { targetUserId: theme.ownerId, themeId: theme.id });
      return reply.code(204).send();
    },
  );

  return Promise.resolve();
};
