import {
  appConnectionSchema,
  appPasswordSchema,
  changePasswordRequestSchema,
  createAppPasswordRequestSchema,
  createAppPasswordResponseSchema,
  currentSessionSchema,
  loggedInResponseSchema,
  loginRequestSchema,
  loginResponseSchema,
  loginTwoFactorRequestSchema,
  recoveryCodesResponseSchema,
  sessionSchema,
  twoFactorCodeRequestSchema,
  twoFactorDisableRequestSchema,
  twoFactorSetupRequestSchema,
  twoFactorSetupResponseSchema,
  twoFactorStatusSchema,
} from '@rss-reader/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { AuthService, LoggedIn } from '../../core/auth/auth-service.ts';
import type { AppPasswordService } from '../../core/auth/app-passwords.ts';
import type { SessionService } from '../../core/auth/sessions.ts';
import type { TwoFactorService } from '../../core/auth/two-factor.ts';
import { DomainError } from '../../core/errors.ts';
import { clearSessionCookie, requireAuth, requireUser, setSessionCookie } from '../auth.ts';
import { toAppPassword, toSession, toUser } from '../dto.ts';
import { logSecurity, type SecurityEvent } from '../security-log.ts';

export interface AuthRoutesOptions {
  auth: AuthService;
  sessions: SessionService;
  twoFactor: TwoFactorService;
  appPasswords: AppPasswordService;
  /** Origin shown to apps; null uses each request's origin. */
  publicUrl: string | null;
}

/** Apps polling more often than this keep the AWS database from pausing. */
export const SYNC_INTERVAL_MINUTES = 60;

/** Logs `event` when `work` fails with a domain error (wrong password, wrong code, lockout). */
async function logFailure<T>(
  request: FastifyRequest,
  event: SecurityEvent,
  work: () => Promise<T>,
  fields: Record<string, unknown> = {},
): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof DomainError) {
      logSecurity(request, err.code === 'throttled' ? 'login_throttled' : event, fields);
    }
    throw err;
  }
}

/** A new login ends the session the client was holding, so a planted session cannot survive it. */
async function sessionResponse(
  request: FastifyRequest,
  reply: FastifyReply,
  sessions: SessionService,
  result: LoggedIn,
) {
  const { token, session, user } = result;
  if (request.auth) await sessions.revoke(request.auth.user.id, request.auth.session.id);
  logSecurity(request, 'login', { userId: user.id, kind: session.kind });
  if (session.kind === 'bearer') return { user: toUser(user), token };
  setSessionCookie(reply, token);
  return { user: toUser(user), csrfToken: session.csrfToken ?? undefined };
}

export const authRoutes: FastifyPluginAsyncZod<AuthRoutesOptions> = (
  app,
  { auth, sessions, twoFactor, appPasswords, publicUrl },
) => {
  const client = (request: FastifyRequest) => ({
    ip: request.ip,
    userAgent: request.headers['user-agent'] ?? null,
  });

  app.post(
    '/auth/login',
    { schema: { body: loginRequestSchema, response: { 200: loginResponseSchema } } },
    async (request, reply) => {
      const { login, password, tokenType } = request.body;
      const result = await logFailure(
        request,
        'login_failed',
        () => auth.login({ login, password, kind: tokenType, ...client(request) }),
        { login },
      );
      if ('challenge' in result) {
        logSecurity(request, 'login_second_factor_required', { userId: result.user.id });
        return { twoFactorRequired: true as const, challenge: result.challenge };
      }
      return sessionResponse(request, reply, sessions, result);
    },
  );

  app.post(
    '/auth/login/2fa',
    { schema: { body: loginTwoFactorRequestSchema, response: { 200: loggedInResponseSchema } } },
    async (request, reply) => {
      const result = await logFailure(request, 'two_factor_failed', () =>
        auth.completeLogin({ ...request.body, ...client(request) }),
      );
      return sessionResponse(request, reply, sessions, result);
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
      await logFailure(request, 'password_change_failed', () =>
        auth.changePassword(user, session.id, currentPassword, newPassword),
      );
      logSecurity(request, 'password_changed');
      return reply.code(204).send();
    },
  );

  app.get(
    '/auth/app-passwords',
    { preHandler: requireUser, schema: { response: { 200: z.array(appPasswordSchema) } } },
    async (request) => (await appPasswords.list(requireAuth(request).user.id)).map(toAppPassword),
  );

  app.get(
    '/auth/app-passwords/connection',
    { preHandler: requireUser, schema: { response: { 200: appConnectionSchema } } },
    (request) => ({
      serverUrl: publicUrl ?? `${request.protocol}://${request.host}`,
      syncIntervalMinutes: SYNC_INTERVAL_MINUTES,
    }),
  );

  app.post(
    '/auth/app-passwords',
    {
      preHandler: requireUser,
      schema: {
        body: createAppPasswordRequestSchema,
        response: { 201: createAppPasswordResponseSchema },
      },
    },
    async (request, reply) => {
      const { user } = requireAuth(request);
      const created = await logFailure(request, 'app_password_create_failed', () =>
        auth.createAppPassword(user, request.body.password, request.body.name),
      );
      logSecurity(request, 'app_password_created', { appPasswordId: created.appPassword.id });
      return reply
        .code(201)
        .send({ appPassword: toAppPassword(created.appPassword), password: created.password });
    },
  );

  app.delete(
    '/auth/app-passwords/:id',
    { preHandler: requireUser, schema: { params: z.object({ id: z.coerce.number().int() }) } },
    async (request, reply) => {
      await appPasswords.revoke(requireAuth(request).user.id, request.params.id);
      logSecurity(request, 'app_password_revoked', { appPasswordId: request.params.id });
      return reply.code(204).send();
    },
  );

  app.get(
    '/auth/2fa',
    { preHandler: requireUser, schema: { response: { 200: twoFactorStatusSchema } } },
    async (request) => {
      const { user } = requireAuth(request);
      return {
        enabled: user.totpEnabledAt !== null,
        recoveryCodesLeft: await twoFactor.recoveryCodesLeft(user.id),
      };
    },
  );

  app.post(
    '/auth/2fa/setup',
    {
      preHandler: requireUser,
      schema: {
        body: twoFactorSetupRequestSchema,
        response: { 200: twoFactorSetupResponseSchema },
      },
    },
    async (request) => {
      const { user } = requireAuth(request);
      const setup = await logFailure(request, 'two_factor_failed', () =>
        auth.beginTwoFactor(user, request.body.password),
      );
      logSecurity(request, 'two_factor_setup_started');
      return setup;
    },
  );

  app.post(
    '/auth/2fa/enable',
    {
      preHandler: requireUser,
      schema: { body: twoFactorCodeRequestSchema, response: { 200: recoveryCodesResponseSchema } },
    },
    async (request) => {
      const { user, session } = requireAuth(request);
      const recoveryCodes = await logFailure(request, 'two_factor_failed', () =>
        auth.enableTwoFactor(user, session.id, request.body.code),
      );
      logSecurity(request, 'two_factor_enabled');
      return { recoveryCodes };
    },
  );

  app.post(
    '/auth/2fa/disable',
    { preHandler: requireUser, schema: { body: twoFactorDisableRequestSchema } },
    async (request, reply) => {
      const { user } = requireAuth(request);
      await logFailure(request, 'two_factor_failed', () =>
        auth.disableTwoFactor(user, request.body.password, request.body.code),
      );
      logSecurity(request, 'two_factor_disabled');
      return reply.code(204).send();
    },
  );

  app.post(
    '/auth/2fa/recovery-codes',
    {
      preHandler: requireUser,
      schema: { body: twoFactorCodeRequestSchema, response: { 200: recoveryCodesResponseSchema } },
    },
    async (request) => {
      const { user } = requireAuth(request);
      const recoveryCodes = await logFailure(request, 'two_factor_failed', () =>
        auth.regenerateRecoveryCodes(user, request.body.code),
      );
      logSecurity(request, 'recovery_codes_regenerated');
      return { recoveryCodes };
    },
  );
  return Promise.resolve();
};
