import type { Entry } from '@newses/shared';
import { textOfHtml } from '../entries/text.ts';
import { escapeHtml } from '../html.ts';
import type { MailMessage } from '../ports.ts';
import { translate } from '../../i18n.ts';
import { buttonHtml, mailDocument } from './layout.ts';

/** The full article, or its title, excerpt, and link. */
export type ArticleMailInclude = 'content' | 'link';

export interface ArticleMailContent {
  entry: Entry;
  /** The sender's language. */
  locale: string;
  /** The sender's login, which the mail names. */
  sender: string;
  note?: string | undefined;
  include: ArticleMailInclude;
  /** The article's HTML as it is mailed: sanitised at ingest, images through the proxy if wanted. */
  content: string | null;
}

const MUTED = 'color:#5f5b66';
const NOTE = 'margin:0 0 24px;padding:12px 16px;border-radius:8px;background:#f3eff7';
const TITLE = 'font-size:24px;line-height:1.3;margin:0 0 4px';
const LINK = 'color:#3f51b5';

export const isHttp = (url: string | null): url is string =>
  url !== null && /^https?:\/\//i.test(url);

/** Paragraphs at blank lines and line breaks of text a person wrote, as HTML. */
const textHtml = (text: string) =>
  text
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`)
    .join('');

/**
 * An article mailed from one user to others: who sent it and their note, the article's title,
 * where it is from, and the article itself or its excerpt, with a link to the original. Everything
 * but the article's own sanitised HTML is escaped.
 */
export function articleMail({
  entry,
  locale,
  sender,
  note,
  include,
  content,
}: ArticleMailContent): Pick<MailMessage, 'subject' | 'html' | 'text'> {
  const message = (key: Parameters<typeof translate>[1]) =>
    translate(locale, key, { login: sender });
  const title = entry.title ?? message('untitled');
  const date = new Date(entry.publishedAt ?? entry.sortAt).toLocaleDateString(locale, {
    dateStyle: 'long',
    timeZone: 'UTC',
  });
  const meta = [entry.feedTitle, entry.author, date].filter((part): part is string => !!part);
  const link = isHttp(entry.link) ? entry.link : null;
  const lang = entry.lang ? ` lang="${escapeHtml(entry.lang)}"` : '';
  const trimmedNote = note?.trim() || null;
  const body = include === 'content' && content ? content : null;
  const summary = body ? null : entry.excerpt;
  const attachments =
    include === 'content' ? (entry.enclosures ?? []).filter((e) => isHttp(e.url)) : [];

  const html = [
    `<p style="${MUTED}">${escapeHtml(message('articleSentBy'))}</p>`,
    trimmedNote && `<div style="${NOTE}" dir="auto">${textHtml(trimmedNote)}</div>`,
    `<h1 style="${TITLE}" dir="auto"${lang}>${
      link
        ? `<a href="${escapeHtml(link)}" style="${LINK}">${escapeHtml(title)}</a>`
        : escapeHtml(title)
    }</h1>`,
    `<p style="${MUTED};margin:0 0 24px">${meta.map((part) => `<bdi>${escapeHtml(part)}</bdi>`).join(' · ')}</p>`,
    body && `<div dir="auto"${lang} style="overflow-wrap:anywhere">\n${body}\n</div>`,
    summary && `<p dir="auto"${lang}>${escapeHtml(summary)}</p>`,
    attachments.length > 0 &&
      `<h2 style="font-size:18px">${escapeHtml(message('attachments'))}</h2>\n<ul>${attachments
        .map(
          (e) =>
            `<li><a href="${escapeHtml(e.url)}" style="${LINK}">${escapeHtml(
              e.url.split('/').pop() || e.url,
            )}</a></li>`,
        )
        .join('')}</ul>`,
    link && `<p style="margin:24px 0">${buttonHtml(message('readOriginal'), link)}</p>`,
    `<hr style="border:0;border-top:1px solid #e0dce4;margin:32px 0 16px">`,
    `<p style="${MUTED};font-size:14px">${escapeHtml(message('articleReply'))}</p>`,
  ].filter((part): part is string => typeof part === 'string' && part !== '');

  const text = [
    message('articleSentBy'),
    trimmedNote,
    `${title}\n${meta.join(' · ')}`,
    body ? textOfHtml(body) : summary,
    ...attachments.map((e) => e.url),
    link && `${message('readOriginal')}: ${link}`,
    `-- \n${message('articleReply')}`,
  ].filter((part): part is string => !!part);

  return {
    subject: title,
    html: mailDocument(locale, title, html.join('\n')),
    text: `${text.join('\n\n')}\n`,
  };
}
