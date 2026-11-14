import { describe, expect, it } from 'vitest';
import { mountWithPlugins } from '../../test/mount.ts';
import ScoreBadge from './ScoreBadge.vue';

describe('ScoreBadge', () => {
  it('shows a score with its direction, and says when it is high', () => {
    const low = mountWithPlugins(ScoreBadge, { props: { score: -5, high: false } });
    expect(low.text()).toBe('Score -5');
    expect(low.find('.score').classes()).not.toContain('high');
    const high = mountWithPlugins(ScoreBadge, { props: { score: 1200, high: true } });
    expect(high.text()).toBe('High score 1,200');
    expect(high.find('.score').classes()).toContain('high');
  });

  it('shows nothing for no score', () => {
    expect(mountWithPlugins(ScoreBadge, { props: { score: 0, high: false } }).text()).toBe('');
  });
});
