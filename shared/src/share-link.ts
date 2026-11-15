import type { ShareLink } from './platform-bridge.ts';

/** Longest title and text a shared link carries, so the `mailto:` URL stays within what mail apps take. */
export const MAX_SHARE_TITLE_LENGTH = 300;
export const MAX_SHARE_TEXT_LENGTH = 1000;

/** The text, then the link on its own after a blank line: a mail's body, or the shared text. */
export const shareBody = ({ text, url }: ShareLink): string =>
  [text, url].filter(Boolean).join('\n\n');

/**
 * A new mail with the link and no recipients (RFC 6068): the title as its subject, the text and
 * then the URL as its body, lines broken with CRLF.
 */
export function mailtoUrl(link: ShareLink): string {
  const body = shareBody(link).replace(/\r?\n/g, '\r\n');
  return `mailto:?subject=${encodeURIComponent(link.title)}&body=${encodeURIComponent(body)}`;
}
