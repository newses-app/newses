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

/**
 * A mail's HTML and plain-text parts, from text already in its language: no images or remote
 * styles, so it reads the same with them blocked, and every part of it escaped.
 */
export function renderMail({
  locale,
  subject,
  paragraphs,
  action,
}: MailContent): Pick<MailMessage, 'subject' | 'html' | 'text'> {
  const dir = LOCALES.find((candidate) => candidate.code === locale)?.direction ?? 'ltr';
  const blocks = paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`);
  const texts = [...paragraphs];
  if (action) {
    const url = escapeHtml(action.url);
    blocks.splice(
      1,
      0,
      `<p style="margin:24px 0"><a href="${url}" style="${BUTTON}">${escapeHtml(action.label)}</a></p>`,
    );
    texts.splice(1, 0, `${action.label}: ${action.url}`);
  }
  const html = `<!doctype html>
<html lang="${escapeHtml(locale)}" dir="${dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width">
<title>${escapeHtml(subject)}</title>
</head>
<body style="${BODY}">
<main style="${MAIN}">
${blocks.join('\n')}
</main>
</body>
</html>
`;
  return { subject, html, text: `${texts.join('\n\n')}\n` };
}
