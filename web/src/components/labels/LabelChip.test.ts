import { describe, expect, it } from 'vitest';
import { mountWithPlugins, testRouter } from '../../test/mount.ts';
import LabelChip from './LabelChip.vue';

const label = { id: 3, caption: 'Später', fgColor: '#ffffff', bgColor: '#123456' };

describe('LabelChip', () => {
  it("shows the label in its colours, in the caption's direction", () => {
    const chip = mountWithPlugins(LabelChip, { props: { label } });
    const span = chip.get('span.label-chip');
    expect(span.text()).toBe('Später');
    expect(span.attributes('dir')).toBe('auto');
    expect(span.attributes('style')).toContain('background-color: #123456');
  });

  it("links to the label's stream when given one", async () => {
    const router = await testRouter();
    const chip = mountWithPlugins(LabelChip, {
      props: { label, to: '/l/3' },
      global: { plugins: [router] },
    });
    expect(chip.get('a.label-chip').attributes('href')).toBe('/l/3');
  });
});
