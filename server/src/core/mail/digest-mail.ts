import type { DigestFrequency, Entry } from '@newses/shared';
import type { MessageParams } from '@newses/shared/messages';
import { type MessageKey, translate } from '../../i18n.ts';
import { escapeHtml } from '../html.ts';
import type { DigestAddition, DigestAdditionSection, DigestTest } from '../plugins/catalog.ts';
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
  /** Plugins' overviews and their sections, and text under listed entries. */
  additions?: readonly DigestAddition[];
  frequency: Exclude<DigestFrequency, 'off'>;
  hour: number;
  weekday: number;
  timeZone: string;
  markedRead: boolean;
  unsubscribeUrl: string;
  /**
   * A test digest someone asked for: how each plugin on for them did; such a digest says so
   * instead of when digests come, and has no unsubscribe link.
   */
  test?: { plugins: readonly Pick<DigestTest, 'name' | 'failure' | 'detail'>[] };
}

const MUTED = 'color:#5f5b66';
const GROUP = 'font-size:20px;margin:32px 0 8px';
const FEED = 'font-size:16px;margin:24px 0 8px;color:#5f5b66';
const ITEM = 'margin:0 0 16px';
const TITLE = 'font-weight:600;color:#3f51b5;text-decoration:none';
const LINK = 'color:#3f51b5';
const ADDITION = 'margin:24px 0';
const NOTE = 'margin-top:4px;color:#5f5b66;font-style:italic';
const SECTION = 'font-size:16px;font-weight:600;margin:16px 0 8px';
const CITED = 'margin:2px 0 0;font-size:14px';

/** Plain text as paragraphs (split at blank lines) of escaped lines. */
const paragraphs = (text: string, style: string) =>
  text
    .split(/\n{2,}/)
    .map(
      (paragraph) =>
        `<p style="${style}" dir="auto">${escapeHtml(paragraph).replaceAll('\n', '<br>')}</p>`,
    )
    .join('');

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
export const appEntryUrl = (appUrl: string, entry: Pick<Entry, 'id' | 'subscriptionId'>) =>
  `${appUrl}/${entry.subscriptionId === null ? 'all' : `f${String(entry.subscriptionId)}`}/${String(entry.id)}`;

/**
 * A plugin's sections as HTML and as text: each heading, then its points as paragraphs or a list,
 * each followed by the titles of the entries it cites, linked into the web app.
 */
function sectionsMail(
  sections: readonly DigestAdditionSection[],
  appUrl: string,
  untitled: string,
): { html: string; text: string[] } {
  const html: string[] = [];
  const text: string[] = [];
  for (const section of sections) {
    html.push(`<p style="${SECTION}" dir="auto">${escapeHtml(section.heading)}</p>`);
    text.push(section.heading);
    const points = section.items.map((item) => {
      const cited = item.entries.map((entry) => ({
        title: entry.title.trim() || untitled,
        url: appEntryUrl(appUrl, entry),
      }));
      const lines = escapeHtml(item.text).replaceAll('\n', '<br>');
      const links = cited
        .map(
          ({ title, url }) =>
            `<div style="${CITED}" dir="auto"><a href="${escapeHtml(url)}" style="${LINK}">${escapeHtml(title)}</a></div>`,
        )
        .join('');
      text.push(
        [
          section.list ? `- ${item.text.replaceAll('\n', '\n  ')}` : item.text,
          ...cited.map(({ title, url }) => `  ${title}: ${url}`),
        ].join('\n'),
      );
      return section.list
        ? `<li style="margin:0 0 8px" dir="auto">${lines}${links}</li>`
        : `<div style="margin:0 0 8px" dir="auto"><p style="margin:0">${lines}</p>${links}</div>`;
    });
    html.push(
      section.list ? `<ul style="margin:0 0 8px">${points.join('')}</ul>` : points.join(''),
    );
  }
  return { html: html.join(''), text };
}

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

/** Why a plugin added nothing to a test digest, if it did not. */
function testOutcome(
  { name: plugin, failure, detail }: Pick<DigestTest, 'name' | 'failure' | 'detail'>,
  message: (key: MessageKey, params?: MessageParams) => string,
): string[] {
  switch (failure) {
    case null:
      return [];
    case 'error':
      return [
        detail
          ? message('digestTestError', { plugin, detail })
          : message('digestTestFailed', { plugin }),
      ];
    case 'timeout':
      return [message('digestTestTimeout', { plugin })];
    case 'invalid':
      return [message('digestTestInvalid', { plugin })];
    case 'empty':
      return [message('digestTestEmpty', { plugin })];
  }
}

/**
 * The unread digest: unread entries that came in since the last, by category and subscription,
 * each linked into the web app and to the original, with how many more there are, when it comes,
 * and links to its settings and to unsubscribe. Plugins' overviews open it, under each plugin's
 * name, and their text follows the entries it is for. Every part is escaped; no entry content is
 * sent.
 */
export function digestMail(content: DigestContent): Pick<MailMessage, 'subject' | 'html' | 'text'> {
  const { locale, appUrl, groups, more } = content;
  const additions = content.additions ?? [];
  const lang = escapeHtml(locale);
  const message = (key: MessageKey, params: MessageParams = {}) =>
    translate(locale, key, { login: content.login, ...params });
  const count = groups.reduce(
    (sum, group) => sum + group.feeds.reduce((n, feed) => n + feed.entries.length, 0),
    0,
  );
  const test = content.test;
  const subject = test
    ? message('digestTestSubject', { n: count + more })
    : message('digestSubject', { n: count + more });
  const categories = groups.some((group) => group.title !== null);
  const settingsUrl = `${appUrl}/settings/account`;

  const intro = test
    ? [
        message('digestTestIntro'),
        ...test.plugins.flatMap((plugin) => testOutcome(plugin, message)),
      ]
    : [message('digestIntro')];
  const html = intro.map((line) => `<p style="${MUTED}">${escapeHtml(line)}</p>`);
  const text = [intro.join('\n')];
  for (const addition of additions) {
    if (!addition.overview && addition.sections.length === 0) continue;
    const sections = sectionsMail(addition.sections, appUrl, message('untitled'));
    html.push(
      `<div style="${ADDITION}" lang="${lang}">` +
        `<p style="${MUTED};font-size:14px;margin:0 0 8px" dir="auto">${escapeHtml(addition.name)}</p>` +
        (addition.overview ? paragraphs(addition.overview, 'margin:0 0 8px') : '') +
        sections.html +
        `</div>`,
    );
    text.push(
      [addition.name, ...(addition.overview ? [addition.overview] : []), ...sections.text].join(
        '\n\n',
      ),
    );
  }
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
        const entryLang = entry.lang ? ` lang="${escapeHtml(entry.lang)}"` : '';
        const notes = additions.flatMap((addition) => addition.entries.get(entry.id) ?? []);
        const inApp = appEntryUrl(appUrl, entry);
        const original = isHttp(entry.link) ? entry.link : null;
        html.push(
          `<div style="${ITEM}" dir="auto"${entryLang}>` +
            `<a href="${escapeHtml(inApp)}" style="${TITLE}">${escapeHtml(title)}</a>` +
            (entry.excerpt ? `<br>${escapeHtml(entry.excerpt)}` : '') +
            notes
              .map(
                (note) =>
                  `<div style="${NOTE}" lang="${lang}" dir="auto">${escapeHtml(note).replaceAll('\n', '<br>')}</div>`,
              )
              .join('') +
            (original
              ? `<br><a href="${escapeHtml(original)}" style="${LINK};font-size:14px">${escapeHtml(message('digestOriginal'))}</a>`
              : '') +
            `</div>`,
        );
        text.push(
          [
            title,
            entry.excerpt,
            ...notes,
            inApp,
            original && `${message('digestOriginal')}: ${original}`,
          ]
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

  const footer = test
    ? [message('digestTestFooter')]
    : [...(content.markedRead ? [message('digestMarkedRead')] : []), schedule(content, message)];
  const links = [
    { label: message('digestSettings'), url: settingsUrl },
    ...(test ? [] : [{ label: message('digestUnsubscribe'), url: content.unsubscribeUrl }]),
  ];
  html.push(
    `<hr style="border:0;border-top:1px solid #e0dce4;margin:32px 0 16px">`,
    ...footer.map((line) => `<p style="${MUTED};font-size:14px">${escapeHtml(line)}</p>`),
    `<p style="${MUTED};font-size:14px">` +
      links
        .map(
          (link) =>
            `<a href="${escapeHtml(link.url)}" style="${LINK}">${escapeHtml(link.label)}</a>`,
        )
        .join(' · ') +
      `</p>`,
  );
  text.push(['-- ', ...footer, ...links.map((link) => `${link.label}: ${link.url}`)].join('\n'));

  return {
    subject,
    html: mailDocument(locale, subject, html.join('\n')),
    text: `${text.join('\n\n')}\n`,
  };
}
