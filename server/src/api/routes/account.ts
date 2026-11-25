import {
  confirmEmailRequestSchema,
  confirmEmailResponseSchema,
  digestTestPreviewSchema,
  setEmailRequestSchema,
  userSchema,
} from '@newses/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { AccountEmailService } from '../../core/auth/account-email.ts';
import type { DigestService } from '../../core/mail/digest-service.ts';
import type { UserRateLimiter } from '../../core/rate-limit.ts';
import { requireAuth, requireUser } from '../auth.ts';
import { toUser } from '../dto.ts';
import { logSecurity } from '../security-log.ts';

export interface AccountRoutesOptions {
  email: AccountEmailService;
  digest: Pick<DigestService, 'requestTest' | 'previewTest'>;
  limits: Pick<UserRateLimiter, 'take'>;
  /** Origin of the web app the confirmation link opens; null uses each request's origin. */
  publicUrl: string | null;
}

export const accountRoutes: FastifyPluginAsyncZod<AccountRoutesOptions> = (
  app,
  { email, digest, limits, publicUrl },
) => {
  app.put(
    '/account/email',
    {
      preHandler: requireUser,
      schema: { body: setEmailRequestSchema, response: { 200: userSchema } },
    },
    async (request) => {
      const { user } = requireAuth(request);
      const updated = await email.request(user, request.body.email, {
        appUrl: (publicUrl ?? `${request.protocol}://${request.host}`).replace(/\/+$/, ''),
        acceptLanguage: request.headers['accept-language'],
      });
      logSecurity(request, 'email_change_requested');
      return toUser(updated);
    },
  );

  // No session: the token from the mailed link is the credential, so it confirms in any browser.
  app.post(
    '/account/email/confirm',
    {
      schema: {
        security: [],
        body: confirmEmailRequestSchema,
        response: { 200: confirmEmailResponseSchema },
      },
    },
    async (request) => {
      const user = await email.confirm(request.body.token);
      logSecurity(request, 'email_confirmed', { userId: user.id });
      return { email: user.email ?? '' };
    },
  );

  app.delete('/account/email', { preHandler: requireUser }, async (request, reply) => {
    await email.remove(requireAuth(request).user.id);
    logSecurity(request, 'email_removed');
    return reply.code(204).send();
  });

  // What a test digest would hold now, sending nothing (API 1.17).
  app.get(
    '/account/digest/test',
    { preHandler: requireUser, schema: { response: { 200: digestTestPreviewSchema } } },
    async (request) => {
      const userId = requireAuth(request).user.id;
      await limits.take(userId, 'digestPreview');
      return digest.previewTest(userId);
    },
  );

  // Sent by the next run that sends test digests, within a minute (API 1.17).
  app.post('/account/digest/test', { preHandler: requireUser }, async (request, reply) => {
    const userId = requireAuth(request).user.id;
    await limits.take(userId, 'digestTest');
    await digest.requestTest(userId);
    return reply.code(202).send();
  });
  return Promise.resolve();
};
