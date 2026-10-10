/** A candidate's URL: it may contain commas (image CDN transforms), but trailing ones end it. */
const CANDIDATE_URL = /[\s,]*([^\s,]\S*)/y;
/** A candidate's descriptors run to the next comma outside parentheses. */
const DESCRIPTORS = /([^,(]*(?:\([^)]*\)[^,(]*)*),?/y;

/**
 * Maps each candidate URL of a `srcset`, parsing it as the HTML spec does: splitting on commas
 * would break URLs that contain them.
 */
export function mapSrcset(srcset: string, map: (url: string) => string): string {
  const candidates: string[] = [];
  let index = 0;
  for (;;) {
    CANDIDATE_URL.lastIndex = index;
    const raw = CANDIDATE_URL.exec(srcset)?.[1];
    if (!raw) break;
    index = CANDIDATE_URL.lastIndex;
    const url = map(raw.replace(/,+$/, ''));
    if (raw.endsWith(',')) {
      candidates.push(url);
      continue;
    }
    DESCRIPTORS.lastIndex = index;
    const descriptors = DESCRIPTORS.exec(srcset)?.[1]?.trim() ?? '';
    index = DESCRIPTORS.lastIndex;
    candidates.push(descriptors ? `${url} ${descriptors}` : url);
  }
  return candidates.join(', ');
}
