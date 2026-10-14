import { z } from 'zod';
import { MAX_SCORE } from './limits.ts';
import { isKeySequence, MAX_BINDINGS_PER_ACTION, SHORTCUT_ACTIONS } from './shortcuts.ts';
import { BUILTIN_THEME_KEYS, FONT_KEYS } from './themes-builtin.ts';
import { partialThemeTokensSchema } from './themes.ts';

export const viewModeSchema = z.enum(['all', 'unread', 'adaptive']);
export const headlineOrderSchema = z.enum(['newest', 'oldest', 'title']);

const prefsShape = {
  /** `adaptive` shows unread entries when there are any, else all. */
  viewMode: viewModeSchema,
  sortOrder: headlineOrderSchema,
  layout: z.enum(['threePane', 'combined']),
  /** Light or dark mode of the appearance theme; `system` follows the OS. */
  theme: z.enum(['system', 'light', 'dark']),
  /** A built-in theme's key or a custom theme's id; one that no longer resolves shows Original. */
  appearanceTheme: z.union([z.enum(BUILTIN_THEME_KEYS), z.number().int().positive()]),
  /** The reader's changes to the appearance theme's tokens. */
  themeAdjustments: partialThemeTokensSchema,
  /** Typeface of article text; `default` follows the theme. */
  articleFont: z.enum(FONT_KEYS),
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
  /** Entries scored above this are highlighted. */
  scoreHighlightAbove: z.number().int().min(-MAX_SCORE).max(MAX_SCORE),
  /** Entries scored below this are left out of feed, category, All, and Fresh lists and counts. */
  scoreHideBelow: z.number().int().min(-MAX_SCORE).max(MAX_SCORE),
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
