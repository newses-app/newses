// Content Security Policies for the web app (no Zod, so build tools and shells can import it).

/** Video hosts whose players the sanitiser keeps as iframes. */
export const VIDEO_FRAME_SOURCES =
  'https://www.youtube.com https://www.youtube-nocookie.com https://player.vimeo.com';

const directives = (connectSrc: string) => [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  'img-src * data: blob:',
  'media-src *',
  `frame-src ${VIDEO_FRAME_SOURCES}`,
  `connect-src ${connectSrc}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
];

/**
 * The SPA's policy. Styles allow inline because Vuetify injects its theme; feed images and media
 * load from anywhere, but scripts only from this origin, and frames only from the video hosts the
 * sanitiser keeps.
 */
export const WEB_CSP = [...directives("'self'"), "frame-ancestors 'none'"].join('; ');

/**
 * The apps' bundled build: the server is chosen at runtime, so the API may be any HTTPS origin.
 * Without `frame-ancestors`, which a `<meta>` policy cannot carry.
 */
export const NATIVE_CSP = directives('https:').join('; ');
