/** Text and background colours for new labels; each pair meets WCAG AA (4.5:1). */
export const LABEL_COLORS: { fgColor: string; bgColor: string }[] = [
  { fgColor: '#ffffff', bgColor: '#1565c0' },
  { fgColor: '#ffffff', bgColor: '#b71c1c' },
  { fgColor: '#ffffff', bgColor: '#2e7d32' },
  { fgColor: '#000000', bgColor: '#ffd54f' },
  { fgColor: '#ffffff', bgColor: '#6a1b9a' },
  { fgColor: '#ffffff', bgColor: '#00695c' },
  { fgColor: '#ffffff', bgColor: '#ad1457' },
  { fgColor: '#000000', bgColor: '#ffab91' },
  { fgColor: '#ffffff', bgColor: '#4e342e' },
  { fgColor: '#ffffff', bgColor: '#455a64' },
];

/** WCAG 2 minimum contrast for normal text. */
export const MIN_CONTRAST = 4.5;

/** The colours for the next new label, cycling through `LABEL_COLORS`. */
export const nextLabelColors = (existing: number) =>
  LABEL_COLORS[existing % LABEL_COLORS.length] ?? { fgColor: '#ffffff', bgColor: '#1565c0' };

function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** WCAG 2 contrast ratio of two `#rrggbb` colours, from 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}
