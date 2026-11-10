import { BUILTIN_THEMES } from '@newses/shared/client';
import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { appliedTokens } from '../composables/useAppearance.ts';
import JitterText from './JitterText.vue';

describe('JitterText', () => {
  afterEach(() => {
    appliedTokens.value = BUILTIN_THEMES.original;
  });

  it('shows the text as it is under other styles', () => {
    expect(mount(JitterText, { props: { text: 'Case file' } }).html()).toBe('Case file');
  });

  it('jitters the letters in the Noir style, with the text as it is for screen readers', () => {
    appliedTokens.value = BUILTIN_THEMES.noir;
    const text = mount(JitterText, { props: { text: 'Case file' } });
    expect(text.get('.d-sr-only').text()).toBe('Case file');
    const letters = text.get('[aria-hidden="true"]');
    expect(letters.findAll('.jitter-word')).toHaveLength(2);
    expect(
      letters
        .findAll('.jitter-letter')
        .map((letter) => letter.text())
        .join(''),
    ).toBe('Casefile');
    expect(letters.findAll('.jitter-letter')).toHaveLength(8);
    const style = letters.get('.jitter-letter').attributes('style');
    expect(style).toMatch(/--jy: -?[\d.]+em; --jr: -?[\d.]+deg; --ji: 0/);
  });

  it('leaves the text whole in the Saul style', () => {
    appliedTokens.value = BUILTIN_THEMES.saul;
    expect(mount(JitterText, { props: { text: 'Title' } }).html()).toBe('Title');
  });

  it('leaves the text whole without texture, and in scripts whose letters join', () => {
    appliedTokens.value = { ...BUILTIN_THEMES.noir, effects: { texture: false, animation: true } };
    expect(mount(JitterText, { props: { text: 'Case file' } }).html()).toBe('Case file');
    appliedTokens.value = BUILTIN_THEMES.noir;
    expect(mount(JitterText, { props: { text: 'أخبار' } }).html()).toBe('أخبار');
  });
});
