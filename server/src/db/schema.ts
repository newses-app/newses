import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  customType,
  date,
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
  uuid,
} from 'drizzle-orm/pg-core';

const tstz = (name: string) => timestamp(name, { withTimezone: true });
const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });

// `updated_at` is maintained by the set_updated_at trigger (see migrations), so raw SQL updates bump it too.
const timestamps = () => ({
  createdAt: tstz('created_at').notNull().defaultNow(),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
});

export const userRole = pgEnum('user_role', ['admin', 'user']);
export const sessionKind = pgEnum('session_kind', ['cookie', 'bearer', 'api']);

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
    // API sessions only: the app password that opened it; revoking that ends the session.
    appPasswordId: bigint('app_password_id', { mode: 'number' }).references(() => appPasswords.id, {
      onDelete: 'cascade',
    }),
    createdAt: tstz('created_at').notNull().defaultNow(),
    lastSeenAt: tstz('last_seen_at').notNull().defaultNow(),
    expiresAt: tstz('expires_at').notNull(),
  },
  (t) => [
    index('sessions_user_id_idx').on(t.userId),
    index('sessions_expires_at_idx').on(t.expiresAt),
    index('sessions_app_password_idx').on(t.appPasswordId),
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
    // New entries get their full text extracted, and readers see it first.
    fullText: boolean('full_text').notNull().default(false),
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
    // Normalised feed categories, copied to each subscriber as tags when the entry is fanned out.
    categories: text('categories')
      .array()
      .notNull()
      .default(sql`'{}'`),
    lang: text('lang'),
    // Readability extraction of the linked page, sanitised; the original content is kept.
    fullContent: text('full_content'),
    // Set once extraction was tried, with `full_content_error` when it failed.
    fullContentAt: tstz('full_content_at'),
    fullContentError: text('full_content_error'),
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
    // Imported entries not yet matched to a fetched item, looked up by link when one arrives.
    index('entries_imported_link_idx')
      .on(t.feedSourceId, t.link)
      .where(sql`${t.guid} LIKE 'ttrss:%'`),
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
    score: integer('score').notNull().default(0),
    // Plain text; null when the user has no note on the entry.
    note: text('note'),
    // Public share link id; null when the entry is not shared.
    shareId: uuid('share_id').unique(),
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

export const labels = pgTable(
  'labels',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    caption: text('caption').notNull(),
    // `#rrggbb`
    fgColor: text('fg_color').notNull(),
    bgColor: text('bg_color').notNull(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('labels_user_caption_key').on(t.userId, sql`lower(${t.caption})`),
    index('labels_user_updated_idx').on(t.userId, t.updatedAt),
  ],
);

// Inserts and deletes bump the user entry's updated_at (trigger), so sync carries its labels.
export const entryLabels = pgTable(
  'entry_labels',
  {
    userEntryId: bigint('user_entry_id', { mode: 'number' })
      .notNull()
      .references(() => userEntries.id, { onDelete: 'cascade' }),
    labelId: integer('label_id')
      .notNull()
      .references(() => labels.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.userEntryId, t.labelId] }),
    index('entry_labels_label_idx').on(t.labelId, t.userEntryId),
  ],
);

// Normalised (see `normaliseTag` in shared); inserts and deletes touch the user entry for sync.
export const entryTags = pgTable(
  'entry_tags',
  {
    userEntryId: bigint('user_entry_id', { mode: 'number' })
      .notNull()
      .references(() => userEntries.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tag: text('tag').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userEntryId, t.tag] }),
    index('entry_tags_user_tag_idx').on(t.userId, t.tag, t.userEntryId),
  ],
);

// Filters run on each user's newly delivered entries, in `sort_order`; see `core/filters`.
export const filters = pgTable(
  'filters',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    matchAny: boolean('match_any').notNull().default(false),
    inverse: boolean('inverse').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [index('filters_user_idx').on(t.userId, t.sortOrder)],
);

export const filterRules = pgTable(
  'filter_rules',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    filterId: integer('filter_id')
      .notNull()
      .references(() => filters.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    // title, content, titleOrContent, author, link, tag
    field: text('field').notNull(),
    // RE2 syntax, matched case-insensitively.
    pattern: text('pattern').notNull(),
    inverse: boolean('inverse').notNull().default(false),
    // Scope; both empty for all feeds. Ids of deleted subscriptions and categories match nothing.
    subscriptionIds: integer('subscription_ids')
      .array()
      .notNull()
      .default(sql`'{}'`),
    categoryIds: integer('category_ids')
      .array()
      .notNull()
      .default(sql`'{}'`),
  },
  (t) => [index('filter_rules_filter_idx').on(t.filterId, t.position)],
);

export const filterActions = pgTable(
  'filter_actions',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    filterId: integer('filter_id')
      .notNull()
      .references(() => filters.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    // delete, markRead, star, publish, label, tag, score, stop
    type: text('type').notNull(),
    labelId: integer('label_id').references(() => labels.id, { onDelete: 'cascade' }),
    tag: text('tag'),
    score: integer('score'),
  },
  (t) => [index('filter_actions_filter_idx').on(t.filterId, t.position)],
);

// Secret keys in public URLs (published feed). Stored as is, so the URL can be shown again.
export const accessKeys = pgTable(
  'access_keys',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    purpose: text('purpose').notNull(),
    key: text('key').notNull().unique(),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [unique('access_keys_user_purpose_key').on(t.userId, t.purpose)],
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

// Rows imported from TTRSS, so re-running an import updates them instead of adding copies.
export const importMap = pgTable(
  'import_map',
  {
    sourceTable: text('source_table').notNull(),
    sourceId: bigint('source_id', { mode: 'number' }).notNull(),
    targetId: bigint('target_id', { mode: 'number' }).notNull(),
    // The user the row belongs to; null for shared rows (feed sources, entries).
    userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }),
    importedAt: tstz('imported_at').notNull().defaultNow(),
    // On `ttrss_users` rows: when that user's last import finished.
    completedAt: tstz('completed_at'),
    // On `ttrss_users` rows: the earliest start and latest end of runs that have not finished
    // since; changes in between are the importer's own. A null end means a run was cut short.
    runStartedAt: tstz('run_started_at'),
    runEndedAt: tstz('run_ended_at'),
  },
  (t) => [
    primaryKey({ columns: [t.sourceTable, t.sourceId] }),
    index('import_map_user_idx').on(t.userId),
  ],
);

// Operations reporting for the admin Operations page and alert rules. Rollup counters are added to
// per bucket; rows older than OPS_RETENTION_DAYS are pruned.

// Security-relevant actions, kept AUDIT_RETENTION_DAYS.
export const auditEvents = pgTable(
  'audit_events',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    at: tstz('at').notNull().defaultNow(),
    event: text('event').notNull(),
    // The account the event concerns; null for unknown logins and deleted users.
    userId: integer('user_id').references(() => users.id, { onDelete: 'set null' }),
    // The signed-in user who acted, when that is someone else (an admin).
    actorUserId: integer('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    ip: text('ip'),
    userAgent: text('user_agent'),
    details: jsonb('details').notNull().default({}),
  },
  (t) => [
    index('audit_events_at_idx').on(t.at),
    index('audit_events_user_idx').on(t.userId, t.id.desc()),
  ],
);

// Authenticated API requests per user, day (UTC), and client.
export const userActivityDaily = pgTable(
  'user_activity_daily',
  {
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    day: date('day', { mode: 'string' }).notNull(),
    client: text('client').notNull(),
    requests: integer('requests').notNull().default(0),
    lastSeenAt: tstz('last_seen_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.day, t.client] }),
    index('user_activity_daily_day_idx').on(t.day),
  ],
);

// API requests per hour, client, and status class (`2xx`, `5xx`, ...).
export const requestStatsHourly = pgTable(
  'request_stats_hourly',
  {
    hour: tstz('hour').notNull(),
    client: text('client').notNull(),
    statusClass: text('status_class').notNull(),
    requests: integer('requests').notNull().default(0),
    // Requests that took 2 s or longer.
    slow: integer('slow').notNull().default(0),
    totalMs: bigint('total_ms', { mode: 'number' }).notNull().default(0),
    maxMs: integer('max_ms').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.hour, t.client, t.statusClass] })],
);

// Requests to remote hosts per hour, host, purpose (feed, favicon, ...), and outcome.
export const hostFetchStatsHourly = pgTable(
  'host_fetch_stats_hourly',
  {
    hour: tstz('hour').notNull(),
    host: text('host').notNull(),
    purpose: text('purpose').notNull(),
    outcome: text('outcome').notNull(),
    requests: integer('requests').notNull().default(0),
    bytes: bigint('bytes', { mode: 'number' }).notNull().default(0),
    totalMs: bigint('total_ms', { mode: 'number' }).notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.hour, t.host, t.purpose, t.outcome] }),
    index('host_fetch_stats_hourly_host_idx').on(t.host, t.hour),
  ],
);

// Background job and scheduled task runs per hour.
export const jobStatsHourly = pgTable(
  'job_stats_hourly',
  {
    hour: tstz('hour').notNull(),
    job: text('job').notNull(),
    runs: integer('runs').notNull().default(0),
    failures: integer('failures').notNull().default(0),
    totalMs: bigint('total_ms', { mode: 'number' }).notNull().default(0),
    maxMs: integer('max_ms').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.hour, t.job] })],
);

// Alerts raised by the ops check; at most one open alert per rule and subject (e.g. a host).
export const opsAlerts = pgTable(
  'ops_alerts',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    rule: text('rule').notNull(),
    subject: text('subject').notNull(),
    severity: text('severity').notNull(),
    openedAt: tstz('opened_at').notNull().defaultNow(),
    lastSeenAt: tstz('last_seen_at').notNull().defaultNow(),
    resolvedAt: tstz('resolved_at'),
    details: jsonb('details').notNull().default({}),
  },
  (t) => [
    uniqueIndex('ops_alerts_open_key')
      .on(t.rule, t.subject)
      .where(sql`${t.resolvedAt} IS NULL`),
    index('ops_alerts_opened_at_idx').on(t.openedAt),
  ],
);

// Small operational facts, such as when the ops check last ran.
export const opsState = pgTable('ops_state', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
});
