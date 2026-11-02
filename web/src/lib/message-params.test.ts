import { describe, expect, it } from 'vitest';
import { shownParam, withoutIsolates } from './message-params.ts';

describe('shownParam', () => {
  it('formats numbers for the language', () => {
    expect(shownParam(1234567, 'en', false)).toBe('1,234,567');
    expect(shownParam(1234567, 'es', false)).toBe('1.234.567');
    expect(shownParam(0, 'en', false)).toBe('0');
  });

  it('leaves left-to-right text alone in a left-to-right UI', () => {
    expect(shownParam('Fish & Chips', 'en', false)).toBe('Fish & Chips');
  });

  it('isolates right-to-left text in any UI', () => {
    expect(shownParam('חדשות', 'en', false)).toBe('\u2068חדשות\u2069');
    expect(shownParam('أخبار 24', 'en', false)).toBe('\u2068أخبار 24\u2069');
  });

  it('isolates all text in a right-to-left UI', () => {
    expect(shownParam('Fish!', 'ar', true)).toBe('\u2068Fish!\u2069');
  });

  it('leaves empty text and other values alone', () => {
    expect(shownParam('', 'ar', true)).toBe('');
    expect(shownParam(null, 'ar', true)).toBeNull();
    expect(shownParam(undefined, 'ar', true)).toBeUndefined();
  });
});

describe('withoutIsolates', () => {
  it('leaves the text as it was', () => {
    const shown = `Copy of ${String(shownParam('חדשות', 'en', false))}`;
    expect(withoutIsolates(shown)).toBe('Copy of חדשות');
  });
});
