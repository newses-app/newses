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

/** The colours for the next new label, cycling through `LABEL_COLORS`. */
export const nextLabelColors = (existing: number) =>
  LABEL_COLORS[existing % LABEL_COLORS.length] ?? { fgColor: '#ffffff', bgColor: '#1565c0' };
