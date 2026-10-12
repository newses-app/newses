import {
  createUserRequestSchema,
  resetPasswordRequestSchema,
  updateUserRequestSchema,
  userSchema,
} from '@newses/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { AuthService } from '../../core/auth/auth-service.ts';
import type { UserService } from '../../core/auth/users.ts';
import { requireAdmin } from '../auth.ts';
import { toUser } from '../dto.ts';
import { logSecurity } from '../security-log.ts';

const idParams = z.object({ id: z.coerce.number().int() });

export const adminUserRoutes: FastifyPluginAsyncZod<{ users: UserService; auth: AuthService }> = (
  app,
  { users, auth },
) => {
  app.addHook('preHandler', requireAdmin);

  app.get('/admin/users', { schema: { response: { 200: z.array(userSchema) } } }, async () =>
    (await users.list()).map(toUser),
  );

  app.post(
    '/admin/users',
    { schema: { body: createUserRequestSchema, response: { 201: userSchema } } },
    async (request, reply) => {
      const { login, password, role } = request.body;
      const user = await users.create(login, password, role);
      logSecurity(request, 'user_created', { targetUserId: user.id, role });
      return reply.code(201).send(toUser(user));
    },
  );

  app.patch(
    '/admin/users/:id',
    { schema: { params: idParams, body: updateUserRequestSchema, response: { 200: userSchema } } },
    async (request) => {
      const { role, disabled } = request.body;
      const user = await users.update(request.params.id, {
        ...(role && { role }),
        ...(disabled !== undefined && { disabled }),
      });
      logSecurity(request, 'user_updated', { targetUserId: user.id, role, disabled });
      return toUser(user);
    },
  );

  app.post(
    '/admin/users/:id/password',
    { schema: { params: idParams, body: resetPasswordRequestSchema } },
    async (request, reply) => {
      await auth.resetPassword(request.params.id, request.body.password);
      logSecurity(request, 'user_password_reset', { targetUserId: request.params.id });
      return reply.code(204).send();
    },
  );

  app.post(
    '/admin/users/:id/2fa/reset',
    { schema: { params: idParams } },
    async (request, reply) => {
      await auth.resetTwoFactor(request.params.id);
      logSecurity(request, 'user_two_factor_reset', { targetUserId: request.params.id });
      return reply.code(204).send();
    },
  );

  app.delete('/admin/users/:id', { schema: { params: idParams } }, async (request, reply) => {
    await users.delete(request.params.id);
    logSecurity(request, 'user_deleted', { targetUserId: request.params.id });
    return reply.code(204).send();
  });
  return Promise.resolve();
};
