import type { Entry } from '@rss-reader/shared';
import { VIDEO_FRAME_SOURCES } from './web-csp.ts';

/**
 * Policy for public pages: no scripts at all, the entry's images, media, and embedded videos,
 * and nothing that could submit or frame the page.
 */
export const PUBLIC_PAGE_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  'img-src * data:',
  'media-src *',
  `frame-src ${VIDEO_FRAME_SOURCES}`,
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Text and attribute values as HTML. */
export const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);

const isHttp = (url: string | null): url is string => url !== null && /^https?:/i.test(url);

const STYLE = `
  :root { color-scheme: light dark; --fg: #1d1b20; --muted: #5f5b66; --bg: #fffbfe; --link: #3f51b5; }
  @media (prefers-color-scheme: dark) {
    :root { --fg: #e6e1e5; --muted: #b5afbb; --bg: #1c1b1f; --link: #a8b4ff; }
  }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 1rem/1.6 system-ui, sans-serif; }
  main { max-width: 50rem; margin: 0 auto; padding: 2rem 1rem; overflow-wrap: anywhere; }
  a { color: var(--link); }
  h1 { font-size: 1.75rem; line-height: 1.3; margin: 0 0 .25rem; }
  .meta, footer { color: var(--muted); font-size: .9rem; }
  img, video, iframe { max-width: 100%; height: auto; }
  pre { overflow-x: auto; }
  blockquote { margin-inline: 0; padding-inline-start: 1rem; border-inline-start: 3px solid var(--muted); }
  footer { margin-top: 3rem; }
`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;
}

/** A shared entry as a standalone page. `content` is sanitised HTML, safe to embed. */
export function sharedEntryPage(entry: Entry): string {
  const title = entry.title ?? '(untitled)';
  const date = entry.publishedAt ?? entry.sortAt;
  const heading = isHttp(entry.link)
    ? `<a href="${escapeHtml(entry.link)}" rel="noopener noreferrer">${escapeHtml(title)}</a>`
    : escapeHtml(title);
  const meta = [
    entry.feedTitle && escapeHtml(entry.feedTitle),
    entry.author && escapeHtml(entry.author),
    `<time datetime="${escapeHtml(date)}">${escapeHtml(
      new Date(date).toLocaleDateString('en', { dateStyle: 'long', timeZone: 'UTC' }),
    )}</time>`,
  ].filter(Boolean);
  const attachments = (entry.enclosures ?? []).filter((e) => isHttp(e.url));
  return page(
    title,
    `<article>
<header>
<h1>${heading}</h1>
<p class="meta">${meta.join(' · ')}</p>
</header>
${entry.content ?? `<p>${escapeHtml(entry.excerpt ?? '')}</p>`}
${
  attachments.length
    ? `<h2>Attachments</h2>\n<ul>${attachments
        .map(
          (e) =>
            `<li><a href="${escapeHtml(e.url)}" rel="noopener noreferrer">${escapeHtml(
              e.url.split('/').pop() || e.url,
            )}</a></li>`,
        )
        .join('')}</ul>`
    : ''
}
</article>
${isHttp(entry.link) ? `<p><a href="${escapeHtml(entry.link)}" rel="noopener noreferrer">Read the original</a></p>` : ''}
<footer>Shared from rss-reader.</footer>`,
  );
}

export const notFoundPage = () =>
  page(
    'Not available',
    '<h1>Not available</h1>\n<p>This link does not exist or is no longer shared.</p>',
  );
