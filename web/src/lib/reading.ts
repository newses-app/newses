import type { Prefs } from '@rss-reader/shared';

/** System font stacks, so no font is downloaded (Privacy requirement). */
const FONTS: Record<Prefs['articleFont'], string> = {
  default: 'inherit',
  sans: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  serif: 'Charter, "Bitstream Charter", "Sitka Text", Cambria, Georgia, "Times New Roman", serif',
  mono: 'ui-monospace, "Cascadia Code", "Source Code Pro", Menlo, Consolas, monospace',
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
): Record<string, string> {
  return {
    '--article-font': FONTS[prefs.articleFont],
    // rem-relative, so the browser's own text-size setting still scales it.
    '--article-font-size': `${String(prefs.articleFontSize / 16)}rem`,
    '--article-width': WIDTHS[prefs.articleWidth],
  };
}
