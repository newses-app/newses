import { z } from 'zod';
import { categorySchema, subscriptionSchema } from './feeds.ts';
import { headlineOrderSchema, viewModeSchema } from './prefs.ts';

export const specialFeedSchema = z.enum(['all', 'fresh', 'starred', 'published', 'recentlyRead']);

/** One of `subscriptionId`, `categoryId` (0 = uncategorised; includes subcategories), or `special`. */
export const streamSchema = z.object({
  subscriptionId: z.coerce.number().int().optional(),
  categoryId: z.coerce.number().int().optional(),
  special: specialFeedSchema.optional(),
});

const singleStream = (stream: z.infer<typeof streamSchema>) =>
  [stream.subscriptionId, stream.categoryId, stream.special].filter((v) => v !== undefined)
    .length <= 1;
const ONE_STREAM = { message: 'Give at most one of subscriptionId, categoryId, special' };

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
  /** Null once the feed has been unsubscribed (kept because starred or published). */
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
  /** Plain-text start of the content. */
  excerpt: z.string().nullable(),
  /** Sanitised HTML; present on single entries and when requested in lists. */
  content: z.string().nullable().optional(),
  enclosures: z.array(enclosureSchema).optional(),
});

export const entryListResponseSchema = z.object({
  entries: z.array(entrySchema),
  /** Pass back as `cursor` for the next page; null on the last page. */
  cursor: z.string().nullable(),
  /** The view applied; `adaptive` resolves to `unread` or `all`. */
  view: z.enum(['all', 'unread']),
});

export const entryStateSchema = z
  .object({ unread: z.boolean(), starred: z.boolean(), published: z.boolean() })
  .partial()
  .refine((s) => Object.keys(s).length > 0, { message: 'Set at least one flag' });

export const bulkEntryStateRequestSchema = z
  .object({
    ids: z.array(z.number().int()).min(1).max(1000),
    unread: z.boolean().optional(),
    starred: z.boolean().optional(),
    published: z.boolean().optional(),
  })
  .refine((s) => s.unread !== undefined || s.starred !== undefined || s.published !== undefined, {
    message: 'Set at least one flag',
  });

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
  /** Changed or new entries, without content. */
  entries: z.array(entrySchema),
  deleted: z.object({
    categories: z.array(z.number().int()),
    subscriptions: z.array(z.number().int()),
    entries: z.array(z.number().int()),
  }),
  /** Token for the next call. */
  next: z.string(),
  /** More changes are waiting; call again with `next` straight away. */
  more: z.boolean(),
});

export type SpecialFeed = z.infer<typeof specialFeedSchema>;
export type Stream = z.infer<typeof streamSchema>;
export type EntryListQuery = z.input<typeof entryListQuerySchema>;
export type Enclosure = z.infer<typeof enclosureSchema>;
export type Entry = z.infer<typeof entrySchema>;
export type EntryListResponse = z.infer<typeof entryListResponseSchema>;
export type EntryState = z.infer<typeof entryStateSchema>;
export type BulkEntryStateRequest = z.infer<typeof bulkEntryStateRequestSchema>;
export type MarkReadRequest = z.infer<typeof markReadRequestSchema>;
export type Counters = z.infer<typeof countersSchema>;
export type SyncResponse = z.infer<typeof syncResponseSchema>;
