import type { Category, Session, Subscription, User } from '@rss-reader/shared';
import type { SessionRow, UserRow } from '../core/auth/sessions.ts';
import type { CategoryRow } from '../core/categories.ts';
import type { SubscriptionView } from '../core/feeds/subscriptions.ts';

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

export function toCategory(row: CategoryRow): Category {
  return {
    id: row.id,
    parentId: row.parentId,
    title: row.title,
    sortOrder: row.sortOrder,
    collapsed: row.collapsed,
  };
}

export function toSubscription({ subscription, source }: SubscriptionView): Subscription {
  return {
    id: subscription.id,
    feedSourceId: source.id,
    title: subscription.title ?? source.title ?? source.url,
    customTitle: subscription.title,
    url: source.url,
    siteUrl: source.siteUrl,
    categoryId: subscription.categoryId,
    sortOrder: subscription.sortOrder,
    lastFetchedAt: source.lastFetchedAt?.toISOString() ?? null,
    lastError: source.lastError,
  };
}
