import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { ImageProxy } from '../../core/feeds/images.ts';

const params = z.object({ signature: z.string().max(64), url: z.string().max(8000) });

/**
 * Proxied entry images. The signature is the authorisation, so responses carry no user data and
 * may be cached by the browser and CloudFront.
 */
export const imageRoutes: FastifyPluginAsyncZod<{ images: ImageProxy }> = (app, { images }) => {
  app.get('/images/:signature/:url', { schema: { params, hide: true } }, async (request, reply) => {
    const result = await images.get(request.params.signature, request.params.url);
    if ('error' in result) {
      return result.error === 'forbidden'
        ? reply.code(403).send({ error: 'forbidden', message: 'Invalid image signature' })
        : reply
            .code(404)
            .header('cache-control', 'public, max-age=3600')
            .send({ error: 'not_found', message: 'Image unavailable' });
    }
    return (
      reply
        .type(result.image.contentType)
        .header('cache-control', 'public, max-age=2592000, immutable')
        // Images may be SVG; never let one run script on this origin.
        .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox")
        .send(Buffer.from(result.image.data))
    );
  });
  return Promise.resolve();
};
