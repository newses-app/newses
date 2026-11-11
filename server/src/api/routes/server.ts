import {
  API_VERSION,
  PRODUCT_NAME,
  serverInfoSchema,
  thirdPartyLicenseSchema,
} from '@newses/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { DomainError } from '../../core/errors.ts';
import { serverLicenses } from '../../licenses.ts';
import { requireAuth } from '../auth.ts';

/** What the apps' connect screen checks before signing in; open to anyone. */
export const serverRoutes: FastifyPluginAsyncZod<{
  version: string;
  name: string | null;
  source: string | null;
  /** The VAPID public key devices subscribe to push messages with. */
  pushKey: string;
}> = (app, { version, name, source, pushKey }) => {
  app.get('/server', { schema: { security: [], response: { 200: serverInfoSchema } } }, () => ({
    product: PRODUCT_NAME,
    version,
    apiVersion: API_VERSION,
    ...(name && { name }),
    ...(source && { source }),
    push: { key: pushKey },
  }));

  // Signed in only: exact versions would tell anyone which known vulnerabilities to try.
  app.get(
    '/server/licenses',
    { schema: { response: { 200: z.array(thirdPartyLicenseSchema) } } },
    async (request) => {
      requireAuth(request);
      const licenses = await serverLicenses();
      if (!licenses) throw new DomainError('not_found', 'No licences in this build');
      return licenses;
    },
  );
  return Promise.resolve();
};
