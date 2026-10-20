import { z } from 'zod';
import {
  MAX_CATEGORY_TITLE_LENGTH,
  MAX_FEED_URL_LENGTH,
  MAX_SUBSCRIPTION_TITLE_LENGTH,
} from './limits.ts';

export const categorySchema = z.object({
  id: z.number().int(),
  parentId: z.number().int().nullable(),
  title: z.string(),
  sortOrder: z.number().int(),
  collapsed: z.boolean(),
});

export const createCategoryRequestSchema = z.object({
  title: z.string().trim().min(1).max(MAX_CATEGORY_TITLE_LENGTH),
  parentId: z.number().int().nullable().default(null),
});

export const updateCategoryRequestSchema = z.object({
  title: z.string().trim().min(1).max(MAX_CATEGORY_TITLE_LENGTH).optional(),
  parentId: z.number().int().nullable().optional(),
  sortOrder: z.number().int().optional(),
  collapsed: z.boolean().optional(),
});

/** Changes applied to every category of the user. */
export const updateAllCategoriesRequestSchema = z.object({
  collapsed: z.boolean(),
});

/**
 * Why a feed is checked as often as it is: the user's own setting, a shorter one because feeds are
 * checked once for everyone, the publisher's hint, a slowdown after the site answered 429, the
 * site's minimum set by an admin, or paused for this user.
 */
export const intervalReasonSchema = z.enum([
  'own',
  'shared',
  'publisher',
  'slowdown',
  'siteMinimum',
  'paused',
]);

export const subscriptionSchema = z.object({
  id: z.number().int(),
  feedSourceId: z.number().int(),
  /** Custom title, else the feed's title, else its URL. */
  title: z.string(),
  customTitle: z.string().nullable(),
  url: z.string(),
  siteUrl: z.string().nullable(),
  categoryId: z.number().int().nullable(),
  sortOrder: z.number().int(),
  /** Present once the site's icon has been fetched. */
  iconUrl: z.string().nullable(),
  lastFetchedAt: z.iso.datetime().nullable(),
  lastError: z.string().nullable(),
  lastErrorAt: z.iso.datetime().nullable(),
  /** Consecutive failed fetches. */
  errorCount: z.number().int(),
  /** Disabled after repeated failures or HTTP 410; refreshing re-enables it. */
  disabled: z.boolean(),
  /** Overrides of the user's defaults; null inherits. */
  updateIntervalMinutes: z.number().int().nullable(),
  purgeDays: z.number().int().nullable(),
  /** New entries get their full text extracted, shown before the feed's content. */
  fullText: z.boolean(),
  /** No longer counts toward how often the feed is checked; still gets what other checks bring. */
  paused: z.boolean(),
  /** Left out of All articles and Fresh, and their counts. */
  hideFromAll: z.boolean(),
  /** How often the feed is checked; null while paused, before its first check, or unknown. */
  effectiveIntervalMinutes: z.number().int().nullable(),
  intervalReason: intervalReasonSchema.nullable(),
  /** When the next check is due; null while paused, disabled, before its first check, or unknown. */
  nextFetchAt: z.iso.datetime().nullable(),
});

export const subscribeRequestSchema = z.object({
  url: z.string().trim().min(1).max(MAX_FEED_URL_LENGTH),
  categoryId: z.number().int().nullable().default(null),
});

export const feedCandidateSchema = z.object({
  url: z.string(),
  title: z.string().nullable(),
  type: z.string(),
});

export const subscribeResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('subscribed'), subscription: subscriptionSchema }),
  /** The page advertises several feeds; subscribe again with one of their URLs. */
  z.object({ status: z.literal('choose'), candidates: z.array(feedCandidateSchema) }),
]);

export const updateSubscriptionRequestSchema = z.object({
  /** Null clears the custom title. */
  title: z.string().trim().min(1).max(MAX_SUBSCRIPTION_TITLE_LENGTH).nullable().optional(),
  categoryId: z.number().int().nullable().optional(),
  sortOrder: z.number().int().optional(),
  /** Null inherits the user's default. */
  updateIntervalMinutes: z.number().int().min(15).max(10_080).nullable().optional(),
  /** 0 keeps entries forever; null inherits the user's default. */
  purgeDays: z.number().int().min(0).max(3650).nullable().optional(),
  fullText: z.boolean().optional(),
  paused: z.boolean().optional(),
  hideFromAll: z.boolean().optional(),
});

export const opmlImportResultSchema = z.object({
  categoriesCreated: z.number().int(),
  subscribed: z.number().int(),
  alreadySubscribed: z.number().int(),
  invalid: z.array(z.object({ url: z.string(), reason: z.string() })),
});

/** A dry-run fetch of a subscribed feed: nothing is stored, and the feed's state is left alone. */
export const feedDebugSchema = z.object({
  url: z.string(),
  /** Why nothing was answered: the fetch failed, or the site asked to wait. */
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      status: z.number().int().nullable(),
      retryAfterSeconds: z.number().int().nullable(),
    })
    .nullable(),
  response: z
    .object({
      status: z.number().int(),
      /** After redirects. */
      url: z.string(),
      /** Reached through permanent redirects only; the feed moves there after a fetch. */
      permanentUrl: z.string().nullable(),
      contentType: z.string().nullable(),
      headers: z.array(z.object({ name: z.string(), value: z.string() })),
      bytes: z.number().int(),
      /** The body as text, cut to its first 256 KB. */
      body: z.string(),
      truncated: z.boolean(),
    })
    .nullable(),
  feed: z
    .object({
      format: z.enum(['rss', 'atom', 'rdf', 'json']),
      title: z.string().nullable(),
      siteUrl: z.string().nullable(),
      ttlSeconds: z.number().int().nullable(),
    })
    .nullable(),
  parseError: z.string().nullable(),
  /** Feeds a web page advertises, when the answer was one. */
  discovered: z.array(feedCandidateSchema),
  /** The entries as they would be stored, at most 500, each with the user's filters it matches. */
  entries: z.array(
    z.object({
      guid: z.string(),
      title: z.string().nullable(),
      link: z.string().nullable(),
      author: z.string().nullable(),
      publishedAt: z.iso.datetime().nullable(),
      updatedAt: z.iso.datetime().nullable(),
      tags: z.array(z.string()),
      contentLength: z.number().int(),
      /** The user's enabled filters that would apply, in order, up to one that stops. */
      filterIds: z.array(z.number().int()),
    }),
  ),
});

export type Category = z.infer<typeof categorySchema>;
export type Subscription = z.infer<typeof subscriptionSchema>;
export type IntervalReason = z.infer<typeof intervalReasonSchema>;
export type FeedCandidate = z.infer<typeof feedCandidateSchema>;
export type UpdateSubscriptionRequest = z.infer<typeof updateSubscriptionRequestSchema>;
export type CreateCategoryRequest = z.input<typeof createCategoryRequestSchema>;
export type UpdateCategoryRequest = z.infer<typeof updateCategoryRequestSchema>;
export type UpdateAllCategoriesRequest = z.infer<typeof updateAllCategoriesRequestSchema>;
export type SubscribeRequest = z.input<typeof subscribeRequestSchema>;
export type SubscribeResponse = z.infer<typeof subscribeResponseSchema>;
export type OpmlImportResult = z.infer<typeof opmlImportResultSchema>;
export type FeedDebug = z.infer<typeof feedDebugSchema>;
