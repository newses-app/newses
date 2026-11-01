import { describe, expect, it } from 'vitest';
import { t } from './i18n.ts';

describe('t', () => {
  it('returns the text of a key', () => {
    expect(t('open')).toBe('Open');
  });

  it('fills in params, taking their text literally', () => {
    expect(t('signedOut', { name: 'Home' })).toBe('Home (signed out)');
    expect(t('signedOut', { name: "$& {name} $'" })).toBe("$& {name} $' (signed out)");
  });
});
