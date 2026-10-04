import { describe, expect, it } from 'vitest';
import { discoverFeeds, looksLikeHtml } from './discover.ts';

describe('discoverFeeds', () => {
  it('finds alternate feed links, resolved and de-duplicated', () => {
    const html = `<!doctype html><html><head>
      <link rel="alternate" type="application/rss+xml" title="Posts" href="/feed.xml">
      <link rel="Alternate" type="application/atom+xml; charset=utf-8" href="atom.xml">
      <link rel="alternate" type="application/feed+json" href="https://cdn.example/f.json">
      <link rel="alternate" type="application/rss+xml" href="/feed.xml">
      <link rel="alternate" type="text/html" hreflang="fr" href="/fr/">
      <link rel="stylesheet" type="text/css" href="/style.css">
    </head></html>`;
    expect(discoverFeeds(html, 'https://blog.example/posts/')).toEqual([
      { url: 'https://blog.example/feed.xml', title: 'Posts', type: 'application/rss+xml' },
      { url: 'https://blog.example/posts/atom.xml', title: null, type: 'application/atom+xml' },
      { url: 'https://cdn.example/f.json', title: null, type: 'application/feed+json' },
    ]);
  });

  it('honours <base href>', () => {
    const html =
      '<html><head><base href="https://other.example/x/"><link rel="alternate" type="application/rss+xml" href="rss"></head></html>';
    expect(discoverFeeds(html, 'https://blog.example/')[0]?.url).toBe(
      'https://other.example/x/rss',
    );
  });

  it('detects HTML by content type or doctype', () => {
    expect(looksLikeHtml('<rss/>', 'text/html; charset=utf-8')).toBe(true);
    expect(looksLikeHtml('  <!DOCTYPE html><html>', null)).toBe(true);
    expect(looksLikeHtml('<?xml version="1.0"?><rss/>', 'application/xml')).toBe(false);
  });
});
