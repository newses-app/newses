import type { FastifyRequest } from 'fastify';
import type { AuditLog } from '../core/ops/audit.ts';

declare module 'fastify' {
  interface FastifyInstance {
    /** Persists security events; null where there is no database (tests of the bare app). */
    audit: AuditLog | null;
  }
}

export type SecurityEvent =
  | 'login'
  | 'login_failed'
  | 'login_throttled'
  | 'login_second_factor_required'
  | 'logout'
  | 'csrf_rejected'
  | 'session_revoked'
  | 'password_changed'
  | 'password_change_failed'
  | 'two_factor_setup_started'
  | 'two_factor_enabled'
  | 'two_factor_disabled'
  | 'two_factor_failed'
  | 'recovery_codes_regenerated'
  | 'app_password_created'
  | 'app_password_create_failed'
  | 'app_password_revoked'
  | 'user_created'
  | 'user_updated'
  | 'user_password_reset'
  | 'user_deleted'
  | 'user_two_factor_reset';

const WARN = new Set<SecurityEvent>([
  'login_failed',
  'login_throttled',
  'csrf_rejected',
  'password_change_failed',
  'two_factor_failed',
  'app_password_create_failed',
]);

/**
 * One structured log line per security-relevant action, queryable by `security`, also kept in the
 * audit log. `targetUserId` names the account an admin acted on; `userId` the account otherwise.
 */
export function logSecurity(
  request: FastifyRequest,
  event: SecurityEvent,
  fields: Record<string, unknown> = {},
): void {
  const actorId = request.auth?.user.id ?? null;
  const entry = { security: event, ip: request.ip, userId: request.auth?.user.id, ...fields };
  if (WARN.has(event)) request.log.warn(entry, `Security: ${event}`);
  else request.log.info(entry, `Security: ${event}`);

  const { userId, targetUserId, ...details } = fields;
  const subject = numberOr(targetUserId, numberOr(userId, actorId));
  request.server.audit?.record({
    event,
    userId: subject,
    actorUserId: actorId !== null && actorId !== subject ? actorId : null,
    ip: request.ip,
    userAgent: request.headers['user-agent']?.slice(0, 500) ?? null,
    details,
  });
}

const numberOr = (value: unknown, fallback: number | null) =>
  typeof value === 'number' ? value : fallback;
