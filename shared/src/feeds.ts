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
  lastFetchedAt: z.iso.datetime().nullable(),
  lastError: z.string().nullable(),
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
export type SubscribeResponse = z.infer<typeof subscribeResponseSchema>;
export type OpmlImportResult = z.infer<typeof opmlImportResultSchema>;
