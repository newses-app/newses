import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { FaviconService } from '../../core/feeds/favicons.ts';
import { sendIcon } from '../icons.ts';

/** A content hash, or a source id under which icons were stored before. */
const params = z.object({ name: z.string().regex(/^([0-9a-f]{64}|\d{1,12})$/) });

/**
 * Feed icons at `/<icon key>`, as subscriptions' `iconUrl` gives them; CloudFront serves the same
 * path from the blob bucket. Icons are sites' public favicons named by their content, so they need
 * no session and are cached for good.
 */
export const faviconRoutes: FastifyPluginAsyncZod<{ favicons: FaviconService }> = (
  app,
  { favicons },
) => {
  app.get('/favicons/:name', { schema: { params, hide: true } }, async (request, reply) => {
    const icon = await favicons.byKey(`favicons/${request.params.name}`);
    if (!icon) return reply.code(404).type('text/plain; charset=utf-8').send('Not found\n');
    return sendIcon(reply, icon, 'public, max-age=31536000, immutable');
  });
  return Promise.resolve();
};
