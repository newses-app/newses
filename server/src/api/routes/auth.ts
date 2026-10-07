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
import { DomainError } from '../../core/errors.ts';
import { toSession, toUser } from '../dto.ts';
import { logSecurity } from '../security-log.ts';

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
      let result;
      try {
        result = await auth.login({
          login,
          password,
          kind: tokenType,
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
        });
      } catch (err) {
        if (err instanceof DomainError) {
          logSecurity(request, err.code === 'throttled' ? 'login_throttled' : 'login_failed', {
            login,
          });
        }
        throw err;
      }
      const { token, session, user } = result;
      logSecurity(request, 'login', { userId: user.id, kind: tokenType });
      if (tokenType === 'bearer') return { user: toUser(user), token };
      setSessionCookie(reply, token);
      return { user: toUser(user), csrfToken: session.csrfToken ?? undefined };
    },
  );

  app.post('/auth/logout', { preHandler: requireUser }, async (request, reply) => {
    const { user, session } = requireAuth(request);
    await sessions.revoke(user.id, session.id);
    logSecurity(request, 'logout');
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
      logSecurity(request, 'session_revoked', { sessionId: request.params.id });
      return reply.code(204).send();
    },
  );

  app.post(
    '/auth/password',
    { preHandler: requireUser, schema: { body: changePasswordRequestSchema } },
    async (request, reply) => {
      const { user, session } = requireAuth(request);
      const { currentPassword, newPassword } = request.body;
      try {
        await auth.changePassword(user, session.id, currentPassword, newPassword);
      } catch (err) {
        if (err instanceof DomainError) logSecurity(request, 'password_change_failed');
        throw err;
      }
      logSecurity(request, 'password_changed');
      return reply.code(204).send();
    },
  );
  return Promise.resolve();
};
