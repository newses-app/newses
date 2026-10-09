import { z } from 'zod';
import { categorySchema, subscriptionSchema } from './feeds.ts';
import { labelSchema } from './labels.ts';
import { MAX_NOTE_LENGTH, MAX_SCORE, MAX_TAG_LENGTH, MAX_TAGS_PER_ENTRY } from './limits.ts';
import { headlineOrderSchema, viewModeSchema } from './prefs.ts';

export const specialFeedSchema = z.enum(['all', 'fresh', 'starred', 'published', 'recentlyRead']);

/**
 * One of `subscriptionId`, `categoryId` (0 = uncategorised; includes subcategories), `labelId`,
 * `tag` (normalised), or `special`.
 */
export const streamSchema = z.object({
  subscriptionId: z.coerce.number().int().optional(),
  categoryId: z.coerce.number().int().optional(),
  labelId: z.coerce.number().int().optional(),
  tag: z.string().min(1).max(MAX_TAG_LENGTH).optional(),
  special: specialFeedSchema.optional(),
});

const singleStream = (stream: z.infer<typeof streamSchema>) =>
  [stream.subscriptionId, stream.categoryId, stream.labelId, stream.tag, stream.special].filter(
    (v) => v !== undefined,
  ).length <= 1;
const ONE_STREAM = {
  message: 'Give at most one of subscriptionId, categoryId, labelId, tag, special',
};

export const entryListQuerySchema = streamSchema
  .extend({
    view: viewModeSchema.default('all'),
    /** `relevance` requires `q`; it is the default when `q` is given. */
    order: z.enum([...headlineOrderSchema.options, 'relevance']).optional(),
    /** Full-text search over title and content. */
    q: z.string().trim().min(1).max(500).optional(),
    cursor: z.string().max(1000).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    /** Include content and enclosures (combined layout). */
    content: z.stringbool().default(false),
  })
  .refine(singleStream, ONE_STREAM);

export const enclosureSchema = z.object({
  url: z.string(),
  mimeType: z.string().nullable(),
  length: z.number().nullable(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  durationSeconds: z.number().int().nullable(),
});

export const entrySchema = z.object({
  id: z.number().int(),
  /** Null once the feed has been unsubscribed and the entry kept (starred, published, noted, labelled, or shared). */
  subscriptionId: z.number().int().nullable(),
  feedTitle: z.string().nullable(),
  title: z.string().nullable(),
  link: z.string().nullable(),
  author: z.string().nullable(),
  publishedAt: z.iso.datetime().nullable(),
  /** Headline sort time: publication time, else fetch time. */
  sortAt: z.iso.datetime(),
  unread: z.boolean(),
  starred: z.boolean(),
  published: z.boolean(),
  /** The user's score; lists highlight entries above and hide entries below the user's thresholds. */
  score: z.number().int(),
  /** The user's plain-text note; null when there is none. */
  note: z.string().nullable(),
  /** Ids of the user's labels on the entry. */
  labels: z.array(z.number().int()),
  /** The user's tags on the entry, normalised and sorted. */
  tags: z.array(z.string()),
  /** Public share link id (`/public/share/<id>`); null when not shared. */
  shareId: z.uuid().nullable(),
  /** Plain-text start of the content. */
  excerpt: z.string().nullable(),
  /** Sanitised HTML; present on single entries and when requested in lists. */
  content: z.string().nullable().optional(),
  /** Readability extraction of the linked page, sanitised; present with content once extracted. */
  fullContent: z.string().nullable().optional(),
  enclosures: z.array(enclosureSchema).optional(),
});

export const entryListResponseSchema = z.object({
  entries: z.array(entrySchema),
  /** Pass back as `cursor` for the next page; null on the last page. */
  cursor: z.string().nullable(),
  /** The view applied; `adaptive` resolves to `unread` or `all`. */
  view: z.enum(['all', 'unread']),
});

const scoreSchema = z.number().int().min(-MAX_SCORE).max(MAX_SCORE);

export const entryStateSchema = z
  .object({ unread: z.boolean(), starred: z.boolean(), published: z.boolean(), score: scoreSchema })
  .partial()
  .refine((s) => Object.keys(s).length > 0, { message: 'Set at least one flag' });

export const bulkEntryStateRequestSchema = z
  .object({
    ids: z.array(z.number().int()).min(1).max(1000),
    unread: z.boolean().optional(),
    starred: z.boolean().optional(),
    published: z.boolean().optional(),
    score: scoreSchema.optional(),
  })
  .refine(
    (s) =>
      s.unread !== undefined ||
      s.starred !== undefined ||
      s.published !== undefined ||
      s.score !== undefined,
    { message: 'Set at least one flag' },
  );

/** Null or blank text clears the note. */
export const entryNoteRequestSchema = z.object({
  note: z.string().max(MAX_NOTE_LENGTH).nullable(),
});

/** Replaces the entry's tags; they are normalised and blank ones dropped. */
export const entryTagsRequestSchema = z.object({
  tags: z.array(z.string().max(200)).max(MAX_TAGS_PER_ENTRY),
});

export const shareResponseSchema = z.object({ shareId: z.uuid() });

/** The secret key in the user's published feed URL (`/public/feeds/<key>`). */
export const publishedFeedResponseSchema = z.object({ key: z.string() });

export const tagCountSchema = z.object({ tag: z.string(), count: z.number().int() });

export const markReadRequestSchema = streamSchema
  .extend({
    /** Only entries older than this many days. */
    olderThanDays: z.number().int().min(1).max(3650).optional(),
    /** Only entries with an id up to this one, so entries that arrived since the view loaded stay unread. */
    maxId: z.number().int().optional(),
  })
  .refine(singleStream, ONE_STREAM);

export const updatedCountSchema = z.object({ updated: z.number().int() });

export const countersSchema = z.object({
  subscriptions: z.array(z.object({ id: z.number().int(), unread: z.number().int() })),
  /** Totals include subcategories; id 0 is uncategorised. */
  categories: z.array(z.object({ id: z.number().int(), unread: z.number().int() })),
  labels: z.array(z.object({ id: z.number().int(), unread: z.number().int() })),
  /** Unread counts of the special feeds. */
  special: z.object({
    all: z.number().int(),
    fresh: z.number().int(),
    starred: z.number().int(),
    published: z.number().int(),
  }),
});

export const syncQuerySchema = z.object({
  /** `next` from the previous response; omitted for a full sync. */
  since: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(5000).default(1000),
});

export const syncResponseSchema = z.object({
  categories: z.array(categorySchema),
  subscriptions: z.array(subscriptionSchema),
  labels: z.array(labelSchema),
  /** Changed or new entries, without content. */
  entries: z.array(entrySchema),
  deleted: z.object({
    categories: z.array(z.number().int()),
    subscriptions: z.array(z.number().int()),
    labels: z.array(z.number().int()),
    entries: z.array(z.number().int()),
  }),
  /** Token for the next call. */
  next: z.string(),
  /** More changes are waiting; call again with `next` straight away. */
  more: z.boolean(),
});

export type SpecialFeed = z.infer<typeof specialFeedSchema>;
export type Stream = z.infer<typeof streamSchema>;
/** List query as clients send it (`content` as a boolean; the API reads `true`/`false`). */
export type EntryListQuery = Omit<z.input<typeof entryListQuerySchema>, 'content'> & {
  content?: boolean | undefined;
};
export type Enclosure = z.infer<typeof enclosureSchema>;
export type Entry = z.infer<typeof entrySchema>;
export type EntryListResponse = z.infer<typeof entryListResponseSchema>;
export type EntryState = z.infer<typeof entryStateSchema>;
export type BulkEntryStateRequest = z.infer<typeof bulkEntryStateRequestSchema>;
export type EntryNoteRequest = z.infer<typeof entryNoteRequestSchema>;
export type TagCount = z.infer<typeof tagCountSchema>;
export type ShareResponse = z.infer<typeof shareResponseSchema>;
export type PublishedFeedResponse = z.infer<typeof publishedFeedResponseSchema>;
export type MarkReadRequest = z.infer<typeof markReadRequestSchema>;
export type Counters = z.infer<typeof countersSchema>;
export type SyncResponse = z.infer<typeof syncResponseSchema>;

export const fullTextResponseSchema = z.object({ content: z.string() });
export type FullTextResponse = z.infer<typeof fullTextResponseSchema>;
