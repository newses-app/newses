import { describe, expect, it } from 'vitest';
import { themeSource } from './theme.ts';

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
