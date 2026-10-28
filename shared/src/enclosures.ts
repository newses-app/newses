// How enclosures show, shared by the API and the web app (no Zod, so browsers can import it).

export type EnclosureKind = 'audio' | 'video' | 'image' | 'other';

/** Types that say nothing about the content; the file extension decides instead. */
const GENERIC_TYPES = new Set(['', 'application/octet-stream', 'binary/octet-stream']);

const EXTENSIONS: Record<string, EnclosureKind> = {
  mp3: 'audio',
  m4a: 'audio',
  aac: 'audio',
  oga: 'audio',
  ogg: 'audio',
  opus: 'audio',
  wav: 'audio',
  flac: 'audio',
  mp4: 'video',
  m4v: 'video',
  webm: 'video',
  ogv: 'video',
  mov: 'video',
  jpg: 'image',
  jpeg: 'image',
  png: 'image',
  gif: 'image',
  webp: 'image',
  avif: 'image',
};

/**
 * Whether an enclosure plays as audio or video, shows as an image, or is only a link (streams,
 * Flash, documents): by its MIME type, else by its URL's file extension.
 */
export function enclosureKind(enclosure: { url: string; mimeType: string | null }): EnclosureKind {
  const type = (enclosure.mimeType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (!GENERIC_TYPES.has(type)) {
    const [major] = type.split('/');
    // HLS and DASH playlists carry audio/ and video/ types but need a streaming player.
    if (/mpegurl|dash\+xml/.test(type)) return 'other';
    return major === 'audio' || major === 'video' || major === 'image' ? major : 'other';
  }
  let path: string;
  try {
    path = new URL(enclosure.url).pathname;
  } catch {
    return 'other';
  }
  const extension = /\.(\w+)$/.exec(path)?.[1]?.toLowerCase();
  return (extension && EXTENSIONS[extension]) || 'other';
}
