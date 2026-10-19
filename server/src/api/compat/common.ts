import type { FastifyRequest } from 'fastify';
import type { AuthService, LoggedIn } from '../../core/auth/auth-service.ts';
import type { SessionRow, SessionService, UserRow } from '../../core/auth/sessions.ts';
import { DomainError } from '../../core/errors.ts';
import { logSecurity } from '../security-log.ts';

/** The compatibility protocols, as named in logs. */
export type CompatProtocol = 'ttrss' | 'greader';

export interface CompatServices {
  auth: AuthService;
  sessions: SessionService;
}

export interface CompatOptions {
  /** Log every call with its parameters, credentials redacted. */
  trace: boolean;
}

export interface CompatAuth {
  user: UserRow;
  session: SessionRow;
}

/**
 * The live `api` session for `token`: null when there is none (other session kinds included),
 * or `password_change_required` while the user must change their password first (ADR 0038).
 */
export async function compatSession(
  sessions: SessionService,
  token: string | undefined,
): Promise<CompatAuth | 'password_change_required' | null> {
  if (!token) return null;
  const result = await sessions.validate(token);
  if (result?.session.kind !== 'api') return null;
  if (result.user.passwordChangeRequired) return 'password_change_required';
  return { user: result.user, session: result.session };
}

/** Logs in with an app password, logging the outcome as the native login does. */
export async function openAppSession(
  request: FastifyRequest,
  auth: AuthService,
  login: string,
  password: string,
): Promise<LoggedIn> {
  try {
    const result = await auth.openAppSession({
      login,
      password,
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
    });
    logSecurity(request, 'login', { userId: result.user.id, kind: 'api' });
    return result;
  } catch (err) {
    if (err instanceof DomainError) {
      logSecurity(request, err.code === 'throttled' ? 'login_throttled' : 'login_failed', {
        login,
        kind: 'api',
      });
    }
    throw err;
  }
}

/** Parameter names whose values are credentials or session tokens. */
const SECRET = /pass|sid|auth|token|^t$/i;
const MAX_LOGGED_CHARS = 200;

/** Parameters with credentials replaced and long values cut, for logs. */
export function redact(params: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(params).map(([key, value]) => [
      key,
      SECRET.test(key)
        ? '[redacted]'
        : typeof value === 'string' && value.length > MAX_LOGGED_CHARS
          ? `${value.slice(0, MAX_LOGGED_CHARS)}…`
          : value,
    ]),
  );
}

/**
 * Records a call a client made that the server does not implement, so gaps show in the logs;
 * Google Reader `feed/<url>` stream ids keep only their kind, as feed URLs stay out of the logs.
 */
export function logUnsupported(request: FastifyRequest, protocol: CompatProtocol, call: string) {
  const unsupported = call.replace(/feed\/\S+/g, 'feed/…');
  request.log.warn(
    { compat: protocol, unsupported, userAgent: request.headers['user-agent'] },
    'Unsupported compatibility call',
  );
}

/** With tracing on, records each call and its parameters, for building contract fixtures. */
export function traceCall(
  request: FastifyRequest,
  options: CompatOptions,
  protocol: CompatProtocol,
  call: string,
  params: Record<string, unknown>,
) {
  if (!options.trace) return;
  request.log.info(
    { compat: protocol, call, params: redact(params), userAgent: request.headers['user-agent'] },
    'Compatibility call',
  );
}
