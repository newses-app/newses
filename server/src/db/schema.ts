import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

const tstz = (name: string) => timestamp(name, { withTimezone: true });
const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });

// `updated_at` is maintained by the set_updated_at trigger (see migrations), so raw SQL updates bump it too.
const timestamps = () => ({
  createdAt: tstz('created_at').notNull().defaultNow(),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
});

export const userRole = pgEnum('user_role', ['admin', 'user']);
export const sessionKind = pgEnum('session_kind', ['cookie', 'bearer']);

export const users = pgTable(
  'users',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    login: text('login').notNull(),
    passwordHash: text('password_hash').notNull(),
    role: userRole('role').notNull().default('user'),
    disabledAt: tstz('disabled_at'),
    lastLoginAt: tstz('last_login_at'),
    // Set for a generated initial password; only changing the password is allowed until cleared.
    passwordChangeRequired: boolean('password_change_required').notNull().default(false),
    // Sealed TOTP secret; set while enrolling, required at login once `totp_enabled_at` is set.
    totpSecret: text('totp_secret'),
    totpEnabledAt: tstz('totp_enabled_at'),
    // Last accepted time step, so a code cannot be used twice.
    totpLastStep: bigint('totp_last_step', { mode: 'number' }),
    ...timestamps(),
  },
  (t) => [uniqueIndex('users_login_key').on(sql`lower(${t.login})`)],
);

export const recoveryCodes = pgTable(
  'recovery_codes',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
    usedAt: tstz('used_at'),
  },
  (t) => [index('recovery_codes_user_id_idx').on(t.userId)],
);

export const sessions = pgTable(
  'sessions',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    kind: sessionKind('kind').notNull(),
    userAgent: text('user_agent'),
    // Cookie sessions only; sent back by the web app in X-CSRF-Token.
    csrfToken: text('csrf_token'),
    createdAt: tstz('created_at').notNull().defaultNow(),
    lastSeenAt: tstz('last_seen_at').notNull().defaultNow(),
    expiresAt: tstz('expires_at').notNull(),
  },
  (t) => [
    index('sessions_user_id_idx').on(t.userId),
    index('sessions_expires_at_idx').on(t.expiresAt),
  ],
);

// Passwords for compatibility-API clients that cannot do 2FA; only the hash is kept.
export const appPasswords = pgTable(
  'app_passwords',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    createdAt: tstz('created_at').notNull().defaultNow(),
    lastUsedAt: tstz('last_used_at'),
  },
  (t) => [index('app_passwords_user_id_idx').on(t.userId)],
);

// Image proxy cache index: the blob lives at `key`; failures are remembered so hosts are not
// asked again until the entry expires.
export const imageCache = pgTable(
  'image_cache',
  {
    key: text('key').primaryKey(),
    fetchedAt: tstz('fetched_at').notNull().defaultNow(),
    size: integer('size').notNull().default(0),
    failed: boolean('failed').notNull().default(false),
  },
  (t) => [index('image_cache_fetched_at_idx').on(t.fetchedAt)],
);

// Failed-login counters keyed by `login:<name>` or `ip:<address>`.
export const loginAttempts = pgTable('login_attempts', {
  key: text('key').primaryKey(),
  failures: integer('failures').notNull().default(0),
  lockedUntil: tstz('locked_until'),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
});

export const userPrefs = pgTable(
  'user_prefs',
  {
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    value: jsonb('value').notNull(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.key] })],
);

export const categories = pgTable(
  'categories',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    parentId: integer('parent_id').references((): AnyPgColumn => categories.id, {
      onDelete: 'set null',
    }),
    title: text('title').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    collapsed: boolean('collapsed').notNull().default(false),
    ...timestamps(),
  },
  (t) => [
    index('categories_user_parent_idx').on(t.userId, t.parentId),
    unique('categories_user_parent_title_key').on(t.userId, t.parentId, t.title).nullsNotDistinct(),
  ],
);

export const feedSources = pgTable(
  'feed_sources',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    url: text('url').notNull().unique(),
    siteUrl: text('site_url'),
    title: text('title'),
    etag: text('etag'),
    lastModified: text('last_modified'),
    fetchIntervalSeconds: integer('fetch_interval_seconds').notNull().default(1800),
    nextFetchAt: tstz('next_fetch_at').notNull().defaultNow(),
    lastFetchedAt: tstz('last_fetched_at'),
    errorCount: integer('error_count').notNull().default(0),
    lastError: text('last_error'),
    lastErrorAt: tstz('last_error_at'),
    disabledAt: tstz('disabled_at'),
    // Publisher's update hint from the feed document (RSS ttl, sy:updatePeriod).
    ttlSeconds: integer('ttl_seconds'),
    // No fetch, manual or scheduled, before this time (the host's Retry-After).
    blockedUntil: tstz('blocked_until'),
    faviconKey: text('favicon_key'),
    faviconCheckedAt: tstz('favicon_checked_at'),
    ...timestamps(),
  },
  (t) => [
    index('feed_sources_due_idx')
      .on(t.nextFetchAt)
      .where(sql`${t.disabledAt} IS NULL`),
  ],
);

// Hosts that asked for no requests before `blocked_until` (429, or 503 with Retry-After).
export const fetchHosts = pgTable('fetch_hosts', {
  host: text('host').primaryKey(),
  blockedUntil: tstz('blocked_until').notNull(),
});

export const subscriptions = pgTable(
  'subscriptions',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    feedSourceId: integer('feed_source_id')
      .notNull()
      .references(() => feedSources.id, { onDelete: 'cascade' }),
    categoryId: integer('category_id').references(() => categories.id, { onDelete: 'set null' }),
    title: text('title'),
    updateIntervalSeconds: integer('update_interval_seconds'),
    purgeDays: integer('purge_days'),
    sortOrder: integer('sort_order').notNull().default(0),
    ...timestamps(),
  },
  (t) => [
    unique('subscriptions_user_feed_source_key').on(t.userId, t.feedSourceId),
    index('subscriptions_user_category_idx').on(t.userId, t.categoryId),
    index('subscriptions_feed_source_idx').on(t.feedSourceId),
  ],
);

export const entries = pgTable(
  'entries',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    feedSourceId: integer('feed_source_id')
      .notNull()
      .references(() => feedSources.id, { onDelete: 'cascade' }),
    guid: text('guid').notNull(),
    link: text('link'),
    title: text('title'),
    author: text('author'),
    content: text('content'),
    contentHash: text('content_hash').notNull(),
    lang: text('lang'),
    publishedAt: tstz('published_at'),
    sourceUpdatedAt: tstz('source_updated_at'),
    fetchedAt: tstz('fetched_at').notNull().defaultNow(),
    // Last fetch whose document still contained the entry; purge keeps unreferenced entries until
    // they leave the feed, so they are not re-ingested as new.
    lastSeenAt: tstz('last_seen_at').notNull().defaultNow(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
    // Tags and entities stripped; content capped so the tsvector stays under Postgres's 1 MB limit.
    search: tsvector('search').generatedAlwaysAs(
      sql`setweight(to_tsvector('simple', coalesce(title, '')), 'A') || setweight(to_tsvector('simple', regexp_replace(left(coalesce(content, ''), 200000), '<[^>]*>|&[#a-zA-Z0-9]+;', ' ', 'g')), 'B')`,
    ),
  },
  (t) => [
    unique('entries_feed_source_guid_key').on(t.feedSourceId, t.guid),
    index('entries_feed_source_published_idx').on(t.feedSourceId, t.publishedAt.desc()),
    index('entries_search_idx').using('gin', t.search),
    index('entries_last_seen_idx').on(t.lastSeenAt),
  ],
);

export const enclosures = pgTable(
  'enclosures',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    entryId: bigint('entry_id', { mode: 'number' })
      .notNull()
      .references(() => entries.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    mimeType: text('mime_type'),
    length: bigint('length', { mode: 'number' }),
    width: integer('width'),
    height: integer('height'),
    durationSeconds: integer('duration_seconds'),
  },
  (t) => [unique('enclosures_entry_url_key').on(t.entryId, t.url)],
);

export const userEntries = pgTable(
  'user_entries',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    entryId: bigint('entry_id', { mode: 'number' })
      .notNull()
      .references(() => entries.id, { onDelete: 'cascade' }),
    subscriptionId: integer('subscription_id').references(() => subscriptions.id, {
      onDelete: 'set null',
    }),
    // Denormalised coalesce(published_at, fetched_at) so headline lists paginate on one index.
    sortAt: tstz('sort_at').notNull(),
    unread: boolean('unread').notNull().default(true),
    starred: boolean('starred').notNull().default(false),
    published: boolean('published').notNull().default(false),
    readAt: tstz('read_at'),
    // Plain text; null when the user has no note on the entry.
    note: text('note'),
    ...timestamps(),
  },
  (t) => [
    unique('user_entries_user_entry_key').on(t.userId, t.entryId),
    index('user_entries_entry_idx').on(t.entryId),
    index('user_entries_user_sort_idx').on(t.userId, t.sortAt.desc(), t.id.desc()),
    index('user_entries_subscription_sort_idx').on(t.subscriptionId, t.sortAt.desc(), t.id.desc()),
    index('user_entries_unread_sort_idx')
      .on(t.userId, t.sortAt.desc(), t.id.desc())
      .where(sql`${t.unread}`),
    index('user_entries_starred_sort_idx')
      .on(t.userId, t.sortAt.desc(), t.id.desc())
      .where(sql`${t.starred}`),
    index('user_entries_published_sort_idx')
      .on(t.userId, t.sortAt.desc(), t.id.desc())
      .where(sql`${t.published}`),
    index('user_entries_read_at_idx')
      .on(t.userId, t.readAt.desc())
      .where(sql`${t.readAt} IS NOT NULL`),
    index('user_entries_user_updated_idx').on(t.userId, t.updatedAt),
    // Expression index over the few rows with notes, so search pays nothing for the rest.
    index('user_entries_note_search_idx')
      .using('gin', sql`to_tsvector('simple', ${t.note})`)
      .where(sql`${t.note} IS NOT NULL`),
  ],
);

export const tombstones = pgTable(
  'tombstones',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    entity: text('entity').notNull(),
    entityId: bigint('entity_id', { mode: 'number' }).notNull(),
    deletedAt: tstz('deleted_at').notNull().defaultNow(),
  },
  (t) => [index('tombstones_user_deleted_idx').on(t.userId, t.deletedAt)],
);
