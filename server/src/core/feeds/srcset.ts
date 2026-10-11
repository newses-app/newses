/** A candidate's URL: it may contain commas (image CDN transforms), but trailing ones end it. */
const CANDIDATE_URL = /[\s,]*([^\s,]\S*)/y;
/** A candidate's descriptors run to the next comma outside parentheses. */
const DESCRIPTORS = /([^,(]*(?:\([^)]*\)[^,(]*)*),?/y;
/** A width, height, or pixel density descriptor. */
const DESCRIPTOR = /^(?:\d+[wh]|(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?x)$/i;

/**
 * Maps each candidate URL of a `srcset`, parsing it as the HTML spec does: splitting on commas
 * would break URLs that contain them. Feeds sometimes leave spaces unencoded in URLs, which the
 * spec would split into invalid descriptors; those words are rejoined to the URL as `%20`.
 */
export function mapSrcset(srcset: string, map: (url: string) => string): string {
  const candidates: string[] = [];
  let index = 0;
  for (;;) {
    CANDIDATE_URL.lastIndex = index;
    const raw = CANDIDATE_URL.exec(srcset)?.[1];
    if (!raw) break;
    index = CANDIDATE_URL.lastIndex;
    if (raw.endsWith(',')) {
      candidates.push(map(raw.replace(/,+$/, '')));
      continue;
    }
    DESCRIPTORS.lastIndex = index;
    const tokens = DESCRIPTORS.exec(srcset)?.[1]?.trim().split(/\s+/).filter(Boolean) ?? [];
    index = DESCRIPTORS.lastIndex;
    let split = tokens.length;
    while (split > 0 && DESCRIPTOR.test(tokens[split - 1] ?? '')) split--;
    const url = map([raw, ...tokens.slice(0, split)].join('%20'));
    const descriptors = tokens.slice(split).join(' ');
    candidates.push(descriptors ? `${url} ${descriptors}` : url);
  }
  return candidates.join(', ');
}
