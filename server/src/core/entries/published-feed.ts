import type { Entry } from '@newses/shared';
import { generateRssFeed } from 'feedsmith';

export const PUBLISHED_FEED_LENGTH = 50;

/**
 * RSS 2.0 of a user's published entries. `content` is the sanitised HTML, already pointed at
 * the image proxy when the owner uses it; `selfUrl` is the feed's own public URL.
 */
export function publishedFeedXml(entries: Entry[], urls: { site: string; self: string }): string {
  return generateRssFeed({
    title: 'Published articles',
    link: urls.site,
    description: 'Articles published from Newses',
    lastBuildDate: new Date(),
    atom: { links: [{ href: urls.self, rel: 'self', type: 'application/rss+xml' }] },
    items: entries.map((entry) => ({
      ...(entry.title && { title: entry.title }),
      ...(entry.link && { link: entry.link }),
      ...((entry.content ?? entry.excerpt) && {
        description: entry.content ?? entry.excerpt ?? '',
      }),
      ...(entry.author && { authors: [{ name: entry.author }] }),
      pubDate: new Date(entry.publishedAt ?? entry.sortAt),
      guid: entry.link
        ? { value: entry.link, isPermaLink: true }
        : { value: `${urls.self}#${String(entry.id)}`, isPermaLink: false },
      enclosures: (entry.enclosures ?? []).map((e) => ({
        url: e.url,
        length: e.length ?? 0,
        type: e.mimeType ?? 'application/octet-stream',
      })),
    })),
  });
}
