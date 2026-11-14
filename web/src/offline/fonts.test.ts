import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.resetModules();
  Reflect.deleteProperty(document, 'fonts');
});

/** A fresh module (it warms once per page), with `document.fonts` loading as `load` does. */
async function warm(load?: (font: string) => Promise<unknown>) {
  if (load) Object.defineProperty(document, 'fonts', { value: { load }, configurable: true });
  const { warmThemeFonts } = await import('./fonts.ts');
  return warmThemeFonts;
}

describe('warmThemeFonts', () => {
  it('loads each theme font once per page, ignoring failures', async () => {
    const load = vi.fn((font: string) =>
      font.includes('Patrick') ? Promise.reject(new Error('offline')) : Promise.resolve([]),
    );
    const warmThemeFonts = await warm(load);
    warmThemeFonts();
    warmThemeFonts();
    expect(load.mock.calls.map(([font]) => font)).toEqual([
      '400 1em "Patrick Hand"',
      '400 1em "IBM Plex Mono"',
      '700 1em "IBM Plex Mono"',
    ]);
  });

  it('does nothing where the document cannot load fonts', async () => {
    const warmThemeFonts = await warm();
    expect(() => {
      warmThemeFonts();
    }).not.toThrow();
  });
});
