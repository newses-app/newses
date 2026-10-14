import type { FontKey, Prefs, ThemeTokens } from '@newses/shared';

/** System font stacks, and fonts bundled with the app (`themes/fonts.css`, Privacy requirement). */
export const FONTS: Record<FontKey, string> = {
  default: 'inherit',
  sans: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  serif: 'Charter, "Bitstream Charter", "Sitka Text", Cambria, Georgia, "Times New Roman", serif',
  mono: 'ui-monospace, "Cascadia Code", "Source Code Pro", Menlo, Consolas, monospace',
  patrickHand: '"Patrick Hand", "Segoe Print", "Bradley Hand", cursive',
  plexMono: '"IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace',
};

const WIDTHS: Record<Prefs['articleWidth'], string> = {
  narrow: '40rem',
  medium: '50rem',
  wide: '65rem',
  full: 'none',
};

/** CSS custom properties that article styles read; set on the document root. */
export function readingStyle(
  prefs: Pick<Prefs, 'articleFont' | 'articleFontSize' | 'articleWidth'>,
  theme: Pick<ThemeTokens, 'articleFont' | 'fontScale'>,
): Record<string, string> {
  const font = prefs.articleFont === 'default' ? theme.articleFont : prefs.articleFont;
  return {
    '--article-font': FONTS[font],
    // rem-relative, so the browser's own text-size setting still scales it. The theme's font scale
    // sizes the root font, so it is divided out to keep the reader's size.
    '--article-font-size': `${String(prefs.articleFontSize / 16 / theme.fontScale)}rem`,
    '--article-width': WIDTHS[prefs.articleWidth],
  };
}
