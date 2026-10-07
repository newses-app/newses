import { z } from 'zod';
import { isKeySequence, MAX_BINDINGS_PER_ACTION, SHORTCUT_ACTIONS } from './shortcuts.ts';

export const viewModeSchema = z.enum(['all', 'unread', 'adaptive']);
export const headlineOrderSchema = z.enum(['newest', 'oldest', 'title']);

const prefsShape = {
  /** `adaptive` shows unread entries when there are any, else all. */
  viewMode: viewModeSchema,
  sortOrder: headlineOrderSchema,
  layout: z.enum(['threePane', 'combined']),
  theme: z.enum(['system', 'light', 'dark']),
  /** Typeface of article text; `default` follows the app. System fonts only, so nothing loads. */
  articleFont: z.enum(['default', 'sans', 'serif', 'mono']),
  /** Article text size in CSS pixels. */
  articleFontSize: z.number().int().min(12).max(28),
  /** Maximum width of the article column. */
  articleWidth: z.enum(['narrow', 'medium', 'wide', 'full']),
  /** Combined layout: mark entries read as they scroll past. */
  markReadOnScroll: z.boolean(),
  showContentPreview: z.boolean(),
  hideReadFeeds: z.boolean(),
  confirmCatchUp: z.boolean(),
  /** Load entry images through the server, hiding the reader's address from image hosts. */
  proxyImages: z.boolean(),
  /** Single-key shortcuts; off for users whose assistive technology sends key presses. */
  keyboardShortcuts: z.boolean(),
  /** Key sequences per action, replacing that action's defaults; `[]` unbinds it. */
  shortcutBindings: z.partialRecord(
    z.enum(SHORTCUT_ACTIONS),
    z
      .array(z.string().refine(isKeySequence, 'Expected a key or two keys separated by a space'))
      .max(MAX_BINDINGS_PER_ACTION),
  ),
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
