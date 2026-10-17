import {
  type AppPassword,
  BUILTIN_THEME_KEYS,
  type BuiltinThemeKey,
  type Category,
  type Label,
  partialThemeTokensSchema,
  type Session,
  type Subscription,
  type Theme,
  type User,
} from '@newses/shared';
import type { AppPasswordRow } from '../core/auth/app-passwords.ts';
import type { SessionRow, UserRow } from '../core/auth/sessions.ts';
import type { CategoryRow } from '../core/categories.ts';
import type { LabelRow } from '../core/entries/labels.ts';
import type { SubscriptionView } from '../core/feeds/subscriptions.ts';
import type { ThemeView } from '../core/themes.ts';

export function toUser(row: UserRow): User {
  return {
    id: row.id,
    login: row.login,
    role: row.role,
    disabled: row.disabledAt !== null,
    twoFactor: row.totpEnabledAt !== null,
    passwordChangeRequired: row.passwordChangeRequired,
    createdAt: row.createdAt.toISOString(),
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
  };
}

export function toAppPassword(row: AppPasswordRow): AppPassword {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
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
    // Icon keys name their content, so the icon is served at its key, cached for good.
    iconUrl: source.faviconKey ? `/${source.faviconKey}` : null,
    lastFetchedAt: source.lastFetchedAt?.toISOString() ?? null,
    lastError: source.lastError,
    lastErrorAt: source.lastErrorAt?.toISOString() ?? null,
    errorCount: source.errorCount,
    disabled: source.disabledAt !== null,
    updateIntervalMinutes:
      subscription.updateIntervalSeconds === null
        ? null
        : Math.round(subscription.updateIntervalSeconds / 60),
    purgeDays: subscription.purgeDays,
    fullText: subscription.fullText,
  };
}

export function toLabel(row: LabelRow): Label {
  return { id: row.id, caption: row.caption, fgColor: row.fgColor, bgColor: row.bgColor };
}

export function toTheme({ theme, ownerLogin }: ThemeView, userId: number): Theme {
  // Values a later version no longer accepts fall back, so the theme still shows its base.
  const base = BUILTIN_THEME_KEYS.find((key) => key === theme.base);
  const tokens = partialThemeTokensSchema.safeParse(theme.tokens);
  return {
    id: theme.id,
    name: theme.name,
    base: base ?? ('original' satisfies BuiltinThemeKey),
    tokens: tokens.success ? tokens.data : {},
    shared: theme.shared,
    owner: { id: theme.ownerId, login: ownerLogin },
    mine: theme.ownerId === userId,
    updatedAt: theme.updatedAt.toISOString(),
  };
}
