import { FetchError, type Fetcher, type FetchResult } from '../core/feeds/http.ts';

type Route = { body: string; contentType?: string; redirectTo?: string } | FetchError;

/** Fetcher serving canned responses by URL; unknown URLs fail with HTTP 404. */
export class FakeFetcher implements Fetcher {
  readonly routes = new Map<string, Route>();
  readonly requested: string[] = [];

  set(url: string, route: Route): this {
    this.routes.set(url, route);
    return this;
  }

  fetch(url: string): Promise<FetchResult> {
    this.requested.push(url);
    const route = this.routes.get(url);
    if (!route) return Promise.reject(new FetchError('http_status', 'HTTP 404', { status: 404 }));
    if (route instanceof FetchError) return Promise.reject(route);
    return Promise.resolve({
      url: route.redirectTo ?? url,
      status: 200,
      notModified: false,
      contentType: route.contentType ?? 'application/rss+xml',
      etag: null,
      lastModified: null,
      body: new TextEncoder().encode(route.body),
    });
  }
}

export const rss = (title: string, link = 'https://site.example/') =>
  `<?xml version="1.0"?><rss version="2.0"><channel><title>${title}</title><link>${link}</link><description>d</description></channel></rss>`;

export const htmlPage = (...feeds: { href: string; title?: string }[]) =>
  `<!doctype html><html><head>${feeds
    .map(
      (f) =>
        `<link rel="alternate" type="application/rss+xml" href="${f.href}"${f.title ? ` title="${f.title}"` : ''}>`,
    )
    .join('')}</head><body></body></html>`;
