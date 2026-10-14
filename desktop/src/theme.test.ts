import { describe, expect, it } from 'vitest';
import { themeBackground, themeSource } from './theme.ts';

describe('themeSource', () => {
  it('pins light or dark only when the reader chose it', () => {
    expect(themeSource({ preference: 'dark', dark: true })).toBe('dark');
    expect(themeSource({ preference: 'light', dark: false })).toBe('light');
  });

  it('follows the OS for the system preference, whatever it resolved to', () => {
    expect(themeSource({ preference: 'system', dark: true })).toBe('system');
    expect(themeSource({ preference: 'system', dark: false })).toBe('system');
  });

  it('follows the OS for anything unexpected', () => {
    expect(themeSource(null)).toBe('system');
    expect(themeSource({ preference: 'sepia' })).toBe('system');
  });
});

describe('themeBackground', () => {
  it('takes a #rrggbb background', () => {
    expect(themeBackground({ preference: 'system', dark: true, background: '#0a0e0a' })).toBe(
      '#0a0e0a',
    );
    expect(themeBackground({ background: '#FFFDF6' })).toBe('#FFFDF6');
  });

  it('ignores anything else', () => {
    for (const theme of [
      null,
      'dark',
      {},
      { background: 'red' },
      { background: '#fff' },
      { background: '#ffffff; x' },
      { background: 0xffffff },
    ])
      expect(themeBackground(theme)).toBeNull();
  });
});
