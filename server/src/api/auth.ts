import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  type SessionRow,
  type SessionService,
  TTL_MS,
  type UserRow,
} from '../core/auth/sessions.ts';
import { HttpError } from './errors.ts';

export const SESSION_COOKIE = 'rss_session';
const CSRF_HEADER = 'x-csrf-token';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface RequestAuth {
  user: UserRow;
  session: SessionRow;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: RequestAuth | null;
  }
}

export function setSessionCookie(reply: FastifyReply, token: string): void {
  void reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: 'auto',
    path: '/',
    maxAge: TTL_MS.cookie / 1000,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  void reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

/**
 * Resolves `Authorization: Bearer` or the session cookie into `request.auth`.
 * Cookie-authenticated unsafe requests must echo the session's CSRF token.
 */
export function registerAuth(app: FastifyInstance, sessions: SessionService): void {
  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (request, reply) => {
    const bearer = /^Bearer\s+(\S+)$/i.exec(request.headers.authorization ?? '')?.[1];
    const token = bearer ?? request.cookies[SESSION_COOKIE];
    if (!token) return;
    const result = await sessions.validate(token);
    if (!result) {
      if (!bearer) clearSessionCookie(reply);
      return;
    }
    if (!bearer) {
      if (result.session.kind !== 'cookie') return;
      if (!SAFE_METHODS.has(request.method)) {
        const header = request.headers[CSRF_HEADER];
        if (header !== result.session.csrfToken) {
          throw new HttpError(403, 'csrf', 'Missing or invalid CSRF token');
        }
      }
      if (result.refreshed) setSessionCookie(reply, token);
    }
    request.auth = { user: result.user, session: result.session };
  });
}

export function requireAuth(request: FastifyRequest): RequestAuth {
  if (!request.auth) throw new HttpError(401, 'unauthenticated', 'Authentication required');
  return request.auth;
}

export async function requireUser(request: FastifyRequest): Promise<void> {
  requireAuth(request);
  return Promise.resolve();
}

export async function requireAdmin(request: FastifyRequest): Promise<void> {
  if (requireAuth(request).user.role !== 'admin') {
    throw new HttpError(403, 'forbidden', 'Admin role required');
  }
  return Promise.resolve();
}
