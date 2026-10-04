import { z } from 'zod';

export const categorySchema = z.object({
  id: z.number().int(),
  parentId: z.number().int().nullable(),
  title: z.string(),
  sortOrder: z.number().int(),
  collapsed: z.boolean(),
});

export const createCategoryRequestSchema = z.object({
  title: z.string().trim().min(1).max(200),
  parentId: z.number().int().nullable().default(null),
});

export const updateCategoryRequestSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  parentId: z.number().int().nullable().optional(),
  sortOrder: z.number().int().optional(),
  collapsed: z.boolean().optional(),
});

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
});

export const subscribeRequestSchema = z.object({
  url: z.string().trim().min(1).max(2048),
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
  title: z.string().trim().min(1).max(500).nullable().optional(),
  categoryId: z.number().int().nullable().optional(),
  sortOrder: z.number().int().optional(),
  /** Null inherits the user's default. */
  updateIntervalMinutes: z.number().int().min(15).max(10_080).nullable().optional(),
  /** 0 keeps entries forever; null inherits the user's default. */
  purgeDays: z.number().int().min(0).max(3650).nullable().optional(),
});

export const opmlImportResultSchema = z.object({
  categoriesCreated: z.number().int(),
  subscribed: z.number().int(),
  alreadySubscribed: z.number().int(),
  invalid: z.array(z.object({ url: z.string(), reason: z.string() })),
});

export type Category = z.infer<typeof categorySchema>;
export type Subscription = z.infer<typeof subscriptionSchema>;
export type FeedCandidate = z.infer<typeof feedCandidateSchema>;
export type UpdateSubscriptionRequest = z.infer<typeof updateSubscriptionRequestSchema>;
export type CreateCategoryRequest = z.input<typeof createCategoryRequestSchema>;
export type UpdateCategoryRequest = z.infer<typeof updateCategoryRequestSchema>;
export type SubscribeRequest = z.input<typeof subscribeRequestSchema>;
export type SubscribeResponse = z.infer<typeof subscribeResponseSchema>;
export type OpmlImportResult = z.infer<typeof opmlImportResultSchema>;
