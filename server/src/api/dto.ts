import {
  type AppPassword,
  BUILTIN_THEME_KEYS,
  type BuiltinThemeKey,
  type Category,
  type IntervalReason,
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

/** How often the subscription's feed is checked, and why, as its user should see it. */
function scheduleOf(
  { subscription, source }: SubscriptionView,
  userIntervalSeconds: number,
): Pick<Subscription, 'effectiveIntervalMinutes' | 'intervalReason' | 'nextFetchAt'> {
  if (subscription.paused)
    return { effectiveIntervalMinutes: null, intervalReason: 'paused', nextFetchAt: null };
  if (source.lastFetchedAt === null)
    return { effectiveIntervalMinutes: null, intervalReason: null, nextFetchAt: null };
  const own = subscription.updateIntervalSeconds ?? userIntervalSeconds;
  const seconds = source.fetchIntervalSeconds;
  const reason = source.fetchIntervalReason;
  let intervalReason: IntervalReason = 'own';
  if (reason === 'publisher' || reason === 'slowdown' || reason === 'siteMinimum')
    intervalReason = reason;
  else if (seconds < own) intervalReason = 'shared';
  return {
    effectiveIntervalMinutes: Math.max(1, Math.round(seconds / 60)),
    intervalReason,
    nextFetchAt: source.disabledAt === null ? source.nextFetchAt.toISOString() : null,
  };
}

/** `userIntervalSeconds` is the user's default interval (`FeedUpdater.userIntervalSeconds`). */
export function toSubscription(view: SubscriptionView, userIntervalSeconds: number): Subscription {
  const { subscription, source } = view;
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
    paused: subscription.paused,
    hideFromAll: subscription.hideFromAll,
    ...scheduleOf(view, userIntervalSeconds),
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
