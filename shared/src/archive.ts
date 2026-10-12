import { z } from 'zod';
import { enclosureSchema } from './entries.ts';

/**
 * Past articles of the user's feeds: those they no longer hold (purged, or older than they
 * subscribed) and those in the cold-storage archive.
 */
export const archiveEntriesQuerySchema = z.object({
  /** One of the user's subscriptions; all of them when omitted. */
  subscriptionId: z.coerce.number().int().optional(),
  /** Words that must all appear in the title or text. */
  q: z.string().trim().min(1).max(500).optional(),
  cursor: z.string().max(4000).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const archivedEntrySchema = z.object({
  /** Identifies the article in the archive, for `GET` and restore. */
  key: z.string(),
  archived: z.literal(true),
  subscriptionId: z.number().int(),
  feedTitle: z.string().nullable(),
  title: z.string().nullable(),
  link: z.string().nullable(),
  author: z.string().nullable(),
  publishedAt: z.iso.datetime().nullable(),
  sortAt: z.iso.datetime(),
  /** Plain-text start of the content. */
  excerpt: z.string().nullable(),
  /** Sanitised HTML; present on single entries. */
  content: z.string().nullable().optional(),
  enclosures: z.array(enclosureSchema).optional(),
});

export const archiveEntriesResponseSchema = z.object({
  entries: z.array(archivedEntrySchema),
  /** Pass back as `cursor` for the next page; null on the last page. */
  cursor: z.string().nullable(),
});

export type ArchiveEntriesQuery = z.input<typeof archiveEntriesQuerySchema>;
export type ArchivedEntry = z.infer<typeof archivedEntrySchema>;
export type ArchiveEntriesResponse = z.infer<typeof archiveEntriesResponseSchema>;
