import { describe, expect, it } from 'vitest';
import { contrastRatio, MIN_CONTRAST } from './appearance.ts';
import { LABEL_COLORS, nextLabelColors } from './labels.ts';

describe('label colours', () => {
  it('offers only readable presets, cycling for new labels', () => {
    for (const { fgColor, bgColor } of LABEL_COLORS)
      expect(contrastRatio(fgColor, bgColor)).toBeGreaterThanOrEqual(MIN_CONTRAST);
    expect(nextLabelColors(LABEL_COLORS.length)).toEqual(LABEL_COLORS[0]);
  });
});
