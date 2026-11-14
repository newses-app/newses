import type { CreateThemeRequest, Theme } from '@newses/shared';
import { BUILTIN_THEMES } from '@newses/shared/client';
import { describe, expect, it } from 'vitest';
import {
  editedTheme,
  hasLowContrast,
  importAccepted,
  paletteChange,
  themeGroups,
} from './theme-editor.ts';

const theme = (id: number, mine: boolean, overrides: Partial<Theme> = {}) =>
  ({ id, name: `T${String(id)}`, base: 'terminal', tokens: {}, mine, ...overrides }) as Theme;

describe('paletteChange', () => {
  it("sets a colour in the mode's palette, lower case", () => {
    expect(paletteChange('dark', 'primary', '#AABBCC')).toEqual({
      palette: { dark: { primary: '#aabbcc' } },
    });
  });

  it('ignores anything but #rrggbb', () => {
    expect(paletteChange('light', 'text', '#abc')).toBeNull();
    expect(paletteChange('light', 'text', 'red')).toBeNull();
  });
});

describe('editedTheme', () => {
  const custom = { base: 'sketch' as const, tokens: { radius: 'none' as const } };

  it('is a built-in theme as it is, or the custom theme in use', () => {
    expect(editedTheme('terminal', () => undefined)).toEqual({ base: 'terminal', tokens: {} });
    expect(editedTheme(7, () => custom)).toBe(custom);
  });

  it('falls back to Original when the custom theme is gone', () => {
    expect(editedTheme(7, () => undefined)).toEqual({ base: 'original', tokens: {} });
  });
});

describe('hasLowContrast', () => {
  it('passes the built-in themes, and finds a colour below WCAG AA in either mode', () => {
    expect(hasLowContrast({ base: 'original', tokens: {} })).toBe(false);
    expect(
      hasLowContrast({ base: 'original', tokens: { palette: { dark: { text: '#222222' } } } }),
    ).toBe(true);
  });
});

describe('importAccepted', () => {
  const file = (tokens: CreateThemeRequest['tokens'], base = 'original'): CreateThemeRequest =>
    ({ name: 'Imported', base, tokens }) as CreateThemeRequest;
  const upTo = (max: number) => (minor: number) => minor <= max;

  it('takes a theme whose base, style, and fonts the server knows', () => {
    expect(importAccepted(file({ style: 'terminal', uiFont: 'mono' }), upTo(0))).toBe(true);
    expect(importAccepted(file({}, 'gruvbox'), upTo(10))).toBe(true);
  });

  it('refuses one newer than the server', () => {
    expect(importAccepted(file({}, 'gruvbox'), upTo(8))).toBe(false);
    expect(importAccepted(file({ style: 'noir' }), upTo(8))).toBe(false);
    expect(importAccepted(file({ articleFont: 'oswald' }), upTo(8))).toBe(false);
  });

  it('leaves values this app does not know to the server', () => {
    // Only the server checks an imported file's values.
    const unknown = file({
      style: 'future',
      uiFont: 'future',
    } as unknown as CreateThemeRequest['tokens']);
    expect(importAccepted(unknown, upTo(0))).toBe(true);
  });
});

describe('themeGroups', () => {
  const labels = {
    builtIn: 'Built in',
    mine: 'Mine',
    shared: 'Shared',
    theme: (key: string) => `theme ${key}`,
  };

  it("groups the built-in themes the server accepts, the reader's own, and shared ones", () => {
    const groups = themeGroups({
      themes: [
        theme(1, true),
        theme(2, false, { tokens: { palette: { dark: { primary: '#123456' } } } }),
      ],
      mode: 'dark',
      accepted: (minor) => minor === 0,
      labels,
    });
    expect(groups.map((g) => g.title)).toEqual(['Built in', 'Mine', 'Shared']);
    expect(groups[0]?.options.map((o) => o.value)).toEqual(['original', 'terminal', 'sketch']);
    expect(groups[0]?.options[1]).toEqual({
      value: 'terminal',
      name: 'theme terminal',
      palette: BUILTIN_THEMES.terminal.palette.dark,
    });
    expect(groups[1]?.options[0]).toMatchObject({ value: 1, name: 'T1', theme: { id: 1 } });
    expect(groups[2]?.options[0]?.palette.primary).toBe('#123456');
  });

  it('leaves out empty groups', () => {
    const groups = themeGroups({ themes: [], mode: 'light', accepted: () => true, labels });
    expect(groups.map((g) => g.title)).toEqual(['Built in']);
    expect(groups[0]?.options).toHaveLength(Object.keys(BUILTIN_THEMES).length);
  });
});
