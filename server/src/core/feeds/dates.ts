const ZONE_SUFFIX = /(?:Z|[+-]\d{2}:?\d{2}|\b[A-Za-z]{1,5})$/;
const ISO_LIKE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/;

/** Parses feed dates leniently. Dates without a zone are UTC; unparseable dates are null. */
export function parseFeedDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== 'string') return null;
  let text = value.trim();
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) text += 'T00:00:00Z';
  else if (!ZONE_SUFFIX.test(text)) {
    text = ISO_LIKE.test(text) ? `${text.replace(' ', 'T')}Z` : `${text} GMT`;
  }
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}
