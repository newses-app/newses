import sanitizeHtml from 'sanitize-html';
import { mapSrcset } from './srcset.ts';
import { isTrackingPixel } from './trackers.ts';

// C0 controls other than tab, newline, and carriage return; and DEL.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export function stripControlChars(text: string): string {
  return text.replace(CONTROL_CHARS, '');
}

const URL_ATTRIBUTES: Record<string, string[]> = {
  a: ['href'],
  img: ['src'],
  video: ['src', 'poster'],
  audio: ['src'],
  source: ['src'],
  iframe: ['src'],
};

function resolve(value: string, base: string | null): string {
  try {
    return new URL(value.trim(), base ?? undefined).href;
  } catch {
    return value;
  }
}

/**
 * Sanitises entry HTML against an allow-list: no scripts, styles, event handlers, or
 * non-http(s) URLs (data: only for images). Relative URLs are resolved against `base`;
 * links open in a new tab without referrer. Tracking pixels are dropped.
 */
export function sanitizeContent(html: string, base: string | null): string {
  return sanitizeHtml(stripControlChars(html), {
    allowedTags: [
      ...sanitizeHtml.defaults.allowedTags,
      'img',
      'picture',
      'source',
      'video',
      'audio',
      'iframe',
      'del',
      'ins',
      'sub',
      'sup',
    ],
    allowedAttributes: {
      a: ['href', 'title', 'name', 'target', 'rel'],
      img: ['src', 'srcset', 'sizes', 'alt', 'title', 'width', 'height'],
      source: ['src', 'srcset', 'sizes', 'type', 'media'],
      video: ['src', 'poster', 'controls', 'width', 'height'],
      audio: ['src', 'controls'],
      iframe: ['src', 'width', 'height', 'allowfullscreen'],
      td: ['colspan', 'rowspan'],
      th: ['colspan', 'rowspan'],
      ol: ['start', 'reversed'],
      '*': ['lang', 'dir'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: { img: ['http', 'https', 'data'] },
    allowedIframeHostnames: ['www.youtube.com', 'www.youtube-nocookie.com', 'player.vimeo.com'],
    allowProtocolRelative: false,
    exclusiveFilter: (frame) => frame.tag === 'img' && isTrackingPixel(frame.attribs),
    transformTags: {
      '*': (tagName, attribs) => {
        for (const attribute of URL_ATTRIBUTES[tagName] ?? []) {
          const value = attribs[attribute];
          if (value) attribs[attribute] = resolve(value, base);
        }
        if (attribs.srcset) attribs.srcset = mapSrcset(attribs.srcset, (url) => resolve(url, base));
        if (tagName === 'a') {
          attribs.target = '_blank';
          attribs.rel = 'noopener noreferrer nofollow';
        }
        if (tagName === 'video' || tagName === 'audio') attribs.controls = '';
        return { tagName, attribs };
      },
    },
  }).trim();
}

/** Plain-text title: markup removed, whitespace collapsed. */
export function sanitizeTitle(title: string | null): string | null {
  if (!title) return null;
  const text = sanitizeHtml(stripControlChars(title), { allowedTags: [], allowedAttributes: {} })
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
  return text || null;
}
