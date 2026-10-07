import { DomainError } from '../errors.ts';

/**
 * Canonical form used to deduplicate feed sources: http(s) only, `feed:` mapped to http,
 * scheme defaulted to https, lower-case host, default port and fragment removed.
 */
export function normalizeFeedUrl(input: string): string {
  let raw = input.trim();
  if (/^feed:\/\//i.test(raw)) raw = raw.replace(/^feed:/i, 'http:');
  else if (/^feed:/i.test(raw)) raw = raw.slice('feed:'.length);
  if (!/^[a-z][a-z0-9+.-]*:/i.test(raw)) raw = `https://${raw}`;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DomainError('invalid_input', `Not a valid URL: ${input}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new DomainError('invalid_input', 'Only http and https URLs are supported');
  }
  if (!url.hostname) throw new DomainError('invalid_input', `Not a valid URL: ${input}`);
  url.hash = '';
  return url.href;
}

/** Absolute http(s) URL, or null: clients open these, so `javascript:` and `data:` must not pass. */
export function httpUrl(input: string | null | undefined, base?: string | null): string | null {
  if (!input?.trim()) return null;
  try {
    const url = new URL(input.trim(), base ?? undefined);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}
