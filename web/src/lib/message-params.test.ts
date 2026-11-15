import { shownParam } from '@newses/shared/messages';
import { describe, expect, it } from 'vitest';
import { withoutIsolates } from './message-params.ts';

describe('withoutIsolates', () => {
  it('leaves the text as it was', () => {
    const shown = `Copy of ${String(shownParam('חדשות', 'en', false))}`;
    expect(withoutIsolates(shown)).toBe('Copy of חדשות');
  });
});
