import { parseFeed as parseAnyFeed } from 'feedsmith';
import { parseFeedDate } from './dates.ts';

export interface ParsedEnclosure {
  url: string;
  mimeType: string | null;
  length: number | null;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
}

export interface ParsedEntry {
  /** Null when the feed provides none; ingest derives one. */
  guid: string | null;
  link: string | null;
  title: string | null;
  author: string | null;
  content: string | null;
  publishedAt: Date | null;
  updatedAt: Date | null;
  enclosures: ParsedEnclosure[];
  categories: string[];
}

export interface ParsedFeed {
  format: 'rss' | 'atom' | 'rdf' | 'json';
  title: string | null;
  siteUrl: string | null;
  entries: ParsedEntry[];
}

export class FeedParseError extends Error {
  override name = 'FeedParseError';
}

type Text = string | { value?: string } | undefined;
interface MediaContent {
  url?: string;
  type?: string;
  fileSize?: number;
  width?: number;
  height?: number;
  duration?: number;
}
interface Media {
  contents?: MediaContent[];
  groups?: { contents?: MediaContent[]; description?: Text }[];
  description?: Text;
}

const text = (value: Text): string | null =>
  (typeof value === 'string' ? value : value?.value)?.trim() || null;

function resolve(url: string | null | undefined, base: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url.trim(), base ?? undefined).href;
  } catch {
    return url.trim() || null;
  }
}

function mediaEnclosures(media: Media | undefined, base: string | null): ParsedEnclosure[] {
  const contents = [
    ...(media?.contents ?? []),
    ...(media?.groups ?? []).flatMap((g) => g.contents ?? []),
  ];
  return contents.flatMap((m) => {
    const url = resolve(m.url, base);
    return url
      ? [
          {
            url,
            mimeType: m.type ?? null,
            length: m.fileSize ?? null,
            width: m.width ?? null,
            height: m.height ?? null,
            durationSeconds: m.duration ?? null,
          },
        ]
      : [];
  });
}

function uniqueByUrl(enclosures: ParsedEnclosure[]): ParsedEnclosure[] {
  const seen = new Set<string>();
  return enclosures.filter((e) => !seen.has(e.url) && seen.add(e.url));
}

function enclosure(url: string | null, mimeType?: string, length?: number): ParsedEnclosure[] {
  return url
    ? [
        {
          url,
          mimeType: mimeType ?? null,
          length: length ?? null,
          width: null,
          height: null,
          durationSeconds: null,
        },
      ]
    : [];
}

/** Parses RSS 0.9x/2.0, RSS 1.0 (RDF), Atom 0.3/1.0, or JSON Feed into the entry model. */
export function parseFeed(body: string, feedUrl: string): ParsedFeed {
  let parsed: ReturnType<typeof parseAnyFeed>;
  try {
    parsed = parseAnyFeed(body);
  } catch (err) {
    throw new FeedParseError(err instanceof Error ? err.message : 'Unrecognised feed', {
      cause: err,
    });
  }

  switch (parsed.format) {
    case 'rss': {
      const feed = parsed.feed;
      const siteUrl = resolve(feed.link, feedUrl);
      const feedAuthor = feed.dc?.creators?.[0] ?? feed.itunes?.author ?? null;
      return {
        format: 'rss',
        title: text(feed.title),
        siteUrl,
        entries: (feed.items ?? []).map((item) => {
          const permalink = item.guid?.isPermaLink !== false ? item.guid?.value : undefined;
          const duration = item.itunes?.duration ?? null;
          const enclosures = uniqueByUrl([
            ...(item.enclosures ?? []).flatMap((e) =>
              enclosure(resolve(e.url, siteUrl ?? feedUrl), e.type, e.length),
            ),
            ...mediaEnclosures(item.media, siteUrl ?? feedUrl),
          ]);
          const first = enclosures[0];
          if (first && duration !== null && first.durationSeconds === null)
            first.durationSeconds = duration;
          return {
            guid: item.guid?.value?.trim() || null,
            link: resolve(item.link ?? permalink, siteUrl ?? feedUrl),
            title: text(item.title),
            author:
              item.dc?.creators?.[0] ??
              item.authors?.[0]?.name ??
              item.itunes?.author ??
              feedAuthor,
            content: item.content?.encoded ?? item.description ?? null,
            publishedAt: parseFeedDate(item.pubDate ?? item.dc?.dates?.[0]),
            updatedAt: null,
            enclosures,
            categories: (item.categories ?? []).map((c) => c.name?.trim() ?? '').filter(Boolean),
          };
        }),
      };
    }
    case 'atom': {
      const feed = parsed.feed;
      const base = resolve(feed.xml?.base, feedUrl) ?? feedUrl;
      const alternate = (links?: { href?: string; rel?: string }[]) =>
        links?.find((l) => !l.rel || l.rel === 'alternate')?.href;
      const feedAuthor = feed.authors?.[0]?.name ?? null;
      return {
        format: 'atom',
        title: text(feed.title),
        siteUrl: resolve(alternate(feed.links), base),
        entries: (feed.entries ?? []).map((entry) => {
          const media = entry.media;
          return {
            guid: entry.id?.trim() || null,
            link: resolve(alternate(entry.links), base),
            title: text(entry.title),
            author: entry.authors?.[0]?.name ?? entry.dc?.creators?.[0] ?? feedAuthor,
            content:
              text(entry.content) ??
              text(entry.summary) ??
              text(media?.groups?.[0]?.description ?? media?.description),
            publishedAt: parseFeedDate(entry.published ?? entry.updated ?? entry.dc?.dates?.[0]),
            updatedAt: parseFeedDate(entry.updated),
            enclosures: uniqueByUrl([
              ...(entry.links ?? [])
                .filter((l) => l.rel === 'enclosure')
                .flatMap((l) => enclosure(resolve(l.href, base), l.type, l.length)),
              ...mediaEnclosures(media, base),
            ]),
            categories: (entry.categories ?? [])
              .map((c) => (c.label ?? c.term ?? '').trim())
              .filter(Boolean),
          };
        }),
      };
    }
    case 'rdf': {
      const feed = parsed.feed;
      const siteUrl = resolve(feed.link, feedUrl);
      return {
        format: 'rdf',
        title: text(feed.title),
        siteUrl,
        entries: (feed.items ?? []).map((item) => ({
          guid: item.rdf?.about?.trim() || item.link?.trim() || null,
          link: resolve(item.link, siteUrl ?? feedUrl),
          title: text(item.title),
          author: item.dc?.creators?.[0] ?? null,
          content: item.content?.encoded ?? item.description ?? null,
          publishedAt: parseFeedDate(item.dc?.dates?.[0]),
          updatedAt: null,
          enclosures: mediaEnclosures(item.media, siteUrl ?? feedUrl),
          categories: item.dc?.subjects ?? [],
        })),
      };
    }
    case 'json': {
      const feed = parsed.feed;
      const siteUrl = resolve(feed.home_page_url, feedUrl);
      return {
        format: 'json',
        title: text(feed.title),
        siteUrl,
        entries: (feed.items ?? []).map((item) => ({
          guid: item.id?.trim() || null,
          link: resolve(item.url ?? item.external_url, siteUrl ?? feedUrl),
          title: text(item.title),
          author: item.authors?.[0]?.name ?? feed.authors?.[0]?.name ?? null,
          content: item.content_html ?? item.content_text ?? item.summary ?? null,
          publishedAt: parseFeedDate(item.date_published ?? item.date_modified),
          updatedAt: parseFeedDate(item.date_modified),
          enclosures: (item.attachments ?? []).flatMap((a) =>
            enclosure(resolve(a.url, siteUrl ?? feedUrl), a.mime_type, a.size_in_bytes),
          ),
          categories: item.tags ?? [],
        })),
      };
    }
  }
}
