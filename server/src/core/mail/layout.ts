import { LOCALES } from '@newses/shared/locales';
import { escapeHtml } from '../html.ts';
import type { MailMessage } from '../ports.ts';

export interface MailContent {
  /** The language the mail is in, for its `lang` and direction. */
  locale: string;
  subject: string;
  /** Plain text, one paragraph each. */
  paragraphs: readonly string[];
  /** A button after the first paragraph, its link spelled out in the text part. */
  action?: { label: string; url: string };
}

const BODY = 'margin:0;padding:24px 16px;background:#ffffff;color:#1d1b20';
const MAIN = 'max-width:36rem;margin:0 auto;font:16px/1.5 system-ui,-apple-system,sans-serif';
const BUTTON =
  'display:inline-block;padding:10px 20px;border-radius:20px;background:#3f51b5;' +
  'color:#ffffff;text-decoration:none;font-weight:600';

/** A link styled as a button, which mail clients show without the page's styles. */
export const buttonHtml = (label: string, url: string) =>
  `<a href="${escapeHtml(url)}" style="${BUTTON}">${escapeHtml(label)}</a>`;

/**
 * A mail's HTML document around `body`, which is already HTML: no images or remote styles of its
 * own, so it reads the same with them blocked.
 */
export function mailDocument(locale: string, subject: string, body: string): string {
  const dir = LOCALES.find((candidate) => candidate.code === locale)?.direction ?? 'ltr';
  return `<!doctype html>
<html lang="${escapeHtml(locale)}" dir="${dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width">
<title>${escapeHtml(subject)}</title>
<style>img, video { max-width: 100%; height: auto; }</style>
</head>
<body style="${BODY}">
<main style="${MAIN}">
${body}
</main>
</body>
</html>
`;
}

/** A mail's HTML and plain-text parts from text already in its language, every part escaped. */
export function renderMail({
  locale,
  subject,
  paragraphs,
  action,
}: MailContent): Pick<MailMessage, 'subject' | 'html' | 'text'> {
  const blocks = paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`);
  const texts = [...paragraphs];
  if (action) {
    blocks.splice(1, 0, `<p style="margin:24px 0">${buttonHtml(action.label, action.url)}</p>`);
    texts.splice(1, 0, `${action.label}: ${action.url}`);
  }
  return {
    subject,
    html: mailDocument(locale, subject, blocks.join('\n')),
    text: `${texts.join('\n\n')}\n`,
  };
}
