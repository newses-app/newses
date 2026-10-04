import { Parser } from 'htmlparser2';

export interface FeedCandidate {
  url: string;
  title: string | null;
  type: string;
}

const FEED_TYPES = new Set([
  'application/rss+xml',
  'application/atom+xml',
  'application/rdf+xml',
  'application/feed+json',
  'application/json',
  'application/xml',
  'text/xml',
]);

/** Finds feeds advertised by `<link rel="alternate">` in an HTML page. */
export function discoverFeeds(html: string, pageUrl: string): FeedCandidate[] {
  let baseHref: string | undefined;
  const links: Record<string, string>[] = [];
  const parser = new Parser(
    {
      onopentag(name, attributes) {
        if (name === 'base' && attributes.href && baseHref === undefined)
          baseHref = attributes.href;
        else if (name === 'link') links.push(attributes);
      },
    },
    { lowerCaseAttributeNames: true },
  );
  parser.end(html);

  const base = resolveUrl(baseHref, pageUrl) ?? pageUrl;
  const seen = new Set<string>();
  const candidates: FeedCandidate[] = [];
  for (const link of links) {
    const rel = (link.rel ?? '').toLowerCase().split(/\s+/);
    const type = (link.type ?? '').toLowerCase().split(';')[0]?.trim() ?? '';
    if (!rel.includes('alternate') || !FEED_TYPES.has(type)) continue;
    const url = resolveUrl(link.href, base);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    candidates.push({ url, title: link.title?.trim() || null, type });
  }
  return candidates;
}

function resolveUrl(href: string | undefined, base: string): string | null {
  if (!href) return null;
  try {
    return new URL(href, base).href;
  } catch {
    return null;
  }
}

export function looksLikeHtml(body: string, contentType: string | null): boolean {
  return /html/i.test(contentType ?? '') || /^\s*(<!doctype html|<html)/i.test(body);
}
