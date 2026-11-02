import { describe, expect, it } from 'vitest';
import { DEFAULT_PREFS } from './prefs-defaults.ts';
import { prefsSchema, updatePrefsRequestSchema } from './prefs.ts';

describe('preferences', () => {
  it('validates shortcut bindings', () => {
    const valid = { shortcutBindings: { help: ['h', 'g ?'], toggleStar: [] } };
    expect(updatePrefsRequestSchema.parse(valid)).toEqual(valid);
    for (const shortcutBindings of [
      { unknownAction: ['x'] },
      { help: ['a b c'] },
      { help: [''] },
      { help: ['a  b'] },
      { help: ['a', 'b', 'c', 'd', 'e'] },
    ])
      expect(updatePrefsRequestSchema.safeParse({ shortcutBindings }).success).toBe(false);
  });

  it('has valid defaults', () => {
    expect(prefsSchema.parse(DEFAULT_PREFS)).toEqual(DEFAULT_PREFS);
  });

  it('takes any language tag, or null to follow the device', () => {
    for (const language of ['en', 'es-MX', 'zh-Hant-TW', 'tlh', null])
      expect(updatePrefsRequestSchema.parse({ language })).toEqual({ language });
    for (const language of ['', 'e', 'es_ES', 'es-', 'a b', `es-${'x'.repeat(40)}`, 5])
      expect(updatePrefsRequestSchema.safeParse({ language }).success).toBe(false);
  });

  it('bounds reading preferences', () => {
    const valid = { articleFont: 'serif', articleFontSize: 20, articleWidth: 'wide' };
    expect(updatePrefsRequestSchema.parse(valid)).toEqual(valid);
    for (const invalid of [
      { articleFontSize: 11 },
      { articleFontSize: 29 },
      { articleFontSize: 16.5 },
      { articleFont: 'comic' },
      { articleWidth: 'huge' },
    ])
      expect(updatePrefsRequestSchema.safeParse(invalid).success).toBe(false);
  });
});
