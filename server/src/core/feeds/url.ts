import { DomainError } from '../errors.ts';

/**
 * Canonical form used to deduplicate feed sources: http(s) only, `feed:` mapped to http,
 * scheme defaulted to https, lower-case host, default port and fragment removed.
 */
export function normalizeFeedUrl(input: string): string {
  let raw = input.trim();
  if (/^feed:\/\//i.test(raw)) raw = raw.replace(/^feed:/i, 'http:');
  else if (/^feed:/i.test(raw)) raw = raw.slice('feed:'.length);
  return httpHref(raw, input);
}

/**
 * Canonical form of a page's address (a published page): http(s) only, scheme defaulted to
 * https, lower-case host, default port and fragment removed.
 */
export function normalizePageUrl(input: string): string {
  return httpHref(input.trim(), input);
}

function httpHref(raw: string, input: string): string {
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
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

/**
 * The host (and port) of a URL, as host pauses and limits key it, or `invalid`. Logs and traces
 * show only this: paths and queries of feed URLs may carry private tokens.
 */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid';
  }
}
