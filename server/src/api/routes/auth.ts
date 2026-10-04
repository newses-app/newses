import {
  changePasswordRequestSchema,
  currentSessionSchema,
  loginRequestSchema,
  loginResponseSchema,
  sessionSchema,
} from '@rss-reader/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { AuthService } from '../../core/auth/auth-service.ts';
import type { SessionService } from '../../core/auth/sessions.ts';
import { clearSessionCookie, requireAuth, requireUser, setSessionCookie } from '../auth.ts';
import { toSession, toUser } from '../dto.ts';

export interface AuthRoutesOptions {
  auth: AuthService;
  sessions: SessionService;
}

export const authRoutes: FastifyPluginAsyncZod<AuthRoutesOptions> = (app, { auth, sessions }) => {
  app.post(
    '/auth/login',
    { schema: { body: loginRequestSchema, response: { 200: loginResponseSchema } } },
    async (request, reply) => {
      const { login, password, tokenType } = request.body;
      const { token, session, user } = await auth.login({
        login,
        password,
        kind: tokenType,
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });
      if (tokenType === 'bearer') return { user: toUser(user), token };
      setSessionCookie(reply, token);
      return { user: toUser(user), csrfToken: session.csrfToken ?? undefined };
    },
  );

  app.post('/auth/logout', { preHandler: requireUser }, async (request, reply) => {
    const { user, session } = requireAuth(request);
    await sessions.revoke(user.id, session.id);
    clearSessionCookie(reply);
    return reply.code(204).send();
  });

  app.get(
    '/auth/session',
    { preHandler: requireUser, schema: { response: { 200: currentSessionSchema } } },
    async (request) => {
      const { user, session } = requireAuth(request);
      return Promise.resolve({ user: toUser(user), csrfToken: session.csrfToken });
    },
  );

  app.get(
    '/auth/sessions',
    { preHandler: requireUser, schema: { response: { 200: z.array(sessionSchema) } } },
    async (request) => {
      const { user, session } = requireAuth(request);
      return (await sessions.list(user.id)).map((row) => toSession(row, session.id));
    },
  );

  app.delete(
    '/auth/sessions/:id',
    { preHandler: requireUser, schema: { params: z.object({ id: z.coerce.number().int() }) } },
    async (request, reply) => {
      await sessions.revoke(requireAuth(request).user.id, request.params.id);
      return reply.code(204).send();
    },
  );

  app.post(
    '/auth/password',
    { preHandler: requireUser, schema: { body: changePasswordRequestSchema } },
    async (request, reply) => {
      const { user, session } = requireAuth(request);
      const { currentPassword, newPassword } = request.body;
      await auth.changePassword(user, session.id, currentPassword, newPassword);
      return reply.code(204).send();
    },
  );
  return Promise.resolve();
};
