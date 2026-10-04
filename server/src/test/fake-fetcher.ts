import {
  FetchError,
  type Fetcher,
  type FetchRequest,
  type FetchResult,
} from '../core/feeds/http.ts';

type Route =
  | {
      body: string | Uint8Array;
      contentType?: string;
      redirectTo?: string;
      /** The redirect is permanent (301/308). */
      permanent?: boolean;
      etag?: string;
      maxAge?: number;
    }
  | FetchError;

/** Fetcher serving canned responses by URL; unknown URLs fail with HTTP 404. */
export class FakeFetcher implements Fetcher {
  readonly routes = new Map<string, Route>();
  readonly requested: string[] = [];

  set(url: string, route: Route): this {
    this.routes.set(url, route);
    return this;
  }

  fetch(url: string, request: FetchRequest = {}): Promise<FetchResult> {
    this.requested.push(url);
    const route = this.routes.get(url);
    if (!route) return Promise.reject(new FetchError('http_status', 'HTTP 404', { status: 404 }));
    if (route instanceof FetchError) return Promise.reject(route);
    const notModified = route.etag !== undefined && request.etag === route.etag;
    return Promise.resolve({
      url: route.redirectTo ?? url,
      permanentUrl: route.permanent ? (route.redirectTo ?? null) : null,
      maxAgeSeconds: route.maxAge ?? null,
      status: notModified ? 304 : 200,
      notModified,
      contentType: route.contentType ?? 'application/rss+xml',
      etag: route.etag ?? null,
      lastModified: null,
      body: notModified
        ? new Uint8Array()
        : typeof route.body === 'string'
          ? new TextEncoder().encode(route.body)
          : route.body,
    });
  }
}

export interface FeedItem {
  guid?: string;
  title?: string;
  link?: string;
  description?: string;
  pubDate?: string;
  enclosure?: string;
}

export const rss = (title: string, link = 'https://site.example/', items: FeedItem[] = []) =>
  `<?xml version="1.0"?><rss version="2.0"><channel><title>${title}</title><link>${link}</link><description>d</description>${items
    .map(
      (i) =>
        `<item>${i.guid ? `<guid>${i.guid}</guid>` : ''}${i.title ? `<title>${i.title}</title>` : ''}${
          i.link ? `<link>${i.link}</link>` : ''
        }${i.description ? `<description><![CDATA[${i.description}]]></description>` : ''}${
          i.pubDate ? `<pubDate>${i.pubDate}</pubDate>` : ''
        }${i.enclosure ? `<enclosure url="${i.enclosure}" type="audio/mpeg" length="1"/>` : ''}</item>`,
    )
    .join('')}</channel></rss>`;

export const htmlPage = (...feeds: { href: string; title?: string }[]) =>
  `<!doctype html><html><head>${feeds
    .map(
      (f) =>
        `<link rel="alternate" type="application/rss+xml" href="${f.href}"${f.title ? ` title="${f.title}"` : ''}>`,
    )
    .join('')}</head><body></body></html>`;
