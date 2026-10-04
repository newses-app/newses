import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeBody } from './decode.ts';
import { FeedParseError, parseFeed } from './parse.ts';

const FEED_URL = 'https://edge.example/feed';
const load = (name: string) =>
  parseFeed(
    decodeBody(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)), null),
    FEED_URL,
  );
const first = (name: string) => {
  const entry = load(name).entries[0];
  if (!entry) throw new Error(`no entries in ${name}`);
  return entry;
};

describe('parseFeed', () => {
  it('parses RSS 0.91', () => {
    expect(first('rss091.xml')).toMatchObject({
      title: 'Hello 0.91',
      link: 'http://old.example/1',
      content: 'Body one',
    });
  });

  it('parses RSS 2.0 with content, Dublin Core, media, and iTunes', () => {
    const feed = load('rss2-full.xml');
    expect(feed).toMatchObject({ format: 'rss', title: 'Full', siteUrl: 'https://full.example/' });
    expect(feed.entries[0]).toMatchObject({
      guid: 'full-guid-1',
      link: 'https://full.example/posts/1',
      author: 'Jane Doe',
      content: '<p>Full <b>content</b> here</p>',
      categories: ['news', 'tech'],
    });
    expect(feed.entries[0]?.publishedAt?.toISOString()).toBe('2026-10-03T14:00:00.000Z');
    expect(feed.entries[0]?.enclosures).toEqual([
      expect.objectContaining({
        url: 'https://full.example/ep1.mp3',
        mimeType: 'audio/mpeg',
        length: 12345,
      }),
      expect.objectContaining({ url: 'https://full.example/img.jpg', mimeType: 'image/jpeg' }),
    ]);
  });

  it('parses Atom 0.3', () => {
    const entry = first('atom03.xml');
    expect(entry).toMatchObject({
      title: 'Atom03 entry',
      link: 'http://a03.example/1',
      author: 'Old Atom',
    });
    expect(entry.content).toContain('<p>Atom03 body</p>');
    expect(entry.publishedAt?.toISOString()).toBe('2026-10-03T12:00:00.000Z');
  });

  it('parses Atom with XHTML content, xml:base, and enclosure links', () => {
    const entry = first('atom-xhtml.xml');
    expect(entry.link).toBe('https://ax.example/blog/posts/1');
    expect(entry.author).toBe('Axel');
    expect(entry.content).toContain('<em>body</em>');
    expect(entry.publishedAt?.toISOString()).toBe('2026-10-03T10:00:00.000Z');
    expect(entry.enclosures[0]).toMatchObject({
      url: 'https://ax.example/file.pdf',
      mimeType: 'application/pdf',
    });
  });

  it('parses RSS 1.0 (RDF)', () => {
    const entry = first('rdf.xml');
    expect(entry).toMatchObject({
      guid: 'https://rdf.example/1',
      title: 'RDF item',
      author: 'Rita',
    });
    expect(entry.content).toContain('RDF full');
    expect(entry.publishedAt?.toISOString()).toBe('2026-10-03T07:30:00.000Z');
  });

  it('parses JSON Feed 1.1', () => {
    expect(load('jsonfeed11.json').entries[0]).toMatchObject({
      guid: 'j1',
      link: 'https://json.example/1',
      author: 'Jason',
      content: '<p>JSON body</p>',
      categories: ['a', 'b'],
      enclosures: [
        expect.objectContaining({ url: 'https://json.example/a.mp3', mimeType: 'audio/mpeg' }),
      ],
    });
  });

  it('tolerates unescaped ampersands, HTML entities, BOMs, and Latin-1', () => {
    expect(first('malformed-amp.xml')).toMatchObject({
      title: 'Q&A session',
      link: 'https://amp.example/?a=1&b=2',
    });
    expect(first('html-entities.xml').title).toBe('Café time — ok');
    expect(first('bom.xml').title).toBe('BOM item');
    expect(first('latin1.xml').title).toBe('Café crème');
  });

  it('parses dates leniently', () => {
    expect(load('bad-dates.xml').entries.map((e) => e.publishedAt?.toISOString() ?? null)).toEqual([
      '2026-10-03T14:00:00.000Z',
      '2026-10-03T18:00:00.000Z',
      null,
      '2026-10-03T14:00:00.000Z',
    ]);
  });

  it('keeps entries without GUIDs or titles', () => {
    expect(load('no-guid.xml').entries.map((e) => [e.guid, e.title])).toEqual([
      [null, 'Only title'],
      [null, null],
    ]);
    expect(load('empty.xml').entries).toEqual([]);
  });

  it('reads update hints from RSS ttl and the syndication module', () => {
    const channel = (extra: string, ns = '') =>
      `<rss version="2.0"${ns}><channel><title>T</title>${extra}</channel></rss>`;
    const sy = ' xmlns:sy="http://purl.org/rss/1.0/modules/syndication/"';
    expect(parseFeed(channel('<ttl>90</ttl>'), FEED_URL).ttlSeconds).toBe(5400);
    expect(
      parseFeed(
        channel(
          '<sy:updatePeriod>daily</sy:updatePeriod><sy:updateFrequency>2</sy:updateFrequency>',
          sy,
        ),
        FEED_URL,
      ).ttlSeconds,
    ).toBe(43_200);
    expect(load('rss091.xml').ttlSeconds).toBeNull();
  });

  it('rejects HTML pages and structurally broken XML', () => {
    expect(() => load('not-a-feed.html')).toThrow(FeedParseError);
    expect(() => load('truncated.xml')).toThrow(FeedParseError);
  });
});
