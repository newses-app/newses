// Input limits and normalisation shared by the API and the web app (no Zod, so browsers can import it).

export const MAX_NOTE_LENGTH = 10_000;

/** Names users give: categories, labels, a feed's own title, and filters. */
export const MAX_CATEGORY_TITLE_LENGTH = 200;
export const MAX_LABEL_CAPTION_LENGTH = 100;
export const MAX_SUBSCRIPTION_TITLE_LENGTH = 500;
export const MAX_FILTER_TITLE_LENGTH = 200;

/** Feed addresses; titles feeds give themselves are cut to the second. */
export const MAX_FEED_URL_LENGTH = 2048;
export const MAX_FEED_TITLE_LENGTH = 1000;

/** Scores and score thresholds lie within ±this. */
export const MAX_SCORE = 1_000_000;

export const MAX_TAG_LENGTH = 64;
export const MAX_TAGS_PER_ENTRY = 50;

/** Most entries per contents request. */
export const MAX_CONTENTS_IDS = 100;

/** Published pages: address, title, and text. */
export const MAX_PAGE_URL_LENGTH = 2048;
export const MAX_PAGE_TITLE_LENGTH = 1000;
export const MAX_PAGE_TEXT_LENGTH = 100_000;

/** OPML import: most feeds and folders together, and deepest folder nesting, per file. */
export const MAX_OPML_OUTLINES = 2000;
export const MAX_OPML_DEPTH = 10;

export const MAX_THEME_NAME_LENGTH = 60;
export const MAX_THEMES_PER_USER = 50;

/** A tag as stored: lower-case, single-spaced, without commas or control characters; null if empty. */
export function normaliseTag(text: string): string | null {
  const tag = text
    .replace(/[,\p{Cc}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, MAX_TAG_LENGTH)
    .trim();
  return tag || null;
}

/** Distinct normalised tags, in order, at most `MAX_TAGS_PER_ENTRY`. */
export function normaliseTags(texts: readonly string[]): string[] {
  const tags = new Set<string>();
  for (const text of texts) {
    const tag = normaliseTag(text);
    if (tag) tags.add(tag);
    if (tags.size === MAX_TAGS_PER_ENTRY) break;
  }
  return [...tags];
}
