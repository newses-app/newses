import type { FastifyRequest } from 'fastify';

export type SecurityEvent =
  | 'login'
  | 'login_failed'
  | 'login_throttled'
  | 'logout'
  | 'csrf_rejected'
  | 'session_revoked'
  | 'password_changed'
  | 'password_change_failed'
  | 'user_created'
  | 'user_updated'
  | 'user_password_reset'
  | 'user_deleted';

const WARN = new Set<SecurityEvent>([
  'login_failed',
  'login_throttled',
  'csrf_rejected',
  'password_change_failed',
]);

/** One structured log line per security-relevant action, queryable by `security`. */
export function logSecurity(
  request: FastifyRequest,
  event: SecurityEvent,
  fields: Record<string, unknown> = {},
): void {
  const entry = { security: event, ip: request.ip, userId: request.auth?.user.id, ...fields };
  if (WARN.has(event)) request.log.warn(entry, `Security: ${event}`);
  else request.log.info(entry, `Security: ${event}`);
}
