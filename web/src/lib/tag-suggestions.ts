import { normaliseTag } from '@newses/shared/client';

/** Few enough to show without scrolling. */
export const MAX_TAG_SUGGESTIONS = 5;

/**
 * The tags that match what is typed, those starting with it first, leaving out the ones already
 * chosen; none until something is typed, as an account can have tens of thousands of tags.
 */
export function suggestTags(
  tags: readonly string[],
  typed: string | null,
  chosen: readonly string[],
  limit = MAX_TAG_SUGGESTIONS,
): string[] {
  const text = normaliseTag(typed ?? '');
  if (!text) return [];
  const starts: string[] = [];
  const contains: string[] = [];
  for (const tag of tags) {
    if (chosen.includes(tag)) continue;
    if (tag.startsWith(text)) {
      starts.push(tag);
      if (starts.length === limit) break;
    } else if (contains.length < limit && tag.includes(text)) contains.push(tag);
  }
  return [...starts, ...contains].slice(0, limit);
}
