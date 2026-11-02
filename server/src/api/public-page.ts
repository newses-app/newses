import type { Entry } from '@newses/shared';
import { LOCALES } from '@newses/shared/locales';
import { VIDEO_FRAME_SOURCES } from '@newses/shared/web-csp';
import { messagesFor } from '../i18n.ts';

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
  pre, code { direction: ltr; unicode-bidi: isolate; }
  audio, video { direction: ltr; }
  blockquote { margin-inline: 0; padding-inline-start: 1rem; border-inline-start: 3px solid var(--muted); }
  footer { margin-top: 3rem; }
`;

function page(locale: string, title: string, body: string): string {
  const direction = LOCALES.find((known) => known.code === locale)?.direction ?? 'ltr';
  return `<!doctype html>
<html lang="${locale}" dir="${direction}">
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
export function sharedEntryPage(entry: Entry, locale: string): string {
  const text = messagesFor(locale);
  const title = entry.title ?? text.untitled;
  const date = entry.publishedAt ?? entry.sortAt;
  const heading = isHttp(entry.link)
    ? `<a href="${escapeHtml(entry.link)}" rel="noopener noreferrer">${escapeHtml(title)}</a>`
    : escapeHtml(title);
  const meta = [
    entry.feedTitle && `<bdi>${escapeHtml(entry.feedTitle)}</bdi>`,
    entry.author && `<bdi>${escapeHtml(entry.author)}</bdi>`,
    `<time datetime="${escapeHtml(date)}">${escapeHtml(
      new Date(date).toLocaleDateString(locale, { dateStyle: 'long', timeZone: 'UTC' }),
    )}</time>`,
  ].filter(Boolean);
  const attachments = (entry.enclosures ?? []).filter((e) => isHttp(e.url));
  const lang = entry.lang ? ` lang="${escapeHtml(entry.lang)}"` : '';
  return page(
    locale,
    title,
    `<article>
<header>
<h1 dir="auto"${lang}>${heading}</h1>
<p class="meta">${meta.join(' · ')}</p>
</header>
<div dir="auto"${lang}>
${entry.content ?? `<p>${escapeHtml(entry.excerpt ?? '')}</p>`}
</div>
${
  attachments.length
    ? `<h2>${escapeHtml(text.attachments)}</h2>\n<ul>${attachments
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
${isHttp(entry.link) ? `<p><a href="${escapeHtml(entry.link)}" rel="noopener noreferrer">${escapeHtml(text.readOriginal)}</a></p>` : ''}
<footer>${escapeHtml(text.sharedFrom)}</footer>`,
  );
}

export function notFoundPage(locale: string): string {
  const text = messagesFor(locale);
  return page(
    locale,
    text.notAvailable,
    `<h1>${escapeHtml(text.notAvailable)}</h1>\n<p>${escapeHtml(text.notAvailableText)}</p>`,
  );
}
