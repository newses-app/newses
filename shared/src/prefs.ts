import { z } from 'zod';

export const viewModeSchema = z.enum(['all', 'unread', 'adaptive']);
export const headlineOrderSchema = z.enum(['newest', 'oldest', 'title']);

const prefsShape = {
  /** `adaptive` shows unread entries when there are any, else all. */
  viewMode: viewModeSchema,
  sortOrder: headlineOrderSchema,
  layout: z.enum(['threePane', 'combined']),
  theme: z.enum(['system', 'light', 'dark']),
  /** Combined layout: mark entries read as they scroll past. */
  markReadOnScroll: z.boolean(),
  showContentPreview: z.boolean(),
  hideReadFeeds: z.boolean(),
  confirmCatchUp: z.boolean(),
  /** Unread entries published within this many hours are Fresh. */
  freshMaxAgeHours: z.number().int().min(1).max(720),
  /** Default for this user's subscriptions; null uses the server default. */
  updateIntervalMinutes: z.number().int().min(15).max(10_080).nullable(),
  /** Default for this user's subscriptions; 0 keeps entries forever, null uses the server default. */
  purgeDays: z.number().int().min(0).max(3650).nullable(),
};

export const prefsSchema = z.object(prefsShape);
export const updatePrefsRequestSchema = z.object(prefsShape).partial().strict();

export type Prefs = z.infer<typeof prefsSchema>;
export type PrefKey = keyof Prefs;
export type UpdatePrefsRequest = z.infer<typeof updatePrefsRequestSchema>;

export const DEFAULT_PREFS: Prefs = {
  viewMode: 'adaptive',
  sortOrder: 'newest',
  layout: 'threePane',
  theme: 'system',
  markReadOnScroll: false,
  showContentPreview: true,
  hideReadFeeds: false,
  confirmCatchUp: true,
  freshMaxAgeHours: 24,
  updateIntervalMinutes: null,
  purgeDays: null,
};
