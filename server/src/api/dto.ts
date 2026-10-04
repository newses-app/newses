import type { Session, User } from '@rss-reader/shared';
import type { SessionRow, UserRow } from '../core/auth/sessions.ts';

export function toUser(row: UserRow): User {
  return {
    id: row.id,
    login: row.login,
    role: row.role,
    disabled: row.disabledAt !== null,
    createdAt: row.createdAt.toISOString(),
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
  };
}

export function toSession(row: SessionRow, currentId: number): Session {
  return {
    id: row.id,
    kind: row.kind,
    userAgent: row.userAgent,
    createdAt: row.createdAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    current: row.id === currentId,
  };
}
