import type { Entry } from '@newses/shared';
import { describe, expect, it } from 'vitest';
import { articleMail } from './article-mail.ts';

const ENTRY: Entry = {
  id: 1,
  subscriptionId: 1,
  feedTitle: 'Fish & Chips Weekly',
  title: 'A <b>bold</b> claim',
  link: 'https://news.example/a?x=1&y=2',
  author: 'Ann "the Fish"',
  lang: 'en-GB',
  publishedAt: '2026-11-01T12:00:00.000Z',
  sortAt: '2026-11-01T12:00:00.000Z',
  unread: true,
  starred: false,
  published: false,
  score: 0,
  note: null,
  labels: [],
  tags: [],
  shareId: null,
  readAt: null,
  contentVersion: 'v',
  excerpt: 'The <start> of it.',
  content: '<p>Sanitised <em>body</em>.</p>',
  enclosures: [
    {
      url: 'https://cdn.example/episode.mp3',
      mimeType: 'audio/mpeg',
      length: 1,
      width: null,
      height: null,
      durationSeconds: null,
    },
  ],
};

const mail = (overrides: Partial<Parameters<typeof articleMail>[0]> = {}) =>
  articleMail({
    entry: ENTRY,
    locale: 'en',
    sender: 'pat',
    include: 'content',
    content: ENTRY.content ?? null,
    ...overrides,
  });

describe('articleMail', () => {
  it('escapes all but the sanitised article', () => {
    const { subject, html } = mail({ note: '<script>alert(1)</script>' });
    expect(subject).toBe('A <b>bold</b> claim');
    expect(html).toContain('<title>A &lt;b&gt;bold&lt;/b&gt; claim</title>');
    expect(html).toContain('>A &lt;b&gt;bold&lt;/b&gt; claim</a></h1>');
    expect(html).toContain('href="https://news.example/a?x=1&amp;y=2"');
    expect(html).toContain(
      '<bdi>Fish &amp; Chips Weekly</bdi> · <bdi>Ann &quot;the Fish&quot;</bdi>',
    );
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('<p>Sanitised <em>body</em>.</p>');
    expect(html).toContain('lang="en-GB"');
    expect(html).toContain('href="https://cdn.example/episode.mp3"');
  });

  it('has a plain-text part with the note, the article, and the links', () => {
    expect(mail({ note: '  Look!  ' }).text).toBe(
      [
        'pat sent you this article from Newses.',
        'Look!',
        'A <b>bold</b> claim\nFish & Chips Weekly · Ann "the Fish" · November 1, 2026',
        'Sanitised body.',
        'https://cdn.example/episode.mp3',
        'Read the original: https://news.example/a?x=1&y=2',
        '-- \nReply to this email to answer pat.',
      ].join('\n\n') + '\n',
    );
  });

  it('sends the excerpt and the link alone, and names an untitled article', () => {
    const { subject, html, text } = mail({
      entry: { ...ENTRY, title: null },
      include: 'link',
    });
    expect(subject).toBe('(untitled)');
    expect(html).toContain('<p dir="auto" lang="en-GB">The &lt;start&gt; of it.</p>');
    expect(html).not.toContain('Sanitised');
    expect(html).not.toContain('episode.mp3');
    expect(text).toContain('The <start> of it.');
  });

  it('falls back to the excerpt for an article without content', () => {
    expect(mail({ content: null }).html).toContain('The &lt;start&gt; of it.');
  });
});
