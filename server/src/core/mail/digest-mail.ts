import type { DigestFrequency, Entry } from '@newses/shared';
import type { MessageParams } from '@newses/shared/messages';
import { type MessageKey, translate } from '../../i18n.ts';
import { escapeHtml } from '../html.ts';
import type { MailMessage } from '../ports.ts';
import { isHttp } from './article-mail.ts';
import { buttonHtml, mailDocument } from './layout.ts';

/** An entry a digest lists, with the category of its subscription. */
export interface DigestEntry extends Entry {
  categoryTitle: string | null;
}

/** A subscription's entries in a digest, newest first. */
export interface DigestFeed {
  title: string;
  entries: DigestEntry[];
}

/** A category's subscriptions in a digest; `title` null for those without a category. */
export interface DigestGroup {
  title: string | null;
  feeds: DigestFeed[];
}

export interface DigestContent {
  locale: string;
  login: string;
  /** Origin of the web app, without a trailing slash. */
  appUrl: string;
  groups: DigestGroup[];
  /** Unread entries left out over the cap. */
  more: number;
  frequency: Exclude<DigestFrequency, 'off'>;
  hour: number;
  weekday: number;
  timeZone: string;
  markedRead: boolean;
  unsubscribeUrl: string;
}

const MUTED = 'color:#5f5b66';
const GROUP = 'font-size:20px;margin:32px 0 8px';
const FEED = 'font-size:16px;margin:24px 0 8px;color:#5f5b66';
const ITEM = 'margin:0 0 16px';
const TITLE = 'font-weight:600;color:#3f51b5;text-decoration:none';
const LINK = 'color:#3f51b5';

/**
 * Entries grouped by category, then subscription, both by title (entries without a category
 * last), each subscription's entries in the order given.
 */
export function groupDigest(entries: DigestEntry[], locale: string): DigestGroup[] {
  const groups = new Map<string | null, Map<string, DigestEntry[]>>();
  for (const entry of entries) {
    const feeds = groups.get(entry.categoryTitle) ?? new Map<string, DigestEntry[]>();
    groups.set(entry.categoryTitle, feeds);
    const feed = entry.feedTitle ?? '';
    feeds.set(feed, [...(feeds.get(feed) ?? []), entry]);
  }
  const byTitle = (a: string, b: string) => a.localeCompare(b, locale);
  return [...groups]
    .sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : byTitle(a, b)))
    .map(([title, feeds]) => ({
      title,
      feeds: [...feeds]
        .sort(([a], [b]) => byTitle(a, b))
        .map(([feedTitle, list]) => ({ title: feedTitle, entries: list })),
    }));
}

/** The entry in the web app's reader, in its subscription or else in All. */
export const appEntryUrl = (appUrl: string, entry: Entry) =>
  `${appUrl}/${entry.subscriptionId === null ? 'all' : `f${String(entry.subscriptionId)}`}/${String(entry.id)}`;

/** When the digest goes out, in the user's words: the day, the hour, and the time zone. */
function schedule(
  content: DigestContent,
  message: (key: MessageKey, params?: MessageParams) => string,
) {
  const time = new Intl.DateTimeFormat(content.locale, {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
  }).format(Date.UTC(2026, 0, 1, content.hour));
  // 4 January 2026 was a Sunday.
  const day = new Intl.DateTimeFormat(content.locale, { weekday: 'long', timeZone: 'UTC' }).format(
    Date.UTC(2026, 0, 4 + content.weekday),
  );
  return content.frequency === 'weekly'
    ? message('digestWeekly', { day, time, zone: content.timeZone })
    : message('digestDaily', { time, zone: content.timeZone });
}

/**
 * The unread digest: unread entries that came in since the last, by category and subscription,
 * each linked into the web app and to the original, with how many more there are, when it comes,
 * and links to its settings and to unsubscribe. Every part is escaped; no entry content is sent.
 */
export function digestMail(content: DigestContent): Pick<MailMessage, 'subject' | 'html' | 'text'> {
  const { locale, appUrl, groups, more } = content;
  const message = (key: MessageKey, params: MessageParams = {}) =>
    translate(locale, key, { login: content.login, ...params });
  const count = groups.reduce(
    (sum, group) => sum + group.feeds.reduce((n, feed) => n + feed.entries.length, 0),
    0,
  );
  const subject = message('digestSubject', { n: count + more });
  const categories = groups.some((group) => group.title !== null);
  const settingsUrl = `${appUrl}/settings/account`;

  const html: string[] = [`<p style="${MUTED}">${escapeHtml(message('digestIntro'))}</p>`];
  const text: string[] = [message('digestIntro')];
  for (const group of groups) {
    if (categories) {
      const title = group.title ?? message('digestUncategorised');
      html.push(`<h2 style="${GROUP}" dir="auto">${escapeHtml(title)}</h2>`);
      text.push(`== ${title} ==`);
    }
    for (const feed of group.feeds) {
      html.push(`<h3 style="${FEED}" dir="auto">${escapeHtml(feed.title)}</h3>`);
      text.push(`-- ${feed.title} --`);
      for (const entry of feed.entries) {
        const title = entry.title ?? message('untitled');
        const lang = entry.lang ? ` lang="${escapeHtml(entry.lang)}"` : '';
        const inApp = appEntryUrl(appUrl, entry);
        const original = isHttp(entry.link) ? entry.link : null;
        html.push(
          `<div style="${ITEM}" dir="auto"${lang}>` +
            `<a href="${escapeHtml(inApp)}" style="${TITLE}">${escapeHtml(title)}</a>` +
            (entry.excerpt ? `<br>${escapeHtml(entry.excerpt)}` : '') +
            (original
              ? `<br><a href="${escapeHtml(original)}" style="${LINK};font-size:14px">${escapeHtml(message('digestOriginal'))}</a>`
              : '') +
            `</div>`,
        );
        text.push(
          [title, entry.excerpt, inApp, original && `${message('digestOriginal')}: ${original}`]
            .filter((part): part is string => !!part)
            .join('\n'),
        );
      }
    }
  }
  if (more > 0) {
    html.push(`<p style="margin:24px 0 0">${escapeHtml(message('digestMore', { n: more }))}</p>`);
    text.push(message('digestMore', { n: more }));
  }
  html.push(`<p style="margin:24px 0">${buttonHtml(message('digestOpen'), `${appUrl}/all`)}</p>`);
  text.push(`${message('digestOpen')}: ${appUrl}/all`);

  const footer = [
    ...(content.markedRead ? [message('digestMarkedRead')] : []),
    schedule(content, message),
  ];
  html.push(
    `<hr style="border:0;border-top:1px solid #e0dce4;margin:32px 0 16px">`,
    ...footer.map((line) => `<p style="${MUTED};font-size:14px">${escapeHtml(line)}</p>`),
    `<p style="${MUTED};font-size:14px">` +
      `<a href="${escapeHtml(settingsUrl)}" style="${LINK}">${escapeHtml(message('digestSettings'))}</a> · ` +
      `<a href="${escapeHtml(content.unsubscribeUrl)}" style="${LINK}">${escapeHtml(message('digestUnsubscribe'))}</a></p>`,
  );
  text.push(
    [
      '-- ',
      ...footer,
      `${message('digestSettings')}: ${settingsUrl}`,
      `${message('digestUnsubscribe')}: ${content.unsubscribeUrl}`,
    ].join('\n'),
  );

  return {
    subject,
    html: mailDocument(locale, subject, html.join('\n')),
    text: `${text.join('\n\n')}\n`,
  };
}
