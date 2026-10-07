import { describe, expect, it } from 'vitest';
import { contrastRatio, LABEL_COLORS, MIN_CONTRAST, nextLabelColors } from './labels.ts';

describe('label colours', () => {
  it('computes WCAG contrast ratios', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21);
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21);
    expect(contrastRatio('#777777', '#777777')).toBe(1);
    expect(contrastRatio('#767676', '#ffffff')).toBeCloseTo(4.54, 2);
  });

  it('offers only readable presets, cycling for new labels', () => {
    for (const { fgColor, bgColor } of LABEL_COLORS)
      expect(contrastRatio(fgColor, bgColor)).toBeGreaterThanOrEqual(MIN_CONTRAST);
    expect(nextLabelColors(LABEL_COLORS.length)).toEqual(LABEL_COLORS[0]);
  });
});
