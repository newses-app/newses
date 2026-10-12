import { API_VERSION, PRODUCT_NAME, serverInfoSchema } from '@newses/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';

/** What the apps' connect screen checks before signing in; open to anyone. */
export const serverRoutes: FastifyPluginAsyncZod<{ version: string }> = (app, { version }) => {
  app.get('/server', { schema: { security: [], response: { 200: serverInfoSchema } } }, () => ({
    product: PRODUCT_NAME,
    version,
    apiVersion: API_VERSION,
  }));
  return Promise.resolve();
};
