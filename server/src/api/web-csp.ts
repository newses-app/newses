/**
 * Content Security Policy for the SPA. Styles allow inline because Vuetify injects its theme;
 * feed images and media load from anywhere, but scripts only from this origin, and frames only
 * from the video hosts the sanitiser keeps.
 */
/** Video hosts whose players the sanitiser keeps as iframes. */
export const VIDEO_FRAME_SOURCES =
  'https://www.youtube.com https://www.youtube-nocookie.com https://player.vimeo.com';

export const WEB_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  'img-src * data: blob:',
  'media-src *',
  `frame-src ${VIDEO_FRAME_SOURCES}`,
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');
