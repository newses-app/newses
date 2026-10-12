import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  type SessionRow,
  type SessionService,
  TTL_MS,
  type UserRow,
} from '../core/auth/sessions.ts';
import { HttpError } from './errors.ts';
import { attributeUser } from './ops-tracking.ts';
import { logSecurity } from './security-log.ts';

/** Over HTTPS the `__Host-` prefix pins the cookie to this host, Secure, and path `/`. */
export const SESSION_COOKIE = '__Host-rss_session';
/** Plain-HTTP deployments (a LAN without TLS) cannot use the prefix. */
export const INSECURE_SESSION_COOKIE = 'rss_session';
const CSRF_HEADER = 'x-csrf-token';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
/** All a user whose password must be changed may do. */
const PASSWORD_CHANGE_ROUTES = new Set([
  '/api/v1/auth/login',
  '/api/v1/auth/login/2fa',
  '/api/v1/auth/session',
  '/api/v1/auth/password',
  '/api/v1/auth/logout',
  '/api/v1/server',
]);

export interface RequestAuth {
  user: UserRow;
  session: SessionRow;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: RequestAuth | null;
  }
}

const isHttps = (request: FastifyRequest) => request.protocol === 'https';

export const sessionCookieName = (request: FastifyRequest) =>
  isHttps(request) ? SESSION_COOKIE : INSECURE_SESSION_COOKIE;

export function setSessionCookie(reply: FastifyReply, token: string): void {
  void reply.setCookie(sessionCookieName(reply.request), token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isHttps(reply.request),
    path: '/',
    maxAge: TTL_MS.cookie / 1000,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  void reply.clearCookie(sessionCookieName(reply.request), {
    path: '/',
    secure: isHttps(reply.request),
  });
}

function csrfMatches(header: string | string[] | undefined, expected: string | null): boolean {
  if (typeof header !== 'string' || !expected) return false;
  const given = Buffer.from(header);
  const wanted = Buffer.from(expected);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

/**
 * Resolves `Authorization: Bearer` or the session cookie into `request.auth`.
 * Cookie-authenticated unsafe requests must echo the session's CSRF token.
 */
export function registerAuth(app: FastifyInstance, sessions: SessionService): void {
  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (request, reply) => {
    const bearer = /^Bearer\s+(\S+)$/i.exec(request.headers.authorization ?? '')?.[1];
    const token = bearer ?? request.cookies[sessionCookieName(request)];
    if (!token) return;
    const result = await sessions.validate(token);
    if (!result) {
      if (!bearer) clearSessionCookie(reply);
      return;
    }
    // App-password sessions reach only the compatibility APIs.
    if (result.session.kind === 'api') return;
    if (!bearer) {
      if (result.session.kind !== 'cookie') return;
      if (!SAFE_METHODS.has(request.method)) {
        if (!csrfMatches(request.headers[CSRF_HEADER], result.session.csrfToken)) {
          logSecurity(request, 'csrf_rejected', { userId: result.user.id });
          throw new HttpError(403, 'csrf', 'Missing or invalid CSRF token');
        }
      }
      if (result.refreshed) setSessionCookie(reply, token);
    }
    if (
      result.user.passwordChangeRequired &&
      !PASSWORD_CHANGE_ROUTES.has(request.routeOptions.url ?? '')
    ) {
      throw new HttpError(403, 'password_change_required', 'Change your password first');
    }
    request.auth = { user: result.user, session: result.session };
    attributeUser(request, result.user.id);
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
