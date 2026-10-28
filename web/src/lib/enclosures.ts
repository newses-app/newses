import type { Enclosure } from '@newses/shared';
import { type EnclosureKind, enclosureKind } from '@newses/shared/client';
import { safeUrl } from './format.ts';
import { absolute } from './native-urls.ts';
import { originalImageUrl } from './offline-content.ts';

/** An enclosure as the article shows it. */
export interface EnclosureView {
  enclosure: Enclosure;
  kind: EnclosureKind;
  /** The file name from the URL, for captions and links. */
  name: string;
  /** Plays inline: audio or video the browser can play, online, and not already in the content. */
  player: boolean;
  /** Where the gallery loads the image from; null when the image shows only as a link. */
  imageSrc: string | null;
}

export interface EnclosureViewOptions {
  /** The article HTML as stored, before stored or absolute URLs, to leave out what it shows. */
  content: string | null | undefined;
  /** Images stored on the device (`blob:` URLs), by original URL. */
  stored: ReadonlyMap<string, string>;
  online: boolean;
  /** The server the apps talk to, for proxy paths; null in the browser. */
  server: string | null;
  /** Whether the browser plays a MIME type (`canPlayType`). */
  canPlay: (mimeType: string) => boolean;
}

/** The images, audio, and video the article HTML already shows, by original URL. */
export function contentMediaUrls(html: string | null | undefined): Set<string> {
  const urls = new Set<string>();
  if (!html) return urls;
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  for (const img of doc.querySelectorAll('img[src]'))
    urls.add(originalImageUrl(img.getAttribute('src') ?? ''));
  for (const media of doc.querySelectorAll('audio[src], video[src], audio source, video source'))
    urls.add(media.getAttribute('src') ?? '');
  return urls;
}

function fileName(url: string): string {
  const last = new URL(url).pathname.split('/').pop() ?? '';
  try {
    return decodeURIComponent(last) || url;
  } catch {
    return last || url;
  }
}

/**
 * The entry's http(s) enclosures as the article shows them: players for audio and video, a gallery
 * for images, the rest as links. Without a connection only stored images show; nothing plays.
 */
export function enclosureViews(
  enclosures: readonly Enclosure[],
  options: EnclosureViewOptions,
): EnclosureView[] {
  const shown = contentMediaUrls(options.content);
  return enclosures
    .filter((enclosure) => safeUrl(enclosure.url))
    .map((enclosure) => {
      const kind = enclosureKind(enclosure);
      const inContent = shown.has(enclosure.url);
      // Typed media asks the browser; media known only by its extension is tried.
      const type = enclosure.mimeType?.split(';')[0]?.trim() ?? '';
      const playable = /^(audio|video)\//i.test(type) ? options.canPlay(type) : true;
      let imageSrc: string | null = null;
      if (kind === 'image' && !inContent)
        imageSrc =
          options.stored.get(enclosure.url) ??
          (options.online ? absolute(enclosure.proxy ?? enclosure.url, options.server) : null);
      return {
        enclosure,
        kind,
        name: fileName(enclosure.url),
        player: (kind === 'audio' || kind === 'video') && !inContent && options.online && playable,
        imageSrc,
      };
    });
}
