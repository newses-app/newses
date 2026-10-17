/**
 * The bundled theme fonts (`themes/fonts.css`), by the CSS font shorthand that loads each face.
 * Loading them as fonts lets the service worker's font cache keep them, so Sketch and Terminal
 * render offline in a browser; the apps bundle them anyway.
 */
const THEME_FONTS = [
  '400 1em "Patrick Hand"',
  '400 1em "IBM Plex Mono"',
  '700 1em "IBM Plex Mono"',
];

let warmed = false;

/** Loads every theme font once per page, so they are cached before the connection goes. */
export function warmThemeFonts(): void {
  if (warmed || typeof document === 'undefined' || !('fonts' in document)) return;
  warmed = true;
  for (const font of THEME_FONTS) void document.fonts.load(font, 'a').catch(() => undefined);
}
