/**
 * Content Security Policy for the SPA. Styles allow inline because Vuetify injects its theme;
 * feed images and media load from anywhere, but scripts only from this origin, and frames only
 * from the video hosts the sanitiser keeps.
 */
export const WEB_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  'img-src * data: blob:',
  'media-src *',
  'frame-src https://www.youtube.com https://www.youtube-nocookie.com https://player.vimeo.com',
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');
