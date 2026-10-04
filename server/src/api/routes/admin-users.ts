import {
  createUserRequestSchema,
  resetPasswordRequestSchema,
  updateUserRequestSchema,
  userSchema,
} from '@rss-reader/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { UserService } from '../../core/auth/users.ts';
import { requireAdmin } from '../auth.ts';
import { toUser } from '../dto.ts';

const idParams = z.object({ id: z.coerce.number().int() });

export const adminUserRoutes: FastifyPluginAsyncZod<{ users: UserService }> = (app, { users }) => {
  app.addHook('preHandler', requireAdmin);

  app.get('/admin/users', { schema: { response: { 200: z.array(userSchema) } } }, async () =>
    (await users.list()).map(toUser),
  );

  app.post(
    '/admin/users',
    { schema: { body: createUserRequestSchema, response: { 201: userSchema } } },
    async (request, reply) => {
      const { login, password, role } = request.body;
      return reply.code(201).send(toUser(await users.create(login, password, role)));
    },
  );

  app.patch(
    '/admin/users/:id',
    { schema: { params: idParams, body: updateUserRequestSchema, response: { 200: userSchema } } },
    async (request) => {
      const { role, disabled } = request.body;
      return toUser(
        await users.update(request.params.id, {
          ...(role && { role }),
          ...(disabled !== undefined && { disabled }),
        }),
      );
    },
  );

  app.post(
    '/admin/users/:id/password',
    { schema: { params: idParams, body: resetPasswordRequestSchema } },
    async (request, reply) => {
      await users.setPassword(request.params.id, request.body.password);
      return reply.code(204).send();
    },
  );

  app.delete('/admin/users/:id', { schema: { params: idParams } }, async (request, reply) => {
    await users.delete(request.params.id);
    return reply.code(204).send();
  });
  return Promise.resolve();
};
